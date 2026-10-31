// Upstream: tools/auth/twitch.go
//
// The endpoints are golang.org/x/oauth2/twitch's Endpoint.

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeNestedList, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { anyType, stringType } from "@/tools/types/go-json";

// Twitch allows authentication via Twitch OAuth2.
export class Twitch extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.scopes = ["user:read:email"];
    this.authURL = "https://id.twitch.tv/oauth2/authorize";
    this.tokenURL = "https://id.twitch.tv/oauth2/token";
    this.userInfoURL = "https://api.twitch.tv/helix/users";
  }

  // API reference: https://dev.twitch.tv/docs/api/reference#get-users
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{ data: unknown }>(data, { data: anyType });
    const users = decodeNestedList<{
      id: string;
      login: string;
      display_name: string;
      email: string;
      profile_image_url: string;
    }>(extracted.data, {
      id: stringType,
      login: stringType,
      display_name: stringType,
      email: stringType,
      profile_image_url: stringType,
    });

    const first = users[0];
    if (first === undefined) {
      throw new Error("failed to fetch AuthUser data");
    }

    return new AuthUser({
      id: first.id,
      name: first.display_name,
      username: first.login,
      email: first.email,
      avatarURL: first.profile_image_url,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });
  }

  // Twitch requires the Client-Id header.
  override fetchRawUserInfo(token: Token): Promise<Uint8Array> {
    return this.sendRawUserInfoRequest(
      this.userInfoURL,
      { headers: { "Client-Id": this.clientId } },
      token,
    );
  }
}
