// The TypeScript migrations and declared renames (D40, S.5) against the
// reference PocketBase v0.41.0 binary. Not part of `bun test`: run
// `bun run test:reference`.
//
// iglo.base applies a schema file with a declared field rename and a
// TypeScript migration (serve --schema, the compiled executable), and records
// the migration as `@schema/<file name>` in `_migrations`. Upstream v0.41.0
// has no file for that row. The check (D40, recorded there): upstream starts
// on the copy of the data, runs its own `migrate up` with the row present,
// serves the records iglo.base stored, and reads the renamed field.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run as runIglo, startServer, type RunningServer } from "@test/support/executable";
import { runUpstream } from "@test/differential/db/fixture";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

const hookTimeout = 180_000;
const email = "migrations@example.test";
const password = "1234567890";

let root = "";
let igloDir = "";
let schemaFile = "";
let upstream: UpstreamServer | undefined;
let upstreamToken = "";
let upstreamMigrate: { exitCode: number; output: string } | undefined;
let igloRecords: Record<string, unknown>[] = [];

// the schema file of the test: posts with a renamed field and a new field
// that the migration fills
const posts = (writer: string) => ({
  type: "base",
  rules: { list: "", view: "" },
  fields: {
    title: { type: "text", required: true },
    [writer]: { type: "text" },
  },
});

async function superuserToken(url: string): Promise<string> {
  const res = await fetch(`${url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: email, password }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function records(url: string, token: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${url}/api/collections/posts/records?perPage=500&sort=id`, {
    headers: { authorization: token },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Record<string, unknown>[] }).items;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "iglo-base-migrations-"));
  igloDir = join(root, "iglo", "pb_data");
  const upsert = await runIglo(["--dir", igloDir, "superuser", "upsert", email, password]);
  expect(upsert.exitCode).toBe(0);

  // the first version: a record that the rename must keep
  schemaFile = join(root, "iglo.schema.json");
  writeFileSync(schemaFile, JSON.stringify({ collections: { posts: posts("writer") } }));
  const first: RunningServer = await startServer(["--schema", schemaFile], igloDir);
  const firstToken = await superuserToken(first.url);
  const created = await fetch(`${first.url}/api/collections/posts/records`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: firstToken },
    body: JSON.stringify({ title: "hello", writer: "Ann" }),
  });
  expect(created.status).toBe(200);
  await first.stop();

  // the second version: the rename, a new field a migration fills, and the
  // migration itself, which runs once
  const migrationsDir = join(root, "migrations");
  mkdirSync(migrationsDir);
  writeFileSync(
    join(migrationsDir, "20261113250000_rename_and_fill.ts"),
    `export default {
  renames: { posts: { writer: "author" } },
  up(tx) {
    for (const post of tx.records("posts")) {
      tx.update("posts", post.id, { slug: "s-" + post.id });
    }
  },
};
`,
  );
  const second = posts("author");
  (second.fields as Record<string, unknown>).slug = { type: "text", required: true };
  writeFileSync(schemaFile, JSON.stringify({ collections: { posts: second } }));
  const applied = await startServer(["--schema", schemaFile], igloDir);
  const appliedToken = await superuserToken(applied.url);
  igloRecords = await records(applied.url, appliedToken);
  await applied.stop();

  // a copy of the data for upstream: the same files, the same rows. Upstream
  // runs its migrate command on the copy first, then serves it.
  const upstreamDir = join(root, "upstream", "pb_data");
  cpSync(igloDir, upstreamDir, { recursive: true });
  upstreamMigrate = await runUpstream(["migrate", "up", "--dir", upstreamDir], root);
  upstream = await startUpstream({ dataDir: upstreamDir });
  upstreamToken = await superuserToken(upstream.url);
}, hookTimeout);

afterAll(async () => {
  await upstream?.stop();
  if (root !== "") {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("TypeScript migrations against upstream", () => {
  test("iglo.base recorded the migration as a @schema/ row", async () => {
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(igloDir, "data.db"), { readonly: true });
    try {
      const rows = db.query("SELECT file FROM _migrations WHERE file LIKE '@schema/%'").all() as {
        file: string;
      }[];
      expect(rows.map((row) => row.file)).toEqual(["@schema/20261113250000_rename_and_fill.ts"]);
    } finally {
      db.close();
    }
  });

  test("upstream runs its migrate command with the @schema/ row, which it has no file for", () => {
    expect(upstreamMigrate?.exitCode).toBe(0);
    expect(upstreamMigrate?.output).toContain("No new migrations to apply");
  });

  test("upstream serves the records iglo.base stored, with the renamed field", async () => {
    if (upstream === undefined) {
      throw new Error("upstream did not start");
    }
    const upstreamRecords = await records(upstream.url, upstreamToken);
    expect(upstreamRecords).toEqual(igloRecords);
    expect(upstreamRecords).toEqual([
      expect.objectContaining({
        title: "hello",
        author: "Ann",
        slug: expect.stringMatching(/^s-/),
      }),
    ]);

    const collection = await fetch(`${upstream.url}/api/collections/posts`, {
      headers: { authorization: upstreamToken },
    });
    const fields = ((await collection.json()) as { fields: { name: string }[] }).fields.map(
      (field) => field.name,
    );
    expect(fields).toContain("author");
    expect(fields).not.toContain("writer");
  });
});
