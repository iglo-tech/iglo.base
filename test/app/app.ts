// tests.NewTestApp: a bootstrapped App (src/app/bootstrap.ts) on a writable
// copy of the vendored fixture (test/fixtures/pocketbase/), or on a given
// pb_data directory. Bootstrap loads the collections cache, as upstream's
// test app does. Without readWorkers there is no read pool: the async
// resolvers read on the main-thread connection.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { App } from "@/app/app";
import { bootstrap, clearBootstrap } from "@/app/bootstrap";
import type { Clock } from "@/app/clock";

import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";

export interface TestApp extends App {
  // what the app logged
  readonly logged: { message: string; cause: unknown }[];
  // the warnings of the bootstrap
  readonly warnings: string[];
  cleanup(): Promise<void>;
}

const systemClock: Clock = { now: () => new Date() };

export interface TestAppOptions {
  clock?: Clock;
  // an existing pb_data directory (not copied, not removed); a fixture copy
  // unless set
  dataDir?: string;
  readWorkers?: number;
}

export function openFixtureApp(options: TestAppOptions = {}): TestApp {
  let root: string | null = null;
  let dataDir = options.dataDir;
  if (dataDir === undefined) {
    root = mkdtempSync(join(tmpdir(), "iglo-base-app-"));
    dataDir = join(root, "pb_data");
    copyDataDir(fixtureDir, dataDir);
  }

  const logged: { message: string; cause: unknown }[] = [];
  const warnings: string[] = [];
  const app = bootstrap({
    dataDir,
    isDev: false,
    encryptionEnv: "",
    queryTimeout: 30,
    clock: options.clock ?? systemClock,
    logger: { error: (message, cause) => logged.push({ message, cause }) },
    readWorkers: options.readWorkers ?? 0,
    warn: (message) => warnings.push(message),
  });

  return {
    ...app,
    logged,
    warnings,
    async cleanup() {
      await clearBootstrap(app);
      if (root !== null) {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
