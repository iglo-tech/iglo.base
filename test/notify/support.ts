// Helpers of the notify watcher tests (P.8): fixture copies, a superuser
// login, and waits on conditions instead of fixed sleeps.

import { join } from "node:path";

import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { tempDir } from "@test/support/executable";

export function fixtureCopy(): string {
  const dataDir = join(tempDir(), "pb_data");
  copyDataDir(fixtureDir, dataDir);
  return dataDir;
}

export async function login(url: string): Promise<string> {
  const res = await fetch(`${url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: "test@example.com", password: "1234567890" }),
  });
  return ((await res.json()) as { token: string }).token;
}

export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(25);
  }
}

export async function patchSettings(
  url: string,
  token: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${url}/api/settings`, {
    method: "PATCH",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`settings patch failed: ${res.status} ${await res.text()}`);
  }
}

export async function appName(url: string, token: string): Promise<string> {
  const res = await fetch(`${url}/api/settings`, { headers: { Authorization: token } });
  return ((await res.json()) as { meta: { appName: string } }).meta.appName;
}
