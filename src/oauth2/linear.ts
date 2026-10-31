// Upstream: tools/auth/linear.go

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeNested, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { anyType, boolType, stringType } from "@/tools/types/go-json";

// the GraphQL query of Linear's viewer, sent as upstream sends it
const viewerQuery =
  '{"query": "query Me { viewer { id displayName name email avatarUrl active } }"}';

// Linear allows authentication via Linear OAuth2.
//
// API reference: https://developers.linear.app/docs/oauth/authentication
export class Linear extends BaseProvider {
  constructor() {
    super();
    this.pkce = false; // Linear doesn't support PKCE at the moment and returns an error if enabled
    this.scopes = ["read"];
    this.authURL = "https://linear.app/oauth/authorize";
    this.tokenURL = "https://api.linear.app/oauth/token";
    this.userInfoURL = "https://api.linear.app/graphql";
  }

  // API reference: https://developers.linear.app/docs/graphql/working-with-the-graphql-api#authentication
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{ data: unknown }>(data, { data: anyType });
    const body = decodeNested<{ viewer: unknown }>(extracted.data, { viewer: anyType });
    const viewer = decodeNested<{
      id: string;
      displayName: string;
      name: string;
      email: string;
      avatarUrl: string;
      active: boolean;
    }>(body.viewer, {
      id: stringType,
      displayName: stringType,
      name: stringType,
      email: stringType,
      avatarUrl: stringType,
      active: boolType,
    });

    if (!viewer.active) {
      throw new Error("the Linear user account is not active");
    }

    return new AuthUser({
      id: viewer.id,
      name: viewer.name,
      username: viewer.displayName,
      email: viewer.email,
      avatarURL: viewer.avatarUrl,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });
  }

  // Linear doesn't have a UserInfo endpoint and information on the user
  // is retrieved using their GraphQL API (https://developers.linear.app/docs/graphql/working-with-the-graphql-api#queries-and-mutations)
  override fetchRawUserInfo(token: Token): Promise<Uint8Array> {
    return this.sendRawUserInfoRequest(
      this.userInfoURL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: viewerQuery,
      },
      token,
    );
  }
}
