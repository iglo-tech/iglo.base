// Upstream: tools/auth/box.go

import { goQuote } from "@/fields/field";
import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { stringType } from "@/tools/types/go-json";

// Box allows authentication via Box OAuth2.
export class Box extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.scopes = ["root_readonly"];
    this.authURL = "https://account.box.com/api/oauth2/authorize";
    this.tokenURL = "https://api.box.com/oauth2/token";
    this.userInfoURL = "https://api.box.com/2.0/users/me";
  }

  // API reference: https://developer.box.com/reference/get-users-me/
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{
      id: string;
      name: string;
      login: string;
      avatar_url: string;
      status: string;
    }>(data, {
      id: stringType,
      name: stringType,
      login: stringType,
      avatar_url: stringType,
      status: stringType,
    });

    if (extracted.status !== "active") {
      throw new Error(`Box user account is not active (status: ${goQuote(extracted.status)})`);
    }

    return new AuthUser({
      id: extracted.id,
      name: extracted.name,
      avatarURL: extracted.avatar_url,
      email: extracted.login, // Box requires verified email for OAuth authorization
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });
  }
}
