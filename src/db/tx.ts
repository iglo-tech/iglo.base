// Upstream: core/db_tx.go
//
// Upstream's model hooks register their "after" calls with OnComplete; the
// hooks are not ported (D5), but OnComplete stays for internal callers that
// must act once the transaction ends (for example resetting a created
// model's "new" state when the transaction fails, see db.ts).
//
// The callback runs synchronously (see DB.transactional): network calls
// never run inside a write transaction (AGENTS.md).

import { DB, Errors, isPromiseLike } from "@/db/dbx/db";
import { Tx } from "@/db/dbx/tx";
import type { Builder } from "@/db/dbx/builder";
import type { Databases } from "@/db/base";

// RunInTransaction wraps fn into a transaction for the regular app database.
//
// It is safe to nest RunInTransaction calls as long as you use the callback's txApp.
export function runInTransaction(app: Databases, fn: (txApp: Databases) => void): void {
  runInTx(app, app.nonconcurrentDB(), fn, false);
}

// AuxRunInTransaction wraps fn into a transaction for the auxiliary app database.
//
// It is safe to nest RunInTransaction calls as long as you use the callback's txApp.
export function auxRunInTransaction(app: Databases, fn: (txApp: Databases) => void): void {
  runInTx(app, app.auxNonconcurrentDB(), fn, true);
}

function runInTx(
  app: Databases,
  db: Builder,
  fn: (txApp: Databases) => void,
  isForAuxDB: boolean,
): void {
  if (db instanceof Tx) {
    // run as part of the already existing transaction
    const result: unknown = fn(app);
    if (isPromiseLike(result)) {
      // the promise still settles; its outcome no longer matters
      Promise.resolve(result).catch(() => {});
      throw new Error("transaction function must be synchronous (it returned a promise)");
    }
    return;
  }

  if (!(db instanceof DB)) {
    throw new Error("failed to start transaction (unknown db type)");
  }

  let txApp: Databases | null = null;
  let txErr: unknown = null;
  let failed = false;
  try {
    db.transactional((tx) => {
      txApp = app.createTxApp(tx, isForAuxDB);
      // returned so that transactional() can reject a promise
      return fn(txApp);
    });
  } catch (err) {
    failed = true;
    txErr = err;
  }

  // execute all after event calls on transaction complete
  const txInfo = (txApp as Databases | null)?.txInfo() ?? null;
  if (txInfo !== null) {
    const afterFuncErr = txInfo.runAfterFuncs(failed ? txErr : null);
    if (afterFuncErr !== null) {
      throw failed ? new Errors([txErr, afterFuncErr]) : afterFuncErr;
    }
  }

  if (failed) {
    throw txErr;
  }
}

// TxAppInfo represents an active transaction context associated to an existing app instance.
export class TxAppInfo {
  private afterFuncs: ((txErr: unknown) => void)[] = [];

  constructor(
    readonly parent: Databases,
    readonly isForAuxDB: boolean,
  ) {}

  // OnComplete registers the provided callback that will be invoked
  // once the related transaction ends (either completes successfully or rollbacked with an error).
  //
  // The callback receives the transaction error (null on success) as its argument.
  // Any errors thrown by the OnComplete callbacks will be
  // joined together with txErr when returning the final transaction result.
  onComplete(fn: (txErr: unknown) => void): void {
    this.afterFuncs.push(fn);
  }

  // note: can be called only once because TxAppInfo is cleared
  runAfterFuncs(txErr: unknown): Error | null {
    const errs: unknown[] = [];

    for (const call of this.afterFuncs) {
      try {
        call(txErr);
      } catch (err) {
        errs.push(err);
      }
    }

    this.afterFuncs = [];

    if (errs.length > 0) {
      const joined = new Errors(errs);
      return new Error(`transaction afterFunc errors: ${joined.message}`, { cause: joined });
    }

    return null;
  }
}
