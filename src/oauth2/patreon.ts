// Upstream: tools/auth/patreon.go
//
// The endpoints are golang.org/x/oauth2/endpoints' Patreon endpoint.

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeNested, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { anyType, boolType, stringType } from "@/tools/types/go-json";

// Patreon allows authentication via Patreon OAuth2.
export class Patreon extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.scopes = ["identity", "identity[email]"];
    this.authURL = "https://www.patreon.com/oauth2/authorize";
    this.tokenURL = "https://www.patreon.com/api/oauth2/token";
    this.userInfoURL =
      "https://www.patreon.com/api/oauth2/v2/identity?fields%5Buser%5D=full_name,email,vanity,image_url,is_email_verified";
  }

  // API reference:
  // https://docs.patreon.com/#get-api-oauth2-v2-identity
  // https://docs.patreon.com/#user-v2
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{ data: unknown }>(data, { data: anyType });
    const body = decodeNested<{ id: string; attributes: unknown }>(extracted.data, {
      id: stringType,
      attributes: anyType,
    });
    const attributes = decodeNested<{
      email: string;
      full_name: string;
      vanity: string;
      image_url: string;
      is_email_verified: boolean;
    }>(body.attributes, {
      email: stringType,
      full_name: stringType,
      vanity: stringType,
      image_url: stringType,
      is_email_verified: boolType,
    });

    const user = new AuthUser({
      id: body.id,
      username: attributes.vanity,
      name: attributes.full_name,
      avatarURL: attributes.image_url,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });

    if (attributes.is_email_verified) {
      user.email = attributes.email;
    }

    return user;
  }
}
