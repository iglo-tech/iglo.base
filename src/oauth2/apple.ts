// Upstream: tools/auth/apple.go
//
// OIDC differences: https://bitbucket.org/openid/connect/src/master/How-Sign-in-with-Apple-differs-from-OpenID-Connect.md
//
// Apple has no user info endpoint: the claims come from the id_token. The
// JWKS URL is fixed (apple.go's jwksURL, which no configuration sets), so a
// test replaces it through the global fetch, never a request or a setting.

import type { Clock } from "@/app/clock";
import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { validateTokenSignature } from "@/oauth2/jwk";
import { idTokenLeewaySeconds } from "@/oauth2/oidc";
import { decodeFields, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { type MapClaims, parseUnverifiedToken, validateClaims } from "@/tools/security/jwt";
import { toBool } from "@/tools/types/cast";
import { anyType, marshal, stringType } from "@/tools/types/go-json";

const appleIssuer = "https://appleid.apple.com";

const encoder = new TextEncoder();

// Apple allows authentication via Apple OAuth2.
export class Apple extends BaseProvider {
  readonly jwksURL = "https://appleid.apple.com/auth/keys";

  constructor() {
    super();
    this.pkce = true;
    this.scopes = ["name", "email"];
    this.authURL = "https://appleid.apple.com/auth/authorize";
    this.tokenURL = "https://appleid.apple.com/auth/token";
  }

  // API reference: https://developer.apple.com/documentation/signinwithapple/authenticating-users-with-sign-in-with-apple#Retrieve-the-users-information-from-Apple-ID-servers.
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    // email_verified could be string or bool
    const extracted = decodeFields<{
      email_verified: unknown;
      email: string;
      sub: string;
      // not returned at the time of writing and it is usually
      // manually populated in apis.recordAuthWithOAuth2
      name: string;
    }>(data, {
      email_verified: anyType,
      email: stringType,
      sub: stringType,
      name: stringType,
    });

    const user = new AuthUser({
      id: extracted.sub,
      name: extracted.name,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });

    if (toBool(extracted.email_verified)) {
      user.email = extracted.email;
    }

    return user;
  }

  // Apple doesn't have a UserInfo endpoint and claims about the users are
  // included in the id_token (without the name - see #7090).
  override async fetchRawUserInfo(token: Token): Promise<Uint8Array> {
    const idToken = token.extra("id_token");
    const claims = await this.parseAndVerifyIdToken(typeof idToken === "string" ? idToken : "");

    return encoder.encode(marshal(claims));
  }

  private async parseAndVerifyIdToken(idToken: string): Promise<MapClaims> {
    if (idToken === "") {
      throw new Error("empty id_token");
    }

    // extract the token claims
    const claims: MapClaims = {};
    parseUnverifiedToken(idToken, claims);

    // validate common claims per https://developer.apple.com/documentation/sign_in_with_apple/sign_in_with_apple_rest_api/verifying_a_user#3383769
    validateAppleClaims(claims, this.clock, this.clientId);

    // validate id_token signature
    //
    // note: this step could be technically considered optional because we trust
    // the token which is a result of direct TLS communication with the provider
    // (see also https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)
    try {
      await validateTokenSignature(this.signal, idToken, this.jwksURL, this.clock);
    } catch (err) {
      throw new Error(`id_token validation failed: ${(err as Error).message}`, { cause: err });
    }

    return claims;
  }
}

// the validator of apple.go: an expiration is required, the issued-at and
// the expiration are checked with the id_token leeway, and the issuer and
// the audience must match. Every failed check is reported.
function validateAppleClaims(claims: MapClaims, clock: Clock, audience: string): void {
  const errors: string[] = [];

  const exp = claims["exp"];
  if (exp === undefined || exp === null) {
    errors.push("token is missing required claim: exp claim is required");
  }

  try {
    validateClaims(claims, clock, {
      verifyIat: true,
      leewaySeconds: idTokenLeewaySeconds(),
      audience,
    });
  } catch (err) {
    errors.push((err as Error).message);
  }

  if (claims["iss"] !== appleIssuer) {
    errors.push("token has invalid issuer");
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}
