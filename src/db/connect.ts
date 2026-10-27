// Upstream: core/db_connect.go (and core/db_connect_nodefaultdriver.go,
// which only exists for custom Go drivers and has no counterpart here)
//
// Upstream opens SQLite through modernc.org/sqlite with a DSN whose
// `_pragma` values run on every new connection, in order. iglo.base runs
// the same pragmas on its bun:sqlite connection. Upstream's `_defensive=1`
// (SQLITE_DBCONFIG_DEFENSIVE) cannot be set: bun:sqlite exposes no
// sqlite3_db_config call and the setting has no pragma
// (docs/design/03-data-compatibility.md#sqlite-settings).

import { Database } from "bun:sqlite";

import { newFromDB, type DB } from "@/db/dbx/db";

// Note: the busy_timeout pragma must be first because
// the connection needs to be set to block on busy before WAL mode
// is set in case it hasn't been already set by another connection.
export const connectPragmas: readonly string[] = Object.freeze([
  "busy_timeout(10000)",
  "journal_mode(WAL)",
  "journal_size_limit(200000000)",
  "synchronous(NORMAL)",
  "foreign_keys(ON)",
  "temp_store(MEMORY)",
  "cache_size(-32000)",
]);

// DBConnectFunc opens a database file (core.DBConnectFunc).
export type DBConnectFunc = (dbPath: string) => DB;

export function defaultDBConnect(dbPath: string): DB {
  const conn = new Database(dbPath, { create: true, readwrite: true });
  try {
    for (const pragma of connectPragmas) {
      conn.run(`PRAGMA ${pragma}`);
    }
  } catch (err) {
    conn.close();
    throw err;
  }
  return newFromDB(conn, "sqlite");
}
