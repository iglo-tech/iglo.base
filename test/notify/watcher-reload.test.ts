// Upstream: core/notify_watcher.go. The watcher's reload of the settings:
// one at a time, and close() waits for the running one, so the databases
// close under nothing.

import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NotifyWatcher } from "@/app/notify-watcher";

import { tempDir } from "@test/support/executable";

const logger = { debug() {}, warn() {}, error() {}, info() {} } as never;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

test("close waits for a running reload and no reload starts after it", async () => {
  const dataDir = tempDir();
  const watcher = new NotifyWatcher({ dataDir, logger, instanceId: "me" });
  const events: string[] = [];
  const started = deferred();
  const release = deferred();
  let active = 0;
  let maxActive = 0;
  let reloads = 0;
  watcher.start({
    settings: async () => {
      reloads++;
      active++;
      maxActive = Math.max(maxActive, active);
      events.push("reload start");
      started.resolve();
      await release.promise;
      events.push("reload end");
      active--;
    },
    collections: () => {},
  });
  mkdirSync(watcher.dir, { recursive: true });

  // another instance changed the settings
  writeFileSync(join(watcher.dir, "settings@other"), "");
  await started.promise;

  // a second event during the running reload
  writeFileSync(join(watcher.dir, "settings@other2"), "");

  const closed = watcher.close().then(() => events.push("closed"));
  release.resolve();
  await closed;

  expect(events).toEqual(["reload start", "reload end", "closed"]);
  expect(maxActive).toBe(1);
  expect(reloads).toBe(1);
});
