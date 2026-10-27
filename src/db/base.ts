// Upstream: core/base.go (initDataDB, initAuxDB, DB, ConcurrentDB,
// NonconcurrentDB, AuxDB, AuxConcurrentDB, AuxNonconcurrentDB, TxInfo,
// IsTransactional, ClearBootstrap/ResetBootstrapState closing the
// databases, normalizeSQLLog) and core/db_tx.go (createTxApp)
//
// Databases is the database part of upstream's BaseApp. Modules receive it
// instead of reaching for global state; a transaction hands its callback a
// copy whose builders are the transaction (createTxApp).
//
// Upstream opens two connection pools per file: a concurrent one for reads
// (DefaultDataMaxOpenConns 120 / DefaultAuxMaxOpenConns 20 connections) and
// a nonconcurrent one with a single connection for writes. bun:sqlite is
// synchronous, so here both builders of a file share one main-thread
// connection; the read worker pool and --queryTimeout (DefaultQueryTimeout,
// 30s) are decided by the M0.6 spike (D8), which can swap the concurrent
// builders without changing this API.

import { join } from "node:path";

import { defaultDBConnect, type DBConnectFunc } from "@/db/connect";
import type { Builder } from "@/db/dbx/builder";
import { Errors, type DB } from "@/db/dbx/db";
import type { Tx } from "@/db/dbx/tx";
import { DualDBBuilder } from "@/db/dual-builder";
import { defaultSleep, type SleepFunc } from "@/db/retry";
import { TxAppInfo } from "@/db/tx";

export const dataDBFilename = "data.db";
export const auxDBFilename = "auxiliary.db";

export interface DatabasesConfig {
  // the pb_data directory; it must exist (upstream's bootstrap creates it)
  dataDir: string;
  // opens one database file (core.BaseAppConfig.DBConnect)
  dbConnect?: DBConnectFunc;
  // the wait between busy retries; Bun.sleepSync unless set
  sleep?: SleepFunc;
  // --dev: receives every data.db statement, as upstream prints it
  devSQLLog?: (line: string) => void;
}

interface Shared {
  readonly sleep: SleepFunc;
  // the distinct connections, closed once
  readonly dbs: DB[];
  closed: boolean;
}

interface Handles {
  concurrentDB: Builder;
  nonconcurrentDB: Builder;
  auxConcurrentDB: Builder;
  auxNonconcurrentDB: Builder;
}

export class Databases {
  private constructor(
    private readonly handles: Handles,
    private readonly shared: Shared,
    private readonly tx: TxAppInfo | null,
  ) {}

  static open(config: DatabasesConfig): Databases {
    const connect = config.dbConnect ?? defaultDBConnect;
    const sleep = config.sleep ?? defaultSleep;

    // initDataDB
    const concurrentDB = connect(join(config.dataDir, dataDBFilename));
    const nonconcurrentDB = concurrentDB.clone();
    if (config.devSQLLog) {
      const log = config.devSQLLog;
      const logSQL = (ms: number, sql: string): void => {
        log(`[${Math.trunc(ms).toFixed(2)}ms] ${normalizeSQLLog(sql)}`);
      };
      for (const db of [concurrentDB, nonconcurrentDB]) {
        db.queryLogFunc = logSQL;
        db.execLogFunc = logSQL;
      }
    }

    // initAuxDB
    // note: renamed to "auxiliary" because "aux" is a reserved Windows filename
    let auxConcurrentDB: DB;
    try {
      auxConcurrentDB = connect(join(config.dataDir, auxDBFilename));
    } catch (err) {
      concurrentDB.close();
      throw err;
    }
    const auxNonconcurrentDB = auxConcurrentDB.clone();

    return new Databases(
      { concurrentDB, nonconcurrentDB, auxConcurrentDB, auxNonconcurrentDB },
      { sleep, dbs: [concurrentDB, auxConcurrentDB], closed: false },
      null,
    );
  }

  // DB returns the default app data.db builder instance.
  //
  // To minimize SQLITE_BUSY errors, it automatically routes the
  // SELECT queries to the underlying concurrent db pool and everything
  // else to the nonconcurrent one.
  db(): Builder {
    const h = this.open();
    // transactional
    if (h.concurrentDB === h.nonconcurrentDB) {
      return h.concurrentDB;
    }
    return new DualDBBuilder(h.concurrentDB, h.nonconcurrentDB);
  }

