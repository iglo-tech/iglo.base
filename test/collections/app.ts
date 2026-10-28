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
import type { Collection } from "@/collections/collection-model";
import { Databases } from "@/db/base";
import { HashExp } from "@/db/dbx/expression";
import { Store } from "@/tools/store/store";

import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";

export interface TestCollectionsApp extends CollectionsApp {
  cleanup(): void;
}

const systemClock: Clock = { now: () => new Date() };

// a copy of the vendored fixture, with the collections cache loaded
export function openTestApp(clock: Clock = systemClock): TestCollectionsApp {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-collections-"));
  const dataDir = join(root, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  const app = openDataDir(dataDir, clock, () => rmSync(root, { recursive: true, force: true }));
  reloadCachedCollections(app);
  return app;
}

// an app on an existing pb_data directory (not copied), without the
// collections cache
export function openDataDir(
  dataDir: string,
  clock: Clock = systemClock,
  onCleanup: () => void = () => {},
): TestCollectionsApp {
  const databases = Databases.open({ dataDir });
  return {
    databases,
    store: new Store<string, unknown>(),
    clock,
    cleanup() {
      databases.close();
      onCleanup();
    },
  };
}

// Stands in for app.Save(collection) where an upstream test saves a
// collection only to change its stored fields (collection save is M1.7's):
// writes the collection's fields to its `_collections` row.
export function storeFields(app: CollectionsApp, collection: Collection): void {
  app.databases
    .nonconcurrentDB()
    .update(
      "_collections",
      { fields: collection.fields.value() },
      new HashExp({ id: collection.id }),
    )
    .execute();
  reloadCachedCollections(app);
}
