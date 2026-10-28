// The read path (D8): the async resolvers of the concurrent builders read on
// the read worker pool, the query timeout (--queryTimeout) as upstream's
// execLockRetry gives it to ModelQuery/AuxModelQuery queries (core/db.go,
// core/db_retry.go), and reads in a transaction on its connection.
//
// Upstream v0.41.0 fails a SELECT that runs past the timeout with
// "context deadline exceeded; failed query: <SQL>" at the deadline, while
// other requests go on (docs/perf/M0.6-read-path.md). The timeout tests use
// a real slow statement (a cross join, about a second) on a 250 ms timeout.

import { afterEach, expect, test } from "bun:test";

import { Databases, defaultQueryTimeout } from "@/db/base";
import { connectPragmas } from "@/db/connect";
import type { DB } from "@/db/dbx/db";
import { HashExp, newExp } from "@/db/dbx/expression";
import { NoRowsError } from "@/db/dbx/rows";
import { auxModelQuery, modelQuery } from "@/db/db";
import { runInTransaction } from "@/db/tx";
import { Demo, Log } from "@test/db/models";
import { tempDir } from "@test/db/support";

const opened: Databases[] = [];

afterEach(async () => {
  for (const app of opened.splice(0)) {
    app.close();
    await app.closed();
  }
});

function open(config: {
  readWorkers?: number;
  queryTimeout?: number;
  now?: () => number;
}): Databases {
  const app = Databases.open({
    dataDir: tempDir("iglo-base-pb_data-"),
    sleep: () => {},
    ...config,
  });
  opened.push(app);
  app
    .nonconcurrentDB()
    .newQuery(
      "CREATE TABLE demo (id TEXT PRIMARY KEY NOT NULL, title TEXT DEFAULT '' NOT NULL, n INTEGER)",
    )
    .execute();
  app
    .auxNonconcurrentDB()
    .newQuery("CREATE TABLE logs (id TEXT PRIMARY KEY NOT NULL, message TEXT DEFAULT '' NOT NULL)")
    .execute();
  return app;
}

function fill(app: Databases, rows: number): void {
  runInTransaction(app, (txApp) => {
    for (let i = 0; i < rows; i++) {
      txApp
        .db()
        .insert("demo", { id: `id${i}`, title: `t${i}`, n: i })
        .execute();
    }
  });
}

// about a second of SQLite work on 3,000 rows, whatever the outer query
const slowWhere = newExp(
  "EXISTS (SELECT 1 FROM [[demo]] a, [[demo]] b WHERE a.title || b.title LIKE '%zz%')",
);

test("the async resolvers read on the pool what the synchronous ones read", async () => {
  const app = open({ readWorkers: 2 });
  app
    .db()
    .insert("demo", { id: "a", title: "first", n: 2n ** 60n })
    .execute();
  app.db().insert("demo", { id: "b", title: "second", n: 7 }).execute();
  app.auxDB().insert("logs", { id: "l1", message: "hello" }).execute();

  const q = () => app.db().select("id", "title", "n").from("demo").orderBy("id");
  expect(app.readPool()?.stats().workers).toBe(2);
  expect(await q().allAsync()).toEqual(q().all());
  expect(await q().allAsync()).toEqual([
    { id: "a", title: "first", n: 2n ** 60n },
    { id: "b", title: "second", n: 7 },
  ]);
  expect(await q().oneAsync()).toEqual({ id: "a", title: "first", n: 2n ** 60n });
  expect(await q().rowAsync()).toEqual(["a", "first", 2n ** 60n]);
  expect(await q().columnAsync()).toEqual(["a", "b"]);
  expect(
    await q()
      .where(new HashExp({ id: "missing" }))
      .oneAsync()
      .catch((e) => e),
  ).toBeInstanceOf(NoRowsError);

  // models, and the auxiliary database
  const demo = await modelQuery(app, new Demo())
    .where(new HashExp({ id: "b" }))
    .oneAsync(new Demo());
  expect(demo.id).toBe("b");
  expect(demo.title).toBe("second");
  const logs = await auxModelQuery(app, new Log()).allAsync<Log>(() => new Log());
  expect(logs.map((log) => log.message)).toEqual(["hello"]);

  // SQLite errors keep their message and code, and the failed query
  const err = (await modelQuery(app, new Demo())
    .where(newExp("missing_column = 1"))
    .allAsync()
    .catch((e) => e)) as Error & { code?: string };
  expect(err.message).toBe(
    "no such column: missing_column; failed query: SELECT {{demo}}.* FROM `demo` WHERE missing_column = 1",
  );
  expect((err.cause as { code?: string }).code).toBe("SQLITE_ERROR");
});