  // ConcurrentDB returns the concurrent app data.db builder instance.
  //
  // In a transaction the ConcurrentDB() and NonconcurrentDB() refer to the same *dbx.TX instance.
  concurrentDB(): Builder {
    return this.open().concurrentDB;
  }

  // NonconcurrentDB returns the nonconcurrent app data.db builder instance.
  //
  // In a transaction the ConcurrentDB() and NonconcurrentDB() refer to the same *dbx.TX instance.
  nonconcurrentDB(): Builder {
    return this.open().nonconcurrentDB;
  }

  // AuxDB returns the app auxiliary.db builder instance.
  //
  // To minimize SQLITE_BUSY errors, it automatically routes the
  // SELECT queries to the underlying concurrent db pool and everything
  // else to the nonconcurrent one.
  auxDB(): Builder {
    const h = this.open();
    // transactional
    if (h.auxConcurrentDB === h.auxNonconcurrentDB) {
      return h.auxConcurrentDB;
    }
    return new DualDBBuilder(h.auxConcurrentDB, h.auxNonconcurrentDB);
  }

  // AuxConcurrentDB returns the concurrent app auxiliary.db builder instance.
  //
  // In a transaction the AuxConcurrentDB() and AuxNonconcurrentDB() refer to the same *dbx.TX instance.
  auxConcurrentDB(): Builder {
    return this.open().auxConcurrentDB;
  }

  // AuxNonconcurrentDB returns the nonconcurrent app auxiliary.db builder instance.
  //
  // In a transaction the AuxConcurrentDB() and AuxNonconcurrentDB() refer to the same *dbx.TX instance.
  auxNonconcurrentDB(): Builder {
    return this.open().auxNonconcurrentDB;
  }

  // TxInfo returns the transaction associated with the current app instance (if any).
  txInfo(): TxAppInfo | null {
    return this.tx;
  }

  // IsTransactional checks if the current app instance is part of a transaction.
  isTransactional(): boolean {
    return this.tx !== null;
  }

  // the wait between busy retries
  sleep(ms: number): void {
    this.shared.sleep(ms);
  }

  // createTxApp shallow clones the current app and assigns a new tx state.
  createTxApp(tx: Tx, isForAuxDB: boolean): Databases {
    const handles = isForAuxDB
      ? { ...this.handles, auxConcurrentDB: tx, auxNonconcurrentDB: tx }
      : { ...this.handles, concurrentDB: tx, nonconcurrentDB: tx };
    return new Databases(handles, this.shared, new TxAppInfo(this, isForAuxDB));
  }

  // ClearBootstrap releases the databases (closing the db connections).
  // Closing again is a no-op.
  close(): void {
    if (this.shared.closed) {
      return;
    }
    this.shared.closed = true;

    const errs: unknown[] = [];
    for (const db of this.shared.dbs) {
      try {
        db.close();
      } catch (err) {
        errs.push(err);
      }
    }
    if (errs.length > 0) {
      throw new Errors(errs);
    }
  }

  private open(): Handles {
    if (this.shared.closed) {
      throw new Error("the databases are closed");
    }
    return this.handles;
  }
}

const sqlLogReplacements: readonly { pattern: RegExp; replacement: string }[] = [
  { pattern: /\[\[([^[\]{}.]+)\.([^[\]{}.]+)\]\]/g, replacement: "`$1`.`$2`" },
  { pattern: /\{\{([^[\]{}.]+)\.([^[\]{}.]+)\}\}/g, replacement: "`$1`.`$2`" },
  { pattern: /([^'"])?\{\{/g, replacement: "$1`" },
  { pattern: /\}\}([^'"])?/g, replacement: "`$1" },
  { pattern: /([^'"])?\[\[/g, replacement: "$1`" },
  { pattern: /\]\]([^'"])?/g, replacement: "`$1" },
  { pattern: /<nil>/g, replacement: "NULL" },
];

// normalizeSQLLog replaces common query builder characters with their plain SQL version for easier debugging.
// The query is still not suitable for execution and should be used only for log and debug purposes
// (the normalization is done here to avoid breaking changes in dbx).
export function normalizeSQLLog(sql: string): string {
  for (const item of sqlLogReplacements) {
    sql = sql.replace(item.pattern, item.replacement);
  }
  return sql;
}
