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

// Upstream: pocketbase/dbx v1.13.0 tx.go, with the parts of Go's sql.Tx it
// relies on: a transaction is BEGIN/COMMIT/ROLLBACK on the connection,
// using it after Commit or Rollback fails with sql.ErrTxDone, and the
// statements prepared in it are closed when it ends.

import type { Database, SQLQueryBindings, Statement } from "bun:sqlite";

import { EmbeddedBuilder, type Builder } from "@/db/dbx/builder";
import { Stmt, toExecResult, type ExecResult, type Executor } from "@/db/dbx/query";

// sql.ErrTxDone
export class TxDoneError extends Error {
  constructor() {
    super("sql: transaction has already been committed or rolled back");
    this.name = "TxDoneError";
  }
}

export class TxExecutor implements Executor {
  done = false;
  private readonly stmts: Stmt[] = [];

  constructor(readonly conn: Database) {}

  exec(sql: string, args: SQLQueryBindings[]): ExecResult {
    this.checkDone();
    return toExecResult(this.conn.run(sql, args));
  }

  statement(sql: string): Statement {
    this.checkDone();
    return this.conn.query(sql).safeIntegers(true);
  }

  prepare(sql: string): Stmt {
    this.checkDone();
    const stmt = new Stmt(this.conn.prepare(sql).safeIntegers(true));
    this.stmts.push(stmt);
    return stmt;
  }

  // marks the transaction done and closes its prepared statements
  // (sql.Tx.closePrepared)
  end(): void {
    this.checkDone();
    this.done = true;
    for (const stmt of this.stmts.splice(0)) {
      stmt.close();
    }
  }

  private checkDone(): void {
    if (this.done) {
      throw new TxDoneError();
    }
  }
}

// Tx enhances sql.Tx with additional querying methods.
export class Tx extends EmbeddedBuilder {
  constructor(
    public builder: Builder,
    private readonly tx: TxExecutor,
  ) {
    super();
  }

  // Commit commits the transaction.
  //
  // A failed COMMIT leaves SQLite's transaction open; it is rolled back so
  // the shared connection is not left inside it, and the commit error is
  // thrown.
  commit(): void {
    this.end();
    try {
      this.tx.conn.run("COMMIT");
    } catch (err) {
      if (this.tx.conn.inTransaction) {
        try {
          this.tx.conn.run("ROLLBACK");
        } catch {
          // the commit error is the one to report
        }
      }
      throw err;
    }
  }

  // Rollback aborts the transaction.
  rollback(): void {
    this.end();
    // SQLite may have rolled the transaction back already (for example
    // after SQLITE_FULL or an interrupt)
    if (this.tx.conn.inTransaction) {
      this.tx.conn.run("ROLLBACK");
    }
  }

  private end(): void {
    this.tx.end();
  }
}
