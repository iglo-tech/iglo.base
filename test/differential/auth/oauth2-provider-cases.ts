// The sign-in cases of the M4.6 providers (src/oauth2/*.ts, one file per
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
];
