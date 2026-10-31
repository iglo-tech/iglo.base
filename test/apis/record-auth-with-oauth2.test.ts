// Upstream: apis/record_auth_with_oauth2_test.go
//
// The paths that need a Go-injected provider or a public avatar host, in-process
// through the router's options, which the executable never sets: the
// provider is a stub here, and the avatar's address check is replaced
// so that a server on loopback stands in for a public host. The scenarios
// (test/scenarios/record-auth-oauth2.ts) and the differential cases cover
// the rest through the compiled executable.
//
// "creating user (with mapped OAuth2 fields and avatarURL->file field)" and
// "store name with Apple provider" are ported here; the rest are extra checks of
// the same paths.

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { newRouter } from "@/apis/base";
import type { RecordAuthOptions } from "@/apis/record-auth-with-oauth2";
import {
  OAuth2KnownFields,
  OAuth2ProviderConfig,
} from "@/collections/collection-model-auth-options";
import { findCollectionByNameOrId } from "@/collections/collection-query";
import { saveCollection } from "@/collections/collection-save";
import { AuthUser, BaseProvider } from "@/oauth2/base-provider";
import { Token } from "@/oauth2/token";
import { findAuthRecordByEmail } from "@/records/record-query";
import { Client } from "@/tools/subscriptions/client";

import { openFixtureApp, type TestApp } from "@test/app/app";
import { json as jsonResponse, stubFetch } from "@test/support/fetch-stub";
import { serveTest } from "@test/support/router";

const pngPixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const avatarServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(pngPixel),
});

afterAll(() => avatarServer.stop(true));

const avatarURL = `http://127.0.0.1:${avatarServer.port}/images/logo.png`;

class StubProvider extends BaseProvider {
  constructor(readonly user: AuthUser) {
    super();
  }

  override fetchToken(): Promise<Token> {
    return Promise.resolve(new Token({ accessToken: "abc" }));
  }

  fetchAuthUser(): Promise<AuthUser> {
    return Promise.resolve(this.user);
  }
}

let app: TestApp;

beforeEach(async () => {
  app = await openFixtureApp();
});

afterEach(() => app.cleanup());

function useProvider(name: string, mappedFields?: OAuth2KnownFields): void {
  const users = findCollectionByNameOrId(app, "users");
  users.mfa.enabled = false;
  users.oauth2.enabled = true;
  users.oauth2.providers = [
    new OAuth2ProviderConfig({ name, clientId: "123", clientSecret: "456" }),
  ];
  if (mappedFields !== undefined) {
    users.oauth2.mappedFields = mappedFields;
  }
  saveCollection(app, users);
}

const options = (user: AuthUser, extra: RecordAuthOptions = {}): RecordAuthOptions => ({
  initProvider: () => new StubProvider(user),
  avatar: { isAllowedAddress: () => true },
  ...extra,
});

async function signIn(
  recordAuth: RecordAuthOptions,
  body: { [key: string]: unknown },
): Promise<{ status: number; json: { [key: string]: unknown } }> {
  const res = await serveTest(newRouter(app, { recordAuth }).buildMux(), {
    method: "POST",
    target: "/api/collections/users/auth-with-oauth2",
    body: JSON.stringify({ code: "123", redirectURL: "https://example.com", ...body }),
    headers: { "Content-Type": "application/json" },
  });
  return { status: res.status, json: (await res.json()) as { [key: string]: unknown } };
}

const mappedAvatar = new OAuth2KnownFields({
  username: "name", // should be ignored because of the explicit submitted value
  id: "username",
  avatarURL: "avatar",
});

const oauth2User = (): AuthUser =>
  new AuthUser({
    id: "oauth2_id",
    email: "oauth2@example.com",
    username: "oauth2_username",
    avatarURL,
  });

function storedFiles(recordId: string): string[] {
  const dir = join(app.dataDir, "storage", "_pb_users_auth_", recordId);
  return existsSync(dir) ? readdirSync(dir).filter((f) => !f.endsWith(".attrs")) : [];
}

