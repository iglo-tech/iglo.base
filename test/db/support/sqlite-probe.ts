// Reports the SQLite a thread of this process uses (test/db/sqlite-lib.test.ts):
// the version and PRAGMA compile_options without the compiler name.

import { Database } from "bun:sqlite";

import { loadSQLite } from "@/db/sqlite-lib";

export interface SqliteInfo {
  version: string;
  options: string[];
}

export function sqliteInfo(first: boolean): SqliteInfo {
  loadSQLite(first);
  const db = new Database(":memory:");
  try {
    const version = (db.query("select sqlite_version() as v").get() as { v: string }).v;
    const rows = db.query("pragma compile_options").all() as { compile_options: string }[];
    return {
      version,
      options: rows.map((r) => r.compile_options).filter((o) => !o.startsWith("COMPILER=")),
    };
  } finally {
    db.close();
  }
}

// run as a script: print the info as JSON (or fail the way the process would)
if (import.meta.main) {
  console.log(JSON.stringify(sqliteInfo(true)));
}
