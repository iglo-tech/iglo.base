// Not a test: run `nice -n 10 bun test/resolver/bench.ts` for the numbers
// in docs/perf/M2.2-resolver.md.
//
// 1. Resolve + build: a new record field resolver, filterBuildExpr for a
//    representative rule (resolving every field, the joins, the
//    multi-match subqueries), UpdateQuery and the SQL text of the record
//    query, on a copy of the vendored fixture, as a rule is built (hidden
//    fields allowed) and as a guest's client filter is (list-rule joins).
// 2. List with a relation rule: 10,000 books with 100 authors; a guest's
//    list (records list's steps: the rule on the record query, the
//    Provider with the resolver, page 1 of 30 with the count) and
//    CanAccessRecord, on the main thread and through the read pool.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RequestInfo } from "@/app/event-request";
import { newBaseCollection } from "@/collections/collection-model";
import {
  type CollectionsApp,
  findCachedCollectionByNameOrId,
  reloadCachedCollections,
} from "@/collections/collection-query";
import { saveCollection } from "@/collections/collection-save";
import { Databases } from "@/db/base";
import { runInTransaction } from "@/db/tx";
import { BoolField } from "@/fields/bool";
import { RelationField } from "@/fields/relation";
import { TextField } from "@/fields/text";
import type { Record } from "@/records/record-model";
import { findRecordById, recordQuery, recordsTarget } from "@/records/record-query";
import { canAccessRecord, canAccessRecordAsync } from "@/records/record-query-filter";
import { newRecordFieldResolver } from "@/resolver/record-field-resolver";
import { filterBuildExpr } from "@/search/filter";
import { newProvider } from "@/search/provider";
import { Store } from "@/tools/store/store";

import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";

function median(xs: number[]): number {
  const sorted = xs.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

// the median of `runs` timings (ms) after `warmup` runs
async function time(runs: number, warmup: number, fn: () => unknown): Promise<number> {
  for (let i = 0; i < warmup; i++) {
    await fn();
  }
  const out: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    out.push(performance.now() - start);
  }
  return median(out);
}

function openApp(
  dataDir: string,
  readWorkers: number,
): CollectionsApp & { close(): Promise<void> } {
  const databases = Databases.open({ dataDir, readWorkers });
  const app = {
    databases,
    store: new Store<string, unknown>(),
    clock: { now: () => new Date() },
    logger: { error: () => {} },
    async close() {
      databases.close();
      await databases.closed();
    },
  };
  reloadCachedCollections(app);
  return app;
}

const root = mkdtempSync(join(tmpdir(), "iglo-base-resolver-bench-"));
try {
  // 1. resolve + build
  const fixtureCopy = join(root, "fixture");
  copyDataDir(fixtureDir, fixtureCopy);
  const app = openApp(fixtureCopy, 0);
  const user = findRecordById(app, "users", "4q1xlclmfloku33");
  const info = new RequestInfo();
  info.auth = user;

  const rules: [string, string, string][] = [
    ["simple", "demo4", "title = 'test' && @request.auth.id != ''"],
    ["3-level relation", "demo4", "self_rel_one.self_rel_one.self_rel_one.title = 'test'"],
    ["back-relation", "demo3", "demo4_via_rel_one_cascade.title ?= 'test'"],
    [
      "@collection",
      "demo4",
      "@collection.demo2.title ?= title && @collection.demo2:a.active = true",
    ],
    [":each over a multiple relation", "demo4", "self_rel_many:each = 'abc'"],
    // (a guest's filter cannot join users, whose list rule is superusers only)
    ["auth relation", "demo4", "@request.auth.rel.title != ''"],
  ];

  console.log("resolve + build (median of 2,000 after 200 warm-up)");
  for (const [name, collectionName, rule] of rules) {
    const collection = findCachedCollectionByNameOrId(app, collectionName);
    for (const allowHidden of name === "auth relation" ? [true] : [true, false]) {
      const ms = await time(2000, 200, () => {
        const r = newRecordFieldResolver(app, collection, info, allowHidden);
        const q = recordQuery(app, collection);
        const expr = filterBuildExpr(rule, r, { clock: app.clock });
        r.updateQuery(q);
        return q.andWhere(expr).build().sql();
      });
      console.log(`  ${name} (${allowHidden ? "rule" : "guest filter"}): ${ms.toFixed(3)} ms`);
    }
  }
  await app.close();

  // 2. a list over 10,000 rows with a relation rule
  const listDir = join(root, "list");
  copyDataDir(fixtureDir, listDir);
  const setup = openApp(listDir, 0);
  const authors = newBaseCollection("bench_authors");
  authors.listRule = "";
  authors.fields.add(new TextField({ name: "name" }), new BoolField({ name: "active" }));
  saveCollection(setup, authors);
  const books = newBaseCollection("bench_books");
  books.listRule = "author.active = true && author.name != 'author 3'";
  books.viewRule = books.listRule;
  books.fields.add(
    new TextField({ name: "title" }),
    new RelationField({ name: "author", collectionId: authors.id, maxSelect: 1 }),
  );
  saveCollection(setup, books);
  runInTransaction(setup.databases, (tx) => {
    for (let i = 0; i < 100; i++) {
      tx.db()
        .insert("bench_authors", {
          id: `author${String(i).padStart(9, "0")}`,
          name: `author ${i}`,
          active: i % 2 === 0,
        })
        .execute();
    }
    for (let i = 0; i < 10_000; i++) {
      tx.db()
        .insert("bench_books", {
          id: `book${String(i).padStart(11, "0")}`,
          title: `title ${i}`,
          author: `author${String(i % 100).padStart(9, "0")}`,
        })
        .execute();
    }
  });
  await setup.close();

  console.log("list over 10,000 rows (median of 50 after 5 warm-up)");
  for (const workers of [0, 2]) {
    const listApp = openApp(listDir, workers);
    const collection = findCachedCollectionByNameOrId(listApp, "bench_books");
    const guest = new RequestInfo();
    const list = async (filter: string): Promise<number> => {
      const q = recordQuery(listApp, collection);
      const r = newRecordFieldResolver(listApp, collection, guest, true);
      q.andWhere(filterBuildExpr(collection.listRule ?? "", r, { clock: listApp.clock }));
      r.setAllowHiddenFields(false);
      const result = await newProvider(r, { clock: listApp.clock })
        .query(q)
        .countCol("_rowid_")
        .parseAndExec<Record>(`perPage=30&sort=-title${filter}`, recordsTarget);
      return result.totalItems;
    };
    const mode = workers === 0 ? "main thread" : "read pool";
    const total = await list("");
    console.log(`  (${total} of 10,000 rows visible)`);
    console.log(
      `  guest list, page 1 of 30 with count (${mode}): ${(await time(50, 5, () => list(""))).toFixed(2)} ms`,
    );
    const filter = "&filter=" + encodeURIComponent("author.name ~ 'author 1'");
    console.log(
      `  + relation filter (${mode}): ${(await time(50, 5, () => list(filter))).toFixed(2)} ms`,
    );
    const record = findRecordById(listApp, collection, "book00000000042");
    const view =
      workers === 0
        ? () => canAccessRecord(listApp, record, guest, collection.viewRule)
        : () => canAccessRecordAsync(listApp, record, guest, collection.viewRule);
    console.log(`  CanAccessRecord (${mode}): ${(await time(500, 50, view)).toFixed(3)} ms`);
    await listApp.close();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
