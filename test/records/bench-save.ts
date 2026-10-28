// Measurements of the record save and delete path for
// docs/perf/M1.8c-record-save.md. Not a test: run
// `bun test/records/bench-save.ts` after `bun run upstream:prepare`.
//
// A fresh upstream install gets the collections below through POST
// /api/collections. Upstream's records API is timed on it (HTTP round trips
// on 127.0.0.1, as a superuser); then upstream stops, and iglo.base's
// saveRecord, deleteRecord and truncateCollection are timed in this process
// on a copy of the same pb_data. Rows for the delete and truncate runs are
// inserted with SQL before each run and are not timed. Each figure is the
// median of the runs, after one warm-up run.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findCachedCollectionByNameOrId,
  reloadCachedCollections,
  truncateCollection,
} from "@/collections/collection-query";
import { newRecord } from "@/records/record-model";
import { findRecordById } from "@/records/record-query";
import { deleteRecord, saveRecord } from "@/records/record-save";

import { openDataDir } from "@test/collections/app";
import { runUpstream } from "@test/differential/db/fixture";
import { copyDataDir } from "@test/scenarios/fixture";
import { startUpstream } from "@test/support/upstream";

const email = "bench@example.com";
const password = "1234567890";

// a record with 20 fields: id, created, updated and these 17
const wideFields = [
  { name: "t1", type: "text" },
  { name: "t2", type: "text" },
  { name: "t3", type: "text" },
  { name: "t4", type: "text" },
  { name: "ed", type: "editor" },
  { name: "n1", type: "number" },
  { name: "n2", type: "number" },
  { name: "n3", type: "number" },
  { name: "b1", type: "bool" },
  { name: "b2", type: "bool" },
  { name: "em", type: "email" },
  { name: "u", type: "url" },
  { name: "d", type: "date" },
  { name: "s", type: "select", values: ["a", "b", "c"], maxSelect: 1 },
  { name: "sm", type: "select", values: ["a", "b", "c"], maxSelect: 3 },
  { name: "j", type: "json" },
  { name: "g", type: "geoPoint" },
  { name: "created", type: "autodate", onCreate: true },
  { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
];

const wideCreate = (i: number) => ({
  t1: `title ${i}`,
  t2: "second",
  t3: "third",
  t4: "fourth",
  ed: "<p>body</p>",
  n1: i,
  n2: 1.5,
  n3: -3,
  b1: true,
  b2: false,
  em: "a@example.com",
  u: "https://example.com",
  d: "2024-01-02 03:04:05.000Z",
  s: "a",
  sm: ["a", "b"],
  j: { a: [1, 2, 3], b: "x" },
  g: { lon: 1.5, lat: 2.5 },
});

const wideUpdate = (i: number) => ({
  t1: `updated ${i}`,
  n1: i + 1,
  b1: i % 2 === 0,
  sm: ["c"],
  j: { a: i },
});

const cascadeChildren = 1_000;
const truncateRows = 10_000;

const insertParent = `INSERT INTO cparents (id, name) VALUES ('p00000000000001', 'parent')`;
const insertChildren = `INSERT INTO cchildren (id, parent) WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${cascadeChildren}) SELECT printf('c%014d', x), 'p00000000000001' FROM c`;
const insertTruncate = `INSERT INTO trunc (id, title) WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${truncateRows}) SELECT printf('t%014d', x), 'title ' || x FROM c`;

function median(values: number[]): number {
  const s = values.toSorted((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

// the median of runs timed calls of fn(i), after one warm-up call; setup
// runs before each call and is not timed
async function time(
  runs: number,
  fn: (i: number) => Promise<void>,
  setup: () => Promise<void> = async () => {},
): Promise<number> {
  await setup();
  await fn(-1); // warm-up
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    await setup();
    const start = performance.now();
    await fn(i);
    times.push(performance.now() - start);
  }
  return median(times);
}

const root = mkdtempSync(join(tmpdir(), "iglo-base-bench-save-"));
try {
  const dataDir = join(root, "pb_data");
  const upsert = await runUpstream(
    ["superuser", "upsert", email, password, "--dir", dataDir],
    root,
  );
  if (upsert.exitCode !== 0) {
    throw new Error("superuser upsert failed");
  }

  const upstream = await startUpstream({ dataDir });
  const results: [string, string, number][] = [];
  const wideIds: string[] = [];
  try {
    let token = "";
    const call = async (method: string, path: string, body?: unknown): Promise<string> => {
      const res = await fetch(`${upstream.url}${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: token },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      if (res.status !== 200 && res.status !== 204) {
        throw new Error(`${method} ${path}: ${res.status} ${text}`);
      }
      return text;
    };
    token = (
      JSON.parse(
        await call("POST", "/api/collections/_superusers/auth-with-password", {
          identity: email,
          password,
        }),
      ) as { token: string }
    ).token;
    await call("POST", "/api/collections", { name: "wide", type: "base", fields: wideFields });
    const parentsId = (
      JSON.parse(
        await call("POST", "/api/collections", {
          name: "cparents",
          type: "base",
          fields: [{ name: "name", type: "text" }],
        }),
      ) as { id: string }
    ).id;
    await call("POST", "/api/collections", {
      name: "cchildren",
      type: "base",
      fields: [
        {
          name: "parent",
          type: "relation",
          collectionId: parentsId,
          maxSelect: 1,
          cascadeDelete: true,
        },
      ],
    });
    await call("POST", "/api/collections", {
      name: "trunc",
      type: "base",
      fields: [{ name: "title", type: "text" }],
    });

    results.push([
      "create, 20 fields",
      "POST /records",
      await time(200, async (i) => {
        const res = await call("POST", "/api/collections/wide/records", wideCreate(i));
        wideIds.push((JSON.parse(res) as { id: string }).id);
      }),
    ]);
    results.push([
      "update, 20 fields (5 changed)",
      "PATCH /records/{id}",
      await time(200, async (i) => {
        await call("PATCH", `/api/collections/wide/records/${wideIds[i + 1]}`, wideUpdate(i));
      }),
    ]);
    results.push([
      `delete with a cascade over ${cascadeChildren.toLocaleString("en")} records`,
      "DELETE /records/{id}",
      await time(
        5,
        async () => {
          await call("DELETE", "/api/collections/cparents/records/p00000000000001");
        },
        async () => {
          await call("POST", "/api/sql", { query: insertParent });
          await call("POST", "/api/sql", { query: insertChildren });
        },
      ),
    ]);
    results.push([
      `TruncateCollection, ${truncateRows.toLocaleString("en")} records`,
      "DELETE /collections/{c}/truncate",
      await time(
        3,
        async () => {
          await call("DELETE", "/api/collections/trunc/truncate");
        },
        async () => {
          await call("POST", "/api/sql", { query: insertTruncate });
        },
      ),
    ]);
  } finally {
    await upstream.stop();
  }

  const copy = join(root, "copy");
  copyDataDir(dataDir, copy);
  const app = openDataDir(copy);
  try {
    reloadCachedCollections(app);
    const sql = (query: string) => {
      app.databases.nonconcurrentDB().newQuery(query).execute();
    };
    const created: string[] = [];
    const wide = findCachedCollectionByNameOrId(app, "wide");

    const iglo: number[] = [
      await time(200, async (i) => {
        const record = newRecord(wide);
        record.load(wideCreate(i));
        await saveRecord(app, record);
        created.push(record.id);
      }),
      await time(200, async (i) => {
        const record = findRecordById(app, wide, created[i + 1] as string);
        record.load(wideUpdate(i));
        await saveRecord(app, record);
      }),
      await time(
        5,
        async () => {
          await deleteRecord(app, findRecordById(app, "cparents", "p00000000000001"));
        },
        async () => {
          sql(insertParent);
          sql(insertChildren);
        },
      ),
      await time(
        3,
        async () => {
          truncateCollection(app, findCachedCollectionByNameOrId(app, "trunc"));
        },
        async () => {
          sql(insertTruncate);
        },
      ),
    ];

    console.log("| Operation | iglo.base | upstream (HTTP) | upstream request |");
    console.log("|---|---|---|---|");
    for (const [i, [name, request, ms]] of results.entries()) {
      console.log(
        `| ${name} | ${(iglo[i] as number).toFixed(2)} ms | ${ms.toFixed(2)} ms | ${request} |`,
      );
    }
  } finally {
    app.cleanup();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
