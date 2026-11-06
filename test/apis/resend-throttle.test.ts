// Upstream: apis/record_auth_password_reset_request.go and
// record_auth_verification_request.go. Upstream checks the resend limit and
// sets it after the (background) send, with a timer that always removes the
// key. Here the key is taken before the send, so that concurrent requests
// send one email, and a stale timer cannot remove a newer key.
//
// In-process, with the mail read from the SMTP sink.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { rmSync } from "node:fs";

import { newRouter } from "@/apis/base";

import { openFixtureApp, type TestApp } from "@test/app/app";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { smtpToSink } from "@test/scenarios/settings-prepare";
import { tempDir } from "@test/support/executable";
import { serveTest } from "@test/support/router";
import { sharedSmtpSink, type SinkMessage } from "@test/support/smtp-sink";

const email = "test@example.com";
// a verified user: a request for it sends the barrier mail below
const otherEmail = "test2@example.com";
const resetLink = "/auth/confirm-password-reset/";
const resendLimitMs = 2 * 60 * 1000;

let opened: TestApp[] = [];
let roots: string[] = [];

// The limit timers are held, and a test fires them by hand. A
// test ends only once the timers of its sends are held, so that none of them
// reaches the next test.
const realSetTimeout = globalThis.setTimeout;
let timers: (() => void)[] = [];

beforeEach(() => {
  timers = [];
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) => {
    if (ms !== resendLimitMs) {
      return realSetTimeout(fn, ms, ...args);
    }
    // The limit timers are the ones that are unref'ed (the SMTP client has
    // a timer of this length too, and clears it): held when unref'ed.
    const handle = {
      unref() {
        timers.push(fn);
        return handle;
      },
      ref() {
        return handle;
      },
    };
    return handle;
  }) as unknown as typeof setTimeout;
});

afterEach(async () => {
  globalThis.setTimeout = realSetTimeout;
  for (const app of opened) {
    await app.cleanup();
  }
  opened = [];
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function open(): Promise<TestApp> {
  const root = tempDir();
  roots.push(root);
  const dataDir = join(root, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  smtpToSink()({ dataDir });
  const app = await openFixtureApp({ dataDir });
  opened.push(app);
  return app;
}

function post(app: TestApp, path: string, body: unknown): Promise<Response> {
  return serveTest(newRouter(app).buildMux(), {
    method: "POST",
    target: `/api/collections/users/${path}`,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("timed out");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function mailsTo(since: number, to: string, text: string): SinkMessage[] {
  return sharedSmtpSink().messages.filter(
    (m) => m.received >= since && m.to.some((a) => a.includes(to)) && m.data.includes(text),
  );
}

// The mail of another user is requested after the one under test and awaited:
// whatever the earlier requests sent has reached the sink by then.
async function flushMailer(app: TestApp, since: number): Promise<void> {
  expect((await post(app, "request-password-reset", { email: otherEmail })).status).toBe(204);
  await until(() => mailsTo(since, otherEmail, resetLink).length > 0);
}

describe("concurrent resend requests send one email", () => {
  test("request-password-reset", async () => {
    const app = await open();
    const since = Date.now();

    const responses = await Promise.all([
      post(app, "request-password-reset", { email }),
      post(app, "request-password-reset", { email }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([204, 204]);

    await until(() => mailsTo(since, email, resetLink).length > 0);
    await flushMailer(app, since);
    expect(mailsTo(since, email, resetLink)).toHaveLength(1);
    // the one send held one timer (and the barrier mail one)
    await until(() => timers.length === 2);
  });

  test("request-verification", async () => {
    const app = await open();
    const since = Date.now();
    const link = "/auth/confirm-verification/";

    const responses = await Promise.all([
      post(app, "request-verification", { email }),
      post(app, "request-verification", { email }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([204, 204]);

    await until(() => mailsTo(since, email, link).length > 0);
    await flushMailer(app, since);
    expect(mailsTo(since, email, link)).toHaveLength(1);
    await until(() => timers.length === 2);
  });
});

describe("the resend limit timer", () => {
  test("a timer of an earlier send does not lift the limit of a later one", async () => {
    const app = await open();
    const since = Date.now();

    {
      // first send, then the confirm clears the limit
      expect((await post(app, "request-password-reset", { email })).status).toBe(204);
      await until(() => timers.length === 1);
      await until(() => mailsTo(since, email, resetLink).length === 1);
      const [message] = mailsTo(since, email, resetLink);
      const token = new RegExp(`${resetLink}([A-Za-z0-9_.-]+)`).exec(message?.data ?? "")?.[1];
      const password = "1234567!";
      const confirm = await post(app, "confirm-password-reset", {
        token,
        password,
        passwordConfirm: password,
      });
      expect(confirm.status).toBe(204);

      // second send sets the limit again
      expect((await post(app, "request-password-reset", { email })).status).toBe(204);
      await until(() => timers.length === 2);

      // the first send's timer fires: the limit of the second send stays
      timers[0]?.();
      expect((await post(app, "request-password-reset", { email })).status).toBe(204);
      await flushMailer(app, since);
      expect(mailsTo(since, email, resetLink)).toHaveLength(2);

      // its own timer lifts it
      timers[1]?.();
      expect((await post(app, "request-password-reset", { email })).status).toBe(204);
      await until(() => mailsTo(since, email, resetLink).length === 3);
    }
    // two sends of the user and the barrier mail's, and the last send
    await until(() => timers.length === 4);
  });
});
