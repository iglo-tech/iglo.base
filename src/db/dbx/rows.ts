// Translated from pocketbase/dbx v1.13.0, whose license follows:
//
// The MIT License (MIT)
//
// Copyright (c) 2016, Qiang Xue
// Copyright (c) 2022-present Gani Georgiev
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software
// and associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software
// is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
// BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

// Upstream: pocketbase/dbx v1.13.0 rows.go, with Go's sql.Rows
//
// Rows wraps a bun:sqlite statement and its bound arguments. Iterating a
// Rows object yields each row's values in column order (duplicate column
// names stay distinct). Rows are stepped one at a time, as Go's Rows.Next
// does: first(), firstValues() and an iteration that stops early evaluate
// no further rows. Reading a Rows object consumes it; it closes when the
// rows run out, when a single-row reader returns or on close().
//
// bun:sqlite steps rows incrementally only as objects keyed by column
// name, where duplicate names collapse. A SELECT with duplicate column
// names is therefore read through "SELECT * FROM (...)", whose columns
// SQLite names distinctly ("a", "a:1") in the same order. Statements that
// cannot be a subquery (PRAGMA, RETURNING) with duplicate names are read as
// arrays in one go (all rows).
//
// Statements run with safeIntegers; every reader narrows the integers inside
// Number.MAX_SAFE_INTEGER to numbers and keeps the others as exact bigints.

import type { Database, SQLQueryBindings, Statement } from "bun:sqlite";

import { setOwn, type Row } from "@/db/dbx/query";

// sql.ErrNoRows
export class NoRowsError extends Error {
  constructor() {
    super("sql: no rows in result set");
    this.name = "NoRowsError";
  }
}

export function isNoRowsError(err: unknown): boolean {
  return err instanceof NoRowsError;
}

// a number for a safe integer, the bigint itself otherwise (an unsafe
// bigint converts to a number of at least 2^53, which is not safe either)
export function narrowInteger(value: unknown): unknown {
  if (typeof value === "bigint") {
    const n = Number(value);
    if (Number.isSafeInteger(n)) {
      return n;
    }
  }
  return value;
}

function narrowRow(row: Row, keys: string[]): Row {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "bigint") {
      setOwn(row, key, narrowInteger(value));
    }
  }
  return row;
}

function narrowValues(values: unknown[]): unknown[] {
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (typeof value === "bigint") {
      values[i] = narrowInteger(value);
    }
  }
  return values;
}

function hasDuplicates(names: string[]): boolean {
  if (names.length > 8) {
    return new Set(names).size !== names.length;
  }
  for (let i = 1; i < names.length; i++) {
    for (let j = 0; j < i; j++) {
      if (names[i] === names[j]) {
        return true;
      }
    }
  }
  return false;
}

export class Rows implements Iterable<unknown[]> {
  private readonly names: string[];
  // the statement rows are stepped on: stmt, or stmt wrapped in a subquery
  // when column names repeat
  private reader: Statement | null;
  private wrapped: Statement | null = null;
  // reader's column names in column order; null to read arrays in one go
  private keys: string[] | null;
  private it: Iterator<unknown> | null = null;
  private ahead: IteratorResult<unknown> | null = null;
  private closed = false;

  // `sql` is the statement's SQL; `owned`: the statement is finalized when
  // the rows close
  constructor(
    conn: Database | null,
    private readonly stmt: Statement | null,
    sql: string,
    private readonly args: SQLQueryBindings[],
    private readonly owned: boolean,
  ) {
    this.names = stmt?.columnNames ?? [];
    this.reader = stmt;
    this.keys = this.names;
    if (stmt !== null && conn !== null && hasDuplicates(this.names)) {
      this.wrapped = wrapSubquery(conn, sql, this.names.length);
      this.reader = this.wrapped;
      this.keys = this.wrapped?.columnNames ?? null;
    }
  }

  // rows with no columns (a query without statements)
  static empty(): Rows {
    const rows = new Rows(null, null, "", [], false);
    rows.closed = true;
    return rows;
  }

  // Columns returns the column names.
  columns(): string[] {
    return this.names;
  }

