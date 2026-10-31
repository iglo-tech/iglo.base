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
import { Mailcow } from "@/oauth2/mailcow";
import { Microsoft } from "@/oauth2/microsoft";
import { Monday } from "@/oauth2/monday";
import { Notion } from "@/oauth2/notion";
import { OIDC } from "@/oauth2/oidc";
import { Patreon } from "@/oauth2/patreon";
import { Planningcenter } from "@/oauth2/planningcenter";
import { isProviderName } from "@/oauth2/provider-names";
import { initProvider } from "@/oauth2/providers";
import { Spotify } from "@/oauth2/spotify";
import { Strava } from "@/oauth2/strava";
import { Trakt } from "@/oauth2/trakt";
import { Twitch } from "@/oauth2/twitch";
import { Twitter } from "@/oauth2/twitter";
import { VK } from "@/oauth2/vk";
import { Wakatime } from "@/oauth2/wakatime";
import { Yandex } from "@/oauth2/yandex";

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
  [
    "mailcow",
    Mailcow,
    {
      authURL: "",
      tokenURL: "",
      userInfoURL: "",
      scopes: ["profile"],
      pkce: true,
    },
  ],
  [
    "microsoft",
    Microsoft,
    {
      authURL: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenURL: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      userInfoURL: "https://graph.microsoft.com/v1.0/me",
      scopes: ["User.Read"],
      pkce: true,
    },
  ],
  [
    "monday",
    Monday,
    {
      authURL: "https://auth.monday.com/oauth2/authorize",
      tokenURL: "https://auth.monday.com/oauth2/token",
      userInfoURL: "https://api.monday.com/v2",
      scopes: ["me:read"],
      pkce: true,
    },
  ],
  [
    "notion",
    Notion,
    {
      authURL: "https://api.notion.com/v1/oauth/authorize",
      tokenURL: "https://api.notion.com/v1/oauth/token",
      userInfoURL: "https://api.notion.com/v1/users/me",
      scopes: [],
      pkce: true,
    },
  ],
  [
    "patreon",
    Patreon,
    {
      authURL: "https://www.patreon.com/oauth2/authorize",
      tokenURL: "https://www.patreon.com/api/oauth2/token",
      userInfoURL:
        "https://www.patreon.com/api/oauth2/v2/identity?fields%5Buser%5D=full_name,email,vanity,image_url,is_email_verified",
      scopes: ["identity", "identity[email]"],
      pkce: true,
    },
  ],
  [
    "planningcenter",
    Planningcenter,
    {
      authURL: "https://api.planningcenteronline.com/oauth/authorize",
      tokenURL: "https://api.planningcenteronline.com/oauth/token",
      userInfoURL: "https://api.planningcenteronline.com/people/v2/me",
      scopes: ["people"],
      pkce: true,
    },
  ],
  [
    "spotify",
    Spotify,
    {
      authURL: "https://accounts.spotify.com/authorize",
      tokenURL: "https://accounts.spotify.com/api/token",
      userInfoURL: "https://api.spotify.com/v1/me",
      scopes: ["user-read-private"],
      pkce: true,
    },
  ],
  [
    "strava",
    Strava,
    {
      authURL: "https://www.strava.com/oauth/authorize",
      tokenURL: "https://www.strava.com/api/v3/oauth/token",
      userInfoURL: "https://www.strava.com/api/v3/athlete",
      scopes: ["profile:read_all"],
      pkce: true,
    },
  ],
  [
    "trakt",
    Trakt,
    {
      authURL: "https://trakt.tv/oauth/authorize",
      tokenURL: "https://api.trakt.tv/oauth/token",
      userInfoURL: "https://api.trakt.tv/users/settings",
      scopes: [],
      pkce: true,
    },
  ],
  [
    "twitch",
    Twitch,
    {
      authURL: "https://id.twitch.tv/oauth2/authorize",
      tokenURL: "https://id.twitch.tv/oauth2/token",
      userInfoURL: "https://api.twitch.tv/helix/users",
      scopes: ["user:read:email"],
      pkce: true,
    },
  ],
  [
    "twitter",
    Twitter,
    {
      authURL: "https://x.com/i/oauth2/authorize",
      tokenURL: "https://api.x.com/2/oauth2/token",
      userInfoURL:
        "https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url,confirmed_email",
      scopes: ["users.read", "users.email", "tweet.read"],
      pkce: true,
    },
  ],
  [
    "vk",
    VK,
    {
      authURL: "https://oauth.vk.com/authorize",
      tokenURL: "https://oauth.vk.com/access_token",
      userInfoURL: "https://api.vk.com/method/users.get?fields=photo_max,screen_name&v=5.131",
      scopes: ["email"],
      pkce: false,
    },
  ],
  [
    "wakatime",
    Wakatime,
    {
      authURL: "https://wakatime.com/oauth/authorize",
      tokenURL: "https://wakatime.com/oauth/token",
      userInfoURL: "https://wakatime.com/api/v1/users/current",
      scopes: ["email"],
      pkce: true,
    },
  ],
  [
    "yandex",
    Yandex,
    {
      authURL: "https://oauth.yandex.com/authorize",
      tokenURL: "https://oauth.yandex.com/token",
      userInfoURL: "https://login.yandex.ru/info",
      scopes: ["login:email", "login:avatar", "login:info"],
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

// Microsoft's SetExtra: a non-empty idTokenEmailClaim adds "openid" once
const initMicrosoft = (extra: { [key: string]: unknown } | null) =>
  initProvider(new OAuth2ProviderConfig({ name: "microsoft", extra }));

describe("Microsoft's extra config", () => {
  test("no extra config keeps the default scopes", () => {
    expect(initMicrosoft(null).scopes).toEqual(["User.Read"]);
  });

  test("an empty idTokenEmailClaim keeps the default scopes", () => {
    expect(initMicrosoft({ idTokenEmailClaim: "" }).scopes).toEqual(["User.Read"]);
  });

  test("a non-empty idTokenEmailClaim adds openid", () => {
    const p = initMicrosoft({ idTokenEmailClaim: "email" });
    expect(p.scopes).toEqual(["User.Read", "openid"]);
    expect(p.extra).toEqual({ idTokenEmailClaim: "email" });
  });

  test("openid is added once", () => {
    const p = initMicrosoft({ idTokenEmailClaim: "any_verified" });
    p.setExtra({ idTokenEmailClaim: "email" });
    expect(p.scopes).toEqual(["User.Read", "openid"]);
  });
});
