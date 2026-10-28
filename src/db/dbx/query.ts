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
// first row's values, Column() the first column's values.
//
// Go's context.Context is reduced to what PocketBase uses it for, a
// deadline (WithDeadline, Deadline). A query with an expired deadline fails
// before it runs, as QueryContext and ExecContext do. A synchronous resolver
// and Rows() check it again before and after each step of reading the rows
// (rows.ts): bun:sqlite cannot interrupt a running statement, so such a
// read fails only once its statement returns (docs/design/04-api-
// compatibility.md, Deliberate differences). The async resolvers (OneAsync, AllAsync,
// RowAsync, ColumnAsync) run the query, prepared or not, on the executor's
// reader when it has one (the read worker pool, src/db/read-pool.ts), which gives up at the
// deadline; otherwise they run it as the synchronous ones do.
//
// Integers are read losslessly: statements run with bun:sqlite's
// safeIntegers, and the row readers (rows.ts) narrow every integer inside
// Number.MAX_SAFE_INTEGER to a number. Integers outside it stay bigint, as
// Go's int64 and NullStringMap keep them exact, and binding a bigint stores
// the exact value. M1.8 maps them to record values. A generated rowid
// (lastInsertId) is narrowed the same way.
//
// A SQL text with several statements runs as Go's SQLite driver runs it
// (driver.ts): Execute() runs them all and reports the last one's result,
// and the rows come from the last statement.
//
// Maps keyed by SQL identifiers (params, rows, columns) are written with
// setOwn, so that a name like "__proto__" is an ordinary key.

import type { Database, SQLQueryBindings, Statement } from "bun:sqlite";

import type { DB } from "@/db/dbx/db";
import {
  execStatements,
  isSingle,
  queryStatements,
  splitStatements,
  type ScriptPart,
} from "@/db/dbx/driver";
import { readRows, type ReadMode, type Rows } from "@/db/dbx/rows";
import { isStructModel, scanStruct, type StructModel } from "@/db/dbx/struct";

// Params represents a list of parameter values to be bound to a SQL statement.
// The map keys are the parameter names while the map values are the corresponding parameter values.
export type Params = Record<string, unknown>;

// a result row keyed by column name, as bun:sqlite returns it
export type Row = Record<string, unknown>;

// sets map[key] as an own data property: plain assignment would call the
// __proto__ setter for the key "__proto__"
export function setOwn(map: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(map, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    map[key] = value;
  }
}

// Object.assign with setOwn
export function assignOwn(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    setOwn(target, key, source[key]);
  }
}

// sql.Result
export interface ExecResult {
  rowsAffected: number;
  // a bigint outside Number.MAX_SAFE_INTEGER
  lastInsertId: number | bigint;
}

// Executor prepares, executes, or queries a SQL statement
// (a DB connection or a transaction).
export interface Executor {
  // Exec executes a SQL statement (or several, separated by semicolons)
  exec(sql: string, args: SQLQueryBindings[]): ExecResult;
  // Query executes a query that returns rows. With `own`, the rows get a
  // statement of their own, so other queries can run while they are read;
  // otherwise a single statement may be the connection's cached one.
  query(sql: string, args: SQLQueryBindings[], own: boolean): Rows;
  // Prepare creates a prepared statement that the caller closes
  prepare(sql: string): Stmt;
  // Reads the result of a query that returns rows on another connection
  // (the read worker pool); an executor without it reads synchronously
  readonly reader?: AsyncReader;
}

// AsyncReader runs a query that returns rows somewhere else than the
// calling thread and resolves with what readRows(rows, mode) returns.
export interface AsyncReader {
  read(
    sql: string,
    args: SQLQueryBindings[],
    mode: ReadMode,
    deadline: Deadline | null,
  ): Promise<unknown>;
}

// context.DeadlineExceeded
export class DeadlineExceededError extends Error {
  constructor() {
    super("context deadline exceeded");
    this.name = "DeadlineExceededError";
  }
}

// Deadline is the part of a Go context.Context with a timeout
// (context.WithTimeout) that queries use: the time after which they fail.
export class Deadline {
  private readonly at: number;

  // timeout in milliseconds; now returns monotonic milliseconds
  constructor(
    timeout: number,
    private readonly now: () => number,
  ) {
    this.at = now() + timeout;
  }