test("the pool's connections are read-only and use upstream's pragmas", async () => {
  const app = open({ readWorkers: 1 });
  const db = app.concurrentDB();
  const pragma = async (name: string) => (await db.newQuery(`PRAGMA ${name}`).rowAsync())[0];
  for (const p of connectPragmas) {
    const [, name, value] = /^(\w+)\((.*)\)$/.exec(p)!;
    const expected: Record<string, unknown> = {
      busy_timeout: 10000,
      journal_mode: "wal",
      journal_size_limit: 200000000,
      synchronous: 1,
      foreign_keys: 1,
      temp_store: 2,
      cache_size: -32000,
    };
    expect([name, await pragma(name!)]).toEqual([name, expected[name!] ?? value]);
  }
  const err = (await db
    .newQuery("INSERT INTO demo (id) VALUES ('x') RETURNING id")
    .allAsync()
    .catch((e) => e)) as Error;
  expect(err.message).toBe("attempt to write a readonly database");
});

test("a read on the pool sees what the main thread committed before it", async () => {
  const app = open({ readWorkers: 2 });
  for (let i = 0; i < 20; i++) {
    app
      .db()
      .insert("demo", { id: `id${i}`, title: "x" })
      .execute();
    const count = await app.db().select("count(*)").from("demo").rowAsync();
    expect(count).toEqual([i + 1]);
  }
});

test("in a transaction the async resolvers read on its connection", async () => {
  const app = open({ readWorkers: 2 });
  let inside: Promise<unknown[]> | null = null;
  expect(() =>
    runInTransaction(app, (txApp) => {
      txApp.db().insert("demo", { id: "uncommitted", title: "x" }).execute();
      // read now, on the transaction's connection, before the rollback
      inside = txApp.concurrentDB().select("id").from("demo").columnAsync();
      throw new Error("rollback");
    }),
  ).toThrow("rollback");
  expect(await inside!).toEqual(["uncommitted"]);
  expect(await app.concurrentDB().select("id").from("demo").columnAsync()).toEqual([]);
});

test("--queryTimeout 0 or less is upstream's default", () => {
  expect(defaultQueryTimeout).toBe(30_000);
  expect(open({ queryTimeout: 0 }).queryTimeout()).toBe(30_000);
  expect(open({ queryTimeout: -5 }).queryTimeout()).toBe(30_000);
  expect(open({ queryTimeout: 1500 }).queryTimeout()).toBe(1500);
});

