// Upstream: apis/record_auth_with_otp_test.go
// (TestRecordAuthWithOTPManualRateLimiterCheck), and the OTP request flow
// through the compiled executable: the password read from the message the
// SMTP sink received, sentTo after the send, and the failed send.
// test/differential/auth/otp-flows.test.ts runs these against upstream too.

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { insertOTPs, otpRows, setMFA } from "@test/scenarios/record-auth-prepare";
import { smtpToSink } from "@test/scenarios/settings-prepare";
import { startServer, tempDir } from "@test/support/executable";
import { sharedSmtpSink } from "@test/support/smtp-sink";

const email = "test@example.com";
const userId = "4q1xlclmfloku33";
const otpAId = "a".repeat(15);
const otpBId = "b".repeat(15);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function usersWithoutMFA(): string {
  const root = tempDir();
  roots.push(root);
  const dataDir = join(root, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  setMFA("users", false, "")({ dataDir });
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

async function post(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${url}/api/collections/users/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitFor(condition: () => boolean): Promise<void> {
  const until = Date.now() + 5000;
  while (!condition() && Date.now() < until) {
    await Bun.sleep(10);
  }
  expect(condition()).toBe(true);
}

describe("TestRecordAuthWithOTPManualRateLimiterCheck", () => {
  test("the sixth attempt of a record is refused, even with the right password", async () => {
    const dataDir = usersWithoutMFA();
    insertOTPs("users", email, { id: otpAId }, { id: otpBId })({ dataDir });

    await withServer(dataDir, async (url) => {
      const attempts: [string, string, number][] = [
        [otpAId, "12345", 400],
        [otpAId, "12345", 400],
        [otpBId, "12345", 400],
        [otpBId, "12345", 400],
        [otpBId, "12345", 400],
        [otpAId, "12345", 429],
        [otpAId, "123456", 429], // reject even if it is correct
        [otpAId, "123456", 429],
        [otpBId, "123456", 429],
      ];

      for (const [otpId, password, expectedStatus] of attempts) {
        const res = await post(url, "auth-with-otp", { otpId, password });
        expect(res.status).toBe(expectedStatus);
      }
    });
  });
});

describe("the OTP email", () => {
  test("the mailed password signs in, and sentTo is set after the send", async () => {
    const dataDir = usersWithoutMFA();
    smtpToSink()({ dataDir });
    const since = Date.now();

    await withServer(dataDir, async (url) => {
      const res = await post(url, "request-otp", { email });
      expect(res.status).toBe(200);
      const { otpId } = (await res.json()) as { otpId: string };

      await waitFor(() => otpRows(dataDir, userId)[0]?.sentTo === email);

      const message = sharedSmtpSink().messages.find(
        (m) => m.received >= since && m.to.includes(email),
      );
      const password = /<strong>(\d+)<\/strong>/.exec(message?.data ?? "")?.[1];
      expect(password).toMatch(/^\d{8}$/);

      const auth = await post(url, "auth-with-otp", { otpId, password });
      expect(auth.status).toBe(200);
      expect(otpRows(dataDir, userId)).toEqual([]);
    });
  });

  test("a failed send keeps the 200 and removes the OTP", async () => {
    // the fixture has SMTP off and the host has no sendmail
    const dataDir = usersWithoutMFA();

    await withServer(dataDir, async (url) => {
      const res = await post(url, "request-otp", { email });
      expect(res.status).toBe(200);

      await waitFor(() => otpRows(dataDir, userId).length === 0);
    });
  });
});
