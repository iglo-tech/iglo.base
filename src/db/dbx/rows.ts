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

// Upstream: pocketbase/dbx v1.13.0 rows.go
//
// Rows wraps a bun:sqlite statement and its bound arguments. Row values are
// read when a resolver asks for them; iterating a Rows object yields each
// row's values in column order (duplicate column names stay distinct).
// Rows are stepped one at a time, as Go's Rows.Next does: first(),
// firstValues() and an iteration that stops early evaluate no further
// rows. bun:sqlite only steps row objects incrementally, so a result with
// duplicate column names is read as arrays in one go (all rows).
//
// Statements run with safeIntegers; every reader narrows the integers inside
// Number.MAX_SAFE_INTEGER to numbers and keeps the others as exact bigints.

import type { SQLQueryBindings, Statement } from "bun:sqlite";

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
  return new Set(names).size !== names.length;
}

export class Rows implements Iterable<unknown[]> {
  constructor(
    private readonly stmt: Statement,
    private readonly args: SQLQueryBindings[],
  ) {}

  // Columns returns the column names.
  columns(): string[] {
    return this.stmt.columnNames;
  }

  // the declared column types (sql.ColumnType.DatabaseTypeName); null for
  // expressions
  declaredTypes(): (string | null)[] {
    return this.stmt.declaredTypes;
  }

  *[Symbol.iterator](): Iterator<unknown[]> {
    const names = this.stmt.columnNames;
    if (hasDuplicates(names)) {
      for (const values of this.stmt.values(...this.args)) {
        yield narrowValues(values);
      }
      return;
    }
    for (const row of this.stmt.iterate(...this.args) as Iterable<Row>) {
      yield names.map((name) => narrowInteger(row[name]));
    }
  }

  // the first row; throws NoRowsError when there is none
  first(): Row {
    const row = this.stmt.get(...this.args) as Row | null;
    if (row === null) {
      throw new NoRowsError();
    }
    return narrowRow(row, this.stmt.columnNames);
  }

  // the values of the first row; throws NoRowsError when there is none
  firstValues(): unknown[] {
    for (const values of this) {
      return values;
    }
    throw new NoRowsError();
  }

  all(): Row[] {
    const rows = this.stmt.all(...this.args) as Row[];
    const keys = this.stmt.columnNames;
    for (const row of rows) {
      narrowRow(row, keys);
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
}
