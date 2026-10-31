// The sign-in cases of the OAuth2 providers (src/oauth2/*.ts, one file per
// provider), each run through /auth-with-oauth2 on upstream PocketBase v0.41.0
// and on iglo.base against the local mock (test/support/oauth2-mock.ts). The
// users are realistic provider responses, and each case reaches one branch
// of its provider: the email branches, the mapping quirks, the errors.
//
// Apple's id_token is read from the token response and its JWKS is fixed in
// the code (no configuration reaches it), so the cases here fail before the
// signature check: the signature and the first-login name are checked
// in-process (test/oauth2/apple.test.ts). Gitee's emails lookup is fixed too,
// so its cases use a valid public email; the other providers' lookups go to
// the mock through userInfoURL.

import { generateKeyPairSync } from "node:crypto";

// one case of a provider
export interface ProviderCase {
  name: string;
  // the provider's name in the collection's configuration
  provider: string;
  // the token endpoint's answer (default: an access token)
  token?: unknown;
  // the userinfo endpoint's answer, or the Linear GraphQL answer
  user?: unknown;
  userStatus?: number;
  // the `/emails` lookup, where the provider has one
  emails?: unknown;
  emailsStatus?: number;
  // the extra config options of the provider (Microsoft's idTokenEmailClaim)
  extra?: { [key: string]: unknown };
  // the status of upstream's answer, which the case must reach
  status: number;
  // the email of the record upstream answers with, when the case reaches one
  email?: string;
}

const verifiedEmail = { email_verified: true };

const b64url = (value: string): string => Buffer.from(value).toString("base64url");

// an id_token with no valid signature: the Apple cases below stop before it
// is checked, as the claims are validated first
function idToken(claims: { [key: string]: unknown }): string {
  return [
    b64url(JSON.stringify({ alg: "RS256", kid: "apple-test-key" })),
    b64url(JSON.stringify(claims)),
    b64url("not a signature"),
  ].join(".");
}

const now = (): number => Math.floor(Date.now() / 1000);
const appleClaims = (overrides: { [key: string]: unknown } = {}): { [key: string]: unknown } => ({
  iss: "https://appleid.apple.com",
  aud: "123",
  sub: "001234.abcdef.0123",
  iat: now() - 10,
  exp: now() + 3600,
  email: "apple@example.com",
  ...verifiedEmail,
  ...overrides,
});

// the claims of a Microsoft id_token: its signature is not checked, only
// its times and the email claims
const msClaims = (overrides: { [key: string]: unknown } = {}): { [key: string]: unknown } => ({
  iat: now() - 10,
  exp: now() + 3600,
  ...overrides,
});

