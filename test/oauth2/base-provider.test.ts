// Upstream: tools/auth/base_provider_test.go, tools/auth/auth_test.go
//
// The Go getters and setters are the public fields of BaseProvider, so each
// accessor test is a field round trip. The Go provider factories that are not
// ported yet are left out (see the notes in src/oauth2/providers.ts).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { OAuth2ProviderConfig } from "@/collections/collection-model-auth-options";
import { type AuthUser, BaseProvider } from "@/oauth2/base-provider";
import { OIDC } from "@/oauth2/oidc";
import { isProviderName } from "@/oauth2/provider-names";
import { buildAuthURL, initProvider, initSignInProvider } from "@/oauth2/providers";
import { Token } from "@/oauth2/token";

// BaseProvider is abstract: a provider with no user info endpoint
class TestProvider extends BaseProvider {
  fetchAuthUser(): Promise<AuthUser> {
    return Promise.reject(new Error("unused"));
  }
}

// a clock the test moves by hand (tests never sleep)
const clock = { now: () => new Date("2026-10-29T12:00:00.000Z") };

// -------------------------------------------------------------------
// the local provider endpoints: /token answers a token, /resource echoes
// the request's Authorization header

interface Recorded {
  method: string;
  path: string;
  headers: Headers;
  body: string;
}

const requests: Recorded[] = [];
let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      requests.push({
        method: req.method,
        path: url.pathname,
        headers: req.headers,
        body: await req.text(),
      });

      if (url.pathname === "/token") {
        return Response.json({
          access_token: "access_test",
          token_type: "Bearer",
          refresh_token: "refresh_test",
          expires_in: 3600,
        });
      }

      return new Response(req.headers.get("Authorization") ?? "", { status: 200 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  requests.splice(0);
});

// -------------------------------------------------------------------
// BaseProvider fields (TestContext, TestDisplayName, ... TestExtra)

describe("BaseProvider fields", () => {
  // Go's TestContext: SetContext stores the request's context. Here it is the
  // signal the requests are made with.
  test("TestContext: signal", () => {
    const provider = new TestProvider();
    expect(provider.signal).toBeUndefined();

    const controller = new AbortController();
    provider.signal = controller.signal;

    expect(provider.signal).toBe(controller.signal);
  });

  // the zero value of each field, and a value it takes after being set
  const cases: [string, string, unknown, unknown][] = [
    ["TestDisplayName", "displayName", "", "test"],
    ["TestOrder", "order", 0, 123],
    ["TestLogo", "logo", "", "test"],
    ["TestPKCE", "pkce", false, true],
    ["TestScopes", "scopes", [], ["test1", "test2"]],
    ["TestClientId", "clientId", "", "test"],
    ["TestClientSecret", "clientSecret", "", "test"],
    ["TestRedirectURL", "redirectURL", "", "test"],
    ["TestAuthURL", "authURL", "", "test"],
    ["TestTokenURL", "tokenURL", "", "test"],
    ["TestUserInfoURL", "userInfoURL", "", "test"],
    ["TestExtra", "extra", null, { a: 1, b: 2 }],
  ];

  for (const [name, field, zero, value] of cases) {
    test(name, () => {
      const provider = new TestProvider();

      expect(Reflect.get(provider, field)).toEqual(zero);

      Reflect.set(provider, field, value);

      expect(Reflect.get(provider, field)).toEqual(value);
    });
  }
});

// Go's TestBuildAuthURL
test("TestBuildAuthURL", () => {
  const provider = new TestProvider();
  provider.authURL = "authURL_test";
  provider.tokenURL = "tokenURL_test";
  provider.redirectURL = "redirectURL_test";
  provider.clientId = "clientId_test";
  provider.clientSecret = "clientSecret_test";
  provider.scopes = ["test_scope"];

  const expected =
    "authURL_test?access_type=offline&client_id=clientId_test&prompt=consent&redirect_uri=redirectURL_test&response_type=code&scope=test_scope&state=state_test";

  expect(
    buildAuthURL(provider, "state_test", ["access_type", "offline"], ["prompt", "consent"]),
  ).toBe(expected);
});

// Go's TestClient: the client sends requests with the token
test("TestClient: fetchWithToken sends the bearer token", async () => {
  const provider = new TestProvider();
  provider.clock = clock;

  const token = new Token({ accessToken: "access_test", tokenType: "Bearer" });
  const res = await provider.fetchWithToken(token, `${base}/resource`);

  expect(res.status).toBe(200);
  expect(requests.map((r) => r.headers.get("Authorization"))).toEqual(["Bearer access_test"]);
});

// Go's TestOauth2Config: the token request uses the configured endpoint,
// redirect URL and client credentials
test("TestOauth2Config: fetchToken uses the configured endpoint and credentials", async () => {
  const provider = new TestProvider();
  provider.clock = clock;
  provider.authURL = "authURL_test";
  provider.tokenURL = `${base}/token`;
  provider.redirectURL = "redirectURL_test";
  provider.clientId = "clientId_test";
  provider.clientSecret = "clientSecret_test";
  provider.scopes = ["test"];

  const token = await provider.fetchToken("code_test");

  expect(token.accessToken).toBe("access_test");
  expect(requests.length).toBe(1);

  const [req] = requests;
  expect(req?.method).toBe("POST");
  expect(req?.path).toBe("/token");
  expect(req?.headers.get("Authorization")).toBe(
    "Basic " + Buffer.from("clientId_test:clientSecret_test").toString("base64"),
  );

  const form = new URLSearchParams(req?.body);
  expect(form.get("grant_type")).toBe("authorization_code");
  expect(form.get("code")).toBe("code_test");
  expect(form.get("redirect_uri")).toBe("redirectURL_test");
});

// -------------------------------------------------------------------
// auth_test.go

// the 32 names of auth.Providers (instagram is registered as "instagram2",
// oidc as "oidc", "oidc2" and "oidc3")
const providerNames = [
  "google",
  "facebook",
  "github",
  "gitlab",
  "twitter",
  "discord",
  "microsoft",
  "spotify",
  "kakao",
  "twitch",
  "strava",
  "gitee",
  "livechat",
  "gitea",
  "oidc",
  "oidc2",
  "oidc3",
  "apple",
  "instagram2",
  "vk",
  "yandex",
  "patreon",
  "mailcow",
  "bitbucket",
  "planningcenter",
  "notion",
  "monday",
  "wakatime",
  "box",
  "linear",
  "trakt",
  "lark",
];

// Go's TestProvidersCount: the registry holds 32 providers
test("TestProvidersCount: every registered name is accepted", () => {
  expect(providerNames.length).toBe(32);
  expect(providerNames.filter((name) => !isProviderName(name))).toEqual([]);
  expect(isProviderName("invalid")).toBe(false);
});

// Go's TestNewProviderByName, for the providers that are ported
describe("TestNewProviderByName", () => {
  test("invalid", () => {
    expect(() => initProvider(new OAuth2ProviderConfig({ name: "invalid" }))).toThrow();
  });

  for (const name of ["oidc", "oidc2", "oidc3"]) {
    test(name, () => {
      expect(initProvider(new OAuth2ProviderConfig({ name }))).toBeInstanceOf(OIDC);
    });
  }

  // M4.7's providers are not ported yet, so they cannot sign in
  for (const name of ["microsoft", "yandex"]) {
    test(`${name} sign-in is not ported yet`, () => {
      expect(() => initSignInProvider(new OAuth2ProviderConfig({ name }))).toThrow();
    });
  }
});
