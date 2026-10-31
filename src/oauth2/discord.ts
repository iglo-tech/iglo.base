// Upstream: tools/auth/discord.go
//
// https://discord.com/developers/docs/topics/oauth2
// https://discord.com/developers/docs/resources/user#get-current-user

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { boolType, stringType } from "@/tools/types/go-json";

// Discord allows authentication via Discord OAuth2.
export class Discord extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.scopes = ["identify", "email"];
    this.authURL = "https://discord.com/api/oauth2/authorize";
    this.tokenURL = "https://discord.com/api/oauth2/token";
    this.userInfoURL = "https://discord.com/api/users/@me";
  }

  // API reference: https://discord.com/developers/docs/resources/user#user-object
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{
      id: string;
      global_name: string;
      username: string;
      discriminator: string;
      avatar: string;
      email: string;
      verified: boolean;
    }>(data, {
      id: stringType,
      global_name: stringType,
      username: stringType,
      discriminator: stringType,
      avatar: stringType,
      email: stringType,
      verified: boolType,
    });

    // build a full avatar URL using the avatar hash provided in the API response
    // https://discord.com/developers/docs/reference#image-formatting
    let avatarURL = "";
    if (extracted.avatar !== "") {
      avatarURL = `https://cdn.discordapp.com/avatars/${extracted.id}/${extracted.avatar}.png`;
    }

    let name = extracted.global_name;
    if (name === "") {
      // fallback to username+discriminator
      //
      // Note: Discord migrated to unique usernames without discriminators.
      // Legacy accounts still have a non-zero discriminator (e.g. "1234").
      // See https://support.discord.com/hc/en-us/articles/12620128861463-New-Usernames-Display-Names.
      name = extracted.username;
      if (extracted.discriminator !== "" && extracted.discriminator !== "0") {
        name += "#" + extracted.discriminator;
      }
    }

    const user = new AuthUser({
      id: extracted.id,
      name,
      username: extracted.username,
      avatarURL,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });

    if (extracted.verified) {
      user.email = extracted.email;
    }

    return user;
  }
}
