// Upstream: tools/auth/facebook.go
//
// The endpoints are golang.org/x/oauth2/facebook's Endpoint.

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeNested, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { anyType, stringType } from "@/tools/types/go-json";

// Facebook allows authentication via Facebook OAuth2.
export class Facebook extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.scopes = ["email"];
    this.authURL = "https://www.facebook.com/v3.2/dialog/oauth";
    this.tokenURL = "https://graph.facebook.com/v3.2/oauth/access_token";
    this.userInfoURL = "https://graph.facebook.com/me?fields=name,email,picture.type(large)";
  }

  // API reference: https://developers.facebook.com/docs/graph-api/reference/user/
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{
      id: string;
      name: string;
      email: string;
      picture: unknown;
    }>(data, {
      id: stringType,
      name: stringType,
      email: stringType,
      picture: anyType,
    });
    const picture = decodeNested<{ data: unknown }>(extracted.picture, { data: anyType });
    const pictureData = decodeNested<{ url: string }>(picture.data, { url: stringType });

    return new AuthUser({
      id: extracted.id,
      name: extracted.name,
      email: extracted.email,
      avatarURL: pictureData.url,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });
  }
}