  // the milliseconds left, 0 once expired
  remaining(): number {
    return Math.max(0, this.at - this.now());
  }

  expired(): boolean {
    return this.now() >= this.at;
  }

  // throws DeadlineExceededError once expired (ctx.Err())
  check(): void {
    if (this.expired()) {
      throw new DeadlineExceededError();
    }
  }
}

// sql.Stmt: a prepared statement. A statement prepared in a transaction is
// closed when the transaction ends (sql.Tx closes its statements on Commit
// and Rollback), so it cannot run outside it.
//
// Like the driver's newStmt, a single statement is prepared once; a script
// has its first statement checked now and every statement prepared when it
// runs.
export class Stmt {
  private closed = false;
  private readonly parts: ScriptPart[];
  private readonly single: Statement | null = null;

  constructor(
    private readonly conn: Database,
    sql: string,
  ) {
    const parts = splitStatements(sql);
    this.parts = parts;
    if (isSingle(parts)) {
      this.single = conn.prepare(parts[0].sql).safeIntegers(true);
    } else if (parts.length > 0) {
      conn.prepare(parts[0]!.sql).finalize();
    }
  }

  exec(args: SQLQueryBindings[]): ExecResult {
    this.checkClosed();
    return execStatements(this.conn, this.parts, args, this.single);
  }

  query(args: SQLQueryBindings[]): Rows {
    this.checkClosed();
    return queryStatements(this.conn, this.parts, args, this.single, false);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.single?.finalize();
  }

  private checkClosed(): void {
    if (this.closed) {
      throw new Error("sql: statement is closed");
    }
  }
}

// ExecHookFunc executes before op allowing custom handling like auto fail/retry.
export type ExecHookFunc = (q: Query, op: () => void) => void;

