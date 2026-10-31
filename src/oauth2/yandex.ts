// Upstream: tools/auth/yandex.go
//
// The endpoints are golang.org/x/oauth2/yandex's Endpoint.

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { boolType, stringType } from "@/tools/types/go-json";

// Yandex allows authentication via Yandex OAuth2.
export class Yandex extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.scopes = ["login:email", "login:avatar", "login:info"];
    this.authURL = "https://oauth.yandex.com/authorize";
    this.tokenURL = "https://oauth.yandex.com/token";
    this.userInfoURL = "https://login.yandex.ru/info";
  }

  // API reference: https://yandex.ru/dev/id/doc/en/user-information#response-format
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{
      id: string;
      real_name: string;
      login: string;
      default_email: string;
      is_avatar_empty: boolean;
      default_avatar_id: string;
    }>(data, {
      id: stringType,
      real_name: stringType,
      login: stringType,
      default_email: stringType,
      is_avatar_empty: boolType,
      default_avatar_id: stringType,
    });

    const user = new AuthUser({
      id: extracted.id,
      name: extracted.real_name,
      username: extracted.login,
      email: extracted.default_email,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });

    if (!extracted.is_avatar_empty) {
      user.avatarURL =
        "https://avatars.yandex.net/get-yapic/" + extracted.default_avatar_id + "/islands-200";
    }

    return user;
  }
}
