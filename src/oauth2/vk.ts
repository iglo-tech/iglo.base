// Upstream: tools/auth/vk.go
//
// The endpoints are golang.org/x/oauth2/vk's Endpoint.

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeNestedList, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { toString } from "@/tools/types/cast";
import { anyType, int64Type, stringType } from "@/tools/types/go-json";

// VK allows authentication via VK OAuth2.
//
// @todo mark as deprecated
export class VK extends BaseProvider {
  constructor() {
    super();
    this.pkce = false; // VK currently doesn't support PKCE and throws an error if PKCE params are send
    this.scopes = ["email"];
    this.authURL = "https://oauth.vk.com/authorize";
    this.tokenURL = "https://oauth.vk.com/access_token";
    this.userInfoURL = "https://api.vk.com/method/users.get?fields=photo_max,screen_name&v=5.131";
  }

  // API reference: https://dev.vk.com/method/users.get
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{ response: unknown }>(data, { response: anyType });
    const entries = decodeNestedList<{
      id: number;
      first_name: string;
      last_name: string;
      screen_name: string;
      photo_max: string;
    }>(extracted.response, {
      id: int64Type,
      first_name: stringType,
      last_name: stringType,
      screen_name: stringType,
      photo_max: stringType,
    });

    const first = entries[0];
    if (first === undefined) {
      throw new Error("missing response entry");
    }

    const user = new AuthUser({
      id: String(first.id),
      name: `${first.first_name} ${first.last_name}`.trim(),
      username: first.screen_name,
      avatarURL: first.photo_max,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });

    // the email comes with the token response, not the user api
    const email = token.extra("email");
    if (email !== null && email !== undefined) {
      user.email = toString(email);
    }

    return user;
  }
}
