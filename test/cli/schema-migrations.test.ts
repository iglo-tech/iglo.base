// TypeScript migrations and declared renames (D40, S.5), through the compiled
// executable and the API, on mktemp data. A schema file is applied at startup
// (serve --schema); the results are read back through the records API and the
// SQLite files, and `schema plan` / `schema types` through their output.
//
// Each apply test starts from a database that the earlier version of the file
// built, with rows made through the API, and checks what the next start leaves.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { run, startServer, tempDir, type RunningServer } from "@test/support/executable";

const repoRoot = resolve(import.meta.dir, "../..");
const sdkSource = join(repoRoot, "sdk/src");
const email = "migrations@example.test";
const password = "1234567890";

interface Site {
  root: string;
  dataDir: string;
  schemaPath: string;
  migrationsDir: string;
}

// a data directory with a superuser; the schema and the migrations are written
// by the test
async function newSite(): Promise<Site> {
  const root = tempDir();
  const dataDir = join(root, "pb_data");
  const created = await run(["--dir", dataDir, "superuser", "upsert", email, password]);
  expect(created.exitCode).toBe(0);
  const migrationsDir = join(root, "migrations");
  mkdirSync(migrationsDir);
  return { root, dataDir, schemaPath: join(root, "iglo.schema.json"), migrationsDir };
}

function writeSchema(site: Site, collections: Record<string, unknown>): void {
  writeFileSync(site.schemaPath, JSON.stringify({ collections }, null, 2));
}

function writeMigration(site: Site, file: string, source: string): void {
  writeFileSync(join(site.migrationsDir, file), source);
}

