// Upstream: core/db_tx_test.go (TestRunInTransaction; the hook call counts
// of the other tests are not ported, D5) on a temporary pb_data. The same
// cases on upstream's tests/data run in test/differential/db-fixture.test.ts.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { dataDBFilename, type Databases } from "@/db/base";
import { Errors } from "@/db/dbx/db";
import { auxSaveNoValidate, deleteModel, modelQuery, saveNoValidate } from "@/db/db";
import { auxRunInTransaction, runInTransaction } from "@/db/tx";
import { Demo, Log } from "@test/db/models";
import { openTempDatabases } from "@test/db/support";

function insertDemo(app: Databases, id: string): Demo {
  const m = new Demo();
  m.id = id;
  m.title = id;
  saveNoValidate(app, m);
  return m;
}

function demoIds(app: Databases): string[] {
  return app.concurrentDB().newQuery("SELECT id FROM demo ORDER BY id").column<string>();
}

describe("TestRunInTransaction", () => {
  test("failed nested transaction", () => {
    const { app } = openTempDatabases();
    insertDemo(app, "demo1");

    expect(() =>
      runInTransaction(app, (txApp) => {
        const m = new Demo();
        modelQuery(txApp, m).model("demo1", m);

        runInTransaction(txApp, (tx2App) => {
          deleteModel(tx2App, m);
          throw new Error("test error");
        });
      }),
    ).toThrow("test error");

    // demo1 should still exist
    expect(demoIds(app)).toEqual(["demo1"]);
  });

  test("successful nested transaction", () => {
    const { app } = openTempDatabases();
    insertDemo(app, "demo1");

    runInTransaction(app, (txApp) => {
      const m = new Demo();
      modelQuery(txApp, m).model("demo1", m);

      runInTransaction(txApp, (tx2App) => {
        deleteModel(tx2App, m);
      });
    });

    // demo1 should have been deleted
    expect(demoIds(app)).toEqual([]);
  });
});

describe("transactions", () => {
  test("the nested call reuses the outer transaction", () => {
    const { app } = openTempDatabases();

    runInTransaction(app, (txApp) => {
      expect(txApp.isTransactional()).toBe(true);
      expect(txApp.concurrentDB()).toBe(txApp.nonconcurrentDB());
      expect(txApp.db()).toBe(txApp.nonconcurrentDB());

      runInTransaction(txApp, (tx2App) => {
        expect(tx2App).toBe(txApp);
        insertDemo(tx2App, "inner");
      });

      // visible inside the outer transaction before it commits
      expect(demoIds(txApp)).toEqual(["inner"]);
    });

    expect(app.isTransactional()).toBe(false);
    expect(demoIds(app)).toEqual(["inner"]);
  });

  test("a throw rolls back every write of the transaction", () => {
    const { app } = openTempDatabases();
    insertDemo(app, "before");

    const created = new Demo();
    created.id = "created";
    expect(() =>
      runInTransaction(app, (txApp) => {
        saveNoValidate(txApp, created);
        expect(created.isNew()).toBe(false);
        txApp.nonconcurrentDB().newQuery("DELETE FROM demo WHERE id = 'before'").execute();
        throw new Error("rollback please");
      }),
    ).toThrow("rollback please");

    expect(demoIds(app)).toEqual(["before"]);
    // create() resets the "new" state when the transaction fails
    expect(created.isNew()).toBe(true);
  });

  test("a failing statement rolls back and its error is reported", () => {
    const { app } = openTempDatabases();
    expect(() =>
      runInTransaction(app, (txApp) => {
        insertDemo(txApp, "a");
        insertDemo(txApp, "a");
      }),
    ).toThrow("UNIQUE constraint failed: demo.id");
    expect(demoIds(app)).toEqual([]);
  });

  test("a commit failure is reported", () => {
    const { app, dataDir } = openTempDatabases();

    // a deferred foreign key is checked on COMMIT
    app
      .nonconcurrentDB()
      .newQuery(
        "CREATE TABLE child (id TEXT PRIMARY KEY, demo TEXT REFERENCES demo (id) DEFERRABLE INITIALLY DEFERRED)",
      )
      .execute();

    let completedWith: unknown = "not called";
    expect(() =>
      runInTransaction(app, (txApp) => {
        txApp.txInfo()!.onComplete((txErr) => {
          completedWith = txErr;
        });
        txApp.nonconcurrentDB().insert("child", { id: "c1", demo: "missing" }).execute();
      }),
    ).toThrow("FOREIGN KEY constraint failed");

    expect(completedWith).toBeInstanceOf(Error);
    expect(app.concurrentDB().newQuery("SELECT COUNT(*) FROM child").row()).toEqual([0]);

    // the connection is usable and other connections can write
    insertDemo(app, "after");
    const other = new Database(join(dataDir, dataDBFilename));
    other.run("PRAGMA busy_timeout = 0");
    other.run("INSERT INTO demo (id, title) VALUES ('other', '')");
    other.close();
    expect(demoIds(app)).toEqual(["after", "other"]);
  });

  test("OnComplete callbacks run after the commit with a null error", () => {
    const { app } = openTempDatabases();
    const calls: unknown[] = [];
    runInTransaction(app, (txApp) => {
      txApp.txInfo()!.onComplete((txErr) => {
        calls.push(txErr);
        // the transaction has ended: the parent sees the write
        expect(demoIds(app)).toEqual(["x"]);
      });
      insertDemo(txApp, "x");
    });
    expect(calls).toEqual([null]);
  });

  test("OnComplete errors are joined with the transaction error", () => {
    const { app } = openTempDatabases();

    expect(() =>
      runInTransaction(app, (txApp) => {
        txApp.txInfo()!.onComplete(() => {
          throw new Error("after");
        });
      }),
    ).toThrow("transaction afterFunc errors: after");

    let err: unknown = null;
    try {
      runInTransaction(app, (txApp) => {
        txApp.txInfo()!.onComplete(() => {
          throw new Error("after");
        });
        throw new Error("tx");
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Errors);
    expect((err as Errors).message).toBe("tx\ntransaction afterFunc errors: after");
  });

  test("an async callback is rejected and rolled back", () => {
    const { app } = openTempDatabases();
    const asyncFn = (async (txApp: Databases) => {
      insertDemo(txApp, txApp === app ? "never" : "async");
    }) as never;
    expect(() => runInTransaction(app, asyncFn)).toThrow(
      "transaction function must be synchronous",
    );
    expect(() =>
      runInTransaction(app, (txApp) => {
        runInTransaction(txApp, asyncFn);
      }),
    ).toThrow("transaction function must be synchronous");
    expect(demoIds(app)).toEqual([]);
  });

  test("AuxRunInTransaction", () => {
    const { app } = openTempDatabases();

    expect(() =>
      auxRunInTransaction(app, (txApp) => {
        // only the auxiliary builders are transactional
        expect(txApp.auxConcurrentDB()).toBe(txApp.auxNonconcurrentDB());
        expect(txApp.concurrentDB()).not.toBe(txApp.nonconcurrentDB());

        const log = new Log();
        log.id = "l1";
        auxSaveNoValidate(txApp, log);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(app.auxConcurrentDB().newQuery("SELECT COUNT(*) FROM logs").row()).toEqual([0]);
  });
});
