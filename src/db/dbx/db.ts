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

// Upstream: pocketbase/dbx v1.13.0 db.go
//
// A DB wraps one bun:sqlite connection (Go wraps a *sql.DB pool). Clones
// share the connection. Only the SQLite and standard builders are ported;
// the MySQL, PostgreSQL, MSSQL and OCI ones are not used by PocketBase.

import type { Database, SQLQueryBindings, Statement } from "bun:sqlite";

import { EmbeddedBuilder, type Builder } from "@/db/dbx/builder";
import { SqliteBuilder } from "@/db/dbx/builder-sqlite";
import { StandardBuilder } from "@/db/dbx/builder-standard";
import {
  toExecResult,
  type ExecLogFunc,
  type ExecResult,
  type Executor,
  type QueryLogFunc,
} from "@/db/dbx/query";
import { Tx, TxDoneError, TxExecutor } from "@/db/dbx/tx";

// BuilderFunc creates a Builder instance using the given DB instance and Executor.
export type BuilderFunc = (db: DB, executor: Executor) => Builder;

// BuilderFuncMap lists supported BuilderFunc according to DB driver names.
// If a DB driver is not listed here, the StandardBuilder will be used.
const builderFuncMap: Readonly<Record<string, BuilderFunc>> = {
  sqlite: (db, executor) => new SqliteBuilder(db, executor),
  sqlite3: (db, executor) => new SqliteBuilder(db, executor),
};

// Errors represents a list of errors.
export class Errors extends Error {
  constructor(readonly errors: unknown[]) {
    super(errors.map((e) => (e instanceof Error ? e.message : String(e))).join("\n"));
    this.name = "Errors";
  }
}

class ConnExecutor implements Executor {
  constructor(private readonly conn: Database) {}

  exec(sql: string, args: SQLQueryBindings[]): ExecResult {
    return toExecResult(this.conn.run(sql, args));
  }

  statement(sql: string): Statement {
    return this.conn.query(sql);
  }

  prepare(sql: string): Statement {
    return this.conn.prepare(sql);
  }
}

// DB enhances sql.DB by providing a set of DB-agnostic query building methods.
// DB allows easier query building and population of data into variables.
export class DB extends EmbeddedBuilder {
  builder: Builder;

  // QueryLogFunc is called each time when performing a SQL query that returns data.
  queryLogFunc: QueryLogFunc | null = null;
  // ExecLogFunc is called each time when a SQL statement is executed.
  execLogFunc: ExecLogFunc | null = null;

  private readonly executor: Executor;

  constructor(
    private readonly sqlDB: Database,
    private readonly driver: string,
  ) {
    super();
    this.executor = new ConnExecutor(sqlDB);
    this.builder = this.newBuilder(this.executor);
  }

  // Clone makes a shallow copy of DB.
  clone(): DB {
    const db2 = new DB(this.sqlDB, this.driver);
    db2.queryLogFunc = this.queryLogFunc;
    db2.execLogFunc = this.execLogFunc;
    return db2;
  }

  // DB returns the bun:sqlite connection encapsulated by dbx.DB.
  conn(): Database {
    return this.sqlDB;
  }

  // Close closes the database, releasing any open resources.
  close(): void {
    this.sqlDB.close();
  }

  // Begin starts a transaction.
  begin(): Tx {
    this.sqlDB.run("BEGIN");
    const executor = new TxExecutor(this.sqlDB);
    return new Tx(this.newBuilder(executor), executor);
  }

  // Transactional starts a transaction and executes the given function.
  // If the function throws, the transaction will be rolled back.
  // Otherwise, the transaction will be committed.
  //
  // The function must be synchronous: the transaction holds the only write
  // connection, and work awaited inside it would interleave with other
  // writers. A function that returns a promise rolls the transaction back
  // and fails.
  transactional(f: (tx: Tx) => void): void {
    const tx = this.begin();

    let result: unknown;
    try {
      result = f(tx);
      if (isPromiseLike(result)) {
        // the promise still settles; its outcome no longer matters
        Promise.resolve(result).catch(() => {});
        throw new Error("transaction function must be synchronous (it returned a promise)");
      }
    } catch (err) {
      try {
        tx.rollback();
      } catch (err2) {
        if (err2 instanceof TxDoneError) {
          throw err;
        }
        throw new Errors([err, err2]);
      }
      throw err;
    }

    try {
      tx.commit();
    } catch (err) {
      if (err instanceof TxDoneError) {
        return;
      }
      throw err;
    }
  }

  // DriverName returns the name of the DB driver.
  driverName(): string {
    return this.driver;
  }

  // QuoteTableName quotes the given table name appropriately.
  // If the table name contains DB schema prefix, it will be handled accordingly.
  // This method will do nothing if the table name is already quoted or if it contains parenthesis.
  quoteTableName(s: string): string {
    if (s.includes("(") || s.includes("{{")) {
      return s;
    }
    if (!s.includes(".")) {
      return this.quoteSimpleTableName(s);
    }
    return s
      .split(".")
      .map((part) => this.quoteSimpleTableName(part))
      .join(".");
  }

  // QuoteColumnName quotes the given column name appropriately.
  // If the table name contains table name prefix, it will be handled accordingly.
  // This method will do nothing if the column name is already quoted or if it contains parenthesis.
  quoteColumnName(s: string): string {
    if (s.includes("(") || s.includes("{{") || s.includes("[[")) {
      return s;
    }
    let prefix = "";
    const pos = s.lastIndexOf(".");
    if (pos !== -1) {
      prefix = this.quoteTableName(s.slice(0, pos)) + ".";
      s = s.slice(pos + 1);
    }
    return prefix + this.quoteSimpleColumnName(s);
  }

  // processSQL replaces the named param placeholders in the given SQL with anonymous ones.
  // It also quotes table names and column names found in the SQL if these names are enclosed
  // within double square/curly brackets. The method will return the updated SQL and the list of parameter names.
  processSQL(s: string): [string, string[]] {
    const placeholders: string[] = [];
    let count = 0;
    s = s.replace(plRegex, (m) => {
      count++;
      placeholders.push(m.slice(2, -1));
      return this.generatePlaceholder(count);
    });
    s = s.replace(quoteRegex, (m) => {
      if (m[0] === "{") {
        return this.quoteTableName(m.slice(2, -2));
      }
      return this.quoteColumnName(m.slice(2, -2));
    });
    return [s, placeholders];
  }

  // newBuilder creates a query builder based on the current driver name.
  private newBuilder(executor: Executor): Builder {
    const builderFunc = builderFuncMap[this.driver] ?? standardBuilderFunc;
    return builderFunc(this, executor);
  }
}

const standardBuilderFunc: BuilderFunc = (db, executor) => new StandardBuilder(db, executor);

// Go's \w is ASCII only, as JavaScript's without the u flag
const plRegex = /\{:\w+\}/g;
const quoteRegex = /(\{\{[\w\-. ]+\}\}|\[\[[\w\-. ]+\]\])/g;

// NewFromDB encapsulates an existing database connection.
export function newFromDB(sqlDB: Database, driverName: string): DB {
  return new DB(sqlDB, driverName);
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
