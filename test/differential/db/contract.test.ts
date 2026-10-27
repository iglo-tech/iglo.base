// The data contract (docs/design/03-data-compatibility.md): iglo.base opens a
// copy of upstream's tests/data, writes to both files in transactions and
// closes it; nothing iglo-specific is left in either file, and the
// reference PocketBase v0.41.0 binary finds nothing pending, starts on the
// copy and serves what iglo.base wrote. Not part of `bun test`: run
// `bun run test:reference`.

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { auxDBFilename, Databases, dataDBFilename } from "@/db/base";
import { HashExp } from "@/db/dbx/expression";
import { auxRunInTransaction, runInTransaction } from "@/db/tx";
import {
  copyFixture,
  runUpstream,
  serveUpstream,
  superuserToken,
  type FixtureCopy,
} from "@test/differential/db/fixture";

const recordId = "iglobasedemo201";
const logId = "iglobaselog0001";
const now = "2026-10-27 12:00:00.000Z";

interface Snapshot {
  files: string[];
  schema: Record<string, unknown[]>;
  migrations: unknown[];
}

// sqlite_schema of both files, the _migrations rows and the pb_data entries
function snapshot(dataDir: string): Snapshot {
  const schema: Record<string, unknown[]> = {};
  let migrations: unknown[] = [];
  for (const name of [dataDBFilename, auxDBFilename]) {
    const conn = new Database(join(dataDir, name), { readonly: true });
    try {
      schema[name] = conn
        .query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
        .all();
      if (name === dataDBFilename) {
        migrations = conn.query("SELECT file, applied FROM _migrations ORDER BY file").all();
      }
    } finally {
      conn.close();
    }
  }
  const files = readdirSync(dataDir)
    .filter((f) => !f.endsWith("-wal") && !f.endsWith("-shm"))
    .toSorted();
  return { files, schema, migrations };
}

function integrityCheck(path: string): unknown {
  const conn = new Database(path, { readonly: true });
  try {
    return conn.query("PRAGMA integrity_check").values();
  } finally {
    conn.close();
  }
}

let copy: FixtureCopy;
let before: Snapshot;

beforeAll(() => {
  copy = copyFixture();
  before = snapshot(copy.dataDir);

  const app = Databases.open({ dataDir: copy.dataDir });
  try {
    runInTransaction(app, (txApp) => {
      txApp
        .db()
        .insert("demo2", {
          id: recordId,
          title: "written by iglo.base",
          active: true,
          created: now,
          updated: now,
        })
        .execute();
      // a nested call joins the transaction
      runInTransaction(txApp, (tx2App) => {
        tx2App
          .db()
          .update("demo2", { updated: now }, new HashExp({ id: recordId }))
          .execute();
      });
    });
    auxRunInTransaction(app, (txApp) => {
      txApp
        .auxDB()
        .insert("_logs", {
          id: logId,
          level: 0,
          message: "iglo.base contract test",
          data: '{"type":"test"}',
          created: now,
          updated: now,
        })
        .execute();
    });
  } finally {
    app.close();
  }
});

afterAll(() => {
  copy?.remove();
});

test("nothing iglo-specific is created in either file", () => {
  const after = snapshot(copy.dataDir);
  expect(after.schema).toEqual(before.schema);
  expect(after.migrations).toEqual(before.migrations);
  expect(after.files).toEqual(before.files);
  for (const name of [dataDBFilename, auxDBFilename]) {
    expect(integrityCheck(join(copy.dataDir, name))).toEqual([["ok"]]);
  }
});

test("the reference binary reports nothing pending", async () => {
  const result = await runUpstream(["migrate", "up", "--dir", copy.dataDir], copy.root);
  expect(result.output).toContain("No new migrations to apply.");
  expect(result.exitCode).toBe(0);
  expect(snapshot(copy.dataDir).migrations).toEqual(before.migrations);
});

test("the reference binary starts on the copy and reads what iglo.base wrote", async () => {
  const server = await serveUpstream(copy);
  try {
    const record = await fetch(`${server.url}/api/collections/demo2/records/${recordId}`);
    expect(record.status).toBe(200);
    expect(await record.json()).toMatchObject({
      id: recordId,
      title: "written by iglo.base",
      active: true,
      created: now,
      updated: now,
    });

    const log = await fetch(`${server.url}/api/logs/${logId}`, {
      headers: { Authorization: superuserToken },
    });
    expect(log.status).toBe(200);
    expect(await log.json()).toMatchObject({
      id: logId,
      message: "iglo.base contract test",
      data: { type: "test" },
    });
  } finally {
    await server.stop();
  }
});
