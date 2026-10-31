// Upstream: tools/auth/lark.go
//
// Lark has two domains with the same API: feishu.cn and larksuite.com. The
// former is used in China and the latter in the other regions. feishu.cn is
// the default, matching Lark's official SDK.

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeNested, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { anyType, stringType } from "@/tools/types/go-json";

// Lark allows authentication via Lark OAuth2.
export class Lark extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.authURL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
    this.tokenURL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
    this.userInfoURL = "https://open.feishu.cn/open-apis/authen/v1/user_info";
  }

  // API reference: https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{ data: unknown }>(data, { data: anyType });
    // https://open.feishu.cn/document/platform-overveiw/basic-concepts/user-identity-introduction/introduction#3f2d4b63
    const info = decodeNested<{ union_id: string; name: string; avatar_url: string }>(
      extracted.data,
      { union_id: stringType, name: stringType, avatar_url: stringType },
    );

    return new AuthUser({
      id: info.union_id,
      name: info.name,
      avatarURL: info.avatar_url,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });
  }
}