// a key pair for the Apple client secret cases of the settings endpoint
export function appleSecretPrivateKey(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

export const providerCases: ProviderCase[] = [
  // apple
  {
    name: "apple: a missing id_token",
    provider: "apple",
    token: { access_token: "abc", token_type: "bearer" },
    status: 400,
  },
  {
    name: "apple: an id_token from another issuer",
    provider: "apple",
    token: { access_token: "abc", id_token: idToken(appleClaims({ iss: "https://evil.example" })) },
    status: 400,
  },
  {
    name: "apple: an id_token for another audience",
    provider: "apple",
    token: { access_token: "abc", id_token: idToken(appleClaims({ aud: "other" })) },
    status: 400,
  },
  {
    name: "apple: an expired id_token",
    provider: "apple",
    token: { access_token: "abc", id_token: idToken(appleClaims({ exp: now() - 3600 })) },
    status: 400,
  },
  {
    name: "apple: an id_token without an expiration",
    provider: "apple",
    token: {
      access_token: "abc",
      id_token: idToken(appleClaims({ exp: undefined })),
    },
    status: 400,
  },

  // bitbucket
  {
    name: "bitbucket: the primary confirmed email",
    provider: "bitbucket",
    user: {
      uuid: "{5f3b8a2e-0c1d-4e2a-9d1f-8a7b6c5d4e3f}",
      username: "bb_user",
      display_name: "BB User",
      account_status: "active",
      links: { avatar: { href: "https://bitbucket.example/avatar.png" } },
    },
    emails: {
      values: [
        { email: "other@example.com", is_primary: false, is_confirmed: true },
        { email: "bb@example.com", is_primary: true, is_confirmed: true },
      ],
    },
    status: 200,
    email: "bb@example.com",
  },
  {
    name: "bitbucket: a primary email that is not confirmed",
    provider: "bitbucket",
    user: { uuid: "{1}", username: "bb", display_name: "BB", account_status: "active" },
    emails: { values: [{ email: "bb@example.com", is_primary: true, is_confirmed: false }] },
    status: 200,
    email: "",
  },
  {
    name: "bitbucket: the emails lookup is forbidden",
    provider: "bitbucket",
    user: { uuid: "{2}", username: "bb", display_name: "BB", account_status: "active" },
    emails: { error: "forbidden" },
    emailsStatus: 403,
    status: 200,
    email: "",
  },
  {
    name: "bitbucket: an inactive account",
    provider: "bitbucket",
    user: { uuid: "{3}", username: "bb", display_name: "BB", account_status: "deactivated" },
    status: 400,
  },

  // box
  {
    name: "box: the login is the email",
    provider: "box",
    user: {
      id: "11446498",
      name: "Box User",
      login: "box@example.com",
      avatar_url: "https://box.example/avatar.png",
      status: "active",
    },
    status: 200,
    email: "box@example.com",
  },
  {
    name: "box: an account that is not active",
    provider: "box",
    user: { id: "1", name: "Box", login: "box@example.com", status: "inactive" },
    status: 400,
  },

  // discord
  {
    name: "discord: a verified user with an avatar and a global name",
    provider: "discord",
    user: {
      id: "80351110224678912",
      username: "nelly",
      global_name: "Nelly",
      discriminator: "0",
      avatar: "8342729096ea3675442027381ff50dfe",
      email: "nelly@example.com",
      verified: true,
    },
    status: 200,
    email: "nelly@example.com",
  },
  {
    name: "discord: an unverified email",
    provider: "discord",
    user: {
      id: "80351110224678912",
      username: "nelly",
      global_name: "Nelly",
      discriminator: "0",
      avatar: "",
      email: "nelly@example.com",
      verified: false,
    },
    status: 200,
    email: "",
  },
  {
    name: "discord: a legacy username with a discriminator and no global name",
    provider: "discord",
    user: {
      id: "1",
      username: "legacy",
      global_name: "",
      discriminator: "1234",
      avatar: "",
      email: "legacy@example.com",
      verified: true,
    },
    status: 200,
    email: "legacy@example.com",
  },

  // facebook
  {
    name: "facebook: the picture and the email",
    provider: "facebook",
    user: {
      id: "10158",
      name: "Facebook User",
      email: "fb@example.com",
      picture: { data: { url: "https://facebook.example/picture.jpg", is_silhouette: false } },
    },
    status: 200,
    email: "fb@example.com",
  },
  {
    name: "facebook: no email",
    provider: "facebook",
    user: {
      id: "10159",
      name: "Facebook User",
      picture: { data: { url: "https://facebook.example/picture.jpg", is_silhouette: true } },
    },
    status: 200,
    email: "",
  },

  // gitea
  {
    name: "gitea: the verified primary email",
    provider: "gitea",
    user: {
      id: 1234,
      login: "gitea_user",
      full_name: "Gitea User",
      avatar_url: "https://gitea.example/avatar.png",
      active: true,
    },
    emails: [
      { email: "secondary@example.com", verified: true, primary: false },
      { email: "gitea@example.com", verified: true, primary: true },
    ],
    status: 200,
    email: "gitea@example.com",
  },
  {
    name: "gitea: an unverified primary email",
    provider: "gitea",
    user: { id: 1, login: "gitea", full_name: "Gitea", active: true },
    emails: [{ email: "gitea@example.com", verified: false, primary: true }],
    status: 200,
    email: "",
  },
  {
    name: "gitea: the emails lookup is not found",
    provider: "gitea",
    user: { id: 2, login: "gitea", full_name: "Gitea", active: true },
    emails: { message: "not found" },
    emailsStatus: 404,
    status: 200,
    email: "",
  },
  {
    name: "gitea: the emails lookup fails",
    provider: "gitea",
    user: { id: 3, login: "gitea", full_name: "Gitea", active: true },
    emails: "internal error",
    emailsStatus: 500,
    status: 400,
  },
  {
    name: "gitea: an account that is not active",
    provider: "gitea",
    user: { id: 4, login: "gitea", full_name: "Gitea", active: false },
    status: 400,
  },

  // gitee (the public email is valid, so the hard-coded emails lookup is not reached)
  {
    name: "gitee: a valid public email",
    provider: "gitee",
    user: {
      login: "gitee_user",
      name: "Gitee User",
      email: "gitee@example.com",
      avatar_url: "https://gitee.example/avatar.png",
      id: 99,
    },
    status: 200,
    email: "gitee@example.com",
  },

  // github
  {
    name: "github: the verified primary email",
    provider: "github",
    user: {
      id: 1,
      login: "octocat",
      name: "The Octocat",
      avatar_url: "https://github.example/octocat.png",
    },
    emails: [
      { email: "secondary@example.com", verified: true, primary: false },
      { email: "octocat@example.com", verified: true, primary: true },
    ],
    status: 200,
    email: "octocat@example.com",
  },
  {
    name: "github: an unverified primary email",
    provider: "github",
    user: { id: 2, login: "octo", name: "Octo" },
    emails: [{ email: "octo@example.com", verified: false, primary: true }],
    status: 200,
    email: "",
  },
  {
    name: "github: the token lacks the email scope",
    provider: "github",
    user: { id: 3, login: "octo", name: "Octo" },
    emails: { message: "Resource not accessible by integration" },
    emailsStatus: 401,
    status: 200,
    email: "",
  },
  {
    name: "github: an emails lookup that is not a list",
    provider: "github",
    user: { id: 4, login: "octo", name: "Octo" },
    emails: { email: "octo@example.com" },
    status: 400,
  },

  // gitlab
  {
    name: "gitlab: a confirmed account",
    provider: "gitlab",
    user: {
      id: 5,
      username: "gitlab_user",
      name: "GitLab User",
      email: "gitlab@example.com",
      avatar_url: "https://gitlab.example/avatar.png",
      confirmed_at: "2024-05-01T10:00:00.000Z",
    },
    status: 200,
    email: "gitlab@example.com",
  },
  {
    name: "gitlab: a confirmation with an offset",
    provider: "gitlab",
    user: {
      id: 6,
      username: "gitlab_user",
      name: "GitLab User",
      email: "offset@example.com",
      confirmed_at: "2024-05-01T10:00:00+02:00",
    },
    status: 200,
    email: "offset@example.com",
  },
  {
    name: "gitlab: an unconfirmed account",
    provider: "gitlab",
    user: { id: 7, username: "gitlab_user", email: "gitlab@example.com", confirmed_at: null },
    status: 200,
    email: "",
  },
  {
    name: "gitlab: a confirmation time that is Go's zero time",
    provider: "gitlab",
    user: {
      id: 8,
      username: "gitlab_user",
      email: "zero@example.com",
      confirmed_at: "0001-01-01T00:00:00Z",
    },
    status: 200,
    email: "",
  },
  {
    name: "gitlab: a confirmation time that is not RFC 3339",
    provider: "gitlab",
    user: {
      id: 9,
      username: "gitlab_user",
      email: "bad@example.com",
      confirmed_at: "yesterday",
    },
    status: 200,
    email: "",
  },

  // google
  {
    name: "google: a verified email",
    provider: "google",
    user: {
      sub: "109876543210",
      name: "Google User",
      picture: "https://google.example/picture.png",
      email: "google@example.com",
      ...verifiedEmail,
    },
    status: 200,
    email: "google@example.com",
  },
  {
    name: "google: an unverified email",
    provider: "google",
    user: {
      sub: "109876543211",
      name: "Google User",
      email: "google@example.com",
      email_verified: false,
    },
    status: 200,
    email: "",
  },
  {
    name: `google: email_verified as the string "true"`,
    provider: "google",
    user: {
      sub: "109876543212",
      name: "Google User",
      email: "google@example.com",
      email_verified: "true",
    },
    status: 400,
  },
  {
    name: "google: a numeric sub",
    provider: "google",
    user: { sub: 109876543213, name: "Google User", email: "google@example.com", ...verifiedEmail },
    status: 400,
  },

  // instagram (registered as instagram2)
  {
    name: "instagram2: permissions from the token when the user has none",
    provider: "instagram2",
    token: {
      access_token: "abc",
      token_type: "bearer",
      permissions: ["instagram_business_basic"],
    },
    user: {
      user_id: "17841400000000001",
      username: "ig_user",
      name: "IG User",
      profile_picture_url: "https://instagram.example/picture.jpg",
      account_type: "BUSINESS",
    },
    status: 200,
  },
  {
    name: "instagram2: the user's own permissions win over the token's",
    provider: "instagram2",
    token: { access_token: "abc", token_type: "bearer", permissions: ["from_token"] },
    user: {
      user_id: "17841400000000002",
      username: "ig_user",
      name: "IG User",
      permissions: ["from_user"],
    },
    status: 200,
  },

  // kakao
  {
    name: "kakao: a valid and verified email",
    provider: "kakao",
    user: {
      id: 1234567890,
      properties: { nickname: "kakao_nick", profile_image: "https://kakao.example/profile.png" },
      kakao_account: { email: "kakao@example.com", is_email_valid: true, is_email_verified: true },
    },
    status: 200,
    email: "kakao@example.com",
  },
  {
    name: "kakao: a valid email that is not verified",
    provider: "kakao",
    user: {
      id: 1234567891,
      properties: { nickname: "kakao_nick" },
      kakao_account: { email: "kakao@example.com", is_email_valid: true, is_email_verified: false },
    },
    status: 200,
    email: "",
  },
  {
    name: "kakao: no kakao_account",
    provider: "kakao",
    user: { id: 1234567892, properties: { nickname: "kakao_nick" } },
    status: 200,
    email: "",
  },

  // lark
  {
    name: "lark: the nested user data",
    provider: "lark",
    user: {
      code: 0,
      msg: "success",
      data: {
        union_id: "on_1234567890abcdef",
        name: "Lark User",
        avatar_url: "https://lark.example/avatar.png",
      },
    },
    status: 200,
  },
  {
    name: "lark: data that is not an object",
    provider: "lark",
    user: { code: 0, msg: "success", data: "not an object" },
    status: 400,
  },

  // linear
  {
    name: "linear: the viewer and its email",
    provider: "linear",
    user: {
      data: {
        viewer: {
          id: "lin_viewer_1",
          displayName: "linear_user",
          name: "Linear User",
          email: "linear@example.com",
          avatarUrl: "https://linear.example/avatar.png",
          active: true,
        },
      },
    },
    status: 200,
    email: "linear@example.com",
  },
  {
    name: "linear: an inactive viewer",
    provider: "linear",
    user: {
      data: {
        viewer: { id: "lin_viewer_2", displayName: "linear", name: "Linear", active: false },
      },
    },
    status: 400,
  },

  // livechat
  {
    name: "livechat: a verified email",
    provider: "livechat",
    user: {
      account_id: "lc_account_1",
      name: "LiveChat User",
      email: "livechat@example.com",
      email_verified: true,
      avatar_url: "https://livechat.example/avatar.png",
    },
    status: 200,
    email: "livechat@example.com",
  },
  {
    name: "livechat: an unverified email",
    provider: "livechat",
    user: {
      account_id: "lc_account_2",
      name: "LiveChat User",
      email: "livechat@example.com",
      email_verified: false,
    },
    status: 200,
    email: "",
  },

  // mailcow
  {
    name: "mailcow: an active user, whose username is an email address",
    provider: "mailcow",
    user: {
      id: "7",
      username: "jane@example.org",
      email: "jane@example.org",
      full_name: "Jane Doe",
      active: 1,
    },
    status: 200,
    email: "jane@example.org",
  },
  {
    name: "mailcow: an inactive user",
    provider: "mailcow",
    user: { id: "8", username: "bob", email: "bob@example.org", full_name: "Bob", active: 0 },
    status: 400,
  },

  // microsoft
  {
    name: "microsoft: the mail of the Graph user",
    provider: "microsoft",
    user: { id: "e1f2a3", displayName: "Jane Doe", mail: "jane@example.com" },
    status: 200,
    email: "jane@example.com",
  },
  {
    name: "microsoft: no mail",
    provider: "microsoft",
    user: { id: "e1f2a4", displayName: "Jane Doe", mail: null },
    status: 200,
    email: "",
  },
  {
    name: "microsoft: the verified primary email of the id_token",
    provider: "microsoft",
    extra: { idTokenEmailClaim: "verified_primary_email" },
    token: {
      access_token: "abc",
      token_type: "bearer",
      id_token: idToken(
        msClaims({ verified_primary_email: "jane@example.com", email: "other@example.com" }),
      ),
    },
    user: { id: "e1f2a5", displayName: "Jane Doe", mail: "jane@example.com" },
    status: 200,
    email: "jane@example.com",
  },
  {
    name: "microsoft: any_verified falls back to the xms_edov email",
    provider: "microsoft",
    extra: { idTokenEmailClaim: "any_verified" },
    token: {
      access_token: "abc",
      token_type: "bearer",
      id_token: idToken(msClaims({ xms_edov: true, email: "edov@example.com" })),
    },
    user: { id: "e1f2a6", displayName: "Jane Doe", mail: "" },
    status: 200,
    email: "edov@example.com",
  },
  {
    name: "microsoft: email_and_xms_edov without xms_edov is no email",
    provider: "microsoft",
    extra: { idTokenEmailClaim: "email_and_xms_edov" },
    token: {
      access_token: "abc",
      token_type: "bearer",
      id_token: idToken(msClaims({ xms_edov: false, email: "edov@example.com" })),
    },
    user: { id: "e1f2a7", displayName: "Jane Doe", mail: "jane@example.com" },
    status: 200,
    email: "",
  },
  {
    name: "microsoft: an expired id_token gives no email, not an error",
    provider: "microsoft",
    extra: { idTokenEmailClaim: "email" },
    token: {
      access_token: "abc",
      token_type: "bearer",
      id_token: idToken(msClaims({ email: "jane@example.com", exp: now() - 3600 })),
    },
    user: { id: "e1f2a8", displayName: "Jane Doe", mail: "jane@example.com" },
    status: 200,
    email: "",
  },
  {
    name: "microsoft: an email claim selected with no id_token",
    provider: "microsoft",
    extra: { idTokenEmailClaim: "email" },
    user: { id: "e1f2a9", displayName: "Jane Doe", mail: "jane@example.com" },
    status: 200,
    email: "",
  },

  // monday
  {
    name: "monday: a verified email of an enabled user",
    provider: "monday",
    user: {
      data: {
        me: {
          id: "10000001",
          enabled: true,
          name: "Monday User",
          email: "monday@example.com",
          is_verified: true,
          photo_small: "",
        },
      },
    },
    status: 200,
    email: "monday@example.com",
  },
  {
    name: "monday: an unverified email",
    provider: "monday",
    user: {
      data: {
        me: {
          id: "10000002",
          enabled: true,
          name: "Monday User",
          email: "monday@example.com",
          is_verified: false,
          photo_small: "",
        },
      },
    },
    status: 200,
    email: "",
  },
  {
    name: "monday: a disabled user",
    provider: "monday",
    user: {
      data: { me: { id: "10000003", enabled: false, name: "Monday", is_verified: true } },
    },
    status: 400,
  },

  // notion
  {
    name: "notion: the owner of the bot, with its person email",
    provider: "notion",
    user: {
      avatar_url: "",
      bot: {
        owner: {
          type: "user",
          user: {
            avatar_url: "",
            id: "notion-user-1",
            name: "Notion User",
            person: { email: "notion@example.com" },
          },
        },
        workspace_name: "Workspace",
      },
      id: "bot-1",
      name: "Integration",
      object: "user",
      request_id: "req-1",
      type: "bot",
    },
    status: 200,
    email: "notion@example.com",
  },
  {
    name: "notion: an owner without a person",
    provider: "notion",
    user: {
      bot: {
        owner: { type: "user", user: { id: "notion-user-2", name: "Notion User" } },
      },
      id: "bot-2",
      object: "user",
      type: "bot",
    },
    status: 200,
    email: "",
  },

  // patreon
  {
    name: "patreon: a verified email",
    provider: "patreon",
    user: {
      data: {
        id: "9876",
        type: "user",
        attributes: {
          email: "patreon@example.com",
          full_name: "Patreon User",
          vanity: "patreon_vanity",
          image_url: "",
          is_email_verified: true,
        },
      },
    },
    status: 200,
    email: "patreon@example.com",
  },
  {
    name: "patreon: an unverified email",
    provider: "patreon",
    user: {
      data: {
        id: "9877",
        type: "user",
        attributes: {
          email: "patreon@example.com",
          full_name: "Patreon User",
          vanity: "patreon_vanity2",
          image_url: "",
          is_email_verified: false,
        },
      },
    },
    status: 200,
    email: "",
  },

  // planningcenter
  {
    // upstream's untagged Attributes field never matches "attributes" (json
    // v2 matches names case-sensitively), so even an active person is refused
    name: "planningcenter: an active person is refused, as its attributes never match",
    provider: "planningcenter",
    user: {
      data: {
        id: "42",
        type: "Person",
        attributes: { name: "Planning Person", status: "active", avatar: "" },
      },
    },
    status: 400,
  },
  {
    name: "planningcenter: an inactive person",
    provider: "planningcenter",
    user: {
      data: { id: "43", type: "Person", attributes: { name: "Inactive", status: "inactive" } },
    },
    status: 400,
  },

  // spotify
  {
    name: "spotify: a user without images, whose email is not mapped",
    provider: "spotify",
    user: {
      id: "spotify-1",
      display_name: "Spotify User",
      email: "spotify@example.com",
      images: [],
    },
    status: 200,
    email: "",
  },

  // strava
  {
    name: "strava: an athlete",
    provider: "strava",
    user: {
      id: 123456,
      firstname: "Strava",
      lastname: "Athlete",
      username: "strava_athlete",
      profile: "",
    },
    status: 200,
    email: "",
  },

  // trakt
  {
    name: "trakt: the user settings with the Trakt headers",
    provider: "trakt",
    user: {
      user: {
        username: "trakt_user",
        name: "Trakt User",
        ids: { slug: "trakt-user", uuid: "trakt-uuid-1" },
        images: { avatar: { full: "" } },
      },
    },
    status: 200,
    email: "",
  },

  // twitch
  {
    name: "twitch: the user with an email and the Client-Id header",
    provider: "twitch",
    user: {
      data: [
        {
          id: "141981764",
          login: "twitchuser",
          display_name: "TwitchUser",
          email: "twitch@example.com",
          profile_image_url: "",
        },
      ],
    },
    status: 200,
    email: "twitch@example.com",
  },
  {
    name: "twitch: no user in the data",
    provider: "twitch",
    user: { data: [] },
    status: 400,
  },

  // twitter
  {
    name: "twitter: a confirmed email",
    provider: "twitter",
    user: {
      data: {
        id: "2244994945",
        name: "X User",
        username: "xuser",
        confirmed_email: "x@example.com",
        profile_image_url: "",
      },
    },
    status: 200,
    email: "x@example.com",
  },
  {
    name: "twitter: no confirmed email",
    provider: "twitter",
    user: { data: { id: "2244994946", name: "X User", username: "xuser2" } },
    status: 200,
    email: "",
  },

  // vk
  {
    name: "vk: the email of the token response",
    provider: "vk",
    token: { access_token: "abc", token_type: "bearer", email: "vk@example.com" },
    user: {
      response: [
        {
          id: 210700286,
          first_name: "Pavel",
          last_name: "Durov",
          screen_name: "durov",
          photo_max: "",
        },
      ],
    },
    status: 200,
    email: "vk@example.com",
  },
  {
    name: "vk: no email in the token response",
    provider: "vk",
    user: {
      response: [{ id: 210700287, first_name: "Vk", last_name: "User", screen_name: "vk_user" }],
    },
    status: 200,
    email: "",
  },
  {
    name: "vk: an empty response",
    provider: "vk",
    user: { response: [] },
    status: 400,
  },

  // wakatime
  {
    name: "wakatime: a confirmed email",
    provider: "wakatime",
    user: {
      data: {
        id: "w-1",
        display_name: "Waka User",
        username: "waka_user",
        email: "waka@example.com",
        photo: "",
        photo_public: false,
        is_email_confirmed: true,
      },
    },
    status: 200,
    email: "waka@example.com",
  },
  {
    name: "wakatime: an unconfirmed email",
    provider: "wakatime",
    user: {
      data: {
        id: "w-2",
        display_name: "Waka User",
        username: "waka_user2",
        email: "waka@example.com",
        photo: "",
        photo_public: false,
        is_email_confirmed: false,
      },
    },
    status: 200,
    email: "",
  },

  // yandex: the avatar is not in these cases (the avatar host is fixed)
  {
    name: "yandex: the default email, with no avatar",
    provider: "yandex",
    user: {
      id: "1000000001",
      real_name: "Yandex User",
      login: "yandex_user",
      default_email: "yandex@example.com",
      is_avatar_empty: true,
      default_avatar_id: "0/0-0",
    },
    status: 200,
    email: "yandex@example.com",
  },
  {
    name: "yandex: no default email",
    provider: "yandex",
    user: {
      id: "1000000002",
      real_name: "Yandex User",
      login: "yandex_user2",
      default_email: "",
      is_avatar_empty: true,
    },
    status: 200,
    email: "",
  },
];

// the provider names of the collection configs of the auth methods cases
export const authMethodsProviders = [
  "apple",
  "bitbucket",
  "box",
  "discord",
  "facebook",
  "gitea",
  "gitee",
  "github",
  "gitlab",
  "google",
  "instagram2",
  "kakao",
  "lark",
  "linear",
  "livechat",
  "mailcow",
  "microsoft",
  "monday",
  "notion",
  "oidc",
  "oidc2",
  "oidc3",
  "patreon",
  "planningcenter",
  "spotify",
  "strava",
  "trakt",
  "twitch",
  "twitter",
  "vk",
  "wakatime",
  "yandex",
];
