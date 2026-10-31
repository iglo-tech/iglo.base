// Upstream: tools/auth/strava.go

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { int64Type, stringType } from "@/tools/types/go-json";

// Strava allows authentication via Strava OAuth2.
export class Strava extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.scopes = ["profile:read_all"];
    this.authURL = "https://www.strava.com/oauth/authorize";
    this.tokenURL = "https://www.strava.com/api/v3/oauth/token";
    this.userInfoURL = "https://www.strava.com/api/v3/athlete";
  }

  // API reference: https://developers.strava.com/docs/authentication/
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    // Strava OAuth2 doesn't return the user email address
    const extracted = decodeFields<{
      id: number;
      firstname: string;
      lastname: string;
      username: string;
      profile: string;
    }>(data, {
      id: int64Type,
      firstname: stringType,
      lastname: stringType,
      username: stringType,
      profile: stringType,
    });

    const user = new AuthUser({
      name: extracted.firstname + " " + extracted.lastname,
      username: extracted.username,
      avatarURL: extracted.profile,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });

    // a zero id is no id
    if (BigInt(extracted.id) !== 0n) {
      user.id = String(extracted.id);
    }

    return user;
  }
}
