// Upstream: the Go SQLite driver PocketBase v0.41.0 pins (modernc.org/sqlite
// v1.60.1, stmt.go: newStmt, stmt.exec, stmt.query) as database/sql uses it,
// and SQLite's complete.c (sqlite3_complete) for statement boundaries.
//
// bun:sqlite prepares only the first statement of a SQL text and ignores the
// rest, and Database.run reports the total of all statements' changes. The
// Go driver runs a SQL text holding several statements ("a script") one
// statement at a time:
//
//   - Exec runs every statement to completion; its result (rows affected,
//     last insert id) is sqlite3_changes() and sqlite3_last_insert_rowid()
//     after the last one.
//   - Query steps every statement once, in order, and returns the rows of a
//     statement that produced a row, replaced by any later statement that
//     produces one. A statement that produced no row is the result only when
//     nothing was chosen before it or nothing (not even whitespace) follows
//     it. So the rows usually come from the last statement.
//   - Every statement binds the same arguments: its parameter i is
//     argument i.
//   - Statements with only whitespace and comments are skipped.
//
// splitStatements finds the statement boundaries with sqlite3_complete's
// tokenizer and state machine, which knows that the semicolons inside
// CREATE TRIGGER ... BEGIN ... END belong to the trigger.

import type { Database, SQLQueryBindings, Statement } from "bun:sqlite";

import type { ExecResult } from "@/db/dbx/query";
import { narrowInteger, Rows } from "@/db/dbx/rows";

export interface ScriptPart {
  // the statement's SQL, without its terminating semicolon
  sql: string;
  // nothing follows the statement, not even whitespace (the driver's
  // "*psql == 0" after preparing it)
  last: boolean;
}

// sqlite3_complete's tokens
const tkSEMI = 0;
const tkWS = 1;
const tkOTHER = 2;
const tkEXPLAIN = 3;
const tkCREATE = 4;
const tkTEMP = 5;
const tkTRIGGER = 6;
const tkEND = 7;

// sqlite3_complete's state transitions; state 1 (START) after a semicolon
// ends a statement
const trans: readonly (readonly number[])[] = [
  /*               SEMI  WS  OTHER  EXPLAIN  CREATE  TEMP  TRIGGER  END */
  /* 0 NOTHING */ [1, 0, 2, 3, 4, 2, 2, 2],
  /* 1   START */ [1, 1, 2, 3, 4, 2, 2, 2],
  /* 2  NORMAL */ [1, 2, 2, 2, 2, 2, 2, 2],
  /* 3 EXPLAIN */ [1, 3, 3, 2, 4, 2, 2, 2],
  /* 4  CREATE */ [1, 4, 2, 2, 2, 4, 5, 2],
  /* 5 TRIGGER */ [6, 5, 5, 5, 5, 5, 5, 5],
  /* 6    SEMI */ [6, 6, 5, 5, 5, 5, 5, 7],
  /* 7     END */ [1, 7, 5, 5, 5, 5, 5, 5],
];

// a Map, so identifiers such as "constructor" or "__proto__" stay tkOTHER
const keywords: ReadonlyMap<string, number> = new Map([
  ["create", tkCREATE],
  ["trigger", tkTRIGGER],
  ["temp", tkTEMP],
  ["temporary", tkTEMP],
  ["end", tkEND],
  ["explain", tkEXPLAIN],
]);

// IdChar: letters, digits, "_", "$" and every non-ASCII character
function isIdChar(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x5f || // _
    code === 0x24 || // $
    code >= 0x80
  );
}

// text without a semicolon that starts with a token (not whitespace or a
// comment) is one statement
function isPlainStatement(sql: string): boolean {
  if (sql.length === 0 || sql.includes(";")) {
    return false;
  }
  const c = sql[0];
  return (
    c !== " " && c !== "\r" && c !== "\t" && c !== "\n" && c !== "\f" && c !== "-" && c !== "/"
  );
}

