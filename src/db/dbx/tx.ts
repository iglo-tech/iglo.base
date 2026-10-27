// Upstream: pocketbase/dbx v1.13.0 tx.go, with the parts of Go's sql.Tx it
// relies on: a transaction is BEGIN/COMMIT/ROLLBACK on the connection, and
// using it after Commit or Rollback fails with sql.ErrTxDone.

import type { Database, SQLQueryBindings, Statement } from "bun:sqlite";

import { EmbeddedBuilder, type Builder } from "@/db/dbx/builder";
import { toExecResult, type ExecResult, type Executor } from "@/db/dbx/query";

// sql.ErrTxDone
export class TxDoneError extends Error {
  constructor() {
    super("sql: transaction has already been committed or rolled back");
    this.name = "TxDoneError";
  }
}

export class TxExecutor implements Executor {
  done = false;

  constructor(readonly conn: Database) {}

  exec(sql: string, args: SQLQueryBindings[]): ExecResult {
    this.checkDone();
    return toExecResult(this.conn.run(sql, args));
  }

  statement(sql: string): Statement {
    this.checkDone();
    return this.conn.query(sql);
  }

  prepare(sql: string): Statement {
    this.checkDone();
    return this.conn.prepare(sql);
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
    if (this.tx.done) {
      throw new TxDoneError();
    }
    this.tx.done = true;
  }
}
