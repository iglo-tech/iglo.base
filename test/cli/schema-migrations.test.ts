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
        `  renames: { posts: { writer: "author", title: "author" } },`,
        ["renames collide"],
      ],
      [
        "20261113160350_chain.ts",
        `  renames: { posts: { writer: "author", author: "byline" } },`,
        ["renamed again in the same file"],
      ],
    ];
    const schemaWithAuthor = {
      posts: posts({ title: { type: "text" }, author: { type: "text" } }),
    };
    for (const [file, body, expected] of cases) {
      writeSchema(site, schemaWithAuthor);
      writeMigration(site, file, migrationSource(body));
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
      rmFile(join(site.migrationsDir, file));
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

  test("a migration with a syntax error, or an import that does not resolve, names the file, the position and the reason", async () => {
    const site = await newSite();
    writeSchema(site, { posts: posts({ title: { type: "text" } }) });
    const plan = () => run(["--dir", site.dataDir, "schema", "plan", "--schema", site.schemaPath]);

    writeMigration(
      site,
      "20261113210000_syntax.ts",
      `export default {\n  up(tx) {\n    tx.create("posts", { title: "x" ));\n  },\n};\n`,
    );
    const syntax = await plan();
    expect(syntax.exitCode).not.toBe(0);
    const syntaxOutput = syntax.stdout + syntax.stderr;
    expect(syntaxOutput).toContain("20261113210000_syntax.ts:3:37");
    expect(syntaxOutput).toContain('Expected "}" but found ")"');
    rmFile(join(site.migrationsDir, "20261113210000_syntax.ts"));

    writeMigration(
      site,
      "20261113220000_import.ts",
      `import { title } from "../lib/nope";\nexport default {\n  up(tx) {\n    tx.create("posts", { title });\n  },\n};\n`,
    );
    const missing = await plan();
    expect(missing.exitCode).not.toBe(0);
    const missingOutput = missing.stdout + missing.stderr;
    expect(missingOutput).toContain("20261113220000_import.ts");
    expect(missingOutput).toContain("20261113220000_import.ts:1:");
    expect(missingOutput).toContain("../lib/nope");
    expect(missingOutput).not.toContain("Bundle failed");
  });

  test("import.meta.dir in a migration is the migration's directory: a file read next to it applies", async () => {
    const site = await newSite();
    writeSchema(site, { posts: posts({ title: { type: "text" } }) });
    writeFileSync(join(site.migrationsDir, "seed.csv"), "title\nfirst row\nsecond row\n");
    writeMigration(
      site,
      "20261113230000_seed.ts",
      `import { readFileSync } from "node:fs";\nimport { join } from "node:path";\n\nexport default {\n  up(tx) {\n    const csv = readFileSync(join(import.meta.dir, "seed.csv"), "utf8");\n    tx.create("posts", { title: csv.split("\\n")[1] });\n  },\n};\n`,
    );
    const server = await serveWith(site);
    try {
      const token = await superuser(server.url);
      const rows = await records(server.url, token, "posts");
      expect(rows.map((row) => row.title)).toEqual(["first row"]);
    } finally {
      await server.stop();
    }
    expect(schemaRows(site.dataDir)).toEqual(["@schema/20261113230000_seed.ts"]);
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

// Declared renames across the references that a stored rule or index can
// take (round 1 of S.5): the rules and indexes that name a renamed field or
// collection in any form are cleared, and the file's are set again. A start
// with the file and its renames applies, and `schema plan` says so first.
async function renameScenario(
  before: Record<string, unknown>,
  seed: (url: string, token: string) => Promise<void>,
  after: Record<string, unknown>,
  migrations: [file: string, source: string][],
  check: (url: string, token: string) => Promise<void>,
): Promise<void> {
  const site = await newSite();
  writeSchema(site, before);
  const first = await serveWith(site);
  await seed(first.url, await superuser(first.url));
  await first.stop();

  writeSchema(site, after);
  for (const [file, source] of migrations) {
    writeMigration(site, file, source);
  }
  const plan = await run(["--dir", site.dataDir, "schema", "plan", "--schema", site.schemaPath]);
  expect(plan.stdout).toContain("the schema would apply");
  expect(plan.exitCode).toBe(0);

  const server = await serveWith(site);
  try {
    await check(server.url, await superuser(server.url));
  } finally {
    await server.stop();
  }
}

// the collection's rules, the fields and the indexes as the API returns them
async function collectionOf(
  url: string,
  token: string,
  name: string,
): Promise<Record<string, unknown>> {
  return (await api(url, token, "GET", `/api/collections/${name}`)).json;
}

const relationTo = (collection: string) => ({
  type: "relation",
  collection,
  maxSelect: 1,
});

describe("declared renames: references, files and hidden fields (S.5)", () => {
  test("a rule of another collection that reaches the renamed field through a relation is set again", async () => {
    await renameScenario(
      {
        posts: posts({ title: { type: "text" }, writer: { type: "text" } }),
        comments: {
          type: "base",
          rules: { list: 'post.writer != ""', view: "" },
          fields: { text: { type: "text" }, post: relationTo("posts") },
        },
      },
      async (url, token) => {
        const post = await api(url, token, "POST", "/api/collections/posts/records", {
          title: "t",
          writer: "Ann",
        });
        expect(post.status).toBe(200);
        const comment = await api(url, token, "POST", "/api/collections/comments/records", {
          text: "hi",
          post: post.json.id,
        });
        expect(comment.status).toBe(200);
      },
      {
        posts: posts({ title: { type: "text" }, author: { type: "text" } }),
        comments: {
          type: "base",
          rules: { list: 'post.author != ""', view: "" },
          fields: {
            text: { type: "text" },
            post: relationTo("posts"),
            score: { type: "number" },
          },
        },
      },
      [
        [
          "20261114100000_writer.ts",
          migrationSource(`  renames: { posts: { writer: "author" } },`),
        ],
      ],
      async (url, token) => {
        expect((await collectionOf(url, token, "comments")).listRule).toBe('post.author != ""');
        const rows = await records(url, token, "comments");
        expect(rows).toEqual([expect.objectContaining({ text: "hi" })]);
      },
    );
  });

  test("a rule that names the renamed field through a self relation is set again", async () => {
    await renameScenario(
      {
        posts: {
          type: "base",
          rules: { list: 'parent.writer != ""', view: "" },
          fields: {
            title: { type: "text" },
            writer: { type: "text" },
            parent: relationTo("posts"),
          },
        },
      },
      async (url, token) => {
        const parent = await api(url, token, "POST", "/api/collections/posts/records", {
          title: "parent",
          writer: "Ann",
        });
        expect(parent.status).toBe(200);
        const child = await api(url, token, "POST", "/api/collections/posts/records", {
          title: "child",
          parent: parent.json.id,
        });
        expect(child.status).toBe(200);
      },
      {
        posts: {
          type: "base",
          rules: { list: 'parent.author != ""', view: "" },
          fields: {
            title: { type: "text" },
            author: { type: "text" },
            parent: relationTo("posts"),
          },
        },
      },
      [["20261114100100_self.ts", migrationSource(`  renames: { posts: { writer: "author" } },`)]],
      async (url, token) => {
        expect((await collectionOf(url, token, "posts")).listRule).toBe('parent.author != ""');
        expect(await records(url, token, "posts")).toHaveLength(2);
      },
    );
  });

  test("a relation path into a renamed collection, with both collections renamed in one file", async () => {
    await renameScenario(
      {
        posts: posts({ title: { type: "text" }, writer: { type: "text" } }),
        comments: {
          type: "base",
          rules: { list: 'post.writer != ""', view: "" },
          fields: { text: { type: "text" }, post: relationTo("posts") },
        },
      },
      async (url, token) => {
        const post = await api(url, token, "POST", "/api/collections/posts/records", {
          title: "t",
          writer: "Ann",
        });
        await api(url, token, "POST", "/api/collections/comments/records", {
          text: "kept",
          post: post.json.id,
        });
      },
      {
        posts: posts({ title: { type: "text" }, author: { type: "text" } }),
        comments: {
          type: "base",
          rules: { list: 'post.author != ""', view: "" },
          fields: { body: { type: "text" }, post: relationTo("posts") },
        },
      },
      [
        [
          "20261114100200_both.ts",
          migrationSource(
            `  renames: { posts: { writer: "author" }, comments: { text: "body" } },`,
          ),
        ],
      ],
      async (url, token) => {
        expect((await collectionOf(url, token, "comments")).listRule).toBe('post.author != ""');
        expect(await records(url, token, "comments")).toEqual([
          expect.objectContaining({ body: "kept" }),
        ]);
      },
    );
  });

  test("a back relation whose relation field is renamed", async () => {
    await renameScenario(
      {
        posts: posts({ title: { type: "text" } }, { list: 'comments_via_post.id != ""', view: "" }),
        comments: {
          type: "base",
          rules: { list: "", view: "" },
          fields: { text: { type: "text" }, post: relationTo("posts") },
        },
      },
      async (url, token) => {
        const post = await api(url, token, "POST", "/api/collections/posts/records", {
          title: "t",
        });
        await api(url, token, "POST", "/api/collections/comments/records", {
          text: "c",
          post: post.json.id,
        });
      },
      {
        posts: posts(
          { heading: { type: "text" } },
          { list: 'comments_via_article.id != ""', view: "" },
        ),
        comments: {
          type: "base",
          rules: { list: "", view: "" },
          fields: { text: { type: "text" }, article: relationTo("posts") },
        },
      },
      [
        [
          "20261114100300_back.ts",
          migrationSource(
            `  renames: { comments: { post: "article" }, posts: { title: "heading" } },`,
          ),
        ],
      ],
      async (url, token) => {
        expect((await collectionOf(url, token, "posts")).listRule).toBe(
          'comments_via_article.id != ""',
        );
        expect(await records(url, token, "posts")).toEqual([
          expect.objectContaining({ heading: "t" }),
        ]);
      },
    );
  });

  test("a back relation through a renamed collection", async () => {
    await renameScenario(
      {
        posts: posts({ title: { type: "text" } }, { list: 'comments_via_post.id != ""', view: "" }),
        comments: {
          type: "base",
          rules: { list: "", view: "" },
          fields: { text: { type: "text" }, post: relationTo("posts") },
        },
      },
      async (url, token) => {
        const post = await api(url, token, "POST", "/api/collections/posts/records", {
          title: "t",
        });
        await api(url, token, "POST", "/api/collections/comments/records", {
          text: "c",
          post: post.json.id,
        });
      },
      {
        posts: posts(
          { heading: { type: "text" } },
          { list: 'replies_via_post.id != ""', view: "" },
        ),
        replies: {
          type: "base",
          rules: { list: "", view: "" },
          fields: { text: { type: "text" }, post: relationTo("posts") },
        },
      },
      [
        [
          "20261114100400_renamed_back.ts",
          migrationSource(
            `  renameCollections: { comments: "replies" },\n  renames: { posts: { title: "heading" } },`,
          ),
        ],
      ],
      async (url, token) => {
        expect((await collectionOf(url, token, "posts")).listRule).toBe(
          'replies_via_post.id != ""',
        );
        expect(await records(url, token, "replies")).toEqual([
          expect.objectContaining({ text: "c" }),
        ]);
      },
    );
  });

  test("an alias in a rule that names a renamed field of another collection", async () => {
    await renameScenario(
      {
        alpha: posts({ writer: { type: "text" } }),
        zeta: {
          type: "base",
          rules: { list: '@collection.alpha:p.writer != ""', view: "" },
          fields: { text: { type: "text" } },
        },
      },
      async () => {},
      {
        alpha: posts({ author: { type: "text" } }),
        zeta: {
          type: "base",
          rules: { list: '@collection.alpha:p.author != ""', view: "" },
          fields: { body: { type: "text" } },
        },
      },
      [
        [
          "20261114100500_alias.ts",
          migrationSource(`  renames: { alpha: { writer: "author" }, zeta: { text: "body" } },`),
        ],
      ],
      async (url, token) => {
        expect((await collectionOf(url, token, "zeta")).listRule).toBe(
          '@collection.alpha:p.author != ""',
        );
      },
    );
  });

  test("an expression index and a partial index on the renamed field are written again", async () => {
    await renameScenario(
      {
        posts: {
          type: "base",
          rules: { list: "", view: "" },
          fields: { title: { type: "text" }, writer: { type: "text" } },
          indexes: [
            "CREATE INDEX idx_w ON posts (lower(writer))",
            "CREATE INDEX idx_t ON posts (title) WHERE writer != ''",
          ],
        },
      },
      async (url, token) => {
        await api(url, token, "POST", "/api/collections/posts/records", {
          title: "t",
          writer: "Ann",
        });
      },
      {
        posts: {
          type: "base",
          rules: { list: "", view: "" },
          fields: { title: { type: "text" }, author: { type: "text" } },
          indexes: [
            "CREATE INDEX idx_w ON posts (lower(author))",
            "CREATE INDEX idx_t ON posts (title) WHERE author != ''",
          ],
        },
      },
      [
        [
          "20261114100600_indexes.ts",
          migrationSource(`  renames: { posts: { writer: "author" } },`),
        ],
      ],
      async (url, token) => {
        const indexes = (await collectionOf(url, token, "posts")).indexes as string[];
        expect(indexes.join("\n")).toContain("lower(author)");
        expect(indexes.join("\n")).toContain("WHERE author");
        expect(indexes.join("\n")).not.toContain("writer");
        expect(await records(url, token, "posts")).toHaveLength(1);
      },
    );
  });

  test("a collection rename and a field rename of it in one file, keyed by the old name", async () => {
    await renameScenario(
      {
        authors: {
          type: "base",
          rules: { list: "", view: "" },
          fields: { name: { type: "text" } },
        },
      },
      async (url, token) => {
        await api(url, token, "POST", "/api/collections/authors/records", { name: "Ann" });
      },
      {
        writers: {
          type: "base",
          rules: { list: "", view: "" },
          fields: { fullname: { type: "text" } },
        },
      },
      [
        [
          "20261114100700_writers.ts",
          migrationSource(
            `  renameCollections: { authors: "writers" },\n  renames: { authors: { name: "fullname" } },`,
          ),
        ],
      ],
      async (url, token) => {
        expect(await records(url, token, "writers")).toEqual([
          expect.objectContaining({ fullname: "Ann" }),
        ]);
      },
    );
  });

  test("the same rename across two files: the collection in one, its field in the next", async () => {
    await renameScenario(
      {
        authors: {
          type: "base",
          rules: { list: "", view: "" },
          fields: { name: { type: "text" } },
        },
      },
      async (url, token) => {
        await api(url, token, "POST", "/api/collections/authors/records", { name: "Ann" });
      },
      {
        writers: {
          type: "base",
          rules: { list: "", view: "" },
          fields: { fullname: { type: "text" } },
        },
      },
      [
        [
          "20261114100800_collection.ts",
          migrationSource(`  renameCollections: { authors: "writers" },`),
        ],
        [
          "20261114100900_field.ts",
          migrationSource(`  renames: { writers: { name: "fullname" } },`),
        ],
      ],
      async (url, token) => {
        expect(await records(url, token, "writers")).toEqual([
          expect.objectContaining({ fullname: "Ann" }),
        ]);
      },
    );
  });

  test("a chain across two files, applied in two starts (the first file has run)", async () => {
    const site = await newSite();
    writeSchema(site, { posts: posts({ title: { type: "text" }, writer: { type: "text" } }) });
    let server = await serveWith(site);
    let token = await superuser(server.url);
    await api(server.url, token, "POST", "/api/collections/posts/records", {
      title: "t",
      writer: "Ann",
    });
    await server.stop();

    // the first file runs in a start of its own
    writeSchema(site, { posts: posts({ title: { type: "text" }, author: { type: "text" } }) });
    writeMigration(
      site,
      "20261114101000_author.ts",
      migrationSource(`  renames: { posts: { writer: "author" } },`),
    );
    server = await serveWith(site);
    await server.stop();
    expect(schemaRows(site.dataDir)).toEqual(["@schema/20261114101000_author.ts"]);

    // the second one renames the first's result; the file runs against it
    writeSchema(site, { posts: posts({ title: { type: "text" }, byline: { type: "text" } }) });
    writeMigration(
      site,
      "20261114101100_byline.ts",
      migrationSource(`  renames: { posts: { author: "byline" } },`),
    );
    const plan = await run(["--dir", site.dataDir, "schema", "plan", "--schema", site.schemaPath]);
    expect(plan.exitCode).toBe(0);
    server = await serveWith(site);
    token = await superuser(server.url);
    const rows = await records(server.url, token, "posts");
    expect(rows).toEqual([expect.objectContaining({ title: "t", byline: "Ann" })]);
    expect(Object.keys(await fieldsOf(server.url, token, "posts"))).not.toContain("author");
    await server.stop();
    expect(schemaRows(site.dataDir)).toEqual([
      "@schema/20261114101000_author.ts",
      "@schema/20261114101100_byline.ts",
    ]);
  });

  test("a helper reads the record as a superuser's read does: the email and the hidden fields", async () => {
    const members = {
      type: "auth",
      rules: { list: "", view: "" },
      fields: {
        nick: { type: "text" },
        secret: { type: "text", hidden: true },
      },
    };
    await renameScenario(
      { members },
      async (url, token) => {
        const created = await api(url, token, "POST", "/api/collections/members/records", {
          email: "ann@example.test",
          password: "1234567890",
          passwordConfirm: "1234567890",
          nick: "n",
          secret: "s3cr3t",
        });
        expect(created.status).toBe(200);
      },
      {
        members: {
          ...members,
          fields: {
            nick: { type: "text" },
            secret: { type: "text", hidden: true },
            note: { type: "text" },
          },
        },
      },
      [
        [
          "20261114101200_read.ts",
          `export default {\n  up(tx) {\n    const row = tx.findFirst("members", { filter: 'nick = "n"' });\n` +
            `    if (row === null) throw new Error("no member");\n` +
            `    tx.update("members", row.id, { note: \`\${row.email}|\${row.secret}\` });\n  },\n};\n`,
        ],
      ],
      async (url, token) => {
        const [member] = (await api(url, token, "GET", "/api/collections/members/records")).json
          .items as Record<string, unknown>[];
        expect(member?.note).toBe("ann@example.test|s3cr3t");
        expect(member?.secret).toBe("s3cr3t");
      },
    );
  });

  test("a rename to a hidden field type-checks against the generated Migration type", async () => {
    const site = await newSite();
    writeSchema(site, { posts: posts({ title: { type: "text" }, secret: { type: "text" } }) });
    (await serveWith(site)).stop();

    writeSchema(site, {
      posts: posts({ title: { type: "text" }, apikey: { type: "text", hidden: true } }),
    });
    const good = join(site.migrationsDir, "20261114101300_apikey.ts");
    writeFileSync(
      good,
      `import type { Migration } from "../iglo.types";\n` +
        `export default {\n  renames: { posts: { secret: "apikey" } },\n} satisfies Migration;\n`,
    );
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

    const server = await serveWith(site);
    const token = await superuser(server.url);
    expect(Object.keys(await fieldsOf(server.url, token, "posts"))).toContain("apikey");
    await server.stop();
  });
});

// a members collection, an auth collection with MFA (and the OTP it needs) on a rule
const membersOf = (field: string, rule: string) => ({
  type: "auth",
  rules: { list: "", view: "" },
  fields: { [field]: { type: "text" } },
  otp: { enabled: true },
  mfa: { enabled: true, duration: 1800, rule },
});

// a custom field of _superusers, with the index that names it
const superusersOf = (field: string) => ({
  type: "auth",
  fields: { [field]: { type: "text" } },
  indexes: [`CREATE INDEX idx_su_n ON _superusers (${field})`],
});

describe("declared renames: what step 2 clears, and what the plan shows (S.5, round 2)", () => {
  test("a login by username with a unique index survives a rename of an unrelated field", async () => {
    const users = {
      type: "auth",
      rules: { list: "", view: "" },
      fields: { username: { type: "text" } },
      indexes: ["CREATE UNIQUE INDEX idx_users_username ON users (username)"],
      passwordAuth: { identityFields: ["email", "username"] },
    };
    await renameScenario(
      { users, posts: posts({ title: { type: "text" }, writer: { type: "text" } }) },
      async (url, token) => {
        const created = await api(url, token, "POST", "/api/collections/users/records", {
          email: "ann@example.test",
          password: "1234567890",
          passwordConfirm: "1234567890",
          username: "ann",
        });
        expect(created.status).toBe(200);
        await api(url, token, "POST", "/api/collections/posts/records", {
          title: "t",
          writer: "Ann",
        });
      },
      { users, posts: posts({ title: { type: "text" }, author: { type: "text" } }) },
      [
        [
          "20261114110000_author.ts",
          migrationSource(`  renames: { posts: { writer: "author" } },`),
        ],
      ],
      async (url, token) => {
        const login = await fetch(`${url}/api/collections/users/auth-with-password`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ identity: "ann", password: "1234567890" }),
        });
        expect(login.status).toBe(200);
        const stored = await collectionOf(url, token, "users");
        expect(stored.passwordAuth).toEqual(
          expect.objectContaining({ identityFields: ["email", "username"] }),
        );
        expect(JSON.stringify(stored.indexes)).toContain("idx_users_username");
        expect(await records(url, token, "posts")).toEqual([
          expect.objectContaining({ author: "Ann" }),
        ]);
      },
    );
  });

  test("a rename of a field that the MFA rule names, and the rule is set again", async () => {
    await renameScenario(
      { members: membersOf("nick", "nick != ''") },
      async (url, token) => {
        const created = await api(url, token, "POST", "/api/collections/members/records", {
          email: "ann@example.test",
          password: "1234567890",
          passwordConfirm: "1234567890",
          nick: "n",
        });
        expect(created.status).toBe(200);
      },
      { members: membersOf("handle", "handle != ''") },
      [["20261114110010_mfa.ts", migrationSource(`  renames: { members: { nick: "handle" } },`)]],
      async (url, token) => {
        expect((await collectionOf(url, token, "members")).mfa).toEqual(
          expect.objectContaining({ rule: "handle != ''" }),
        );
        expect(await records(url, token, "members")).toEqual([
          expect.objectContaining({ email: "ann@example.test" }),
        ]);
      },
    );
  });

  test("a rename of a custom _superusers field that has an index", async () => {
    await renameScenario(
      { _superusers: superusersOf("nick") },
      async () => {},
      { _superusers: superusersOf("handle") },
      [
        [
          "20261114110020_superusers.ts",
          migrationSource(`  renames: { _superusers: { nick: "handle" } },`),
        ],
      ],
      async (url, token) => {
        const collection = await collectionOf(url, token, "_superusers");
        expect(Object.keys(await fieldsOf(url, token, "_superusers"))).toContain("handle");
        expect(Object.keys(await fieldsOf(url, token, "_superusers"))).not.toContain("nick");
        expect(JSON.stringify(collection.indexes)).toContain("(handle)");
      },
    );
  });

  test("a view over a view that reads a renamed field is created again", async () => {
    await renameScenario(
      {
        posts: posts({ title: { type: "text" }, writer: { type: "text" } }),
        v1: { type: "view", rules: { list: "", view: "" }, query: "SELECT id, writer FROM posts" },
        v2: {
          type: "view",
          rules: { list: "", view: "" },
          query: "SELECT id, writer AS w FROM v1",
        },
      },
      async (url, token) => {
        await api(url, token, "POST", "/api/collections/posts/records", {
          title: "t",
          writer: "Ann",
        });
      },
      {
        posts: posts({ title: { type: "text" }, author: { type: "text" } }),
        v1: { type: "view", rules: { list: "", view: "" }, query: "SELECT id, author FROM posts" },
        v2: {
          type: "view",
          rules: { list: "", view: "" },
          query: "SELECT id, author AS w FROM v1",
        },
      },
      [["20261114110030_views.ts", migrationSource(`  renames: { posts: { writer: "author" } },`)]],
      async (url, token) => {
        expect(await records(url, token, "v2")).toEqual([expect.objectContaining({ w: "Ann" })]);
      },
    );
  });

  test("the plan shows a real rule change, and not the rules and indexes that a rename clears and sets again", async () => {
    const site = await newSite();
    const teams = {
      type: "base",
      rules: { list: "", view: "" },
      fields: { name: { type: "text" } },
      indexes: ["CREATE INDEX idx_teams_name ON teams (name)"],
    };
    // logs in by username, so its identity fields and unique index stay as they are
    const users = {
      type: "auth",
      rules: { list: "", view: "" },
      fields: { username: { type: "text" } },
      indexes: ["CREATE UNIQUE INDEX idx_users_username ON users (username)"],
      passwordAuth: { identityFields: ["email", "username"] },
    };
    writeSchema(site, {
      posts: posts({ title: { type: "text" }, writer: { type: "text" } }),
      teams,
      users,
    });
    let server = await serveWith(site);
    let token = await superuser(server.url);
    const team = await api(server.url, token, "POST", "/api/collections/teams/records", {
      name: "red",
    });
    expect(team.status).toBe(200);
    await server.stop();

    // posts gets a list rule that names the renamed field; teams changes nothing
    writeSchema(site, {
      posts: {
        type: "base",
        rules: { list: 'author != ""', view: "" },
        fields: { title: { type: "text" }, author: { type: "text" } },
      },
      teams,
      users,
    });
    writeMigration(
      site,
      "20261114110200_author.ts",
      migrationSource(`  renames: { posts: { writer: "author" } },`),
    );
    const plan = await run(["--dir", site.dataDir, "schema", "plan", "--schema", site.schemaPath]);
    expect(plan.exitCode).toBe(0);
    expect(plan.stdout).toContain("~ posts (base)\n      rules: list\n");
    expect(plan.stdout).toMatch(
      /~ teams \(base\)\n {6}index rebuilt: CREATE INDEX idx_teams_name ON teams \(name\) \(1 records in the table\)/,
    );
    expect(plan.stdout).not.toMatch(/~ teams \(base\)\n {6}rules/);
    expect(plan.stdout).not.toContain("index added: CREATE INDEX idx_teams_name");
    // the auth options are as stored, so only the index is listed, as rebuilt
    expect(plan.stdout).toMatch(
      /~ users \(auth\)\n {6}index rebuilt: CREATE UNIQUE INDEX idx_users_username ON users \(username\)/,
    );
    expect(plan.stdout).not.toMatch(/~ users \(auth\)\n {6}(rules|options)/);
    expect(plan.stdout).toContain("the schema would apply");

    server = await serveWith(site);
    token = await superuser(server.url);
    expect((await collectionOf(server.url, token, "posts")).listRule).toBe('author != ""');
    expect((await collectionOf(server.url, token, "teams")).listRule).toBe("");
    expect(JSON.stringify((await collectionOf(server.url, token, "teams")).indexes)).toContain(
      "idx_teams_name",
    );
    await server.stop();
  });
});

