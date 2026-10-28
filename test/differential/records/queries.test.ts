// The record queries (src/records/record-query.ts, FindRecordByViewFile
// and DryRunView in src/collections/view.ts) against the reference
// PocketBase v0.41.0 binary. Not part of `bun test`: run
// `bun run test:reference`.
//
// On a fresh upstream install, the test creates through upstream's API two
// auth collections (the default email index, and one with COLLATE NOCASE),
// a base collection with single and multiple file fields, a view that
// selects the file fields and a view of that view, then creates records
// with files. After upstream stops, iglo.base's finders run on a copy of
// its pb_data and are compared with upstream's answers for the same
// lookups:
//
//   - FindRecordById (by collection name and id), FindRecordsByIds,
//     FindAllRecords and FindFirstRecordByData: the found ids equal the ids
//     upstream's list endpoint returns for the same condition, and each
//     found record's MarshalJSON equals upstream's GET body;
//   - CountRecords with dbx expressions equals the list total for the
//     equivalent filter;
//   - FindAuthRecordByEmail with exact, lower and upper case emails finds
//     a record exactly when upstream's auth-with-password (the same lookup
//     on the email identity field) knows the email;
//   - FindRecordByViewFile finds, for each file name of a view (and a view
//     of a view), the base record whose file upstream serves through the
//     view's /api/files route; a missing name gives sql.ErrNoRows, as
//     upstream's route gives 404;
//   - DryRunView's sample records equal the view's GET bodies, apart from
//     the temporary collection's id and name.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findCollectionByNameOrId, reloadCachedCollections } from "@/collections/collection-query";
import { dryRunView, findRecordByViewFile } from "@/collections/view";
import { type Expression, HashExp, like, newExp, not } from "@/db/dbx/expression";
import { NoRowsError } from "@/db/dbx/rows";
import type { Record as RecordModel } from "@/records/record-model";
import {
  countRecords,
  findAllRecords,
  findAuthRecordByEmail,
  findFirstRecordByData,
  findRecordById,
  findRecordsByIds,
} from "@/records/record-query";

import { openDataDir, type TestCollectionsApp } from "@test/collections/app";
import { runUpstream } from "@test/differential/db/fixture";
import { copyDataDir } from "@test/scenarios/fixture";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

const superEmail = "queries@example.com";
const superPassword = "1234567890";
const userPassword = "1234567890";

const users = "q_users";
const members = "q_members"; // auth, email index with COLLATE NOCASE
const posts = "q_posts";
const view = "q_posts_view";
const view2 = "q_posts_view2";
const viewQuery = `select id, title, doc, docs as files, n from ${posts}`;
const view2Query = `select id, doc as d2, files as f2 from ${view}`;

const emails = ["Alice@Example.com", "bob@example.com", "CAROL@EXAMPLE.COM", "dave.Smith@x.io"];

