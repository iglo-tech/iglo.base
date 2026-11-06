// Upstream: core/base.go Restart and core/backup_restore.go through the CLI
// in-process. A restore restarts the app; when execve fails, the restore is
// reverted, the restart reports its failure and `serve` comes back up on
// the reverted data.

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { type CliContext, runCli } from "@/cli/root";

import { appName, fixtureCopy, login, patchSettings, waitFor } from "@test/notify/support";
import { freePort, tempDir } from "@test/support/executable";

test("a failed restart after a restore reverts the data and serves again", async () => {
  const dataDir = fixtureCopy();
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const shutdown = new AbortController();

  let restartCalls = 0;
  let restartCalled!: () => void;
  const restarted = new Promise<void>((resolve) => (restartCalled = resolve));
  const ctx: CliContext = {
    args: ["serve", "--http", `127.0.0.1:${port}`, "--dir", dataDir, "--automigrate=false"],
    argv0: "iglo-base",
    cwd: tempDir(),
    isCompiled: true,
    out: { stdout: () => {}, stderr: () => {}, now: () => new Date(), color: false },
    shutdown: shutdown.signal,
    restart: () => {
      restartCalls++;
      restartCalled();
      throw new Error("execve failed");
    },
  };
  const finished = runCli(ctx);

  try {
    const token = await waitFor("the server", async () => {
      try {
        return await login(url);
      } catch {
        return undefined;
      }
    });

    // back up the original data, then change it
    const before = await appName(url, token);
    const created = await fetch(`${url}/api/backups`, {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "restart.zip" }),
    });
    expect(created.status).toBe(204);
    await patchSettings(url, token, { meta: { appName: "changed by the test" } });

    const restored = await fetch(`${url}/api/backups/restart.zip/restore`, {
      method: "POST",
      headers: { Authorization: token },
    });
    expect(restored.status).toBe(204);
    await restarted;

    // the restore was reverted: the data is what it was before the restore
    // call, and the server is back
    const token2 = await waitFor("the server after the failed restart", async () => {
      try {
        return await login(url);
      } catch {
        return undefined;
      }
    });
    expect(await appName(url, token2)).toBe("changed by the test");
    expect(await appName(url, token2)).not.toBe(before);
    expect(restartCalls).toBe(1);
  } finally {
    shutdown.abort();
    expect(await finished).toBe(0);
  }
});

test("a shutdown during the restart window does not undo the restore", async () => {
  const dataDir = fixtureCopy();
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const args = ["serve", "--http", `127.0.0.1:${port}`, "--dir", dataDir, "--automigrate=false"];
  const context = (shutdown: AbortSignal, restart?: () => void): CliContext => ({
    args,
    argv0: "iglo-base",
    cwd: tempDir(),
    isCompiled: true,
    out: { stdout: () => {}, stderr: () => {}, now: () => new Date(), color: false },
    shutdown,
    restart,
  });

  const shutdown = new AbortController();
  const finished = runCli(
    context(shutdown.signal, () => {
      throw new Error("execve failed");
    }),
  );
  const held = new AbortController();
  let original: string;
  try {
    const token = await waitFor("the server", async () => {
      try {
        return await login(url);
      } catch {
        return undefined;
      }
    });
    original = await appName(url, token);
    const created = await fetch(`${url}/api/backups`, {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "shutdown.zip" }),
    });
    expect(created.status).toBe(204);
    await patchSettings(url, token, { meta: { appName: "changed by the test" } });

    // a request that never ends keeps the server busy, so the graceful stop
    // after the restore takes its full wait: that is the restart window
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
    });
    fetch(`${url}/api/collections/_superusers/auth-with-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: held.signal,
    }).catch(() => {});

    const restored = await fetch(`${url}/api/backups/shutdown.zip/restore`, {
      method: "POST",
      headers: { Authorization: token },
    });
    expect(restored.status).toBe(204);
    const marker = join(dataDir, ".pb_temp_to_delete", "restore_phase.swapped");
    await waitFor("the swapped marker", async () => existsSync(marker));
    // the signal arrives in the restart window
    shutdown.abort();
  } finally {
    shutdown.abort();
    held.abort();
  }
  expect(await finished).toBe(0);

  // the next start runs on the restored data
  const second = new AbortController();
  const again = runCli(context(second.signal));
  try {
    const token = await waitFor("the server after the restart", async () => {
      try {
        return await login(url);
      } catch {
        return undefined;
      }
    });
    expect(await appName(url, token)).toBe(original);
    expect(existsSync(join(dataDir, ".pb_temp_to_delete", "restore_phase.swapped"))).toBe(false);
  } finally {
    second.abort();
    expect(await again).toBe(0);
  }
});
