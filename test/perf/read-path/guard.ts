// M0.6 fixer: the cost of the deadline checks on synchronous reads (Rows
// checks the deadline before and after each step). Run it on two checkouts
// and compare. Not shipped.
//
//   nice -n 10 bun test/perf/read-path/guard.ts <scratch dir>
//
// 1,000 rows in a temporary database under the scratch dir (removed
// afterwards); ModelQuery reads (with --queryTimeout's deadline) and an
// untimed column read; median of 5 runs of 30,000 queries.

import { mkdirSync, rmSync } from "node:fs";
import { Databases } from "@/db/base";
import { modelQuery } from "@/db/db";
import { HashExp } from "@/db/dbx/expression";
import { runInTransaction } from "@/db/tx";
import { Demo } from "@test/db/models";
const dir = process.argv[2]!;
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const app = Databases.open({ dataDir: dir, readWorkers: 1 });
app
  .nonconcurrentDB()
  .newQuery(
    "CREATE TABLE demo (id TEXT PRIMARY KEY NOT NULL, title TEXT DEFAULT '' NOT NULL, n INTEGER)",
  )
  .execute();
runInTransaction(app, (tx) => {
  for (let i = 0; i < 1000; i++)
    tx.db()
      .insert("demo", { id: `id${i}`, title: `t${i}`, n: i })
      .execute();
});
function run(name: string, f: () => unknown) {
  for (let i = 0; i < 5000; i++) f();
  const res: number[] = [];
  for (let r = 0; r < 5; r++) {
    const n = 30000;
    const t = performance.now();
    for (let i = 0; i < n; i++) f();
    res.push(((performance.now() - t) * 1000) / n);
  }
  res.sort((a, b) => a - b);
  console.log(name, "median µs/query", res[2]!.toFixed(2));
}
run("one by id", () =>
  modelQuery(app, new Demo())
    .where(new HashExp({ id: "id7" }))
    .one(),
);
run("page 30 all", () => modelQuery(app, new Demo()).orderBy("n DESC").limit(30).all());
run("page 30 column", () =>
  app.db().select("id").from("demo").orderBy("n DESC").limit(30).column(),
);
app.close();
await app.closed();
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
