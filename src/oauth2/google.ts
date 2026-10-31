// Upstream: tools/auth/google.go

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { boolType, stringType } from "@/tools/types/go-json";

// Google allows authentication via Google OAuth2.
export class Google extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.scopes = [
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/userinfo.email",
    ];
    this.authURL = "https://accounts.google.com/o/oauth2/v2/auth";
    this.tokenURL = "https://oauth2.googleapis.com/token";
    this.userInfoURL = "https://www.googleapis.com/oauth2/v3/userinfo";
  }

  // FetchAuthUser returns an AuthUser instance based the Google's user api.
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{
      sub: string;
      name: string;
      picture: string;
      email: string;
      email_verified: boolean;
    }>(data, {
      sub: stringType,
      name: stringType,
      picture: stringType,
      email: stringType,
      email_verified: boolType,
    });

    const user = new AuthUser({
      id: extracted.sub,
      name: extracted.name,
      avatarURL: extracted.picture,
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
