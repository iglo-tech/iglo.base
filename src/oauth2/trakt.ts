// Upstream: tools/auth/trakt.go

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeNested, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { anyType, stringType } from "@/tools/types/go-json";

// Trakt allows authentication via Trakt OAuth2.
export class Trakt extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.authURL = "https://trakt.tv/oauth/authorize";
    this.tokenURL = "https://api.trakt.tv/oauth/token";
    this.userInfoURL = "https://api.trakt.tv/users/settings";
  }

  // API reference: https://trakt.docs.apiary.io/#reference/users/settings/retrieve-settings
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{ user: unknown }>(data, { user: anyType });
    const user = decodeNested<{
      username: string;
      name: string;
      ids: unknown;
      images: unknown;
    }>(extracted.user, {
      username: stringType,
      name: stringType,
      ids: anyType,
      images: anyType,
    });
    const ids = decodeNested<{ slug: string; uuid: string }>(user.ids, {
      slug: stringType,
      uuid: stringType,
    });
    const images = decodeNested<{ avatar: unknown }>(user.images, { avatar: anyType });
    const avatar = decodeNested<{ full: string }>(images.avatar, { full: stringType });

    return new AuthUser({
      id: ids.uuid,
      username: user.username,
      name: user.name,
      avatarURL: avatar.full,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });
  }

  // Trakt requires a number of mandatory headers for all requests
  // (https://trakt.docs.apiary.io/#introduction/required-headers).
  override fetchRawUserInfo(token: Token): Promise<Uint8Array> {
    return this.sendRawUserInfoRequest(
      this.userInfoURL,
      {
        headers: {
          "Content-type": "application/json",
          "trakt-api-key": this.clientId,
          "trakt-api-version": "2",
        },
      },
      token,
    );
  }
}
