// The schema file's apply (D40, S.3) against the reference PocketBase
// v0.41.0 binary. Not part of `bun test`: run `bun run test:reference`.
//
// One fresh upstream install is copied for both sides. The same change is
// made in two ways: iglo.base applies a schema file at startup (serve
// --schema, the compiled executable), and upstream gets the same change
// through its /api/collections endpoints (the way the dashboard saves it).
// Then the stored schema must be the same on both: `_collections` rows
// (created and updated left out, token secrets compared as present or
// absent) and `sqlite_schema` rows (type, name, tbl_name, sql). At the end
// upstream serves iglo.base's data directory: it opens it, and its
// GET /api/collections returns the bodies it returns for its own result.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run as runIglo, startServer } from "@test/support/executable";
import { runUpstream } from "@test/differential/db/fixture";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

const hookTimeout = 180_000;
const email = "apply@example.com";
const password = "1234567890";

let root = "";
let upstreamDir = "";
let igloDir = "";
let schemaFile = "";

// the collections of the change, as the schema file lists them
const posts = {
  type: "base",
  rules: { list: "", view: "", create: "@request.auth.id != ''" },
  indexes: ["CREATE UNIQUE INDEX `idx_posts_slug` ON `posts` (`slug`)"],
  fields: {
    title: { type: "text", required: true, max: 120 },
    slug: { type: "text", required: true, pattern: "^[a-z0-9-]+$" },
    body: { type: "editor" },
    author: { type: "relation", collection: "users", maxSelect: 1 },
  },
};
const members = {
  type: "auth",
  rules: { list: "", view: "", create: "" },
  authAlert: { enabled: false },
  fields: { name: { type: "text", max: 80 } },
};
const postSlugs = {
  type: "view",
  query: "SELECT id, slug FROM posts",
  rules: { list: "", view: "" },
};

// the file: a fresh install's users, with a nickname, and the three new collections
async function fileText(): Promise<string> {
  const pulled = await runIglo(["--dir", igloDir, "schema", "pull"]);
  expect(pulled.exitCode).toBe(0);
  const file = JSON.parse(pulled.stdout) as { collections: Record<string, unknown> };
  const users = file.collections.users as { fields: Record<string, unknown> };
  users.fields.nickname = { type: "text", min: 2 };
  file.collections.posts = posts;
  file.collections.members = members;
  file.collections.post_slugs = postSlugs;
  return JSON.stringify(file, null, 2);
}

let upstream: UpstreamServer | undefined;
let token = "";