// The content of the databases: every table's rows, read back. A failed apply
// must leave the content as it was. (The bytes of the file are not compared:
// SQLite rewrites pages on a rolled-back write, so the file can differ while
// no row does.)
function digests(dataDir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ["data.db", "auxiliary.db"]) {
    const path = join(dataDir, name);
    if (!existsSync(path)) {
      continue;
    }
    const db = new Database(path, { readonly: true });
    try {
      const tables = (
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((row) => row.name);
      const content = Object.fromEntries(
        tables.map((table) => [
          table,
          (db.query(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[])
            .map((row) => JSON.stringify(row))
            .toSorted(),
        ]),
      );
      result[name] = JSON.stringify(content);
    } finally {
      db.close();
    }
  }
  return result;
}

// starts the server with the schema file; the start applies it
function serveWith(site: Site, extra: string[] = []): Promise<RunningServer> {
  return startServer(["--schema", site.schemaPath, ...extra], site.dataDir);
}

// the start fails: the error text of the failed start
async function startFails(site: Site, extra: string[] = []): Promise<string> {
  try {
    const server = await serveWith(site, extra);
    await server.stop();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("the server started, but the apply was expected to fail");
}

// the rows of the migrations table, read from the file
function migrationRows(dataDir: string): string[] {
  const db = new Database(join(dataDir, "data.db"), { readonly: true });
  try {
    return (
      db.query("SELECT file FROM _migrations ORDER BY rowid").all() as { file: string }[]
    ).map((row) => row.file);
  } finally {
    db.close();
  }
}

// the rows the apply recorded (the TypeScript migrations' rows)
function schemaRows(dataDir: string): string[] {
  return migrationRows(dataDir).filter((row) => row.startsWith("@schema/"));
}

// the API, with the superuser's token
async function superuser(url: string): Promise<string> {
  const response = await fetch(`${url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: email, password }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

async function api(
  url: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

// the records of a collection, through the API
async function records(
  url: string,
  token: string,
  collection: string,
): Promise<Record<string, unknown>[]> {
  const result = await api(url, token, "GET", `/api/collections/${collection}/records?perPage=500`);
  expect(result.status).toBe(200);
  return result.json.items as Record<string, unknown>[];
}

// the fields of a collection as the API returns them
async function fieldsOf(
  url: string,
  token: string,
  collection: string,
): Promise<Record<string, Record<string, unknown>>> {
  const result = await api(url, token, "GET", `/api/collections/${collection}`);
  expect(result.status).toBe(200);
  const fields = result.json.fields as Record<string, unknown>[];
  return Object.fromEntries(fields.map((field) => [String(field.name), field]));
}

// the rules of a collection as the API returns them
async function rulesOf(
  url: string,
  token: string,
  collection: string,
): Promise<Record<string, unknown>> {
  const result = await api(url, token, "GET", `/api/collections/${collection}`);
  expect(result.status).toBe(200);
  return result.json;
}

// a migration file with the given default export (the object as source text)
const migrationSource = (body: string): string => `export default {\n${body}\n};\n`;

const posts = (
  fields: Record<string, unknown>,
  rules: Record<string, string | null> = { list: "", view: "" },
) => ({
  type: "base",
  rules,
  fields,
});

describe("TypeScript migrations and declared renames (S.5)", () => {
  test("serve, schema plan and schema types document the migrations directory", async () => {
    const serve = await run(["serve", "--help"]);
    expect(serve.stdout).toContain("--schemaMigrationsDir");

    const plan = await run(["schema", "plan", "--help"]);
    expect(plan.stdout).toContain("--schemaMigrationsDir");

    const types = await run(["schema", "types", "--help"]);
    expect(types.stdout).toContain("--schemaMigrationsDir");
  });

  test("a field rename keeps the values, and the old name is gone", async () => {
    const site = await newSite();
    writeSchema(site, { posts: posts({ title: { type: "text" }, writer: { type: "text" } }) });
    let server = await serveWith(site);
    let token = await superuser(server.url);
    const created = await api(server.url, token, "POST", "/api/collections/posts/records", {
      title: "hello",
      writer: "Ann",
    });
    expect(created.status).toBe(200);
    const id = created.json.id as string;
    await server.stop();

    writeSchema(site, { posts: posts({ title: { type: "text" }, author: { type: "text" } }) });
    writeMigration(
      site,
      "20261113120000_rename_writer.ts",
      migrationSource(`  renames: { posts: { writer: "author" } },`),
    );
    server = await serveWith(site);
    token = await superuser(server.url);
    const rows = await records(server.url, token, "posts");
    expect(rows).toEqual([expect.objectContaining({ id, title: "hello", author: "Ann" })]);
    expect(Object.keys(await fieldsOf(server.url, token, "posts"))).not.toContain("writer");
    await server.stop();

    expect(migrationRows(site.dataDir)).toContain("@schema/20261113120000_rename_writer.ts");
  });

  test("a collection rename keeps records, ids, files and relations; the rules that name it come from the file", async () => {
    const site = await newSite();
    writeSchema(site, {
      authors: { type: "base", rules: { list: "", view: "" }, fields: { name: { type: "text" } } },
      posts: posts(
        {
          title: { type: "text" },
          author: { type: "relation", collection: "authors", maxSelect: 1 },
          cover: { type: "file", maxSelect: 1, maxSize: 100000 },
        },
        { list: '@collection.authors.id != ""', view: "" },
      ),
    });
    let server = await serveWith(site);
    let token = await superuser(server.url);
    const author = await api(server.url, token, "POST", "/api/collections/authors/records", {
      name: "Ann",
    });
    expect(author.status).toBe(200);
    const form = new FormData();
    form.append("title", "first");
    form.append("author", author.json.id as string);
    form.append("cover", new Blob(["file bytes"], { type: "text/plain" }), "cover.txt");
    const upload = await fetch(`${server.url}/api/collections/posts/records`, {
      method: "POST",
      headers: { authorization: token },
      body: form,
    });
    expect(upload.status).toBe(200);
    const post = (await upload.json()) as Record<string, unknown>;
    const postsCollection = (await api(server.url, token, "GET", "/api/collections/posts")).json;
    const authorsCollection = (await api(server.url, token, "GET", "/api/collections/authors"))
      .json;
    const cover = post.cover as string;
    await server.stop();

    writeSchema(site, {
      writers: { type: "base", rules: { list: "", view: "" }, fields: { name: { type: "text" } } },
      posts: posts(
        {
          title: { type: "text" },
          author: { type: "relation", collection: "writers", maxSelect: 1 },
          cover: { type: "file", maxSelect: 1, maxSize: 100000 },
        },
        { list: '@collection.writers.id != ""', view: "" },
      ),
    });
    writeMigration(
      site,
      "20261113150000_writers.ts",
      migrationSource(`  renameCollections: { authors: "writers" },`),
    );
    server = await serveWith(site);
    token = await superuser(server.url);
    expect(await records(server.url, token, "writers")).toEqual([
      expect.objectContaining({ id: author.json.id, name: "Ann" }),
    ]);
    const kept = await records(server.url, token, "posts");
    expect(kept).toEqual([
      expect.objectContaining({ id: post.id, title: "first", author: author.json.id, cover }),
    ]);
    // the stored file is served under the collection's id, as before
    const file = await fetch(`${server.url}/api/files/${postsCollection.id}/${post.id}/${cover}`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("file bytes");
    // the rule that named the old collection is the file's now
    expect((await rulesOf(server.url, token, "posts")).listRule).toBe(
      '@collection.writers.id != ""',
    );
    expect((await rulesOf(server.url, token, "writers")).id).toBe(authorsCollection.id);
    await server.stop();
  });

  test("the plan lists the renames and the rate-limit rules a collection rename relabels", async () => {
    const site = await newSite();
    writeSchema(site, {
      authors: { type: "base", rules: { list: "", view: "" }, fields: { name: { type: "text" } } },
    });
    let server = await serveWith(site);
    const token = await superuser(server.url);
    const settings = await api(server.url, token, "PATCH", "/api/settings", {
      rateLimits: {
        enabled: true,
        rules: [{ label: "authors:create", maxRequests: 5, duration: 10 }],
      },
    });
    expect(settings.status).toBe(200);
    await server.stop();

    writeSchema(site, {
      writers: { type: "base", rules: { list: "", view: "" }, fields: { name: { type: "text" } } },
    });
    writeMigration(
      site,
      "20261113151000_writers.ts",
      migrationSource(`  renameCollections: { authors: "writers" },`),
    );
    const plan = await run(["--dir", site.dataDir, "schema", "plan", "--schema", site.schemaPath]);
    expect(plan.exitCode).toBe(0);
    expect(plan.stdout).toContain("collection authors -> writers (20261113151000_writers.ts)");
    expect(plan.stdout).toContain("rate limit rule authors:create -> writers:create");
  });

  test("a view over a renamed field is created again with the file's query", async () => {
    const site = await newSite();
    writeSchema(site, {
      posts: posts({ title: { type: "text" }, writer: { type: "text" } }),
      names: {
        type: "view",
        rules: { list: "", view: "" },
        query: "SELECT id, writer FROM posts",
      },
    });
    let server = await serveWith(site);
    let token = await superuser(server.url);
    expect(
      (
        await api(server.url, token, "POST", "/api/collections/posts/records", {
          title: "a",
          writer: "Ann",
        })
      ).status,
    ).toBe(200);
    await server.stop();

    writeSchema(site, {
      posts: posts({ title: { type: "text" }, author: { type: "text" } }),
      names: {
        type: "view",
        rules: { list: "", view: "" },
        query: "SELECT id, author FROM posts",
      },
    });
    writeMigration(
      site,
      "20261113152500_view_rename.ts",
      migrationSource(`  renames: { posts: { writer: "author" } },`),
    );
    server = await serveWith(site);
    token = await superuser(server.url);
    const names = await records(server.url, token, "names");
    expect(names).toEqual([expect.objectContaining({ author: "Ann" })]);
    await server.stop();
  });

  test("a rename and a narrow in the same apply", async () => {
    const site = await newSite();
    writeSchema(site, {
      posts: posts({ title: { type: "text" }, writer: { type: "text" } }),
    });
    let server = await serveWith(site);
    let token = await superuser(server.url);
    expect(
      (await api(server.url, token, "POST", "/api/collections/posts/records", { title: "a" }))
        .status,
    ).toBe(200);
    await server.stop();

    writeSchema(site, {
      posts: posts({ title: { type: "text", max: 40 }, author: { type: "text" } }),
    });
    writeMigration(
      site,
      "20261113152000_rename_and_narrow.ts",
      migrationSource(`  renames: { posts: { writer: "author" } },`),
    );
    server = await serveWith(site);
    token = await superuser(server.url);
    expect((await fieldsOf(server.url, token, "posts")).title?.max).toBe(40);
    await server.stop();
  });

  test("refuses renames that cannot run, and the apply leaves the database unchanged", async () => {
    const site = await newSite();
    writeSchema(site, { posts: posts({ title: { type: "text" }, writer: { type: "text" } }) });
    (await serveWith(site)).stop();

    const cases: [string, string, string[]][] = [
      [
        "20261113160000_missing.ts",
        `  renames: { posts: { nothere: "author" } },`,
        ['no field "nothere"'],
      ],
      [
        "20261113160100_taken.ts",
        `  renames: { posts: { writer: "title" } },`,
        ['already has a field "title"'],
      ],
      [
        "20261113160200_unlisted.ts",
        `  renames: { posts: { writer: "byline" } },`,
        ['the schema file has no field "byline"'],
      ],
      [
        "20261113160300_collide.ts",
        `  renames: { posts: { writer: "author" } },`,
        ["renames collide"],
      ],
    ];
    const schemaWithAuthor = {
      posts: posts({ title: { type: "text" }, author: { type: "text" } }),
    };
    for (const [file, body, expected] of cases) {
      writeSchema(site, schemaWithAuthor);
      writeMigration(site, file, migrationSource(body));
      if (file.includes("collide")) {
        writeMigration(
          site,
          "20261113160250_again.ts",
          migrationSource(`  renames: { posts: { writer: "editor" } },`),
        );
      }
      const before = digests(site.dataDir);
      const plan = await run([
        "--dir",
        site.dataDir,
        "schema",
        "plan",
        "--schema",
        site.schemaPath,
      ]);
      expect(plan.exitCode).not.toBe(0);
      for (const text of expected) {
        expect(plan.stdout + plan.stderr).toContain(text);
      }
      const failed = await startFails(site);
      expect(failed).toContain("not applied");
      expect(digests(site.dataDir)).toEqual(before);
      expect(schemaRows(site.dataDir)).toEqual([]);
      // the next case starts without the declared renames of this one
      for (const name of [file, "20261113160250_again.ts"]) {
        rmFile(join(site.migrationsDir, name));
      }
    }
  });

  test("a migration fills a new required field across two passes, and the record check passes", async () => {
    const site = await newSite();
    writeSchema(site, { posts: posts({ title: { type: "text" } }) });
    let server = await serveWith(site);
    let token = await superuser(server.url);
    for (const title of ["one", "two"]) {
      expect(
        (await api(server.url, token, "POST", "/api/collections/posts/records", { title })).status,
      ).toBe(200);
    }
    await server.stop();

    writeSchema(site, {
      posts: posts({ title: { type: "text" }, slug: { type: "text", required: true } }),
    });
    writeMigration(
      site,
      "20261113170000_slug.ts",
      migrationSource(`  up(tx) {
    // pass one touches every record, before the slug is set
    for (const post of tx.records("posts")) {
      tx.update("posts", post.id, { title: post.title + "!" });
    }
    // pass two fills the slug
    for (const post of tx.records("posts")) {
      tx.update("posts", post.id, { slug: "s-" + post.id });
    }
  },`),
    );
    server = await serveWith(site);
    token = await superuser(server.url);
    const rows = await records(server.url, token, "posts");
    expect(rows.map((row) => row.title).toSorted()).toEqual(["one!", "two!"]);
    expect(rows.every((row) => String(row.slug).startsWith("s-"))).toBe(true);
    expect((await fieldsOf(server.url, token, "posts")).slug?.required).toBe(true);
    await server.stop();
  });

  test("a required field that stays empty fails the record check, and nothing is applied", async () => {
    const site = await newSite();
    writeSchema(site, { posts: posts({ title: { type: "text" } }) });
    let server = await serveWith(site);
    const token = await superuser(server.url);
    expect(
      (await api(server.url, token, "POST", "/api/collections/posts/records", { title: "x" }))
        .status,
    ).toBe(200);
    await server.stop();

    writeSchema(site, {
      posts: posts({ title: { type: "text" }, slug: { type: "text", required: true } }),
    });
    const before = digests(site.dataDir);
    const failed = await startFails(site);
    expect(failed).toContain("not applied");
    expect(failed).toContain("slug");
    expect(digests(site.dataDir)).toEqual(before);
  });

  test("a migration that throws rolls back the whole startup and names the file", async () => {
    const site = await newSite();
    writeSchema(site, { posts: posts({ title: { type: "text" } }) });
    (await serveWith(site)).stop();

    writeSchema(site, { posts: posts({ title: { type: "text" }, note: { type: "text" } }) });
    writeMigration(
      site,
      "20261113180000_throws.ts",
      migrationSource(`  up(tx) {
    tx.create("posts", { title: "made before the throw" });
    throw new Error("the data is wrong");
  },`),
    );
    const before = digests(site.dataDir);
    const failed = await startFails(site);
    expect(failed).toContain("20261113180000_throws.ts");
    expect(failed).toContain("the data is wrong");
    expect(digests(site.dataDir)).toEqual(before);
    expect(schemaRows(site.dataDir)).toEqual([]);
  });

  test("an async up fails the apply, because up must be synchronous", async () => {
    const site = await newSite();
    writeSchema(site, { posts: posts({ title: { type: "text" } }) });
    (await serveWith(site)).stop();

    writeMigration(
      site,
      "20261113181000_async.ts",
      migrationSource(`  async up(tx) {
    tx.create("posts", { title: "late" });
  },`),
    );
    const before = digests(site.dataDir);
    const failed = await startFails(site);
    expect(failed).toContain("20261113181000_async.ts");
    expect(failed).toContain("synchronous");
    expect(digests(site.dataDir)).toEqual(before);
  });

  test("a file runs once across restarts", async () => {
    const site = await newSite();
    writeSchema(site, { posts: posts({ title: { type: "text" } }) });
    writeMigration(
      site,
      "20261113190000_once.ts",
      migrationSource(`  up(tx) {
    tx.create("posts", { title: "once" });
  },`),
    );
    for (let start = 0; start < 2; start++) {
      const server = await serveWith(site);
      const token = await superuser(server.url);
      const rows = await records(server.url, token, "posts");
      expect(rows.filter((row) => row.title === "once")).toHaveLength(1);
      await server.stop();
    }
    expect(schemaRows(site.dataDir)).toEqual(["@schema/20261113190000_once.ts"]);
  });

  test("schema plan with a pending migration changes nothing", async () => {
    const site = await newSite();
    writeSchema(site, { posts: posts({ title: { type: "text" } }) });
    (await serveWith(site)).stop();

    writeMigration(
      site,
      "20261113200000_pending.ts",
      migrationSource(`  up(tx) {
    tx.create("posts", { title: "planned" });
  },`),
    );
    const before = digests(site.dataDir);
    const plan = await run(["--dir", site.dataDir, "schema", "plan", "--schema", site.schemaPath]);
    expect(plan.exitCode).toBe(0);
    expect(plan.stdout).toContain("migrations that would run:");
    expect(plan.stdout).toContain("20261113200000_pending.ts");
    expect(digests(site.dataDir)).toEqual(before);
    expect(schemaRows(site.dataDir)).toEqual([]);
  });

  test("a file name that does not fit, or a file that does not load, is refused with its name", async () => {
    const site = await newSite();
    writeSchema(site, { posts: posts({ title: { type: "text" } }) });

    writeMigration(site, "fill-title.ts", migrationSource(`  up(tx) {}`));
    const badName = await run([
      "--dir",
      site.dataDir,
      "schema",
      "plan",
      "--schema",
      site.schemaPath,
    ]);
    expect(badName.exitCode).not.toBe(0);
    expect(badName.stdout + badName.stderr).toContain("fill-title.ts");
    rmFile(join(site.migrationsDir, "fill-title.ts"));

    writeMigration(site, "20261113210000_broken.ts", "export default { up(tx) {");
    const broken = await run([
      "--dir",
      site.dataDir,
      "schema",
      "plan",
      "--schema",
      site.schemaPath,
    ]);
    expect(broken.exitCode).not.toBe(0);
    expect(broken.stdout + broken.stderr).toContain("20261113210000_broken.ts");
  });

  test("--schemaMigrationsDir names the directory of the migrations", async () => {
    const site = await newSite();
    writeSchema(site, { posts: posts({ title: { type: "text" } }) });
    const elsewhere = join(site.root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(
      join(elsewhere, "20261113220000_elsewhere.ts"),
      migrationSource(`  up(tx) {\n    tx.create("posts", { title: "elsewhere" });\n  },`),
    );

    const without = await run([
      "--dir",
      site.dataDir,
      "schema",
      "plan",
      "--schema",
      site.schemaPath,
    ]);
    expect(without.stdout).not.toContain("20261113220000_elsewhere.ts");

    const named = await run([
      "--dir",
      site.dataDir,
      "schema",
      "plan",
      "--schema",
      site.schemaPath,
      "--schemaMigrationsDir",
      elsewhere,
    ]);
    expect(named.exitCode).toBe(0);
    expect(named.stdout).toContain("20261113220000_elsewhere.ts");
  });

  test("schema types writes the migration types, and tsc catches a migration that does not match them", async () => {
    const site = await newSite();
    writeSchema(site, {
      posts: posts({ title: { type: "text", required: true }, views: { type: "number" } }),
    });
    const typesPath = join(site.root, "iglo.types.ts");
    const generated = await run([
      "--dir",
      site.dataDir,
      "schema",
      "types",
      "--schema",
      site.schemaPath,
      "--out",
      typesPath,
    ]);
    expect(generated.exitCode).toBe(0);
    const types = readFileSync(typesPath, "utf8");
    expect(types).toContain("export type Migration = {");
    expect(types).toContain("export interface MigrationTx {");
    expect(types).toContain("update<C extends keyof MigrationRecords>(");

    const good = join(site.migrationsDir, "20261113230000_good.ts");
    writeFileSync(
      good,
      `import type { Migration } from "../iglo.types";\n` +
        `export default {\n  up(tx) {\n    for (const post of tx.records("posts")) {\n      tx.update("posts", post.id, { views: 1 });\n    }\n  },\n} satisfies Migration;\n`,
    );
    const bad = join(site.migrationsDir, "20261113230100_bad.ts");
    writeFileSync(
      bad,
      `import type { Migration } from "../iglo.types";\n` +
        `export default {\n  up(tx) {\n    tx.update("posts", "x", { titel: "typo" });\n    tx.update("posts", "x", { views: "many" });\n  },\n} satisfies Migration;\n`,
    );
    const tsconfig = join(site.root, "tsconfig.json");
    writeFileSync(
      tsconfig,
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022", "DOM"],
          module: "Preserve",
          moduleResolution: "bundler",
          types: [],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          verbatimModuleSyntax: true,
          paths: {
            "@iglo.tech/iglo.base": [join(sdkSource, "index.ts")],
            "@sdk/*": [join(sdkSource, "*")],
          },
        },
        files: [typesPath, good],
      }),
    );
    const tsc = Bun.spawn([join(repoRoot, "node_modules/.bin/tsc"), "-p", tsconfig], {
      cwd: site.root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await tsc.exited).toBe(0);

    writeFileSync(
      tsconfig,
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022", "DOM"],
          module: "Preserve",
          moduleResolution: "bundler",
          types: [],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          verbatimModuleSyntax: true,
          paths: {
            "@iglo.tech/iglo.base": [join(sdkSource, "index.ts")],
            "@sdk/*": [join(sdkSource, "*")],
          },
        },
        files: [typesPath, bad],
      }),
    );
    const badTsc = Bun.spawn([join(repoRoot, "node_modules/.bin/tsc"), "-p", tsconfig], {
      cwd: site.root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output =
      (await new Response(badTsc.stdout).text()) + (await new Response(badTsc.stderr).text());
    expect(await badTsc.exited).not.toBe(0);
    expect(output).toContain("'titel' does not exist in type 'PostsUpdate'");
    expect(output).toContain("Type 'string' is not assignable to type 'number'");
  });

  test("migrate history-sync keeps the @schema rows and removes nothing else", async () => {
    const site = await newSite();
    writeSchema(site, { posts: posts({ title: { type: "text" } }) });
    writeMigration(
      site,
      "20261113240000_kept.ts",
      migrationSource(`  up(tx) {\n    tx.create("posts", { title: "kept" });\n  },`),
    );
    (await serveWith(site)).stop();
    expect(migrationRows(site.dataDir)).toContain("@schema/20261113240000_kept.ts");

    rmFile(join(site.migrationsDir, "20261113240000_kept.ts"));
    const sync = await run(["--dir", site.dataDir, "migrate", "history-sync"]);
    expect(sync.exitCode).toBe(0);
    expect(migrationRows(site.dataDir)).toContain("@schema/20261113240000_kept.ts");
  });
});

// removes a file the test wrote (a migration that the next case must not see)
function rmFile(path: string): void {
  rmSync(path, { force: true });
}