// splitStatements splits a SQL text into its statements, skipping the ones
// with only whitespace and comments. An unterminated string, identifier or
// comment extends to the end of the text, where preparing it reports the
// error (or, for a comment, finds nothing to run).
export function splitStatements(sql: string): ScriptPart[] {
  if (isPlainStatement(sql)) {
    return [{ sql, last: true }];
  }

  const parts: ScriptPart[] = [];
  const n = sql.length;
  let state = 0;
  let start = 0;
  let blank = true;

  for (let i = 0; i < n; i++) {
    const c = sql[i]!;
    let token: number;
    switch (c) {
      case ";":
        token = tkSEMI;
        break;
      case " ":
      case "\r":
      case "\t":
      case "\n":
      case "\f":
        token = tkWS;
        break;
      case "/": {
        if (sql[i + 1] !== "*") {
          token = tkOTHER;
          break;
        }
        const end = sql.indexOf("*/", i + 2);
        i = end === -1 ? n - 1 : end + 1;
        token = tkWS;
        break;
      }
      case "-": {
        if (sql[i + 1] !== "-") {
          token = tkOTHER;
          break;
        }
        const end = sql.indexOf("\n", i);
        i = end === -1 ? n - 1 : end;
        token = tkWS;
        break;
      }
      case "[": {
        const end = sql.indexOf("]", i + 1);
        i = end === -1 ? n - 1 : end;
        token = tkOTHER;
        break;
      }
      case "`":
      case '"':
      case "'": {
        const end = sql.indexOf(c, i + 1);
        i = end === -1 ? n - 1 : end;
        token = tkOTHER;
        break;
      }
      default: {
        if (!isIdChar(sql.charCodeAt(i))) {
          token = tkOTHER;
          break;
        }
        let j = i + 1;
        while (j < n && isIdChar(sql.charCodeAt(j))) {
          j++;
        }
        token = keywords.get(sql.slice(i, j).toLowerCase()) ?? tkOTHER;
        i = j - 1;
        break;
      }
    }

    state = trans[state]![token]!;
    if (token === tkSEMI) {
      if (state === 1) {
        if (!blank) {
          parts.push({ sql: sql.slice(start, i), last: i + 1 === n });
        }
        start = i + 1;
        blank = true;
      }
    } else if (token !== tkWS) {
      blank = false;
    }
  }

  if (!blank) {
    parts.push({ sql: sql.slice(start), last: true });
  }
  return parts;
}

// a single statement that the driver prepares once and caches (newStmt
// without a tail)
export function isSingle(parts: ScriptPart[]): parts is [ScriptPart] {
  return parts.length === 1 && parts[0]!.last;
}

// the arguments a statement binds: argument i for its parameter i
function bindArgs(stmt: Statement, args: SQLQueryBindings[]): SQLQueryBindings[] {
  const n = stmt.paramsCount;
  if (args.length < n) {
    throw new Error(`missing argument with index ${args.length + 1}`);
  }
  return args.length === n ? args : args.slice(0, n);
}

// sql.Result after the last statement: sqlite3_changes() counts only that
// statement's direct changes (and keeps the previous count for a statement
// that changes nothing), unlike the change counts bun:sqlite reports
function lastResult(conn: Database): ExecResult {
  const [changes, rowid] = conn
    .query("SELECT changes(), last_insert_rowid()")
    .safeIntegers(true)
    .values()[0]!;
  return {
    rowsAffected: Number(changes),
    lastInsertId: narrowInteger(rowid) as number | bigint,
  };
}

// stmt.exec: runs every statement to completion. `prepared` is the statement
// of a single-statement prepared query; another single statement runs on
// the connection's cached statement for its SQL.
export function execStatements(
  conn: Database,
  parts: ScriptPart[],
  args: SQLQueryBindings[],
  prepared: Statement | null,
): ExecResult {
  if (isSingle(parts)) {
    const stmt = prepared ?? conn.query(parts[0].sql);
    stmt.run(...bindArgs(stmt, args));
    return lastResult(conn);
  }

  let result: ExecResult | null = null;
  for (const part of parts) {
    const stmt = conn.prepare(part.sql);
    try {
      stmt.run(...bindArgs(stmt, args));
    } finally {
      stmt.finalize();
    }
    result = lastResult(conn);
  }
  // the driver returns no result when there was nothing to run
  return result ?? { rowsAffected: 0, lastInsertId: 0 };
}

// stmt.query: the rows of the statement chosen as described above. A
// single statement is not stepped until its rows are read. `own` gives
// the rows a statement of their own instead of the connection's cached
// one, for rows read while other queries run.
export function queryStatements(
  conn: Database,
  parts: ScriptPart[],
  args: SQLQueryBindings[],
  prepared: Statement | null,
  own: boolean,
): Rows {
  if (isSingle(parts)) {
    const sql = parts[0].sql;
    if (prepared !== null) {
      return new Rows(conn, prepared, sql, bindArgs(prepared, args), false);
    }
    const stmt = (own ? conn.prepare(sql) : conn.query(sql)).safeIntegers(true);
    return new Rows(conn, stmt, sql, bindArgs(stmt, args), own);
  }

  let result: Rows | null = null;
  try {
    for (const part of parts) {
      const stmt = conn.prepare(part.sql).safeIntegers(true);
      let rows: Rows;
      try {
        rows = new Rows(conn, stmt, part.sql, bindArgs(stmt, args), true);
      } catch (err) {
        stmt.finalize();
        throw err;
      }
      if (rows.prefetch()) {
        result?.close();
        result = rows;
      } else if (result === null) {
        result = rows;
      } else if (part.last) {
        result.close();
        result = rows;
      } else {
        rows.close();
      }
    }
  } catch (err) {
    result?.close();
    throw err;
  }
  return result ?? Rows.empty();
}
