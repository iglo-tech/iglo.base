// Upstream: tools/auth/twitter.go

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeNested, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { anyType, stringType } from "@/tools/types/go-json";

// Twitter allows authentication via Twitter OAuth2.
export class Twitter extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.scopes = [
      "users.read",
      "users.email",
      // we don't actually use this scope, but for some reason the `/2/users/me` endpoint fails with 403 without it
      // (see https://docs.x.com/fundamentals/authentication/guides/v2-authentication-mapping#x-api-v2-authentication-mapping)
      "tweet.read",
    ];
    this.authURL = "https://x.com/i/oauth2/authorize";
    this.tokenURL = "https://api.x.com/2/oauth2/token";
    this.userInfoURL =
      "https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url,confirmed_email";
  }

  // API reference: https://docs.x.com/x-api/users/user-lookup-me
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{ data: unknown }>(data, { data: anyType });
    const user = decodeNested<{
      id: string;
      name: string;
      username: string;
      confirmed_email: string;
      profile_image_url: string;
    }>(extracted.data, {
      id: stringType,
      name: stringType,
      username: stringType,
      confirmed_email: stringType,
      profile_image_url: stringType,
    });

    return new AuthUser({
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.confirmed_email,
      avatarURL: user.profile_image_url,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });
  }
}