test("creating user (with mapped OAuth2 fields and avatarURL->file field)", async () => {
  useProvider("oidc", mappedAvatar);

  const { status, json } = await signIn(options(oauth2User()), {
    provider: "oidc",
    createData: { name: "test_name", emailVisibility: true, rel: "0yxhwia2amd8gec" },
  });

  expect(status).toBe(200);
  expect(json["meta"]).toMatchObject({ isNew: true });
  const record = json["record"] as { [key: string]: unknown };
  expect(record).toMatchObject({
    email: "oauth2@example.com",
    emailVisibility: true,
    name: "test_name",
    username: "oauth2_id",
    verified: true,
    rel: "0yxhwia2amd8gec",
  });
  // normalized twice: by the download and by the internal request's multipart part
  expect(record["avatar"]).toMatch(/^logo_[a-z0-9]{10}_[a-z0-9]{10}\.png$/);

  expect(storedFiles(record["id"] as string)).toEqual([record["avatar"] as string]);
  const bytes = await Bun.file(
    join(
      app.dataDir,
      "storage",
      "_pb_users_auth_",
      record["id"] as string,
      record["avatar"] as string,
    ),
  ).bytes();
  expect(Buffer.from(bytes).equals(pngPixel)).toBe(true);
});

test("an explicit avatar in createData skips the download", async () => {
  useProvider("oidc", mappedAvatar);
  let downloads = 0;

  const { status } = await signIn(
    options(oauth2User(), {
      avatar: {
        isAllowedAddress: () => {
          downloads++;
          return true;
        },
      },
    }),
    { provider: "oidc", createData: { avatar: "" } },
  );

  expect(status).toBe(200);
  expect(downloads).toBe(0);
});

test("an existing user doesn't download the avatar", async () => {
  useProvider("oidc", mappedAvatar);
  let downloads = 0;
  const user = oauth2User();
  user.email = "test2@example.com";

  const { status, json } = await signIn(
    options(user, {
      avatar: {
        isAllowedAddress: () => {
          downloads++;
          return true;
        },
      },
    }),
    { provider: "oidc" },
  );

  expect(status).toBe(200);
  expect(json["meta"]).toMatchObject({ isNew: false });
  expect(downloads).toBe(0);
});

test("the production address check still refuses the avatar through the handler", async () => {
  useProvider("oidc", mappedAvatar);

  const { status, json } = await signIn(
    { initProvider: () => new StubProvider(oauth2User()) },
    { provider: "oidc" },
  );

  expect(status).toBe(200);
  expect((json["record"] as { [key: string]: unknown })["avatar"]).toBe("");
  expect(app.logged.map((l) => l.message)).toContain("Failed to retrieve OAuth2 avatar");
});

test("the record create and the link are all or nothing, with the avatar too", async () => {
  useProvider("oidc", mappedAvatar);
  const user = oauth2User();
  user.id = ""; // the link's providerId is required

  const { status, json } = await signIn(options(user), { provider: "oidc" });

  expect(status).toBe(400);
  expect(json["data"]).toMatchObject({ providerId: { code: "validation_required" } });
  expect(() => findAuthRecordByEmail(app, "users", "oauth2@example.com")).toThrow();
  const dirs = readdirSync(join(app.dataDir, "storage", "_pb_users_auth_"));
  for (const id of dirs) {
    expect(storedFiles(id).some((f) => f.startsWith("logo_"))).toBe(false);
  }
});

test("store name with Apple provider", async () => {
  useProvider("apple");
  app.store.set("@redirect_name_test_code", "test_store_name");

  const { status, json } = await signIn(options(new AuthUser({ id: "test_id" })), {
    provider: "apple",
    code: "test_code",
  });

  expect(status).toBe(200);
  expect(json["meta"]).toMatchObject({ name: "test_store_name" });
  expect(app.store.has("@redirect_name_test_code")).toBe(false);
});

test("a name from Apple itself leaves the stored one", async () => {
  useProvider("apple");
  app.store.set("@redirect_name_test_code", "test_store_name");

  const { json } = await signIn(options(new AuthUser({ id: "test_id", name: "Apple Name" })), {
    provider: "apple",
    code: "test_code",
  });

  expect(json["meta"]).toMatchObject({ name: "Apple Name" });
  expect(app.store.has("@redirect_name_test_code")).toBe(true);
});

