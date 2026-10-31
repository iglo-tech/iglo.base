// Upstream: tools/auth/base_provider.go, tools/auth/auth.go (AuthUser) and
// the OAuth2 client of golang.org/x/oauth2 (Config.Client, Transport)
//
// Go's interface of getters and setters is the public fields of this class.
// SetContext is `signal` (the request's deadline), and the clock is the
// app's, for the token expiry and the id_token claims. A provider file
// extends the class, sets its defaults in its constructor and implements
// fetchAuthUser; providers.ts lists it.

import { type Clock, systemClock } from "@/app/clock";
import { fetchFollowingRedirects } from "@/oauth2/http-client";
import { exchangeToken, type Token, type TokenConfig, validToken } from "@/oauth2/token";
import { DateTime } from "@/tools/types/datetime";
import { anyType, mapOf, marshal, unmarshal } from "@/tools/types/go-json";

// AuthUser.Expiry: types.ParseDateTime(token.Expiry), the zero DateTime
// without an expiry (a token with no expiry time)
export function expiryOf(token: Token): DateTime {
  return token.expiry === null ? new DateTime() : DateTime.fromDate(token.expiry);
}

// AuthUser defines a standardized OAuth2 user data structure.
export class AuthUser {
  // the zero types.DateTime
  expiry = new DateTime();
  // null is Go's nil map (marshaled as {} by json v2)
  rawUser: { [key: string]: unknown } | null = null;
  id = "";
  name = "";
  username = "";
  avatarURL = "";
  accessToken = "";
  refreshToken = "";

  // The VERIFIED OAuth2 account email.
  //
  // It must be empty if the provider is not able to verify the email ownership.
  email = "";

  constructor(init: Partial<AuthUser> = {}) {
    Object.assign(this, init);
  }

  // json.Marshal + json.Unmarshal into a map, as recordAuthWithOAuth2 builds
  // its meta; the legacy avatarUrl key is populated (AuthUser.MarshalJSON)
  toMeta(): { [key: string]: unknown } {
    const text = marshal({
      expiry: this.expiry.toString(),
      rawUser: this.rawUser ?? {},
      id: this.id,
      name: this.name,
      username: this.username,
      avatarURL: this.avatarURL,
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      email: this.email,
      avatarUrl: this.avatarURL,
    });
    return unmarshal(text, mapOf(anyType)) as { [key: string]: unknown };
  }
}

// BaseProvider defines common fields and methods used by OAuth2 client providers.
export abstract class BaseProvider implements TokenConfig {
  signal: AbortSignal | undefined;
  clock: Clock = systemClock();
  // the Extra config options; null is Go's nil map
  extra: { [key: string]: unknown } | null = null;
  redirectURL = "";
  clientId = "";
  clientSecret = "";
  displayName = "";
  logo = "";
  authURL = "";
  tokenURL = "";
  userInfoURL = "";
  scopes: string[] = [];
  order = 0;
  pkce = false;

  // SetExtra stores the Extra config options. A provider overrides it to
  // react to an option (Microsoft's idTokenEmailClaim adds the openid scope).
  setExtra(data: { [key: string]: unknown }): void {
    this.extra = data;
  }

  // FetchAuthUser is similar to FetchRawUserInfo, but normalizes and
  // marshalizes the user api response into a standardized AuthUser.
  abstract fetchAuthUser(token: Token): Promise<AuthUser>;

  // FetchToken converts an authorization code to token (opts are its
  // SetAuthURLParam options, in order).
  fetchToken(code: string, opts: readonly (readonly [string, string])[] = []): Promise<Token> {
    return exchangeToken(this, this.redirectURL, code, opts);
  }

  // Client(token).Do(request): sends the request with the token's
  // Authorization header, after refreshing an expired token.
  async fetchWithToken(token: Token, url: string, init: RequestInit = {}): Promise<Response> {
    const current = await validToken(this, token);
    return fetchFollowingRedirects(
      url,
      { ...init, signal: this.signal ?? null },
      current.type() + " " + current.accessToken,
    );
  }

  // FetchRawUserInfo requests the OAuth user api response.
  fetchRawUserInfo(token: Token): Promise<Uint8Array> {
    return this.sendRawUserInfoRequest(this.userInfoURL, {}, token);
  }

  // sendRawUserInfoRequest sends the specified user info request and return its raw response body.
  protected async sendRawUserInfoRequest(
    url: string,
    init: RequestInit,
    token: Token,
  ): Promise<Uint8Array> {
    const res = await this.fetchWithToken(token, url, init);
    const result = new Uint8Array(await res.arrayBuffer());

    // fetch doesn't treat non 2xx responses as error
    if (res.status >= 400) {
      throw new Error(
        `failed to fetch OAuth2 user profile via ${this.userInfoURL} (${res.status}):\n${new TextDecoder().decode(result)}`,
      );
    }

    return result;
  }
}
