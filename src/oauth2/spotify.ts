// Upstream: tools/auth/spotify.go
//
// The endpoints are golang.org/x/oauth2/spotify's Endpoint.

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeNestedList, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { anyType, stringType } from "@/tools/types/go-json";

// Spotify allows authentication via Spotify OAuth2.
export class Spotify extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    // currently Spotify doesn't return information whether the email is verified or not
    this.scopes = ["user-read-private"];
    this.authURL = "https://accounts.spotify.com/authorize";
    this.tokenURL = "https://accounts.spotify.com/api/token";
    this.userInfoURL = "https://api.spotify.com/v1/me";
  }

  // API reference: https://developer.spotify.com/documentation/web-api/reference/#/operations/get-current-users-profile
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    // the email is not mapped because per the official docs the email field
    // is "unverified" and there is no proof that it actually belongs to the user
    const extracted = decodeFields<{ id: string; display_name: string; images: unknown }>(data, {
      id: stringType,
      display_name: stringType,
      images: anyType,
    });
    const images = decodeNestedList<{ url: string }>(extracted.images, { url: stringType });

    const user = new AuthUser({
      id: extracted.id,
      name: extracted.display_name,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });

    if (images.length > 0) {
      user.avatarURL = images[0]?.url ?? "";
    }

    return user;
  }
}
