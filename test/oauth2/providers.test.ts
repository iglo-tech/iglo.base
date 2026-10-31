// Upstream: tools/auth/auth_test.go (TestProvidersCount, TestNewProviderByName)
// and the constructors' defaults of tools/auth/*.go: each ported provider
// is its class, with the endpoints and scopes of its constructor.

import { describe, expect, test } from "bun:test";

import { OAuth2ProviderConfig } from "@/collections/collection-model-auth-options";
import { Apple } from "@/oauth2/apple";
import { Bitbucket } from "@/oauth2/bitbucket";
import type { BaseProvider } from "@/oauth2/base-provider";
import { Box } from "@/oauth2/box";
import { Discord } from "@/oauth2/discord";
import { Facebook } from "@/oauth2/facebook";
import { Gitea } from "@/oauth2/gitea";
import { Gitee } from "@/oauth2/gitee";
import { Github } from "@/oauth2/github";
import { Gitlab } from "@/oauth2/gitlab";
import { Google } from "@/oauth2/google";
import { Instagram } from "@/oauth2/instagram";
import { Kakao } from "@/oauth2/kakao";
import { Lark } from "@/oauth2/lark";
import { Linear } from "@/oauth2/linear";
import { Livechat } from "@/oauth2/livechat";
import { OIDC } from "@/oauth2/oidc";
import { initProvider, initSignInProvider } from "@/oauth2/providers";
import { isProviderName } from "@/oauth2/provider-names";

