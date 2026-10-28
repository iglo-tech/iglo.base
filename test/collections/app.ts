// tests.NewTestApp for the collection tests: a CollectionsApp
// (src/collections/collection-query.ts) on a writable temporary copy of
// the vendored fixture (test/fixtures/pocketbase/), or on an existing
// pb_data directory. Upstream's test app loads the collections cache on
// bootstrap; open() does the same (reloadCachedCollections).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Clock } from "@/app/clock";
import { type CollectionsApp, reloadCachedCollections } from "@/collections/collection-query";
import { Databases } from "@/db/base";
import { Store } from "@/tools/store/store";

import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";

export interface TestCollectionsApp extends CollectionsApp {
  // what the app logged (upstream's Logger().Warn calls)
  readonly logged: { message: string; cause: unknown }[];
  cleanup(): void;
}

const systemClock: Clock = { now: () => new Date() };

// a copy of the vendored fixture, with the collections cache loaded
// (queryLog, when set, receives every data.db statement)
export function openTestApp(
  clock: Clock = systemClock,
  queryLog?: (line: string) => void,
): TestCollectionsApp {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-collections-"));
  const dataDir = join(root, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  const app = openDataDir(
    dataDir,
    clock,
    () => rmSync(root, { recursive: true, force: true }),
    queryLog,
  );
  reloadCachedCollections(app);
  return app;
}

// an app on an existing pb_data directory (not copied), without the
// collections cache
export function openDataDir(
  dataDir: string,
  clock: Clock = systemClock,
  onCleanup: () => void = () => {},
  queryLog?: (line: string) => void,
): TestCollectionsApp {
  const databases = Databases.open(
    queryLog === undefined ? { dataDir } : { dataDir, devSQLLog: queryLog },
  );
  const logged: { message: string; cause: unknown }[] = [];
  return {
    databases,
    store: new Store<string, unknown>(),
    clock,
    logger: { error: (message, cause) => logged.push({ message, cause }) },
    logged,
    cleanup() {
      databases.close();
      onCleanup();
    },
  };
}
