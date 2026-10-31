// Upstream: tools/auth/gitea.go

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { fetchVerifiedPrimaryEmail } from "@/oauth2/emails";
import { decodeFields, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { boolType, int64Type, stringType } from "@/tools/types/go-json";

// Gitea allows authentication via Gitea/Forgejo OAuth2.
export class Gitea extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.scopes = ["read:user", "user:email"];
    this.authURL = "https://gitea.com/login/oauth/authorize";
    this.tokenURL = "https://gitea.com/login/oauth/access_token";
    this.userInfoURL = "https://gitea.com/api/v1/user";
  }

  // API reference: https://codeberg.org/api/swagger#/user/userGetCurrent
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{
      full_name: string;
      login: string;
      avatar_url: string;
      id: number;
      active: boolean;
    }>(data, {
      full_name: stringType,
      login: stringType,
      avatar_url: stringType,
      id: int64Type,
      active: boolType,
    });

    if (!extracted.active) {
      throw new Error("user account is not active");
    }

    const user = new AuthUser({
      id: String(extracted.id),
      name: extracted.full_name,
      username: extracted.login,
      avatarURL: extracted.avatar_url,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });

    try {
      user.email = await fetchVerifiedPrimaryEmail(this, token, this.userInfoURL + "/emails");
    } catch (err) {
      throw new Error(`failed to fetch primary email: ${(err as Error).message}`, { cause: err });
    }

    return user;
  }
}
