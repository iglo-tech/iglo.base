// Upstream: tools/auth/oidc.go
//
// The user data comes from userInfoURL or, without one, from the id_token.
// Extra config options, both only for the id_token:
//   - "jwksURL": url to the keys to validate the id_token signature
//   - "issuers": list of valid issuers for the iss claim
//
// PB_ID_TOKEN_LEEWAY is read when a token is parsed; upstream reads it once
// at startup and the value cannot change in between.

import { AuthUser, BaseProvider } from "@/oauth2/base-provider";
import { validateTokenSignature } from "@/oauth2/jwk";
import type { Token } from "@/oauth2/token";
import { constantTimeCompare } from "@/tools/security/crypto";
import { type MapClaims, parseUnverifiedToken, validateClaims } from "@/tools/security/jwt";
import { toBool, toString, toStringSlice } from "@/tools/types/cast";
import { DateTime } from "@/tools/types/datetime";
import {
  anyType,
  mapOf,
  marshal,
  stringType,
  unmarshal,
  unmarshalStruct,
} from "@/tools/types/go-json";

// idTokenLeeway: the optional leeway for the id_token timestamp fields validation
const defaultIdTokenLeewaySeconds = 300;

const encoder = new TextEncoder();

function idTokenLeewaySeconds(): number {
  const leeway = process.env["PB_ID_TOKEN_LEEWAY"] ?? "";
  return /^[+-]?[0-9]+$/.test(leeway) ? Number(leeway) : defaultIdTokenLeewaySeconds;
}

// OIDC allows authentication via OpenID Connect (OIDC) OAuth2 provider.
export class OIDC extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.scopes = [
      "openid", // minimal requirement to return the id
      "email",
      "profile",
    ];
  }

  // API reference: https://openid.net/specs/openid-connect-core-1_0.html#StandardClaims
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = unmarshal(data, mapOf(anyType)) as { [key: string]: unknown } | undefined;

    const extracted = { sub: "", name: "", preferred_username: "", picture: "", email: "" };
    let emailVerified: unknown; // see #6657
    const text = (key: keyof typeof extracted) => (value: unknown) => {
      extracted[key] = (value ?? "") as string;
    };
    unmarshalStruct(
      data,
      {
        sub: text("sub"),
        name: text("name"),
        preferred_username: text("preferred_username"),
        picture: text("picture"),
        email: text("email"),
        email_verified: (value) => {
          emailVerified = value;
        },
      },
      {
        sub: stringType,
        name: stringType,
        preferred_username: stringType,
        picture: stringType,
        email: stringType,
        email_verified: anyType,
      },
      () => {},
    );

    const user = new AuthUser({
      id: extracted.sub,
      name: extracted.name,
      username: extracted.preferred_username,
      avatarURL: extracted.picture,
      rawUser: rawUser ?? null,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
    });

    if (token.expiry !== null) {
      user.expiry = DateTime.fromDate(token.expiry);
    }

    if (toBool(emailVerified)) {
      user.email = extracted.email;
    }

    return user;
  }

  // Fetches the data from userInfoURL, or if not set returns the id_token claims.
  override async fetchRawUserInfo(token: Token): Promise<Uint8Array> {
    if (this.userInfoURL !== "") {
      return super.fetchRawUserInfo(token);
    }

    const claims = await this.#parseIdToken(token);

    return encoder.encode(marshal(claims));
  }

  async #parseIdToken(token: Token): Promise<MapClaims> {
    const idToken = token.extra("id_token");
    if (typeof idToken !== "string" || idToken === "") {
      throw new Error("empty or invalid id_token");
    }

    const claims: MapClaims = {};
    parseUnverifiedToken(idToken, claims);

    // validate common claims
    validateClaims(claims, this.clock, {
      verifyIat: true,
      leewaySeconds: idTokenLeewaySeconds(),
      audience: this.clientId,
    });

    // validate iss (if "issuers" extra config is set)
    const issuers = toStringSlice(this.extra?.["issuers"]);
    if (issuers.length > 0) {
      const iss = claims["iss"];
      const claimIssuer = encoder.encode(typeof iss === "string" ? iss : "");
      if (!issuers.some((issuer) => constantTimeCompare(claimIssuer, encoder.encode(issuer)))) {
        throw new Error(`iss must be one of ${issuers.join(" ")}, got ${String(iss)}`);
      }
    }

    // validate signature (if "jwksURL" extra config is set)
    //
    // note: this step could be technically considered optional because we trust
    // the token which is a result of direct TLS communication with the provider
    // (see also https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)
    const jwksURL = toString(this.extra?.["jwksURL"]);
    if (jwksURL !== "") {
      try {
        await validateTokenSignature(this.signal, idToken, jwksURL, this.clock);
      } catch (err) {
        throw new Error(`id_token validation failed: ${(err as Error).message}`, { cause: err });
      }
    }

    return claims;
  }
}
