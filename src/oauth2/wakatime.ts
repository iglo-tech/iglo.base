// Upstream: tools/auth/wakatime.go

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeNested, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { anyType, boolType, stringType } from "@/tools/types/go-json";

// Wakatime is an auth provider for Wakatime.
export class Wakatime extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.scopes = ["email"];
    this.authURL = "https://wakatime.com/oauth/authorize";
    this.tokenURL = "https://wakatime.com/oauth/token";
    this.userInfoURL = "https://wakatime.com/api/v1/users/current";
  }

  // API reference: https://wakatime.com/developers#users
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{ data: unknown }>(data, { data: anyType });
    const user = decodeNested<{
      id: string;
      display_name: string;
      username: string;
      email: string;
      photo: string;
      photo_public: boolean;
      is_email_confirmed: boolean;
    }>(extracted.data, {
      id: stringType,
      display_name: stringType,
      username: stringType,
      email: stringType,
      photo: stringType,
      photo_public: boolType,
      is_email_confirmed: boolType,
    });

    const authUser = new AuthUser({
      id: user.id,
      name: user.display_name,
      username: user.username,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });

    // note: we don't check for is_email_public field because PocketBase
    // has its own emailVisibility flag which is false by default
    if (user.is_email_confirmed) {
      authUser.email = user.email;
    }

    if (user.photo_public) {
      authUser.avatarURL = user.photo;
    }

    return authUser;
  }
}