// AsyncExecHookFunc is ExecHookFunc for the async resolvers.
export type AsyncExecHookFunc = (q: Query, op: () => Promise<void>) => Promise<void>;

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

  private ctxDeadline: Deadline | null = null;
  private execHook: ExecHookFunc | null = null;
  private asyncExecHook: AsyncExecHookFunc | null = null;
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

  // Deadline returns the query's deadline (Go: Context), null when none.
  deadline(): Deadline | null {
    return this.ctxDeadline;
  }

  // WithDeadline associates a deadline with the query (Go: WithContext with
  // a context.WithTimeout one); null removes it.
  withDeadline(deadline: Deadline | null): this {
    this.ctxDeadline = deadline;
    return this;
  }

  // WithExecHook associates the provided exec hook function with the query.
  //
  // It is called for every Query resolver (Execute(), One(), All(), Row(), Column()),
  // allowing you to implement auto fail/retry or any other additional handling.
  withExecHook(fn: ExecHookFunc | null): this {
    this.execHook = fn;
    return this;
  }

  // WithAsyncExecHook associates the exec hook of the async resolvers
  // (OneAsync(), AllAsync(), RowAsync(), ColumnAsync()) with the query. A
  // query with a synchronous exec hook only cannot use them.
  withAsyncExecHook(fn: AsyncExecHookFunc | null): this {
    this.asyncExecHook = fn;
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
      assignOwn(this.boundParams, params);
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
    // a statement that writes is never failed after it ran
    this.ctxDeadline?.check();

    const start = performance.now();
    let result: ExecResult | null = null;
    let err: unknown = null;
    try {
      if (this.stmt === null) {
        result = this.executor.exec(this.rawSql, args);
      } else {
        result = this.stmt.exec(args);
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
      const row = this.read("one") as Row;
      result = this.populateOne(row, a);
    });
    return result as T;
  }

  // OneAsync is One, run on the executor's reader when it has one.
  async oneAsync<T = Row>(a?: StructModel): Promise<T> {
    let result: unknown = undefined;
    await this.execWrapAsync(async () => {
      const row = (await this.readAsync("one")) as Row;
      result = this.populateOne(row, a);
    });
    return result as T;
  }

  private populateOne(row: Row, a: StructModel | undefined): unknown {
    const op = (b: unknown): unknown => {
      if (isStructModel(b)) {
        scanStruct(b, row);
        return b;
      }
      return row;
    };
    return this.oneHook !== null ? this.oneHook(this, a, op) : op(a);
  }

  // All executes the SQL statement and returns all the resulting rows:
  // row objects, or models created by the given factory and populated with
  // the rows. If the query returns no row, the result is an empty array.
  all<T = Row>(factory?: () => StructModel): T[] {
    let result: unknown = [];
    this.execWrap(() => {
      const rows = this.read("all") as Row[];
      result = this.populateAll(rows, factory);
    });
    return result as T[];
  }

  // AllAsync is All, run on the executor's reader when it has one.
  async allAsync<T = Row>(factory?: () => StructModel): Promise<T[]> {
    let result: unknown = [];
    await this.execWrapAsync(async () => {
      const rows = (await this.readAsync("all")) as Row[];
      result = this.populateAll(rows, factory);
    });
    return result as T[];
  }

  private populateAll(rows: Row[], factory: (() => StructModel) | undefined): unknown {
    const op = (b: unknown): unknown[] => {
      if (typeof b === "function") {
        return rows.map((row) => {
          const model = (b as () => StructModel)();
          scanStruct(model, row);
          return model;
        });
      }
      return rows;
    };
    return this.allHook !== null ? this.allHook(this, factory, op) : op(factory);
  }

  // Row executes the SQL statement and returns the values of the first row.
  // Note that when the query has no rows in the result set, a NoRowsError is thrown.
  row(): unknown[] {
    let result: unknown[] = [];
    this.execWrap(() => {
      result = this.read("row") as unknown[];
    });
    return result;
  }

  // RowAsync is Row, run on the executor's reader when it has one.
  async rowAsync(): Promise<unknown[]> {
    let result: unknown[] = [];
    await this.execWrapAsync(async () => {
      result = (await this.readAsync("row")) as unknown[];
    });
    return result;
  }

  // Column executes the SQL statement and returns the first column of the result.
  column<T = unknown>(): T[] {
    let result: unknown[] = [];
    this.execWrap(() => {
      result = this.read("column") as unknown[];
    });
    return result as T[];
  }

  // ColumnAsync is Column, run on the executor's reader when it has one.
  async columnAsync<T = unknown>(): Promise<T[]> {
    let result: unknown[] = [];
    await this.execWrapAsync(async () => {
      result = (await this.readAsync("column")) as unknown[];
    });
    return result as T[];
  }

  // Rows executes the SQL statement and returns a Rows object to allow retrieving data row by row.
  // The rows have a statement of their own, so other queries (even the
  // same SQL) can run while they are read. Iterate them to the end or
  // close them.
  rows(): Rows {
    return this.rowsOp(true);
  }

  // runs the query on this thread and reads its rows; a deadline that
  // passed while they were read fails the query (rows.ts), as an
  // interrupted one
  private read(mode: ReadMode): unknown {
    return readRows(this.rowsOp(false), mode);
  }

  private async readAsync(mode: ReadMode): Promise<unknown> {
    const reader = this.executor.reader;
    if (reader === undefined) {
      return this.read(mode);
    }
    // a prepared query reads on the pool too (dbx's prepared QueryContext
    // honors the context); the worker prepares the same SQL text itself
    this.takeLastError();
    const args = replacePlaceholders(this.placeholders, this.boundParams);
    const deadline = this.ctxDeadline;
    deadline?.check();

    const start = performance.now();
    let err: unknown = null;
    try {
      return await reader.read(this.rawSql, args, mode, deadline);
    } catch (e) {
      err = e;
      throw e;
    } finally {
      this.queryLogFunc?.(performance.now() - start, this.logSQL(), err);
    }
  }

  private rowsOp(own: boolean): Rows {
    this.takeLastError();
    const args = replacePlaceholders(this.placeholders, this.boundParams);
    const deadline = this.ctxDeadline;

    const start = performance.now();
    let err: unknown = null;
    try {
      deadline?.check();
      const rows =
        this.stmt !== null ? this.stmt.query(args) : this.executor.query(this.rawSql, args, own);
      return rows.withDeadline(deadline);
    } catch (e) {
      err = deadline?.expired() === true ? new DeadlineExceededError() : e;
      throw err;
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

  private async execWrapAsync(op: () => Promise<void>): Promise<void> {
    if (this.asyncExecHook !== null) {
      await this.asyncExecHook(this, op);
      return;
    }
    if (this.execHook !== null) {
      throw new Error("dbx: the query has no async exec hook; use the synchronous resolvers");
    }
    await op();
  }
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