  // the declared column types (sql.ColumnType.DatabaseTypeName); null for
  // expressions. Like Go's Rows.ColumnTypes, read it before the rows close.
  declaredTypes(): (string | null)[] {
    return this.stmt?.declaredTypes ?? [];
  }

  // steps the first row now, as the driver does when it runs a query;
  // reports whether there is one
  prefetch(): boolean {
    try {
      this.ahead = this.open().next();
    } catch (err) {
      this.close();
      throw err;
    }
    return this.ahead.done !== true;
  }

  *[Symbol.iterator](): Iterator<unknown[]> {
    try {
      for (let values = this.step(); values !== null; values = this.step()) {
        yield values;
      }
    } finally {
      this.close();
    }
  }

  // the first row; throws NoRowsError when there is none
  first(): Row {
    if (this.fresh()) {
      try {
        const row = this.reader!.get(...this.args) as Row | null;
        if (row === null) {
          throw new NoRowsError();
        }
        return narrowRow(row, this.names);
      } finally {
        this.close();
      }
    }
    return this.toRow(this.firstValues());
  }

  // the values of the first row; throws NoRowsError when there is none
  firstValues(): unknown[] {
    try {
      const values = this.step();
      if (values === null) {
        throw new NoRowsError();
      }
      return values;
    } finally {
      this.close();
    }
  }

  all(): Row[] {
    if (this.fresh()) {
      try {
        const rows = this.reader!.all(...this.args) as Row[];
        for (const row of rows) {
          narrowRow(row, this.names);
        }
        return rows;
      } finally {
        this.close();
      }
    }
    const rows: Row[] = [];
    for (const values of this) {
      rows.push(this.toRow(values));
    }
    return rows;
  }

  // the first column of every row
  column(): unknown[] {
    const result: unknown[] = [];
    for (const values of this) {
      result.push(values[0]);
    }
    return result;
  }

  // Close closes the rows (and the statements they own).
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.ahead = null;
    try {
      this.it?.return?.();
    } finally {
      this.it = null;
      this.wrapped?.finalize();
      if (this.owned) {
        this.stmt?.finalize();
      }
    }
  }

  // nothing read yet, and rows are objects keyed by the column names
  private fresh(): boolean {
    return !this.closed && this.it === null && this.reader === this.stmt;
  }

  private open(): Iterator<unknown> {
    if (this.it === null) {
      if (this.keys === null) {
        this.it = this.stmt!.values(...this.args)[Symbol.iterator]();
      } else {
        this.it = this.reader!.iterate(...this.args);
      }
    }
    return this.it;
  }

  // the next row's values; null (and the rows closed) when there are no more
  private step(): unknown[] | null {
    if (this.closed) {
      return null;
    }
    let next: IteratorResult<unknown>;
    try {
      next = this.ahead ?? this.open().next();
    } catch (err) {
      this.close();
      throw err;
    }
    this.ahead = null;
    if (next.done === true) {
      this.close();
      return null;
    }
    const keys = this.keys;
    if (keys === null) {
      return narrowValues(next.value as unknown[]);
    }
    const row = next.value as Row;
    return keys.map((key) => narrowInteger(row[key]));
  }

  // a row object; for a repeated column name the last column wins, as in
  // Go's NullStringMap
  private toRow(values: unknown[]): Row {
    const row: Row = {};
    for (let i = 0; i < this.names.length; i++) {
      setOwn(row, this.names[i]!, values[i]);
    }
    return row;
  }
}

// the statement as "SELECT * FROM (...)" with distinct column names, or
// null when it cannot be a subquery
function wrapSubquery(conn: Database, sql: string, columns: number): Statement | null {
  let wrapped: Statement;
  try {
    // the newline ends a trailing "--" comment
    wrapped = conn.prepare(`SELECT * FROM (${sql}\n)`).safeIntegers(true);
  } catch {
    return null;
  }
  const names = wrapped.columnNames;
  if (names.length !== columns || hasDuplicates(names)) {
    wrapped.finalize();
    return null;
  }
  return wrapped;
}
