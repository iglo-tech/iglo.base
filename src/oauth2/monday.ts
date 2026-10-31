// Upstream: tools/auth/monday.go

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeNested, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { anyType, boolType, stringType } from "@/tools/types/go-json";

// the GraphQL query of monday.com's me, sent as upstream sends it
const meQuery = '{"query": "query { me { id enabled name email is_verified photo_small }}"}';

// Monday is an auth provider for monday.com.
export class Monday extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.scopes = ["me:read"];
    this.authURL = "https://auth.monday.com/oauth2/authorize";
    this.tokenURL = "https://auth.monday.com/oauth2/token";
    this.userInfoURL = "https://api.monday.com/v2";
  }

  // API reference: https://developer.monday.com/api-reference/reference/me
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{ data: unknown }>(data, { data: anyType });
    const body = decodeNested<{ me: unknown }>(extracted.data, { me: anyType });
    const me = decodeNested<{
      id: string;
      enabled: boolean;
      name: string;
      email: string;
      is_verified: boolean;
      photo_small: string;
    }>(body.me, {
      id: stringType,
      enabled: boolType,
      name: stringType,
      email: stringType,
      is_verified: boolType,
      photo_small: stringType,
    });

    if (!me.enabled) {
      throw new Error("the monday.com user account is not enabled");
    }

    const user = new AuthUser({
      id: me.id,
      name: me.name,
      avatarURL: me.photo_small,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });

    if (me.is_verified) {
      user.email = me.email;
    }

    return user;
  }

  // monday.com doesn't have a UserInfo endpoint and information on the user
  // is retrieved using their GraphQL API (https://developer.monday.com/api-reference/reference/me#queries)
  override fetchRawUserInfo(token: Token): Promise<Uint8Array> {
    return this.sendRawUserInfoRequest(
      this.userInfoURL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: meQuery,
      },
      token,
    );
  }
}
