// Upstream: pocketbase/dbx v1.13.0 rows.go
//
// Rows wraps a bun:sqlite statement and its bound arguments. Row values are
// read when a resolver asks for them; iterating a Rows object yields each
// row's values in column order (duplicate column names stay distinct).

import type { SQLQueryBindings, Statement } from "bun:sqlite";

import type { Row } from "@/db/dbx/query";

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
    yield* this.stmt.values(...this.args);
  }

  // the first row; throws NoRowsError when there is none
  first(): Row {
    const row = this.stmt.get(...this.args) as Row | null;
    if (row === null) {
      throw new NoRowsError();
    }
    return row;
  }

  // the values of the first row; throws NoRowsError when there is none
  firstValues(): unknown[] {
    const values = this.stmt.values(...this.args);
    const first = values[0];
    if (first === undefined) {
      throw new NoRowsError();
    }
    return first;
  }

  all(): Row[] {
    return this.stmt.all(...this.args) as Row[];
  }

  // the first column of every row
  column(): unknown[] {
    return this.stmt.values(...this.args).map((values) => values[0]);
  }
}
