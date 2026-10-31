// Upstream: tools/auth/bitbucket.go

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeNested, decodeNestedList, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { anyType, boolType, stringType } from "@/tools/types/go-json";

// Bitbucket is an auth provider for Bitbucket.
export class Bitbucket extends BaseProvider {
  constructor() {
    super();
    this.pkce = false;
    this.scopes = ["account"];
    this.authURL = "https://bitbucket.org/site/oauth2/authorize";
    this.tokenURL = "https://bitbucket.org/site/oauth2/access_token";
    this.userInfoURL = "https://api.bitbucket.org/2.0/user";
  }

  // API reference: https://developer.atlassian.com/cloud/bitbucket/rest/api-group-users/#api-user-get
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{
      uuid: string;
      username: string;
      display_name: string;
      account_status: string;
      links: unknown;
    }>(data, {
      uuid: stringType,
      username: stringType,
      display_name: stringType,
      account_status: stringType,
      links: anyType,
    });
    const avatar = decodeNested<{ avatar: unknown }>(extracted.links, { avatar: anyType });
    const avatarHref = decodeNested<{ href: string }>(avatar.avatar, { href: stringType });

    if (extracted.account_status !== "active") {
      throw new Error("the Bitbucket user is not active");
    }

    const email = await this.fetchPrimaryEmail(token);

    const user = new AuthUser({
      id: extracted.uuid,
      name: extracted.display_name,
      username: extracted.username,
      email,
      avatarURL: avatarHref.href,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });

    return user;
  }

  // fetchPrimaryEmail sends an API request to retrieve the first
  // verified primary email.
  //
  // NB! This method can succeed and still return an empty email.
  // Error responses that are result of insufficient scopes permissions are ignored.
  //
  // API reference: https://developer.atlassian.com/cloud/bitbucket/rest/api-group-users/#api-user-emails-get
  private async fetchPrimaryEmail(token: Token): Promise<string> {
    const res = await this.fetchWithToken(token, this.userInfoURL + "/emails");

    // ignore common http errors caused by insufficient scope permissions
    // (the email field is optional, aka. return the auth user without it)
    if (res.status >= 400) {
      await res.body?.cancel();
      return "";
    }

    const data = new Uint8Array(await res.arrayBuffer());

    const expected = decodeFields<{ values: unknown }>(data, { values: anyType });
    const values = decodeNestedList<{ email: string; is_primary: boolean; is_confirmed: boolean }>(
      expected.values,
      { email: stringType, is_primary: boolType, is_confirmed: boolType },
    );

    for (const v of values) {
      if (v.is_primary && v.is_confirmed) {
        return v.email;
      }
    }

    return "";
  }
}
