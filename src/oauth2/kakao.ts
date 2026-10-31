// Upstream: tools/auth/kakao.go
//
// The endpoints are golang.org/x/oauth2/kakao's Endpoint.

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeNested, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { anyType, boolType, int64Type, stringType } from "@/tools/types/go-json";

// Kakao allows authentication via Kakao OAuth2.
export class Kakao extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.scopes = ["account_email", "profile_nickname", "profile_image"];
    this.authURL = "https://kauth.kakao.com/oauth/authorize";
    this.tokenURL = "https://kauth.kakao.com/oauth/token";
    this.userInfoURL = "https://kapi.kakao.com/v2/user/me";
  }

  // API reference: https://developers.kakao.com/docs/latest/en/kakaologin/rest-api#req-user-info-response
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{
      properties: unknown;
      kakao_account: unknown;
      id: number;
    }>(data, {
      properties: anyType, // json:"properties"
      kakao_account: anyType,
      id: int64Type,
    });
    const profile = decodeNested<{ nickname: string; profile_image: string }>(
      extracted.properties,
      { nickname: stringType, profile_image: stringType },
    );
    const account = decodeNested<{
      email: string;
      is_email_verified: boolean;
      is_email_valid: boolean;
    }>(extracted.kakao_account, {
      email: stringType,
      is_email_verified: boolType,
      is_email_valid: boolType,
    });

    const user = new AuthUser({
      id: String(extracted.id),
      username: profile.nickname,
      avatarURL: profile.profile_image,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });

    if (account.is_email_valid && account.is_email_verified) {
      user.email = account.email;
    }

    return user;
  }
}