async function upstreamRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  if (upstream === undefined) {
    throw new Error("upstream is not running");
  }
  const res = await fetch(`${upstream.url}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? undefined : JSON.parse(text) };
}

// the same change through the collections API of upstream
async function changeUpstream(): Promise<void> {
  // the users collection, with the nickname appended to its fields
  const users = (await upstreamRequest("GET", "/api/collections/users")).json as {
    id: string;
    fields: Record<string, unknown>[];
  };
  const patched = await upstreamRequest("PATCH", `/api/collections/${users.id}`, {
    fields: [...users.fields, { name: "nickname", type: "text", min: 2 }],
  });
  expect(patched.status).toBe(200);

  for (const [name, body] of [
    [
      "posts",
      {
        name: "posts",
        type: "base",
        listRule: "",
        viewRule: "",
        createRule: "@request.auth.id != ''",
        indexes: ["CREATE UNIQUE INDEX `idx_posts_slug` ON `posts` (`slug`)"],
        fields: [
          { name: "title", type: "text", required: true, max: 120 },
          { name: "slug", type: "text", required: true, pattern: "^[a-z0-9-]+$" },
          { name: "body", type: "editor" },
          { name: "author", type: "relation", collectionId: users.id, maxSelect: 1 },
        ],
      },
    ],
    [
      "members",
      {
        name: "members",
        type: "auth",
        listRule: "",
        viewRule: "",
        createRule: "",
        authAlert: { enabled: false },
        fields: [{ name: "name", type: "text", max: 80 }],
      },
    ],
    [
      "post_slugs",
      {
        name: "post_slugs",
        type: "view",
        listRule: "",
        viewRule: "",
        viewQuery: "SELECT id, slug FROM posts",
      },
    ],
  ] as const) {
    const created = await upstreamRequest("POST", "/api/collections", body);
    expect({ name, status: created.status }).toEqual({ name, status: 200 });
    if (name === "members") {
      // the file lists the implied system fields first, then the others, and
      // the stored order is the file's (the API saves the order it is given,
      // as the dashboard does when fields are reordered)
      const stored = (created.json as { fields: Record<string, unknown>[] }).fields;
      const reordered = [
        ...stored.filter((field) => field.system === true),
        ...stored.filter((field) => field.system !== true),
      ];
      const reorder = await upstreamRequest("PATCH", `/api/collections/${name}`, {
        fields: reordered,
      });
      expect({ name, status: reorder.status }).toEqual({ name, status: 200 });
    }
  }
}

// the stored schema of a data directory, as its rows: `_collections` (without
// the times; token secrets as present or absent) and `sqlite_schema`
function storedSchema(dataDir: string): { collections: unknown[]; schema: unknown[] } {
  const db = new Database(join(dataDir, "data.db"), { readonly: true });
  try {
    const collections = (
      db.query("SELECT * FROM _collections ORDER BY name").all() as Record<string, unknown>[]
    ).map((row) => {
      const { created: _created, updated: _updated, options, fields, ...rest } = row;
      // every token option has a random secret: its presence is compared
      const normalized = JSON.parse(String(options ?? "{}")) as Record<string, unknown>;
      for (const value of Object.values(normalized)) {
        const option = value as Record<string, unknown> | null;
        if (option !== null && typeof option === "object" && typeof option.secret === "string") {
          option.secret = option.secret === "" ? "" : "<secret>";
        }
      }
      // a view's field ids get a random suffix when they are generated
      const cloneIDs = String(fields).replace(/_clone_[A-Za-z0-9]{4}/g, "_clone_*");
      return { ...rest, options: normalized, fields: JSON.parse(cloneIDs) };
    });
    const schema = db
      .query(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all();
    return { collections, schema };
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "iglo-base-schema-apply-ref-"));
  upstreamDir = join(root, "upstream", "pb_data");
  igloDir = join(root, "iglo", "pb_data");

  const upsert = await runUpstream(
    ["superuser", "upsert", email, password, "--dir", upstreamDir],
    root,
  );
  expect(upsert.exitCode).toBe(0);
  mkdirSync(join(root, "iglo"));
  cpSync(upstreamDir, igloDir, { recursive: true });

  // the file is written from iglo.base's own copy of the fresh install
  schemaFile = join(root, "iglo.schema.json");
  writeFileSync(schemaFile, await fileText());

  upstream = await startUpstream({ dataDir: upstreamDir });
  const login = await fetch(`${upstream.url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: email, password }),
  });
  expect(login.status).toBe(200);
  token = ((await login.json()) as { token: string }).token;
  await changeUpstream();
  await upstream.stop();
  upstream = undefined;
}, hookTimeout);

afterAll(async () => {
  await upstream?.stop();
  if (root !== "") {
    rmSync(root, { recursive: true, force: true });
  }
}, hookTimeout);

describe("schema apply against upstream", () => {
  test(
    "the stored schema equals the one upstream stores for the same change",
    async () => {
      const server = await startServer(["--schema", schemaFile], igloDir);
      const stopped = await server.stop();
      expect(stopped.exitCode).toBe(0);

      const iglo = storedSchema(igloDir);
      const reference = storedSchema(upstreamDir);
      expect(iglo.schema).toEqual(reference.schema);
      expect(iglo.collections).toEqual(reference.collections);
    },
    hookTimeout,
  );

  test(
    "upstream opens the applied data and serves the same collections",
    async () => {
      const applied = await startUpstream({ dataDir: igloDir });
      try {
        const login = await fetch(`${applied.url}/api/collections/_superusers/auth-with-password`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ identity: email, password }),
        });
        expect(login.status).toBe(200);
        const appliedToken = ((await login.json()) as { token: string }).token;
        const res = await fetch(`${applied.url}/api/collections?perPage=500&sort=name`, {
          headers: { authorization: appliedToken },
        });
        expect(res.status).toBe(200);
        const items = ((await res.json()) as { items: { name: string }[] }).items;
        expect(items.map((c) => c.name)).toContain("post_slugs");
        expect(items.map((c) => c.name)).toContain("posts");
        expect(items.map((c) => c.name)).toContain("members");
      } finally {
        await applied.stop();
      }
    },
    hookTimeout,
  );

  test(
    "schema plan on the applied data changes nothing",
    async () => {
      const planned = await runIglo(["--dir", igloDir, "schema", "plan", "--schema", schemaFile]);
      expect(planned.exitCode).toBe(0);
      expect(planned.stdout).toContain("the schema is up to date");
    },
    hookTimeout,
  );
});
