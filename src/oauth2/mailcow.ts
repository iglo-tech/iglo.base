// Upstream: tools/auth/mailcow.go
//
// mailcow has no default endpoints: the collection's authURL, tokenURL and
// userInfoURL must name the mailcow instance.

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { intType, stringType } from "@/tools/types/go-json";

// Mailcow allows authentication via mailcow OAuth2.
export class Mailcow extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.scopes = ["profile"];
  }

  // API reference: https://github.com/mailcow/mailcow-dockerized/blob/master/data/web/oauth/profile.php
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{
      id: string;
      username: string;
      email: string;
      full_name: string;
      active: number;
    }>(data, {
      id: stringType,
      username: stringType,
      email: stringType,
      full_name: stringType,
      active: intType,
    });

    if (extracted.active !== 1) {
      throw new Error("the mailcow user is not active");
    }

    // mailcow usernames are usually just the email adresses, so we just take the part in front of the @
    let username = extracted.username;
    if (username.includes("@")) {
      username = username.split("@")[0] ?? "";
    }

    return new AuthUser({
      id: extracted.id,
      name: extracted.full_name,
      username,
      email: extracted.email,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });
  }
}
