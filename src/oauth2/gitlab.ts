// Upstream: tools/auth/gitlab.go

import { AuthUser, BaseProvider, expiryOf } from "@/oauth2/base-provider";
import { decodeFields, decodeRawUser } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { int64Type, stringType } from "@/tools/types/go-json";
import { parse, type ParsedTime } from "@/tools/types/go-time";

// Gitlab allows authentication via Gitlab OAuth2.
export class Gitlab extends BaseProvider {
  constructor() {
    super();
    this.pkce = true;
    this.scopes = ["read_user"];
    this.authURL = "https://gitlab.com/oauth/authorize";
    this.tokenURL = "https://gitlab.com/oauth/token";
    this.userInfoURL = "https://gitlab.com/api/v4/user";
  }

  // API reference: https://docs.gitlab.com/api/users/#retrieve-the-current-user
  async fetchAuthUser(token: Token): Promise<AuthUser> {
    const data = await this.fetchRawUserInfo(token);

    const rawUser = decodeRawUser(data);

    const extracted = decodeFields<{
      name: string;
      username: string;
      email: string;
      avatar_url: string;
      confirmed_at: string;
      id: number;
    }>(data, {
      name: stringType,
      username: stringType,
      email: stringType,
      avatar_url: stringType,
      confirmed_at: stringType,
      id: int64Type,
    });

    const user = new AuthUser({
      id: String(extracted.id),
      name: extracted.name,
      username: extracted.username,
      avatarURL: extracted.avatar_url,
      rawUser,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: expiryOf(token),
    });

    if (isConfirmed(extracted.confirmed_at)) {
      user.email = extracted.email;
    }

    return user;
  }
}

// time.Parse(time.RFC3339, confirmedAt) succeeds and the time is not Go's
// zero time (the instant 0001-01-01 00:00:00 UTC)
function isConfirmed(confirmedAt: string): boolean {
  let t: ParsedTime;
  try {
    t = parse("2006-01-02T15:04:05Z07:00", confirmedAt);
  } catch {
    return false;
  }
  const zero =
    t.year === 1 &&
    t.month === 1 &&
    t.day === 1 &&
    t.hour === 0 &&
    t.min === 0 &&
    t.sec === 0 &&
    t.nsec === 0 &&
    (t.zoneOffset ?? 0) === 0;
  return !zero;
}