// upstream's auth.Providers: 32 names
const upstreamNames = [
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

// the constructor's defaults of each provider M4.6 ports: the endpoints,
// scopes and PKCE flag upstream sets
interface Defaults {
  authURL: string;
  tokenURL: string;
  userInfoURL?: string;
  scopes: string[];
  pkce: boolean;
}

const defaults: [string, new () => BaseProvider, Defaults][] = [
  [
    "apple",
    Apple,
    {
      authURL: "https://appleid.apple.com/auth/authorize",
      tokenURL: "https://appleid.apple.com/auth/token",
      userInfoURL: "",
      scopes: ["name", "email"],
      pkce: true,
    },
  ],
  [
    "bitbucket",
    Bitbucket,
    {
      authURL: "https://bitbucket.org/site/oauth2/authorize",
      tokenURL: "https://bitbucket.org/site/oauth2/access_token",
      userInfoURL: "https://api.bitbucket.org/2.0/user",
      scopes: ["account"],
      pkce: false,
    },
  ],
  [
    "box",
    Box,
    {
      authURL: "https://account.box.com/api/oauth2/authorize",
      tokenURL: "https://api.box.com/oauth2/token",
      userInfoURL: "https://api.box.com/2.0/users/me",
      scopes: ["root_readonly"],
      pkce: true,
    },
  ],
  [
    "discord",
    Discord,
    {
      authURL: "https://discord.com/api/oauth2/authorize",
      tokenURL: "https://discord.com/api/oauth2/token",
      userInfoURL: "https://discord.com/api/users/@me",
      scopes: ["identify", "email"],
      pkce: true,
    },
  ],
  [
    "facebook",
    Facebook,
    {
      authURL: "https://www.facebook.com/v3.2/dialog/oauth",
      tokenURL: "https://graph.facebook.com/v3.2/oauth/access_token",
      userInfoURL: "https://graph.facebook.com/me?fields=name,email,picture.type(large)",
      scopes: ["email"],
      pkce: true,
    },
  ],
  [
    "gitea",
    Gitea,
    {
      authURL: "https://gitea.com/login/oauth/authorize",
      tokenURL: "https://gitea.com/login/oauth/access_token",
      userInfoURL: "https://gitea.com/api/v1/user",
      scopes: ["read:user", "user:email"],
      pkce: true,
    },
  ],
  [
    "gitee",
    Gitee,
    {
      authURL: "https://gitee.com/oauth/authorize",
      tokenURL: "https://gitee.com/oauth/token",
      userInfoURL: "https://gitee.com/api/v5/user",
      scopes: ["user_info", "emails"],
      pkce: true,
    },
  ],
  [
    "github",
    Github,
    {
      authURL: "https://github.com/login/oauth/authorize",
      tokenURL: "https://github.com/login/oauth/access_token",
      userInfoURL: "https://api.github.com/user",
      scopes: ["read:user", "user:email"],
      pkce: true,
    },
  ],
  [
    "gitlab",
    Gitlab,
    {
      authURL: "https://gitlab.com/oauth/authorize",
      tokenURL: "https://gitlab.com/oauth/token",
      userInfoURL: "https://gitlab.com/api/v4/user",
      scopes: ["read_user"],
      pkce: true,
    },
  ],
  [
    "google",
    Google,
    {
      authURL: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenURL: "https://oauth2.googleapis.com/token",
      userInfoURL: "https://www.googleapis.com/oauth2/v3/userinfo",
      scopes: [
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
      pkce: true,
    },
  ],
  [
    "instagram2",
    Instagram,
    {
      authURL: "https://www.instagram.com/oauth/authorize",
      tokenURL: "https://api.instagram.com/oauth/access_token",
      userInfoURL:
        "https://graph.instagram.com/me?fields=id,username,account_type,user_id,name,profile_picture_url,followers_count,follows_count,media_count",
      scopes: ["instagram_business_basic"],
      pkce: true,
    },
  ],
  [
    "kakao",
    Kakao,
    {
      authURL: "https://kauth.kakao.com/oauth/authorize",
      tokenURL: "https://kauth.kakao.com/oauth/token",
      userInfoURL: "https://kapi.kakao.com/v2/user/me",
      scopes: ["account_email", "profile_nickname", "profile_image"],
      pkce: true,
    },
  ],
  [
    "lark",
    Lark,
    {
      authURL: "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
      tokenURL: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
      userInfoURL: "https://open.feishu.cn/open-apis/authen/v1/user_info",
      scopes: [],
      pkce: true,
    },
  ],
  [
    "linear",
    Linear,
    {
      authURL: "https://linear.app/oauth/authorize",
      tokenURL: "https://api.linear.app/oauth/token",
      userInfoURL: "https://api.linear.app/graphql",
      scopes: ["read"],
      pkce: false,
    },
  ],
  [
    "livechat",
    Livechat,
    {
      authURL: "https://accounts.livechat.com/",
      tokenURL: "https://accounts.livechat.com/token",
      userInfoURL: "https://accounts.livechat.com/v2/accounts/me",
      scopes: [],
      pkce: true,
    },
  ],
];

const classes: [string, new () => BaseProvider][] = defaults.map(([name, cls]) => [name, cls]);

describe("provider names", () => {
  test("upstream registers 32 providers", () => {
    expect(upstreamNames).toHaveLength(32);
    for (const name of upstreamNames) {
      expect(isProviderName(name)).toBe(true);
    }
    expect(isProviderName("Google")).toBe(false);
    expect(isProviderName("invalid")).toBe(false);
  });
});

describe("NewProviderByName", () => {
  for (const [name, cls] of classes) {
    test(name, () => {
      expect(initProvider(new OAuth2ProviderConfig({ name }))).toBeInstanceOf(cls);
    });
  }

  for (const name of ["oidc", "oidc2", "oidc3"]) {
    test(name, () => {
      expect(initProvider(new OAuth2ProviderConfig({ name }))).toBeInstanceOf(OIDC);
    });
  }

  test("an invalid name", () => {
    expect(() => initProvider(new OAuth2ProviderConfig({ name: "invalid" }))).toThrow();
  });
});

describe("constructor defaults", () => {
  for (const [name, , expected] of defaults) {
    test(name, () => {
      const p = initProvider(new OAuth2ProviderConfig({ name }));
      expect({
        authURL: p.authURL,
        tokenURL: p.tokenURL,
        userInfoURL: p.userInfoURL,
        scopes: p.scopes,
        pkce: p.pkce,
      }).toEqual({
        authURL: expected.authURL,
        tokenURL: expected.tokenURL,
        userInfoURL: expected.userInfoURL ?? "",
        scopes: expected.scopes,
        pkce: expected.pkce,
      });
    });
  }
});

describe("sign-in of the ported providers", () => {
  for (const [name] of classes) {
    test(`${name} is ported`, () => {
      expect(() => initSignInProvider(new OAuth2ProviderConfig({ name }))).not.toThrow();
    });
  }

  test("an M4.7 provider is not ported yet", () => {
    expect(() => initSignInProvider(new OAuth2ProviderConfig({ name: "microsoft" }))).toThrow(
      "not ported yet",
    );
  });
});