test("a timed-out read fails at the deadline without blocking other requests", async () => {
  const app = open({ readWorkers: 2, queryTimeout: 250 });
  fill(app, 3000);

  using server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: {
      "/health": () => new Response("ok"),
      "/slow": async () => {
        try {
          await modelQuery(app, new Demo()).where(slowWhere).allAsync();
          return new Response("done");
        } catch (err) {
          return new Response((err as Error).message, { status: 400 });
        }
      },
      "/view": async () =>
        Response.json(
          await modelQuery(app, new Demo())
            .where(new HashExp({ id: "id7" }))
            .oneAsync(),
        ),
    },
  });

  const start = performance.now();
  const slow = fetch(new URL("/slow", server.url)).then(async (res) => ({
    status: res.status,
    body: await res.text(),
    ms: performance.now() - start,
  }));
  await Bun.sleep(20);
  const t = performance.now();
  expect(await (await fetch(new URL("/health", server.url))).text()).toBe("ok");
  expect(performance.now() - t).toBeLessThan(100);
  // another query on the pool's other worker
  expect(
    ((await (await fetch(new URL("/view", server.url))).json()) as { title: string }).title,
  ).toBe("t7");

  const res = await slow;
  expect(res.status).toBe(400);
  expect(res.body).toBe(
    "context deadline exceeded; failed query: SELECT {{demo}}.* FROM `demo` WHERE EXISTS (SELECT 1 FROM [[demo]] a, [[demo]] b WHERE a.title || b.title LIKE '%zz%')",
  );
  expect(res.ms).toBeGreaterThanOrEqual(240);
  expect(res.ms).toBeLessThan(250 + 200);

  // the worker that ran it was replaced; its thread exits when the statement returns
  const stats = app.readPool()!.stats();
  expect(stats.workers).toBe(2);
  expect(stats.abandoned).toBe(1);
  expect(
    ((await (await fetch(new URL("/view", server.url))).json()) as { title: string }).title,
  ).toBe("t7");
});

test("waiting for a free worker counts towards the deadline", async () => {
  const app = open({ readWorkers: 1, queryTimeout: 250 });
  fill(app, 3000);

  // no timeout: concurrentDB() queries are not ModelQuery ones
  const untimed = app.concurrentDB().select("count(*)").from("demo").where(slowWhere).rowAsync();
  const start = performance.now();
  const err = (await modelQuery(app, new Demo())
    .where(new HashExp({ id: "id1" }))
    .oneAsync()
    .catch((e) => e)) as Error;
  expect(err.message).toBe(
    "context deadline exceeded; failed query: SELECT {{demo}}.* FROM `demo` WHERE `id`={:p0}",
  );
  expect(performance.now() - start).toBeLessThan(250 + 200);
  // the queued query was dropped; the running one goes on
  expect(app.readPool()!.stats()).toEqual({ workers: 1, busy: 1, queued: 0, abandoned: 0 });
  expect(await untimed).toEqual([0]);
});

test("a synchronous read that ends past the deadline fails as upstream's", () => {
  let clock = 0;
  const app = open({ queryTimeout: 1000, now: () => clock });
  fill(app, 3);
  // the statement "takes" two seconds: the clock moves while it runs
  (app.concurrentDB() as DB).conn().function("tick", () => {
    clock += 2000;
    return 1;
  });

  expect(() =>
    modelQuery(app, new Demo()).where(newExp("id = 'id1' AND tick() = 1")).one(),
  ).toThrow(
    "context deadline exceeded; failed query: SELECT {{demo}}.* FROM `demo` WHERE id = 'id1' AND tick() = 1",
  );
  // inside the timeout
  expect(
    modelQuery(app, new Demo())
      .where(new HashExp({ id: "id1" }))
      .one(),
  ).toMatchObject({
    id: "id1",
  });
  // the deadline is the query's only while it runs (upstream resets the context)
  const q = modelQuery(app, new Demo()).build();
  q.all();
  expect(q.deadline()).toBeNull();
});

test("closing the databases fails the pool's queued and running reads", async () => {
  const app = open({ readWorkers: 1 });
  fill(app, 3000);
  const running = app.concurrentDB().select("count(*)").from("demo").where(slowWhere).rowAsync();
  const queued = app.concurrentDB().select("count(*)").from("demo").rowAsync();
  app.close();
  expect(((await running.catch((e) => e)) as Error).message).toBe("sql: database is closed");
  expect(((await queued.catch((e) => e)) as Error).message).toBe("sql: database is closed");
  await app.closed();
  expect(app.readPool()!.stats()).toEqual({ workers: 0, busy: 0, queued: 0, abandoned: 0 });
});
