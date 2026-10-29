// The fresh install (src/migrations) against the reference PocketBase
// v0.41.0 binary. Not part of `bun test`: run `bun run test:reference`.
//
//   - upstream `serve` and iglo.base `serve` each start on an empty
//     directory and stop. data.db and auxiliary.db must have the same
//     sqlite_schema (type, name, tbl_name, sql, in order), the same
//     `_migrations` files in the same order, and the same `_collections`
//     rows except the generated values (token secrets, created, updated),
//     which must have upstream's formats. The one schema difference is
//     `sqlite_stat4`, which upstream's SQLite build creates on PRAGMA
//     optimize and Bun's (no SQLITE_ENABLE_STAT4) cannot
//     (03-data-compatibility.md, "SQLite settings"). Both write the
//     default settings row, with the same value bytes (a BLOB).
//   - upstream started on iglo.base's fresh pb_data finds nothing pending:
//     no new `_migrations` rows, no schema or `_collections` change, and
//     it serves the collections.
//   - iglo.base started on upstream's fresh pb_data writes nothing.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copyDataDir } from "@test/scenarios/fixture";
import { dumpPbData, type PbDataDump, withoutStat4 } from "@test/migrations/dump";
import { startServer } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";

// starting and stopping upstream is slow on some runners
const hookTimeout = 60_000;

let root: string;
let upstreamDir: string;
let igloDir: string;
let upstreamFresh: PbDataDump;
let igloFresh: PbDataDump;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "iglo-base-fresh-"));
  upstreamDir = join(root, "upstream", "pb_data");
  igloDir = join(root, "iglo", "pb_data");

  const upstream = await startUpstream({ dataDir: upstreamDir });
  await upstream.stop();
  upstreamFresh = dumpPbData(upstreamDir);

  const iglo = await startServer([], igloDir);
  const result = await iglo.stop();
  expect(result.exitCode).toBe(0);
  igloFresh = dumpPbData(igloDir);
}, hookTimeout);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function users(dump: PbDataDump): { [key: string]: unknown } | undefined {
  return dump.collections.find((c) => c.name === "users");
}

const datePattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const secretPattern = /"secret":"([^"]*)"/g;

// the `_collections` rows with the generated values replaced, after
// checking their formats
function normalizedCollections(dump: PbDataDump): { [key: string]: unknown }[] {
  return dump.collections.map((row) => {
    expect(row.created).toMatch(datePattern);
    expect(row.updated).toMatch(datePattern);
    const options = String(row.options).replace(secretPattern, (_, secret: string) => {
      expect(secret).toMatch(/^[a-zA-Z0-9]{50}$/);
      return `"secret":"<secret>"`;
    });
    return { ...row, created: "<date>", updated: "<date>", options };
  });
}

test("data.db has upstream's schema (but sqlite_stat4)", () => {
  expect(igloFresh.dataSchema).toEqual(withoutStat4(upstreamFresh.dataSchema));
  expect(upstreamFresh.dataSchema.filter((row) => row.name === "sqlite_stat4")).toEqual([
    {
      type: "table",
      name: "sqlite_stat4",
      tbl_name: "sqlite_stat4",
      sql: "CREATE TABLE sqlite_stat4(tbl,idx,neq,nlt,ndlt,sample)",
    },
  ]);
});

test("auxiliary.db has upstream's schema", () => {
  expect(igloFresh.auxSchema).toEqual(upstreamFresh.auxSchema);
  expect(igloFresh.auxSchema.length).toBeGreaterThan(0);
});

test("`_migrations` has upstream's files, in order, with microsecond times", () => {
  expect(igloFresh.migrations.map((m) => m.file)).toEqual(
    upstreamFresh.migrations.map((m) => m.file),
  );
  for (const m of [...igloFresh.migrations, ...upstreamFresh.migrations]) {
    expect(String(m.applied)).toMatch(/^\d{16}$/);
  }
});

test("`_collections` rows equal upstream's but the generated values", () => {
  const upstreamRows = normalizedCollections(upstreamFresh);
  const igloRows = normalizedCollections(igloFresh);
  expect(igloRows).toEqual(upstreamRows);
  // five token secrets per auth collection
  for (const row of igloFresh.collections.filter((c) => c.type === "auth")) {
    expect(String(row.options).match(secretPattern)).toHaveLength(5);
  }
  // users is resaved by 1778828400_normalize_indexes.go on both
  expect(users(igloFresh)?.updated).not.toBe(users(igloFresh)?.created);
  expect(users(upstreamFresh)?.updated).not.toBe(users(upstreamFresh)?.created);
});

test("the default settings row is the only `_params` row, with upstream's value", () => {
  expect(upstreamFresh.params).toEqual([{ id: "settings" }]);
  expect(igloFresh.params).toEqual([{ id: "settings" }]);

  const upstreamRow = readSettingsRow(upstreamDir);
  const igloRow = readSettingsRow(igloDir);
  expect(igloRow.type).toBe("blob");
  expect(upstreamRow.type).toBe("blob");
  expect(new TextDecoder().decode(igloRow.value)).toBe(new TextDecoder().decode(upstreamRow.value));
  for (const row of [upstreamRow, igloRow]) {
    expect(row.created).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(row.updated).toBe(row.created);
  }
});

test(
  "upstream on iglo.base's fresh pb_data finds nothing pending and serves the collections",
  async () => {
    const dataDir = join(root, "iglo-then-upstream", "pb_data");
    copyDataDir(igloDir, dataDir);

    const upstream = await startUpstream({ dataDir });
    try {
      const res = await fetch(`${upstream.url}/api/collections/users/records`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        items: [],
        page: 1,
        perPage: 30,
        totalItems: 0,
        totalPages: 0,
      });
      const methods = await fetch(`${upstream.url}/api/collections/_superusers/auth-methods`);
      expect(methods.status).toBe(200);
    } finally {
      await upstream.stop();
    }

    const after = dumpPbData(dataDir);
    expect(after.migrations).toEqual(igloFresh.migrations);
    expect(withoutStat4(after.dataSchema)).toEqual(igloFresh.dataSchema);
    expect(after.auxSchema).toEqual(igloFresh.auxSchema);
    expect(after.collections).toEqual(igloFresh.collections);
  },
  hookTimeout,
);

test(
  "iglo.base on upstream's fresh pb_data writes nothing",
  async () => {
    const dataDir = join(root, "upstream-then-iglo", "pb_data");
    copyDataDir(upstreamDir, dataDir);

    const iglo = await startServer([], dataDir);
    const res = await fetch(`${iglo.url}/api/health`);
    expect(res.status).toBe(200);
    const result = await iglo.stop();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    expect(dumpPbData(dataDir)).toEqual(upstreamFresh);
  },
  hookTimeout,
);

// the stored settings row of a pb_data
function readSettingsRow(dir: string): {
  type: string;
  value: Uint8Array;
  created: string;
  updated: string;
} {
  const db = new Database(join(dir, "data.db"), { readonly: true });
  try {
    return db.query("SELECT typeof(value) AS type, value, created, updated FROM _params").get() as {
      type: string;
      value: Uint8Array;
      created: string;
      updated: string;
    };
  } finally {
    db.close();
  }
}
