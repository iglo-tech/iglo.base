// `prepare` steps and `after` checks of the collection scenarios
// (upstream's BeforeTestFunc and AfterTestFunc in apis/collection_test.go
// and apis/collection_import_test.go). They read or change a scenario's
// pb_data with SQLite, or through the collections core for a save
// (test/scenarios/prepare.ts).

import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { updateCollection } from "@test/scenarios/prepare";
import { queryRows } from "@test/scenarios/record-checks";
import type { AfterContext, PrepareContext } from "@test/scenarios/scenario";

type After = (ctx: AfterContext) => Promise<void>;

// the collection's storage directory is empty or missing (upstream's
// ensureDeletedFiles of TestCollectionDelete)
export function collectionFilesDeleted(collectionId: string): After {
  return ({ dataDir }) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(dataDir, "storage", collectionId));
    } catch {
      // a missing directory has no files
    }
    if (entries.length !== 0) {
      return Promise.reject(
        new Error(`expected empty/deleted dir, found: ${entries.length} (${entries.join(", ")})`),
      );
    }
    return Promise.resolve();
  };
}

// app.TableIndexes(table) has exactly these index names
export function tableIndexesAre(table: string, ...names: string[]): After {
  return ({ dataDir }) => {
    const rows = queryRows(
      dataDir,
      "SELECT name FROM sqlite_master WHERE sql IS NOT NULL AND type = 'index' AND tbl_name = ?",
      table,
    ) as { name: string }[];
    const got = rows.map((r) => r.name).toSorted();
    if (got.join(",") !== names.toSorted().join(",")) {
      return Promise.reject(
        new Error(`expected indexes ${names.join(", ")}, got ${got.join(", ")}`),
      );
    }
    return Promise.resolve();
  };
}

// app.HasTable(table)
export function tableExists(table: string): After {
  return ({ dataDir }) => {
    const rows = queryRows(
      dataDir,
      "SELECT name FROM sqlite_schema WHERE type IN ('table', 'view') AND LOWER(name) = LOWER(?)",
      table,
    );
    if (rows.length === 0) {
      return Promise.reject(new Error(`expected table ${table} to exist`));
    }
    return Promise.resolve();
  };
}

// the number of collections: n, or a function of the stored collections
// (the number of system ones)
export function collectionsCount(n: number | ((systemCount: number) => number)): After {
  return ({ dataDir }) => {
    const rows = queryRows(dataDir, "SELECT system FROM _collections") as { system: number }[];
    const expected = typeof n === "number" ? n : n(rows.filter((r) => r.system).length);
    if (rows.length !== expected) {
      return Promise.reject(new Error(`Expected ${expected} collections, got ${rows.length}`));
    }
    return Promise.resolve();
  };
}

// demo1.AddIndex(name, false, "updated", "") and app.Save(demo1)
export function addDemo1Index(name: string): (ctx: PrepareContext) => void {
  return ({ dataDir }) => {
    updateCollection(dataDir, "demo1", (demo1) => demo1.addIndex(name, false, "updated", ""));
  };
}

// fails unless the collection's OAuth2 providers are exactly these, in
// this order
export function oauth2ProvidersAre(
  collection: string,
  ...names: string[]
): (ctx: PrepareContext) => void {
  return ({ dataDir }) => {
    const db = new Database(join(dataDir, "data.db"), { readonly: true });
    try {
      const row = db.query("SELECT options FROM _collections WHERE name = ?").get(collection) as {
        options: string;
      };
      const options = JSON.parse(row.options) as { oauth2: { providers: { name: string }[] } };
      const got = options.oauth2.providers.map((p) => p.name);
      if (got.join(",") !== names.join(",")) {
        throw new Error(`Expected OAuth2 providers ${names.join(", ")}, got ${got.join(", ")}`);
      }
    } finally {
      db.close();
    }
  };
}

// a plain table (not a collection) with this name
export function createPlainTable(name: string): (ctx: PrepareContext) => void {
  return ({ dataDir }) => {
    const db = new Database(join(dataDir, "data.db"));
    try {
      db.run(`CREATE TABLE "${name}" (id TEXT PRIMARY KEY)`);
    } finally {
      db.close();
    }
  };
}
