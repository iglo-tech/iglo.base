// Upstream: apis/settings.go (settingsGenerateAppleClientSecret)
//
// A key that fails to parse must not disturb the requests that follow: on
// Bun 1.4.4 a failed crypto.subtle.importKey makes the next token check throw.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { newRouter } from "@/apis/base";

import { openFixtureApp, type TestApp } from "@test/app/app";
import { superuserToken, usersToken } from "@test/scenarios/record-crud";
import { serveTest } from "@test/support/router";

let app: TestApp;

beforeEach(async () => {
  app = await openFixtureApp();
});

afterEach(() => app.cleanup());

const generate = (privateKey: string): Promise<Response> =>
  serveTest(newRouter(app).buildMux(), {
    method: "POST",
    target: "/api/settings/apple/generate-client-secret",
    headers: { Authorization: superuserToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: "com.example.app",
      teamId: "ABCDE12345",
      keyId: "KEYID12345",
      duration: 60,
      privateKey,
    }),
  });

test.each([
  ["malformed ASN.1", "AAAA"],
  ["a truncated structure", "MAMCAQA="],
])("valid tokens work right after a failed key: %s", async (_name, body) => {
  const key = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
  expect((await generate(key)).status).toBe(400);

  const settings = await serveTest(newRouter(app).buildMux(), {
    target: "/api/settings",
    headers: { Authorization: superuserToken },
  });
  expect(settings.status).toBe(200);

  expect((await generate(key)).status).toBe(400);

  const refresh = await serveTest(newRouter(app).buildMux(), {
    method: "POST",
    target: "/api/collections/users/auth-refresh",
    headers: { Authorization: usersToken },
  });
  expect(refresh.status).toBe(200);
});