// removes a file the test wrote (a migration that the next case must not see)
function rmFile(path: string): void {
  rmSync(path, { force: true });
}

describe("S.8 follow-ups: digit-led names, views in migrations, case in renames, paging", () => {
  test("a renamed custom _superusers field whose name starts with a digit keeps its index", async () => {
    await renameScenario(
      {
        _superusers: {
          type: "auth",
          fields: { "2fa": { type: "text" } },
          indexes: ["CREATE INDEX idx_su_2fa ON _superusers (`2fa`)"],
        },
      },
      async () => {},
      {
        _superusers: {
          type: "auth",
          fields: { twofa: { type: "text" } },
          indexes: ["CREATE INDEX idx_su_2fa ON _superusers (`twofa`)"],
        },
      },
      [
        [
          "20261114120000_twofa.ts",
          migrationSource(`  renames: { _superusers: { "2fa": "twofa" } },`),
        ],
      ],
      async (url, token) => {
        expect(Object.keys(await fieldsOf(url, token, "_superusers"))).toContain("twofa");
        expect(JSON.stringify((await collectionOf(url, token, "_superusers")).indexes)).toContain(
          "(`twofa`)",
        );
      },
    );
  });

  test("a migration reads a view that the apply renames over: the view exists while the migrations run", async () => {
    await renameScenario(
      {
        posts: posts({ title: { type: "text" }, writer: { type: "text" } }),
        names: {
          type: "view",
          rules: { list: "", view: "" },
          query: "SELECT id, writer FROM posts",
        },
      },
      async (url, token) => {
        await api(url, token, "POST", "/api/collections/posts/records", {
          title: "a",
          writer: "Ann",
        });
      },
      {
        posts: posts({ title: { type: "text" }, author: { type: "text" } }),
        names: {
          type: "view",
          rules: { list: "", view: "" },
          query: "SELECT id, author FROM posts",
        },
      },
      [
        [
          "20261114120100_views.ts",
          migrationSource(`  renames: { posts: { writer: "author" } },
  up(tx) {
    const seen = [...tx.records("names")];
    tx.create("posts", { title: "seen " + seen.length, author: String(seen[0]?.author) });
  },`),
        ],
      ],
      async (url, token) => {
        const rows = await records(url, token, "posts");
        expect(rows.map((row) => row.title).toSorted()).toEqual(["a", "seen 1"]);
        expect(rows.find((row) => row.title === "seen 1")).toEqual(
          expect.objectContaining({ author: "Ann" }),
        );
      },
    );
  });

  test("a migration reads a view that the file changes: the new query is there while the migrations run", async () => {
    await renameScenario(
      {
        posts: posts({ title: { type: "text" } }),
        names: {
          type: "view",
          rules: { list: "", view: "" },
          query: "SELECT id, title FROM posts",
        },
      },
      async (url, token) => {
        await api(url, token, "POST", "/api/collections/posts/records", { title: "a" });
      },
      {
        posts: posts({ title: { type: "text" } }),
        names: {
          type: "view",
          rules: { list: "", view: "" },
          query: "SELECT id, title AS shout FROM posts",
        },
      },
      [
        [
          "20261114120200_shout.ts",
          migrationSource(`  up(tx) {
    const seen = [...tx.records("names")];
    tx.create("posts", { title: "seen " + String(seen[0]?.shout) });
  },`),
        ],
      ],
      async (url, token) => {
        const rows = await records(url, token, "posts");
        expect(rows.map((row) => row.title).toSorted()).toEqual(["a", "seen a"]);
      },
    );
  });

  test("rename checks compare names without regard to case, and say so", async () => {
    const site = await newSite();
    writeSchema(site, { posts: posts({ title: { type: "text" }, writer: { type: "text" } }) });
    (await serveWith(site)).stop();

    const cases: [string, string, string[]][] = [
      [
        "20261114120300_case_field.ts",
        `  renames: { posts: { writer: "Title" } },`,
        ['already has a field "title"'],
      ],
      [
        "20261114120310_case_collide.ts",
        `  renames: { posts: { writer: "Author", title: "author" } },`,
        ["renames collide"],
      ],
    ];
    const schemaWithAuthor = {
      posts: posts({ title: { type: "text" }, author: { type: "text" } }),
    };
    for (const [file, body, expected] of cases) {
      writeSchema(site, schemaWithAuthor);
      writeMigration(site, file, migrationSource(body));
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
      expect(await startFails(site)).toContain("not applied");
      expect(digests(site.dataDir)).toEqual(before);
      rmFile(join(site.migrationsDir, file));
    }
  });

  test("a collection renamed to a name that differs only in case from another collection is refused", async () => {
    const site = await newSite();
    writeSchema(site, {
      posts: posts({ title: { type: "text" } }),
      news: posts({ title: { type: "text" } }),
    });
    (await serveWith(site)).stop();

    writeSchema(site, { Posts: posts({ title: { type: "text" } }) });
    writeMigration(
      site,
      "20261114120400_case_collection.ts",
      migrationSource(`  renameCollections: { news: "Posts" },`),
    );
    const plan = await run(["--dir", site.dataDir, "schema", "plan", "--schema", site.schemaPath]);
    expect(plan.exitCode).not.toBe(0);
    expect(plan.stdout + plan.stderr).toContain('the collection "posts" already exists');
    expect(await startFails(site)).toContain("not applied");
  });

  test("a rename that only changes the case of its own name keeps the data", async () => {
    const site = await newSite();
    writeSchema(site, {
      posts: posts({ title: { type: "text" } }),
      news: posts({ title: { type: "text" } }),
    });
    let server = await serveWith(site);
    let token = await superuser(server.url);
    expect(
      (await api(server.url, token, "POST", "/api/collections/posts/records", { title: "kept" }))
        .status,
    ).toBe(200);
    await server.stop();

    writeSchema(site, {
      Posts: posts({ Title: { type: "text" } }),
      News: posts({ title: { type: "text" } }),
    });
    writeMigration(
      site,
      "20261114120450_case_only.ts",
      migrationSource(`  renameCollections: { posts: "Posts", news: "News" },
  renames: { posts: { title: "Title" } },`),
    );
    server = await serveWith(site);
    token = await superuser(server.url);
    expect(Object.keys(await fieldsOf(server.url, token, "Posts"))).toContain("Title");
    expect(await records(server.url, token, "Posts")).toEqual([
      expect.objectContaining({ Title: "kept" }),
    ]);
    await server.stop();
  });

  test("a migration iterates more records than one page, each once, over a set fixed at its start", async () => {
    const site = await newSite();
    writeSchema(site, { posts: posts({ title: { type: "text" }, done: { type: "bool" } }) });
    let server = await serveWith(site);
    let token = await superuser(server.url);
    const total = 1200;
    for (let start = 0; start < total; start += 100) {
      const created = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          api(server.url, token, "POST", "/api/collections/posts/records", {
            title: `p${start + i}`,
            done: false,
          }),
        ),
      );
      expect(created.every((result) => result.status === 200)).toBe(true);
    }
    await server.stop();

    // every match is updated in the loop, so a set read page by page would skip rows
    writeMigration(
      site,
      "20261114120500_pages.ts",
      migrationSource(`  up(tx) {
    let count = 0;
    for (const post of tx.records("posts", { filter: "done = false" })) {
      tx.update("posts", post.id, { done: true });
      count += 1;
    }
    tx.create("posts", { title: "counted " + count, done: true });
  },`),
    );
    server = await serveWith(site);
    token = await superuser(server.url);
    const counted = await api(
      server.url,
      token,
      "GET",
      `/api/collections/posts/records?perPage=1&filter=${encodeURIComponent('title = "counted 1200"')}`,
    );
    expect(counted.json.totalItems).toBe(1);
    const open = await api(
      server.url,
      token,
      "GET",
      `/api/collections/posts/records?perPage=1&filter=${encodeURIComponent("done = false")}`,
    );
    expect(open.json.totalItems).toBe(0);
    await server.stop();
  });
});
