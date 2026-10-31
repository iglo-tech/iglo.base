// Upstream: tools/auth/instagram.go
//
// The provider is registered as "instagram2" (a "2" suffix to avoid conflicts
// with the old deprecated version).

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { stringType } from "@/tools/types/go-json";

// Instagram allows authentication via Instagram Login OAuth2.
export class Instagram extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.scopes = ["instagram_business_basic"];
    this.authURL = "https://www.instagram.com/oauth/authorize";
    this.tokenURL = "https://api.instagram.com/oauth/access_token";
    this.userInfoURL =
      "https://graph.instagram.com/me?fields=id,username,account_type,user_id,name,profile_picture_url,followers_count,follows_count,media_count";
  }

  // API reference: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started#fields
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data) ?? {};

    // include list of granted permissions to RawUser's payload
    if (!Object.hasOwn(rawUser, "permissions")) {
      const permissions = token.extra("permissions");
      if (permissions !== null && permissions !== undefined) {
        rawUser["permissions"] = permissions;
      }
    }

    const extracted = decodeFields<{
      user_id: string;
      name: string;
      username: string;
      profile_picture_url: string;
    }>(data, {
      user_id: stringType,
      name: stringType,
      username: stringType,
      profile_picture_url: stringType,
    });

    return new AuthUser({
      id: extracted.user_id,
      username: extracted.username,
      name: extracted.name,
      avatarURL: extracted.profile_picture_url,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });
  }
}
