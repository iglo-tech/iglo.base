// Upstream: tools/auth/planningcenter.go

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeNested, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { anyType, stringType } from "@/tools/types/go-json";

// Planning Center allows authentication via Planning Center OAuth2.
export class Planningcenter extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.scopes = ["people"];
    this.authURL = "https://api.planningcenteronline.com/oauth/authorize";
    this.tokenURL = "https://api.planningcenteronline.com/oauth/token";
    this.userInfoURL = "https://api.planningcenteronline.com/people/v2/me";
  }

  // API reference: https://developer.planning.center/docs/#/overview/authentication
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    // the email is not mapped: users can have multiple assigned and it's
    // not clear if they are verified
    const extracted = decodeFields<{ data: unknown }>(data, { data: anyType });
    // upstream's attributes member has no json tag, so it is matched by its
    // Go name, "Attributes", which json v2 matches case-sensitively: the
    // "attributes" member of the response is never read, and every user is
    // refused as not active
    const body = decodeNested<{ id: string; Attributes: unknown }>(extracted.data, {
      id: stringType,
      Attributes: anyType,
    });
    const attributes = decodeNested<{ status: string; name: string; avatar: string }>(
      body.Attributes,
      {
        status: stringType,
        name: stringType,
        avatar: stringType,
      },
    );

    if (attributes.status !== "active") {
      throw new Error("the user is not active");
    }

    return new AuthUser({
      id: body.id,
      name: attributes.name,
      avatarURL: attributes.avatar,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });
  }
}
