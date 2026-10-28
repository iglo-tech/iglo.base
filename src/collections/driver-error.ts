// Upstream: the error text of the Go SQLite driver PocketBase v0.41.0 pins
// (modernc.org/sqlite v1.60.1 errstr, with SQLite's sqlite3ErrStr from
// main.c)
//
// The driver reports a failed SQLite call as
// "<sqlite3_errstr(rc)>: <sqlite3_errmsg()> (<rc>)", or
// "<sqlite3_errstr(rc)> (<rc>)" when both texts are equal, with the
// extended result code (for example
// "SQL logic error: no such table: missing (1)" or "constraint failed:
// UNIQUE constraint failed: demo.title (2067)"). bun:sqlite throws a
// SQLiteError with only the errmsg and the extended code (errno).
//
// The collection save path puts these texts into API output (the view
// query check, the index creation errors, the raw save error), so the
// SQL calls it runs convert bun:sqlite's errors here. src/db does not
// format them yet; that belongs in its driver (reported for the lead).

import { SQLiteError } from "bun:sqlite";

// sqlite3ErrStr's aMsg, indexed by the primary result code
const errStrings: readonly (string | null)[] = [
  /* SQLITE_OK          */ "not an error",
  /* SQLITE_ERROR       */ "SQL logic error",
  /* SQLITE_INTERNAL    */ null,
  /* SQLITE_PERM        */ "access permission denied",
  /* SQLITE_ABORT       */ "query aborted",
  /* SQLITE_BUSY        */ "database is locked",
  /* SQLITE_LOCKED      */ "database table is locked",
  /* SQLITE_NOMEM       */ "out of memory",
  /* SQLITE_READONLY    */ "attempt to write a readonly database",
  /* SQLITE_INTERRUPT   */ "interrupted",
  /* SQLITE_IOERR       */ "disk I/O error",
  /* SQLITE_CORRUPT     */ "database disk image is malformed",
  /* SQLITE_NOTFOUND    */ null,
  /* SQLITE_FULL        */ "database or disk is full",
  /* SQLITE_CANTOPEN    */ "unable to open database file",
  /* SQLITE_PROTOCOL    */ "locking protocol",
  /* SQLITE_EMPTY       */ null,
  /* SQLITE_SCHEMA      */ "database schema has changed",
  /* SQLITE_TOOBIG      */ "string or blob too big",
  /* SQLITE_CONSTRAINT  */ "constraint failed",
  /* SQLITE_MISMATCH    */ "datatype mismatch",
  /* SQLITE_MISUSE      */ "bad parameter or other API misuse",
  /* SQLITE_NOLFS       */ null,
  /* SQLITE_AUTH        */ "authorization denied",
  /* SQLITE_FORMAT      */ null,
  /* SQLITE_RANGE       */ "column index out of range",
  /* SQLITE_NOTADB      */ "file is not a database",
  /* SQLITE_NOTICE      */ "notification message",
  /* SQLITE_WARNING     */ "warning message",
];

const SQLITE_ROW = 100;
const SQLITE_DONE = 101;
const SQLITE_ABORT_ROLLBACK = 4 | (2 << 8);

// sqlite3ErrStr
function errStr(rc: number): string {
  switch (rc) {
    case SQLITE_ABORT_ROLLBACK:
      return "abort due to ROLLBACK";
    case SQLITE_ROW:
      return "another row available";
    case SQLITE_DONE:
      return "no more rows available";
  }
  return errStrings[rc & 0xff] ?? "unknown error";
}

// the driver's error for a bun:sqlite SQLiteError; other values are
// returned as they are
export function driverError(err: unknown): unknown {
  if (!(err instanceof SQLiteError)) {
    return err;
  }
  const rc = err.errno;
  const str = errStr(rc);
  const msg = err.message;
  const text = msg === str ? `${str} (${rc})` : `${str}: ${msg} (${rc})`;
  return new Error(text, { cause: err });
}

// runs fn, converting a thrown SQLiteError into the driver's error
export function withDriverErrors<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw driverError(err);
  }
}
