// Upstream: tools/auth/microsoft.go
//
// The endpoints are golang.org/x/oauth2/microsoft's AzureADEndpoint("").
// The id_token's email claims are read without a signature check, as
// upstream does: the token comes from the direct TLS exchange with the provider.

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { idTokenLeewaySeconds } from "@/oauth2/oidc";
import type { Token } from "@/oauth2/token";
import { decodeFields, decodeRawUser } from "@/oauth2/user-fields";
import { type MapClaims, parseUnverifiedToken, validateClaims } from "@/tools/security/jwt";
import { toBool, toString } from "@/tools/types/cast";
import { stringType } from "@/tools/types/go-json";

// the name of the extra config entry that selects the email extraction method
const extraIdTokenEmailClaim = "idTokenEmailClaim";

// Microsoft allows authentication via Azure AD/Entra ID OAuth2.
export class Microsoft extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.scopes = ["User.Read"];
    this.authURL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
    this.tokenURL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
    this.userInfoURL = "https://graph.microsoft.com/v1.0/me";
  }

  // If the idTokenEmailClaim extra option is set, "openid" is added to the
  // default scopes in order to get an id_token.
  override setExtra(data: { [key: string]: unknown }): void {
    super.setExtra(data);

    if (toString(this.extra?.[extraIdTokenEmailClaim]) !== "") {
      if (!this.scopes.includes("openid")) {
        this.scopes = [...this.scopes, "openid"];
      }
    }
  }

  // Graph explorer:  https://developer.microsoft.com/en-us/graph/graph-explorer
  // API reference:   https://learn.microsoft.com/en-us/graph/api/user-get
  // Optional claims: https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    // @todo with the future update to v2 endpoint consider skipping the request
    // if id_token is available (we need to make sure that the graph's id is the same as id_token's sub!)
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{ id: string; displayName: string; mail: string }>(data, {
      id: stringType,
      displayName: stringType,
      mail: stringType,
    });

    const user = new AuthUser({
      id: extracted.id,
      name: extracted.displayName,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });

    // decide which email to trust and assign
    const method = this.extra?.[extraIdTokenEmailClaim];
    switch (method) {
      case "any_verified":
        user.email = this.extractIdTokenVerifiedPrimaryEmail(token);
        if (user.email === "") {
          user.email = this.extractIdTokenVerifiedXmsEdovEmail(token);
        }
        break;
      case "verified_primary_email":
        user.email = this.extractIdTokenVerifiedPrimaryEmail(token);
        break;
      case "email_and_xms_edov":
        user.email = this.extractIdTokenVerifiedXmsEdovEmail(token);
        break;
      case "email":
        user.email = this.extractIdTokenEmail(token);
        break;
      default:
        // This is kept to avoid introducing breaking changes and generally
        // it is considered safe because the provider was originally created
        // for single-tenants apps. Furthermore the value is expected to be
        // synced with the id_token's `email` claim which since 2023
        // by *default* would be empty if it is unverified.
        user.email = extracted.mail;
    }

    return user;
  }

  // the id_token's claims, validated (exp, nbf, iat); an error when the
  // token is missing or malformed
  private extractIdTokenClaims(token: Token): MapClaims {
    const idToken = token.extra("id_token");
    if (typeof idToken !== "string" || idToken === "") {
      throw new Error("empty id_token");
    }

    const claims: MapClaims = {};
    parseUnverifiedToken(idToken, claims);

    // loosely validate common claims
    // (we don't check the signature because the token is expected to be
    // from a trusted source, usually from a direct TLS communication with the provider)
    validateClaims(claims, this.clock, {
      verifyIat: true,
      leewaySeconds: idTokenLeewaySeconds(),
    });

    return claims;
  }

  // the claims of the id_token, or none when the token is not usable
  private claimsOf(token: Token): MapClaims {
    try {
      return this.extractIdTokenClaims(token);
    } catch {
      return {};
    }
  }

  private extractIdTokenVerifiedPrimaryEmail(token: Token): string {
    const email = this.claimsOf(token)["verified_primary_email"];
    return typeof email === "string" ? email : "";
  }

  private extractIdTokenVerifiedXmsEdovEmail(token: Token): string {
    const claims = this.claimsOf(token);

    if (!toBool(claims["xms_edov"])) {
      return "";
    }

    const email = claims["email"];
    return typeof email === "string" ? email : "";
  }

  private extractIdTokenEmail(token: Token): string {
    const email = this.claimsOf(token)["email"];
    return typeof email === "string" ? email : "";
  }
}
