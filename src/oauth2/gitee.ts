// Upstream: tools/auth/gitee.go
//
// The emails URL is hard-coded upstream: unlike the other providers' email
// lookups, it cannot be pointed at another host by the configuration.

import { EmailFormat } from "@/validation/is/rules";
import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeNestedList, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { anyType, int64Type, stringType, unmarshal } from "@/tools/types/go-json";

const emailsURL = "https://gitee.com/api/v5/emails";

// Gitee allows authentication via Gitee OAuth2.
export class Gitee extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.scopes = ["user_info", "emails"];
    this.authURL = "https://gitee.com/oauth/authorize";
    this.tokenURL = "https://gitee.com/oauth/token";
    this.userInfoURL = "https://gitee.com/api/v5/user";
  }

  // API reference: https://gitee.com/api/v5/swagger#/getV5User
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{
      login: string;
      name: string;
      email: string;
      avatar_url: string;
      id: number;
    }>(data, {
      login: stringType,
      name: stringType,
      email: stringType,
      avatar_url: stringType,
      id: int64Type,
    });

    const user = new AuthUser({
      id: String(extracted.id),
      name: extracted.name,
      username: extracted.login,
      avatarURL: extracted.avatar_url,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });

    if (extracted.email !== "" && EmailFormat.validate(extracted.email) === null) {
      // valid public primary email
      user.email = extracted.email;
    } else {
      // send an additional optional request to retrieve the email
      user.email = await this.fetchPrimaryEmail(token);
    }

    return user;
  }

  // fetchPrimaryEmail sends an API request to retrieve the verified primary email,
  // in case the user hasn't set "Public email address" or has unchecked
  // the "Access your emails data" permission during authentication.
  //
  // NB! This method can succeed and still return an empty email.
  // Error responses that are result of insufficient scopes permissions are ignored.
  //
  // API reference: https://gitee.com/api/v5/swagger#/getV5Emails
  private async fetchPrimaryEmail(token: Token): Promise<string> {
    const res = await this.fetchWithToken(token, emailsURL);

    // ignore common http errors caused by insufficient scope permissions
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      await res.body?.cancel();
      return "";
    }

    const content = new Uint8Array(await res.arrayBuffer());

    // ignore unmarshal error in case "Keep my email address private"
    // was set because response.Body will be something like:
    // {"email":"12285415+test@user.noreply.gitee.com"}
    let emails: { email: string; state: string; scope: string[] }[];
    try {
      emails = decodeNestedList<{ email: string; state: string; scope: unknown }>(
        unmarshal(content, anyType),
        { email: stringType, state: stringType, scope: anyType },
      ).map((item) => ({ ...item, scope: stringList(item.scope) }));
    } catch {
      return "";
    }

    // extract the first verified primary email
    for (const email of emails) {
      for (const scope of email.scope) {
        if (
          email.state === "confirmed" &&
          scope === "primary" &&
          EmailFormat.validate(email.email) === null
        ) {
          return email.email;
        }
      }
    }

    return "";
  }
}

// a Go []string decoded from JSON: null is nil, every element a string
function stringList(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("json: cannot unmarshal into Go []string");
  }
  return value as string[];
}
