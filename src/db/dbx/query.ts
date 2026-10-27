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

// Upstream: pocketbase/dbx v1.13.0 query.go
//
// Go's database/sql calls (Exec, Query, Prepare) map to bun:sqlite
// statements. Errors are thrown instead of returned, and the query
// resolvers return what they read instead of scanning into pointers:
// One() a row object (or the given StructModel), All() an array, Row() the
// first row's values, Column() the first column's values. Queries have no
// context.Context: query timeouts are left to M0.6 (D8).
//
// Integers are read losslessly: statements run with bun:sqlite's
// safeIntegers, and the row readers (rows.ts) narrow every integer inside
// Number.MAX_SAFE_INTEGER to a number. Integers outside it stay bigint, as
// Go's int64 and NullStringMap keep them exact, and binding a bigint stores
// the exact value. M1.8 maps them to record values.

import type { SQLQueryBindings, Statement } from "bun:sqlite";

import type { DB } from "@/db/dbx/db";
import { Rows } from "@/db/dbx/rows";
import { isStructModel, scanStruct, type StructModel } from "@/db/dbx/struct";

// Params represents a list of parameter values to be bound to a SQL statement.
// The map keys are the parameter names while the map values are the corresponding parameter values.
export type Params = Record<string, unknown>;

// a result row keyed by column name, as bun:sqlite returns it
export type Row = Record<string, unknown>;

// sql.Result
export interface ExecResult {
  rowsAffected: number;
  lastInsertId: number;
}

// Executor prepares, executes, or queries a SQL statement
// (a DB connection or a transaction).
export interface Executor {
  // Exec executes a SQL statement (or several, separated by semicolons)
  exec(sql: string, args: SQLQueryBindings[]): ExecResult;
  // a cached statement for a single query
  statement(sql: string): Statement;
  // Prepare creates a prepared statement that the caller closes
  prepare(sql: string): Stmt;
}

// sql.Stmt: a prepared statement. A statement prepared in a transaction is
// closed when the transaction ends (sql.Tx closes its statements on Commit
// and Rollback), so it cannot run outside it.
export class Stmt {
  private closed = false;

  constructor(private readonly stmt: Statement) {}

  // the statement to run; throws once the statement is closed
  use(): Statement {
    if (this.closed) {
      throw new Error("sql: statement is closed");
    }
    return this.stmt;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stmt.finalize();
  }
}

// ExecHookFunc executes before op allowing custom handling like auto fail/retry.
export type ExecHookFunc = (q: Query, op: () => void) => void;

// OneHookFunc executes right before the query populate the row result from One() call (aka. op).
// Its return value is what One() returns.
export type OneHookFunc = (q: Query, a: unknown, op: (b: unknown) => unknown) => unknown;

// AllHookFunc executes right before the query populate the row result from All() call (aka. op).
// Its return value is what All() returns.
export type AllHookFunc = (
  q: Query,
  sliceA: unknown,
  op: (sliceB: unknown) => unknown[],
) => unknown;

// QueryLogFunc is called each time when performing a SQL query.
// The "ms" parameter gives the time that the SQL statement takes to execute.
export type QueryLogFunc = (ms: number, sql: string, err: unknown) => void;

// ExecLogFunc is called each time when a SQL statement is executed.
export type ExecLogFunc = (
  ms: number,
  sql: string,
  result: ExecResult | null,
  err: unknown,
) => void;

// Query represents a SQL statement to be executed.
export class Query {
  private readonly sqlText: string;
  private rawSql: string;
  private readonly placeholders: string[];
  private boundParams: Params = {};
  private stmt: Stmt | null = null;

  private execHook: ExecHookFunc | null = null;
  private oneHook: OneHookFunc | null = null;
  private allHook: AllHookFunc | null = null;

  // LastError contains the last error (if any) of the query.
  // LastError is cleared by Execute(), Row(), Rows(), One(), and All().
  lastError: unknown = null;
  // QueryLogFunc is called each time when performing a SQL query that returns data.
  queryLogFunc: QueryLogFunc | null;
  // ExecLogFunc is called each time when a SQL statement is executed.
  execLogFunc: ExecLogFunc | null;

  constructor(
    db: DB,
    private readonly executor: Executor,
    sql: string,
  ) {
    const [rawSQL, placeholders] = db.processSQL(sql);
    this.sqlText = sql;
    this.rawSql = rawSQL;
    this.placeholders = placeholders;
    this.queryLogFunc = db.queryLogFunc;
    this.execLogFunc = db.execLogFunc;
  }

  // SQL returns the original SQL used to create the query.
  // The actual SQL (RawSQL) being executed is obtained by replacing the named
  // parameter placeholders with anonymous ones.
  sql(): string {
    return this.sqlText;
  }

  // the SQL that is executed: placeholders replaced and names quoted
  rawSQL(): string {
    return this.rawSql;
  }

  // WithExecHook associates the provided exec hook function with the query.
  //
  // It is called for every Query resolver (Execute(), One(), All(), Row(), Column()),
  // allowing you to implement auto fail/retry or any other additional handling.
  withExecHook(fn: ExecHookFunc | null): this {
    this.execHook = fn;
    return this;
  }

  // WithOneHook associates the provided hook function with the query,
  // called on q.One(), allowing you to implement custom struct scan based
  // on the One() argument and/or result.
  withOneHook(fn: OneHookFunc | null): this {
    this.oneHook = fn;
    return this;
  }

  // WithAllHook associates the provided hook function with the query,
  // called on q.All(), allowing you to implement custom slice scan based
  // on the All() argument and/or result.
  withAllHook(fn: AllHookFunc | null): this {
    this.allHook = fn;
    return this;
  }

