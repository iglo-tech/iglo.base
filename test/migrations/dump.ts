// Reads a pb_data directory back for the migration tests: the schema, the
// `_migrations` rows and the `_collections` rows of data.db and the schema
// of auxiliary.db, each in rowid order. Only for directories whose server
// has stopped (or test copies): the connection is closed before returning.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

export interface PbDataDump {
  dataSchema: SchemaRow[];
  auxSchema: SchemaRow[];
  migrations: { file: string; applied: number }[];
  collections: { [key: string]: unknown }[];
  params: { id: string }[];
}

function withDB<T>(path: string, fn: (db: Database) => T): T {
  const db = new Database(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function hasTable(db: Database, name: string): boolean {
  return (
    db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) !== null
  );
}

export function schemaOf(path: string): SchemaRow[] {
  return withDB(
    path,
    (db) =>
      db
        .query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY rowid")
        .all() as SchemaRow[],
  );
}

export function dumpPbData(dataDir: string): PbDataDump {
  const dataPath = join(dataDir, "data.db");
  const auxPath = join(dataDir, "auxiliary.db");
  return withDB(dataPath, (db) => ({
    dataSchema: db
      .query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY rowid")
      .all() as SchemaRow[],
    auxSchema: existsSync(auxPath) ? schemaOf(auxPath) : [],
    migrations: hasTable(db, "_migrations")
      ? (db.query("SELECT file, applied FROM _migrations ORDER BY rowid").all() as {
          file: string;
          applied: number;
        }[])
      : [],
    collections: hasTable(db, "_collections")
      ? (db.query("SELECT * FROM _collections ORDER BY rowid").all() as {
          [key: string]: unknown;
        }[])
      : [],
    params: hasTable(db, "_params")
      ? (db.query("SELECT id FROM _params ORDER BY rowid").all() as { id: string }[])
      : [],
  }));
}

// runs SQL on a pb_data file (test preparation)
export function execSQL(path: string, ...statements: string[]): void {
  withDB(path, (db) => {
    for (const sql of statements) {
      db.run(sql);
    }
  });
}

// SQLite's own statistics table that upstream's SQLite build (with
// SQLITE_ENABLE_STAT4) creates on PRAGMA optimize and Bun's does not
// (docs/design/03-data-compatibility.md, "SQLite settings")
export function withoutStat4(rows: SchemaRow[]): SchemaRow[] {
  return rows.filter((row) => row.name !== "sqlite_stat4");
}

// every entry of a directory, recursively and sorted, with the SHA-256 of
// each file's bytes ("dir" for a directory): what a refused open must
// leave unchanged
export function fileState(dir: string): Record<string, string> {
  const state: Record<string, string> = {};
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true }).map((e) => ({
    path: join(e.parentPath, e.name),
    isDir: e.isDirectory(),
  }));
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const { path, isDir } of entries) {
    state[path.slice(dir.length + 1)] = isDir
      ? "dir"
      : createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return state;
}

// runs SQL on a pb_data file in a child process that is killed (SIGKILL)
// right after the last statement, without closing the database: the state
// a crashed writer leaves (a hot -journal for an open DELETE-mode
// transaction, or -wal/-shm with the committed WAL frames)
export function crashSQL(path: string, ...statements: string[]): void {
  const script = `
    const { Database } = require("bun:sqlite");
    const [path, statements] = JSON.parse(process.argv[1]);
    const db = new Database(path);
    for (const sql of statements) db.run(sql);
    process.kill(process.pid, "SIGKILL");
  `;
  const result = Bun.spawnSync(
    [process.execPath, "-e", script, JSON.stringify([path, statements])],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.signalCode !== "SIGKILL") {
    throw new Error(`the writer was not killed: ${result.stderr.toString()}`);
  }
}
