// Upstream: tools/auth/livechat.go

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { boolType, stringType } from "@/tools/types/go-json";

// Livechat allows authentication via Livechat OAuth2.
export class Livechat extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.scopes = []; // default scopes are specified from the provider dashboard
    this.authURL = "https://accounts.livechat.com/";
    this.tokenURL = "https://accounts.livechat.com/token";
    this.userInfoURL = "https://accounts.livechat.com/v2/accounts/me";
  }

  // API reference: https://developers.livechat.com/docs/authorization
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{
      account_id: string;
      name: string;
      email: string;
      email_verified: boolean;
      avatar_url: string;
    }>(data, {
      account_id: stringType,
      name: stringType,
      email: stringType,
      email_verified: boolType,
      avatar_url: stringType,
    });

    const user = new AuthUser({
      id: extracted.account_id,
      name: extracted.name,
      avatarURL: extracted.avatar_url,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });

    if (extracted.email_verified) {
      user.email = extracted.email;
    }

    return user;
  }
}