  // logSQL returns the SQL statement with parameters being replaced with the actual values.
  // The result is only for logging purpose and should not be used to execute.
  logSQL(): string {
    let s = this.sqlText;
    for (const [k, v] of Object.entries(this.boundParams)) {
      let sv: string;
      if (typeof v === "string") {
        sv = "'" + v.replaceAll("'", "''") + "'";
      } else if (v instanceof Uint8Array) {
        sv = "0x" + Buffer.from(v).toString("hex");
      } else if (v === null || v === undefined) {
        sv = "<nil>";
      } else {
        sv = String(v);
      }
      s = s.replaceAll("{:" + k + "}", sv);
    }
    return s;
  }

  // Params returns the parameters to be bound to the SQL statement represented by this query.
  params(): Params {
    return this.boundParams;
  }

  // Prepare creates a prepared statement for later queries or executions.
  // Close() should be called after finishing all queries.
  prepare(): this {
    try {
      this.stmt = this.executor.prepare(this.rawSql);
    } catch (err) {
      this.lastError = err;
    }
    return this;
  }

  // Close closes the underlying prepared statement.
  // Close does nothing if the query has not been prepared before.
  close(): void {
    if (this.stmt === null) {
      return;
    }
    const stmt = this.stmt;
    this.stmt = null;
    stmt.close();
  }

  // Bind sets the parameters that should be bound to the SQL statement.
  // The parameter placeholders in the SQL statement are in the format of "{:ParamName}".
  bind(params: Params): this {
    if (Object.keys(this.boundParams).length === 0) {
      this.boundParams = params;
    } else {
      Object.assign(this.boundParams, params);
    }
    return this;
  }

  // Execute executes the SQL statement without retrieving data.
  execute(): ExecResult {
    let result: ExecResult = { rowsAffected: 0, lastInsertId: 0 };
    this.execWrap(() => {
      result = this.executeOp();
    });
    return result;
  }

  private executeOp(): ExecResult {
    this.takeLastError();
    const args = replacePlaceholders(this.placeholders, this.boundParams);

    const start = performance.now();
    let result: ExecResult | null = null;
    let err: unknown = null;
    try {
      if (this.stmt === null) {
        result = this.executor.exec(this.rawSql, args);
      } else {
        result = toExecResult(this.stmt.use().run(...args));
      }
      return result;
    } catch (e) {
      err = e;
      throw e;
    } finally {
      this.execLogFunc?.(performance.now() - start, this.logSQL(), result, err);
    }
  }

  // One executes the SQL statement and returns the first row of the result:
  // the row object, or the given model populated with it.
  // Note that when the query has no rows in the result set, a NoRowsError is thrown.
  one<T = Row>(a?: StructModel): T {
    let result: unknown = undefined;
    this.execWrap(() => {
      const op = (b: unknown): unknown => {
        const row = this.rowsOp().first();
        if (isStructModel(b)) {
          scanStruct(b, row);
          return b;
        }
        return row;
      };
      result = this.oneHook !== null ? this.oneHook(this, a, op) : op(a);
    });
    return result as T;
  }

  // All executes the SQL statement and returns all the resulting rows:
  // row objects, or models created by the given factory and populated with
  // the rows. If the query returns no row, the result is an empty array.
  all<T = Row>(factory?: () => StructModel): T[] {
    let result: unknown = [];
    this.execWrap(() => {
      const op = (b: unknown): unknown[] => {
        const rows = this.rowsOp().all();
        if (typeof b === "function") {
          return rows.map((row) => {
            const model = (b as () => StructModel)();
            scanStruct(model, row);
            return model;
          });
        }
        return rows;
      };
      result = this.allHook !== null ? this.allHook(this, factory, op) : op(factory);
    });
    return result as T[];
  }

  // Row executes the SQL statement and returns the values of the first row.
  // Note that when the query has no rows in the result set, a NoRowsError is thrown.
  row(): unknown[] {
    let result: unknown[] = [];
    this.execWrap(() => {
      result = this.rowsOp().firstValues();
    });
    return result;
  }

  // Column executes the SQL statement and returns the first column of the result.
  column<T = unknown>(): T[] {
    let result: unknown[] = [];
    this.execWrap(() => {
      result = this.rowsOp().column();
    });
    return result as T[];
  }

  // Rows executes the SQL statement and returns a Rows object to allow retrieving data row by row.
  rows(): Rows {
    return this.rowsOp();
  }

  private rowsOp(): Rows {
    this.takeLastError();
    const args = replacePlaceholders(this.placeholders, this.boundParams);

    const start = performance.now();
    let err: unknown = null;
    try {
      const stmt = this.stmt?.use() ?? this.executor.statement(this.rawSql);
      return new Rows(stmt, args);
    } catch (e) {
      err = e;
      throw e;
    } finally {
      this.queryLogFunc?.(performance.now() - start, this.logSQL(), err);
    }
  }

  private takeLastError(): void {
    const err = this.lastError;
    this.lastError = null;
    if (err !== null) {
      throw err;
    }
  }

  private execWrap(op: () => void): void {
    if (this.execHook !== null) {
      this.execHook(this, op);
      return;
    }
    op();
  }
}

export function toExecResult(changes: {
  changes: number;
  lastInsertRowid: number | bigint;
}): ExecResult {
  return { rowsAffected: changes.changes, lastInsertId: Number(changes.lastInsertRowid) };
}

// replacePlaceholders converts a list of named parameters into a list of anonymous parameters.
export function replacePlaceholders(placeholders: string[], params: Params): SQLQueryBindings[] {
  const result: SQLQueryBindings[] = [];
  for (const name of placeholders) {
    if (!Object.hasOwn(params, name)) {
      throw new Error("Named parameter not found: " + name);
    }
    const value = params[name];
    result.push(value === undefined ? null : (value as SQLQueryBindings));
  }
  return result;
}