let root: string;
let dataDir: string;
let upstream: UpstreamServer | undefined;
let token: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "iglo-base-record-queries-ref-"));
  dataDir = join(root, "pb_data");
  const upsert = await runUpstream(
    ["superuser", "upsert", superEmail, superPassword, "--dir", dataDir],
    root,
  );
  expect(upsert.exitCode).toBe(0);
  upstream = await startUpstream({ dataDir });
  const res = await fetch(`${upstream.url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: superEmail, password: superPassword }),
  });
  expect(res.status).toBe(200);
  token = ((await res.json()) as { token: string }).token;
}, 60_000);

afterAll(async () => {
  await upstream?.stop();
  rmSync(root, { recursive: true, force: true });
});

interface Response {
  status: number;
  text: string;
}

async function request(
  method: string,
  path: string,
  body?: string | FormData,
  auth = true,
): Promise<Response> {
  if (upstream === undefined) {
    throw new Error("upstream is not running");
  }
  const headers: { [name: string]: string } = {};
  if (typeof body === "string") {
    headers["content-type"] = "application/json";
  }
  if (auth) {
    headers.authorization = token;
  }
  const res = await fetch(`${upstream.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
  return { status: res.status, text: await res.text() };
}

async function ok(res: Promise<Response>): Promise<string> {
  const r = await res;
  expect({ status: r.status, body: r.status === 200 ? "" : r.text }).toEqual({
    status: 200,
    body: "",
  });
  return r.text;
}

async function createCollection(body: object): Promise<string> {
  const text = await ok(request("POST", "/api/collections", JSON.stringify(body)));
  return (JSON.parse(text) as { id: string }).id;
}

// what the comparison phase needs from upstream
const ids = new Map<string, string[]>(); // collection name -> record ids
const collectionIds = new Map<string, string>(); // collection name -> id
const bodies = new Map<string, string>(); // "<collection>/<id>" -> guest GET body
const listIds = new Map<string, string[]>(); // label -> ids of a list request
const totals = new Map<string, number>(); // label -> totalItems
const authFound = new Map<string, boolean>(); // "<collection>/<email>" -> auth-with-password 200
const viewFiles: { collection: string; field: string; name: string; id: string; status: number }[] =
  [];

// the filters whose list totals the counts are compared with, with the
// equivalent dbx expressions
const countCases: {
  label: string;
  collection: string;
  filter: string;
  exprs: () => (Expression | null)[];
}[] = [
  { label: "all posts", collection: posts, filter: "", exprs: () => [] },
  {
    label: "active posts",
    collection: posts,
    filter: "active=true",
    exprs: () => [null, new HashExp({ active: true })],
  },
  {
    label: "posts like 'post 1'",
    collection: posts,
    filter: "title~'post 1'",
    exprs: () => [like("title", "post 1")],
  },
  {
    label: "posts n > 5 and inactive",
    collection: posts,
    filter: "n>5 && active=false",
    exprs: () => [newExp("[[n]] > {:n}", { n: 5 }), new HashExp({ active: false })],
  },
  {
    label: "posts with a doc",
    collection: posts,
    filter: "doc!=''",
    exprs: () => [not(new HashExp({ doc: "" }))],
  },
  {
    label: "no posts",
    collection: posts,
    filter: "title='missing'",
    exprs: () => [new HashExp({ title: "missing" })],
  },
  { label: "all users", collection: users, filter: "", exprs: () => [] },
  { label: "all view rows", collection: view, filter: "", exprs: () => [] },
  {
    label: "view rows n <= 3",
    collection: view,
    filter: "n<=3",
    exprs: () => [newExp("[[n]] <= {:n}", { n: 3 })],
  },
  { label: "all view2 rows", collection: view2, filter: "", exprs: () => [] },
];

async function listRecords(
  collection: string,
  filter: string,
): Promise<{ ids: string[]; total: number }> {
  const q = new URLSearchParams({ perPage: "500" });
  if (filter !== "") {
    q.set("filter", filter);
  }
  const text = await ok(request("GET", `/api/collections/${collection}/records?${q}`));
  const parsed = JSON.parse(text) as { totalItems: number; items: { id: string }[] };
  return { ids: parsed.items.map((i) => i.id), total: parsed.totalItems };
}

describe("upstream", () => {
  test("collections, records and answers", async () => {
    const usersId = await createCollection({
      name: users,
      type: "auth",
      listRule: "",
      viewRule: "",
      fields: [{ name: "name", type: "text" }],
    });
    collectionIds.set(users, usersId);
    collectionIds.set(
      members,
      await createCollection({
        name: members,
        type: "auth",
        listRule: "",
        viewRule: "",
        indexes: [
          `CREATE UNIQUE INDEX \`idx_${members}_email\` ON \`${members}\` (\`email\` COLLATE NOCASE) WHERE \`email\` != ''`,
        ],
      }),
    );
    collectionIds.set(
      posts,
      await createCollection({
        name: posts,
        type: "base",
        listRule: "",
        viewRule: "",
        fields: [
          { name: "title", type: "text" },
          { name: "n", type: "number" },
          { name: "active", type: "bool" },
          { name: "doc", type: "file", maxSelect: 1, maxSize: 1000 },
          { name: "docs", type: "file", maxSelect: 5, maxSize: 1000 },
          { name: "author", type: "relation", collectionId: usersId, maxSelect: 1 },
        ],
      }),
    );

    for (const collection of [users, members]) {
      const created: string[] = [];
      for (const [i, email] of emails.entries()) {
        const text = await ok(
          request(
            "POST",
            `/api/collections/${collection}/records`,
            JSON.stringify({
              email,
              emailVisibility: i % 2 === 0,
              password: userPassword,
              passwordConfirm: userPassword,
              ...(collection === users ? { name: `user ${i}` } : {}),
            }),
          ),
        );
        created.push((JSON.parse(text) as { id: string }).id);
      }
      ids.set(collection, created);
    }

    const postIds: string[] = [];
    for (let i = 0; i < 24; i++) {
      const form = new FormData();
      form.append(
        "@jsonPayload",
        JSON.stringify({
          title: `post ${i}`,
          n: i % 9,
          active: i % 3 !== 0,
          author: i % 4 === 0 ? "" : (ids.get(users) as string[])[i % emails.length],
        }),
      );
      if (i % 2 === 0) {
        form.append("doc", new Blob([`doc ${i}`], { type: "text/plain" }), `doc_${i}.txt`);
      }
      for (let j = 0; j < i % 4; j++) {
        form.append("docs", new Blob([`docs ${i} ${j}`], { type: "text/plain" }), `many_${i}.txt`);
      }
      const text = await ok(request("POST", `/api/collections/${posts}/records`, form));
      postIds.push((JSON.parse(text) as { id: string }).id);
    }
    ids.set(posts, postIds);

    collectionIds.set(
      view,
      await createCollection({ name: view, type: "view", listRule: "", viewRule: "", viewQuery }),
    );
    collectionIds.set(
      view2,
      await createCollection({
        name: view2,
        type: "view",
        listRule: "",
        viewRule: "",
        viewQuery: view2Query,
      }),
    );
    ids.set(view, postIds);
    ids.set(view2, postIds);

    // the GET bodies
    for (const [collection, list] of ids) {
      for (const id of list) {
        const res = await request(
          "GET",
          `/api/collections/${collection}/records/${id}`,
          undefined,
          false,
        );
        expect(res.status).toBe(200);
        bodies.set(`${collection}/${id}`, res.text);
      }
    }

    // the lists and totals
    for (const c of countCases) {
      const r = await listRecords(c.collection, c.filter);
      listIds.set(c.label, r.ids);
      totals.set(c.label, r.total);
    }
    const some = [postIds[1], postIds[5], postIds[22]] as string[];
    listIds.set(
      "some posts",
      (await listRecords(posts, some.map((id) => `id='${id}'`).join("||"))).ids,
    );

    // auth-with-password with the email in three cases
    for (const collection of [users, members]) {
      for (const email of emails) {
        for (const e of [email, email.toLowerCase(), email.toUpperCase()]) {
          const res = await request(
            "POST",
            `/api/collections/${collection}/auth-with-password`,
            JSON.stringify({ identity: e, password: userPassword }),
            false,
          );
          expect([200, 400]).toContain(res.status);
          authFound.set(`${collection}/${e}`, res.status === 200);
        }
      }
    }

    // the files served through the views
    for (const [collection, single, multi] of [
      [view, "doc", "files"],
      [view2, "d2", "f2"],
    ] as const) {
      for (const id of postIds) {
        const body = JSON.parse(bodies.get(`${collection}/${id}`) as string) as {
          [k: string]: unknown;
        };
        const names: [string, string][] = [];
        if (body[single] !== "") {
          names.push([single, body[single] as string]);
        }
        for (const name of body[multi] as string[]) {
          names.push([multi, name]);
        }
        for (const [field, name] of names) {
          const res = await request(
            "GET",
            `/api/files/${collection}/${id}/${name}`,
            undefined,
            false,
          );
          viewFiles.push({ collection, field, name, id, status: res.status });
        }
      }
    }
  }, 180_000);
});

function upstreamBody(collection: string, id: string): string {
  const b = bodies.get(`${collection}/${id}`);
  if (b === undefined) {
    throw new Error(`no upstream body for ${collection}/${id}`);
  }
  return b;
}

function expectBodies(collection: string, records: RecordModel[]): void {
  for (const r of records) {
    expect({ id: r.id, body: r.marshalJSON() }).toEqual({
      id: r.id,
      body: upstreamBody(collection, r.id),
    });
  }
}

describe("record queries on a copy of upstream's data.db", () => {
  let copyRoot: string;
  let app: TestCollectionsApp;

  beforeAll(async () => {
    await upstream?.stop();
    upstream = undefined;
    copyRoot = mkdtempSync(join(tmpdir(), "iglo-base-record-queries-copy-"));
    const copy = join(copyRoot, "pb_data");
    copyDataDir(dataDir, copy);
    app = openDataDir(copy);
    reloadCachedCollections(app);
  });

  afterAll(() => {
    app.cleanup();
    rmSync(copyRoot, { recursive: true, force: true });
  });

  test("the sample is large enough", () => {
    expect(ids.get(posts)?.length).toBe(24);
    expect(viewFiles.length).toBeGreaterThan(40);
    expect(viewFiles.every((f) => f.status === 200)).toBe(true);
    expect([...authFound.values()].filter((v) => v).length).toBeGreaterThan(8);
    expect([...authFound.values()].filter((v) => !v).length).toBeGreaterThan(4);
  });

  test("FindRecordById", () => {
    for (const [collection, list] of ids) {
      const collectionId = collectionIds.get(collection) as string;
      for (const id of list) {
        expectBodies(collection, [
          findRecordById(app, collection, id),
          findRecordById(app, collectionId, id),
          findRecordById(app, findCollectionByNameOrId(app, collection), id),
        ]);
      }
      expect(() => findRecordById(app, collection, "missing")).toThrow(NoRowsError);
    }
  });

  test("FindRecordsByIds", () => {
    const postIds = ids.get(posts) as string[];
    const some = [postIds[1], postIds[5], postIds[22]] as string[];
    const found = findRecordsByIds(app, posts, [...some, "missing", ""]);
    expect(found.map((r) => r.id).toSorted()).toEqual(
      (listIds.get("some posts") as string[]).toSorted(),
    );
    expectBodies(posts, found);

    const viewFound = findRecordsByIds(app, view, some);
    expect(viewFound.map((r) => r.id).toSorted()).toEqual(some.toSorted());
    expectBodies(view, viewFound);

    expect(findRecordsByIds(app, posts, [])).toEqual([]);
  });

  test("FindAllRecords", () => {
    for (const c of countCases) {
      const found = findAllRecords(app, c.collection, ...c.exprs());
      expect({ label: c.label, ids: found.map((r) => r.id).toSorted() }).toEqual({
        label: c.label,
        ids: (listIds.get(c.label) as string[]).toSorted(),
      });
      expectBodies(c.collection, found);
    }
  });

  test("FindFirstRecordByData", () => {
    const postIds = ids.get(posts) as string[];
    for (const [i, id] of postIds.entries()) {
      const found = findFirstRecordByData(app, posts, "title", `post ${i}`);
      expect(found.id).toBe(id);
      expectBodies(posts, [found]);
    }
    const userIds = ids.get(users) as string[];
    for (const [i, email] of emails.entries()) {
      const found = findFirstRecordByData(app, users, "email", email);
      expect(found.id).toBe(userIds[i] as string);
      expectBodies(users, [found]);
    }
    expect(() => findFirstRecordByData(app, posts, "title", "missing")).toThrow(NoRowsError);
    expect(() => findFirstRecordByData(app, posts, "missing", "x")).toThrow(
      "invalid or missing field missing",
    );
  });

  test("CountRecords", () => {
    for (const c of countCases) {
      expect({ label: c.label, total: countRecords(app, c.collection, ...c.exprs()) }).toEqual({
        label: c.label,
        total: totals.get(c.label) as number,
      });
    }
  });

  test("FindAuthRecordByEmail", () => {
    for (const collection of [users, members]) {
      const list = ids.get(collection) as string[];
      for (const [i, email] of emails.entries()) {
        for (const e of [email, email.toLowerCase(), email.toUpperCase()]) {
          const expected = authFound.get(`${collection}/${e}`) as boolean;
          let found: RecordModel | null = null;
          try {
            found = findAuthRecordByEmail(app, collection, e);
          } catch (err) {
            expect(err).toBeInstanceOf(NoRowsError);
          }
          expect({ collection, email: e, found: found !== null }).toEqual({
            collection,
            email: e,
            found: expected,
          });
          if (found !== null) {
            expect(found.id).toBe(list[i] as string);
            expectBodies(collection, [found]);
          }
        }
      }
    }
    expect(() => findAuthRecordByEmail(app, posts, "x@example.com")).toThrow(
      `"${posts}" is not an auth collection`,
    );
    expect(() => findAuthRecordByEmail(app, "missing", "x@example.com")).toThrow(
      "failed to fetch auth collection: sql: no rows in result set",
    );
  });

  test("FindRecordByViewFile", () => {
    for (const f of viewFiles) {
      const found = findRecordByViewFile(app, f.collection, f.field, f.name);
      expect({ name: f.name, id: found.id }).toEqual({ name: f.name, id: f.id });
      expect(found.collection().name).toBe(posts);
      expectBodies(posts, [found]);
    }
    for (const [collection, single, multi] of [
      [view, "doc", "files"],
      [view2, "d2", "f2"],
    ] as const) {
      for (const field of [single, multi]) {
        expect(() => findRecordByViewFile(app, collection, field, "missing.txt")).toThrow(
          NoRowsError,
        );
      }
    }
    expect(() => findRecordByViewFile(app, posts, "doc", "x.txt")).toThrow("not a view collection");
  });

  test("DryRunView", () => {
    for (const [collection, query] of [
      [view, viewQuery],
      [view2, view2Query],
    ] as const) {
      const result = dryRunView(app, query, 100);
      expect(result.sample.length).toBe(
        totals.get(`all ${collection === view ? "view" : "view2"} rows`) as number,
      );
      for (const r of result.sample) {
        const temp = r.collection();
        const normalized = r
          .marshalJSON()
          .replace(
            `"collectionId":"${temp.id}"`,
            `"collectionId":"${collectionIds.get(collection)}"`,
          )
          .replace(`"collectionName":"${temp.name}"`, `"collectionName":"${collection}"`);
        expect({ id: r.id, body: normalized }).toEqual({
          id: r.id,
          body: upstreamBody(collection, r.id),
        });
      }
      const sampled = dryRunView(app, query, 5);
      expect(sampled.sample.length).toBe(5);
    }
  });
});