// a provider whose init fails (a test seam stands in for one) is a clear error before any network call
test("a provider that fails to init is a clear error before any network call", async () => {
  useProvider("microsoft");

  const { status, json } = await signIn(
    {
      initProvider: () => {
        throw new Error("missing provider microsoft");
      },
    },
    { provider: "microsoft" },
  );

  expect(status).toBe(500);
  expect(json["message"]).toBe("Failed to init provider microsoft.");
});

// the Apple name of (POST) "Apple user's name json" and its nameKey error,
// checked in the store as upstream's AfterTestFunc does
async function redirectWithName(code: string): Promise<void> {
  const client = new Client();
  client.subscribe("@oauth2");
  app.subscriptionsBroker.register(client);

  const form = new URLSearchParams({
    code,
    state: client.id(),
    user: `{"name":{"firstName":"aaa","lastName":"${"b".repeat(200)}"}}`,
  });
  const res = await serveTest(newRouter(app).buildMux(), {
    method: "POST",
    target: "/api/oauth2-redirect",
    body: form.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  expect(res.status).toBe(303);
  expect(res.headers.get("Location")).toContain("/oauth2-redirect-success");
  expect(client.hasSubscription("@oauth2")).toBe(false);
}

test("(POST) Apple user's name json", async () => {
  await redirectWithName("a".repeat(985));
  expect(app.store.get("@redirect_name_" + "a".repeat(985))).toBe("aaa " + "b".repeat(146));
});

test("(POST) Apple user's name json (nameKey error)", async () => {
  await redirectWithName("a".repeat(986));
  expect(app.store.get("@redirect_name_" + "a".repeat(986))).toBeUndefined();
});

const b64url = (value: string | Uint8Array): string => Buffer.from(value).toString("base64url");

// Apple's first-login name, end to end with the real Apple provider: the
// redirect stores it under the code, and the sign-in with that code adds it
// to the auth response. The token and JWKS endpoints are answered by a
// test-only fetch (test/support/fetch-stub.ts).
test("the Apple name from the redirect reaches the auth response", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: "apple-key",
    alg: "RS256",
    use: "sig",
  };
  const head = `${b64url(JSON.stringify({ alg: "RS256", kid: "apple-key" }))}.${b64url(
    JSON.stringify({
      iss: "https://appleid.apple.com",
      aud: "123",
      sub: "apple_user",
      iat: Math.floor(Date.now() / 1000) - 10,
      exp: Math.floor(Date.now() / 1000) + 3600,
      email: "apple@example.com",
      email_verified: "true",
    }),
  )}`;
  const idToken = `${head}.${b64url(sign("sha256", Buffer.from(head), privateKey))}`;

  const stub = stubFetch({
    "https://appleid.apple.com/auth/token": () =>
      jsonResponse({ access_token: "abc", token_type: "bearer", id_token: idToken }),
    "https://appleid.apple.com/auth/keys": () => jsonResponse({ keys: [jwk] }),
  });
  try {
    useProvider("apple");

    const client = new Client();
    client.subscribe("@oauth2");
    app.subscriptionsBroker.register(client);
    const redirect = await serveTest(newRouter(app).buildMux(), {
      method: "POST",
      target: "/api/oauth2-redirect",
      body: new URLSearchParams({
        code: "apple_code",
        state: client.id(),
        user: `{"name":{"firstName":"Ada","lastName":"Lovelace"}}`,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(redirect.status).toBe(303);

    const res = await serveTest(newRouter(app).buildMux(), {
      method: "POST",
      target: "/api/collections/users/auth-with-oauth2",
      body: JSON.stringify({
        provider: "apple",
        code: "apple_code",
        redirectURL: "https://example.com",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const body = (await res.json()) as { meta: { [key: string]: unknown }; record: unknown };

    expect(res.status).toBe(200);
    expect(body.meta).toMatchObject({
      id: "apple_user",
      name: "Ada Lovelace",
      email: "apple@example.com",
      isNew: true,
    });
    expect(app.store.has("@redirect_name_apple_code")).toBe(false);
    expect(stub.calls).toEqual([
      "https://appleid.apple.com/auth/token",
      "https://appleid.apple.com/auth/keys",
    ]);
  } finally {
    stub.restore();
  }
});
