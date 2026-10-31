// Upstream: tools/auth/github.go
//
// The endpoints are golang.org/x/oauth2/github's Endpoint.

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { fetchVerifiedPrimaryEmail } from "@/oauth2/emails";
import { decodeFields, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { int64Type, stringType } from "@/tools/types/go-json";

// Github allows authentication via Github OAuth2.
export class Github extends BaseProvider {
  constructor() {
    super();
    this.pkce = true; // technically is not supported yet but it is safe as the PKCE params are just ignored
    this.scopes = ["read:user", "user:email"];
    this.authURL = "https://github.com/login/oauth/authorize";
    this.tokenURL = "https://github.com/login/oauth/access_token";
    this.userInfoURL = "https://api.github.com/user";
  }

  // API reference: https://docs.github.com/en/rest/users/users?apiVersion=2026-03-10#get-the-authenticated-user
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{
      name: string;
      login: string;
      avatar_url: string;
      id: number;
    }>(data, {
      name: stringType,
      login: stringType,
      avatar_url: stringType,
      id: int64Type,
    });

    const user = new AuthUser({
      id: String(extracted.id),
      name: extracted.name,
      username: extracted.login,
      avatarURL: extracted.avatar_url,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });

    // always send a primary email request even though the email is
    // returned in the userinfo endpoint since the API may change and
    // enterprise setups may have configuration that could allow unverified emails
    user.email = await fetchVerifiedPrimaryEmail(this, token, this.userInfoURL + "/emails");

    return user;
  }
}
