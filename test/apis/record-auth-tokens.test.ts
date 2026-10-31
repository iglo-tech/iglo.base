// Upstream: the "existing auth record (after already sent)" scenarios of
// apis/record_auth_verification_request_test.go and
// apis/record_auth_password_reset_request_test.go, which set the resend
// limit in the app store: here it is set by a first request. And the three
// flows through the compiled executable, with the token read from the
// message the SMTP sink received. test/differential/auth/token-flows.test.ts
// runs these against upstream too.

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { passwordIs, rowHas } from "@test/scenarios/record-checks";
import { usersToken } from "@test/scenarios/record-crud";
import type { AfterContext } from "@test/scenarios/scenario";
import { smtpToSink } from "@test/scenarios/settings-prepare";
import { startServer, tempDir } from "@test/support/executable";
import { sharedSmtpSink, type SinkMessage } from "@test/support/smtp-sink";

const email = "test@example.com";
const userId = "4q1xlclmfloku33";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureWithSink(): string {
  const root = tempDir();
  roots.push(root);
  const dataDir = join(root, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  smtpToSink()({ dataDir });
  return dataDir;
}

async function withServer(dataDir: string, fn: (url: string) => Promise<void>): Promise<void> {
  const server = await startServer([], dataDir);
  try {
    await fn(server.url);
  } finally {
    await server.stop();
  }
}

function post(url: string, path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${url}/api/collections/users/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token === undefined ? {} : { Authorization: token }),
    },
    body: JSON.stringify(body),
  });
}

function messagesSince(since: number, link: string): SinkMessage[] {
  return sharedSmtpSink().messages.filter((m) => m.received >= since && m.data.includes(link));
}

async function firstMessage(since: number, link: string): Promise<SinkMessage> {
  const until = Date.now() + 5000;
  while (messagesSince(since, link).length === 0 && Date.now() < until) {
    await Bun.sleep(10);
  }
  const [message] = messagesSince(since, link);
  if (message === undefined) {
    throw new Error(`no ${link} message`);
  }
  return message;
}

function mailedToken({ data }: SinkMessage, link: string): string {
  const match = new RegExp(`${link}([A-Za-z0-9_.-]+)`).exec(data);
  if (match?.[1] === undefined) {
    throw new Error(`no token in the message:\n${data}`);
  }
  return match[1];
}

// what a record check needs
const checked = (url: string, dataDir: string): AfterContext => ({
  url,
  dataDir,
  status: 0,
  headers: new Headers(),
  body: new Uint8Array(),
});

describe("existing auth record (after already sent)", () => {
  const cases: [string, string, string][] = [
    [
      "apis/record_auth_verification_request_test.go",
      "request-verification",
      "confirm-verification",
    ],
    [
      "apis/record_auth_password_reset_request_test.go",
      "request-password-reset",
      "confirm-password-reset",
    ],
  ];
  for (const [file, path, confirm] of cases) {
    test(file, async () => {
      const dataDir = fixtureWithSink();
      const since = Date.now();
      const link = `/auth/${confirm}/`;

      await withServer(dataDir, async (url) => {
        expect((await post(url, path, { email })).status).toBe(204);
        await firstMessage(since, link);
        // the limit is set right after the send
        await Bun.sleep(100);

        expect((await post(url, path, { email })).status).toBe(204);
        await Bun.sleep(100);
        expect(messagesSince(since, link)).toHaveLength(1);
      });
    });
  }
});

describe("the mailed tokens", () => {
  test("verification", async () => {
    const dataDir = fixtureWithSink();
    const since = Date.now();
    const link = "/auth/confirm-verification/";

    await withServer(dataDir, async (url) => {
      expect((await post(url, "request-verification", { email })).status).toBe(204);
      const token = mailedToken(await firstMessage(since, link), link);

      expect((await post(url, "confirm-verification", { token })).status).toBe(204);
      await rowHas("users", userId, { verified: 1 })(checked(url, dataDir));
    });
  });

  test("password reset", async () => {
    const dataDir = fixtureWithSink();
    const since = Date.now();
    const link = "/auth/confirm-password-reset/";
    const password = "1234567!";

    await withServer(dataDir, async (url) => {
      expect((await post(url, "request-password-reset", { email })).status).toBe(204);
      const token = mailedToken(await firstMessage(since, link), link);

      const body = { token, password, passwordConfirm: password };
      expect((await post(url, "confirm-password-reset", body)).status).toBe(204);
      await passwordIs("users", userId, password)(checked(url, dataDir));

      // the token and the old sessions ended with the password
      expect((await post(url, "confirm-password-reset", body)).status).toBe(400);
      expect((await post(url, "auth-refresh", {}, usersToken)).status).toBe(401);
    });
  });

  test("email change", async () => {
    const dataDir = fixtureWithSink();
    const since = Date.now();
    const link = "/auth/confirm-email-change/";
    const newEmail = "change@example.com";

    await withServer(dataDir, async (url) => {
      const request = await post(url, "request-email-change", { newEmail }, usersToken);
      expect(request.status).toBe(204);
      // sent before the response
      const message = (messagesSince(since, link)[0] as SinkMessage | undefined) ?? null;
      expect(message?.to).toEqual([newEmail]);
      const token = mailedToken(message as SinkMessage, link);

      const body = { token, password: "1234567890" };
      expect((await post(url, "confirm-email-change", body)).status).toBe(204);
      await rowHas("users", userId, { email: newEmail, verified: 1 })(checked(url, dataDir));
    });
  });
});
