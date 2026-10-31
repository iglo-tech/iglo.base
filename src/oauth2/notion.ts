// Upstream: tools/auth/notion.go

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeNested, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { anyType, stringType } from "@/tools/types/go-json";

// Notion allows authentication via Notion OAuth2.
export class Notion extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.authURL = "https://api.notion.com/v1/oauth/authorize";
    this.tokenURL = "https://api.notion.com/v1/oauth/token";
    this.userInfoURL = "https://api.notion.com/v1/users/me";
  }

  // API reference: https://developers.notion.com/reference/get-self
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    // every member of upstream's struct is decoded, so a mistyped one fails
    // the same way, whether or not it is used
    const extracted = decodeFields<{
      avatar_url: string;
      bot: unknown;
      id: string;
      name: string;
      object: string;
      request_id: string;
      type: string;
    }>(data, {
      avatar_url: stringType,
      bot: anyType,
      id: stringType,
      name: stringType,
      object: stringType,
      request_id: stringType,
      type: stringType,
    });
    const bot = decodeNested<{ owner: unknown; workspace_name: string }>(extracted.bot, {
      owner: anyType,
      workspace_name: stringType,
    });
    const owner = decodeNested<{ type: string; user: unknown }>(bot.owner, {
      type: stringType,
      user: anyType,
    });
    const owned = decodeNested<{ avatar_url: string; id: string; name: string; person: unknown }>(
      owner.user,
      {
        avatar_url: stringType,
        id: stringType,
        name: stringType,
        person: anyType,
      },
    );
    const person = decodeNested<{ email: string }>(owned.person, { email: stringType });

    return new AuthUser({
      id: owned.id,
      name: owned.name,
      email: person.email,
      avatarURL: owned.avatar_url,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });
  }

  // Notion requires a version header for all requests
  // (https://developers.notion.com/reference/versioning).
  override fetchRawUserInfo(token: Token): Promise<Uint8Array> {
    return this.sendRawUserInfoRequest(
      this.userInfoURL,
      { headers: { "Notion-Version": "2022-06-28" } },
      token,
    );
  }
}
