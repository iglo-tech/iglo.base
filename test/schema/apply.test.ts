// The schema file's apply and `schema plan` (D40, S.3) through the compiled
// executable and the HTTP API. Each test works on its own mktemp -d data
// directory. The results are read back through `schema pull`, the API, the
// backups directory and the bytes of data.db (the same data upstream opens).

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type CliContext, runCli } from "@/cli/root";
import { readSchema } from "@/schema/read";
import type { SchemaDescription } from "@/schema/types";
import { freePort, run, startServer, tempDir, type RunResult } from "@test/support/executable";

const superuser = { email: "admin@apply.test", password: "1234567890" };

type Json = Record<string, unknown>;

interface Site {
  root: string;
  dataDir: string;
}

function newSite(): Site {
  const root = tempDir();
  return { root, dataDir: join(root, "pb_data") };
}

// a data directory with a superuser (the database is created by the command)
async function createSite(): Promise<Site> {
  const site = newSite();
  const created = await run([
    "--dir",
    site.dataDir,
    "superuser",
    "upsert",
    superuser.email,
    superuser.password,
  ]);
  expect(created.exitCode).toBe(0);
  return site;
}

function writeFile(site: Site, name: string, value: unknown): string {
  const path = join(site.root, name);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

// the schema the database has now, as `schema pull` writes it
async function pulled(site: Site): Promise<SchemaDescription> {
  const result = await run(["--dir", site.dataDir, "schema", "pull"]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return described(result.stdout);
}

function described(text: string): SchemaDescription {
  const result = readSchema(text);
  if (!result.ok) {
    throw new Error(`the schema is refused: ${JSON.stringify(result.errors)}`);
  }
  return result.schema;
}

// the file of the database now, to change it
async function currentFile(site: Site): Promise<Json> {
  const result = await run(["--dir", site.dataDir, "schema", "pull"]);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout) as Json;
}

function collectionsOf(file: Json): Record<string, Json> {
  return file.collections as Record<string, Json>;
}

// the serve command with the file, until it is stopped: the start succeeds
async function applyOK(site: Site, file: string, extra: string[] = []): Promise<void> {
  const server = await startServer(["--schema", file, ...extra], site.dataDir);
  const result = await server.stop();
  expect(result.stderr).not.toContain("schema not applied");
  expect(result.exitCode).toBe(0);
}

// the serve command with the file: the start is refused
async function applyFails(site: Site, file: string, extra: string[] = []): Promise<RunResult> {
  const port = await freePort();
  const result = await run(
    ["serve", "--http", `127.0.0.1:${port}`, "--dir", site.dataDir, "--schema", file, ...extra],
    { cwd: site.root },
  );
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  return result;
}

async function plan(site: Site, file: string, extra: string[] = []): Promise<RunResult> {
  return run(["--dir", site.dataDir, "schema", "plan", "--schema", file, ...extra], {
    cwd: site.root,
  });
}

// the pre-schema backups in the backups directory, by name
function preSchemaBackups(site: Site): string[] {
  const dir = join(site.dataDir, "backups");
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => /^pre-schema-.*\.zip$/.test(name))
    .toSorted();
}

// the bytes of data.db: a refused apply and a plan leave them as they are
function dataDB(site: Site): Buffer {
  return readFileSync(join(site.dataDir, "data.db"));
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.equals(b);
}

async function login(url: string): Promise<string> {
  const res = await fetch(`${url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: superuser.email, password: superuser.password }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function api(
  url: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? undefined : JSON.parse(text) };
}

// a running server on the site, with a superuser token, until fn returns
async function withServer<T>(
  site: Site,
  args: string[],
  fn: (url: string, token: string) => Promise<T>,
): Promise<T> {
  const server = await startServer(args, site.dataDir);
  try {
    return await fn(server.url, await login(server.url));
  } finally {
    await server.stop();
  }
}

// the stored row of a collection, read back from data.db
function storedCollection(site: Site, name: string): Json {
  const db = new Database(join(site.dataDir, "data.db"), { readonly: true });
  try {
    const row = db.query("SELECT * FROM _collections WHERE name = ?").get(name) as Json | null;
    if (row === null) {
      throw new Error(`no stored collection ${name}`);
    }
    return row;
  } finally {
    db.close();
  }
}

// the tables and views of data.db
function tableNames(site: Site): string[] {
  const db = new Database(join(site.dataDir, "data.db"), { readonly: true });
  try {
    return (
      db
        .query("SELECT name FROM sqlite_schema WHERE type IN ('table', 'view') ORDER BY name")
        .all() as {
        name: string;
      }[]
    ).map((row) => row.name);
  } finally {
    db.close();
  }
}

// the database's schema with a posts collection (title is required unless
// the caller says otherwise)
function withPosts(file: Json, title: Json = { type: "text", required: true, max: 120 }): Json {
  const next = structuredClone(file);
  collectionsOf(next).posts = {
    type: "base",
    rules: { list: "", view: "", create: "@request.auth.id != ''" },
    indexes: ["CREATE INDEX `idx_posts_title` ON `posts` (`title`)"],
    fields: {
      title,
      body: { type: "editor" },
    },
  };
  return next;
}

describe("schema apply and schema plan", () => {
  test("adds, changes and removes collections, fields, rules, options, indexes and views", async () => {
    const site = await createSite();

    // v1: posts, tags, a view over posts, and changes to users
    const v1 = withPosts(await currentFile(site));
    collectionsOf(v1).tags = {
      type: "base",
      fields: { name: { type: "text", max: 40 } },
    };
    collectionsOf(v1).post_titles = {
      type: "view",
      query: "SELECT id, title FROM posts",
      rules: { list: "", view: "" },
    };
    const users = collectionsOf(v1).users as Json;
    (users.fields as Json).nickname = { type: "text", min: 2 };
    delete (users.fields as Json).avatar;
    // the OAuth2 mapping of the removed field goes too, as the save unsets it
    const oauth2 = (users.oauth2 ?? {}) as Json;
    oauth2.mappedFields = { ...((oauth2.mappedFields as Json | undefined) ?? {}), avatarURL: "" };
    users.oauth2 = oauth2;
    users.authAlert = { enabled: false };
    const v1File = writeFile(site, "v1.json", v1);
    await applyOK(site, v1File);

    expect(await pulled(site)).toEqual(described(JSON.stringify(v1)));
    expect(tableNames(site)).toContain("posts");

    // v2: posts changes, tags goes, the view changes, users goes back to the default
    const v2 = structuredClone(v1);
    const posts = collectionsOf(v2).posts as Json;
    posts.indexes = ["CREATE UNIQUE INDEX `idx_posts_slug` ON `posts` (`slug`)"];
    posts.rules = { list: "", view: "", create: "@request.auth.id != ''", update: null };
    (posts.fields as Json).title = { type: "text", required: true, max: 200 };
    delete (posts.fields as Json).body;
    (posts.fields as Json).slug = { type: "text", pattern: "^[a-z-]+$" };
    delete collectionsOf(v2).tags;
    collectionsOf(v2).post_titles = {
      type: "view",
      query: "SELECT id, title, slug FROM posts",
      rules: { list: "", view: "" },
    };
    delete (collectionsOf(v2).users as Json).authAlert;
    const v2File = writeFile(site, "v2.json", v2);
    const before = dataDB(site);

    const planned = await plan(site, v2File);
    expect(planned.exitCode).toBe(0);
    expect(planned.stdout).toContain("- tags (base)");
    expect(planned.stdout).toContain("the schema would apply");
    expect(sameBytes(before, dataDB(site))).toBe(true);

    await applyOK(site, v2File);
    expect(await pulled(site)).toEqual(described(JSON.stringify(v2)));
    expect(tableNames(site)).not.toContain("tags");
    expect(tableNames(site)).toContain("post_titles");
  });

  test("a failing record check stops the start, names the records, and leaves the data as it was", async () => {
    const site = await createSite();
    const v1 = writeFile(
      site,
      "v1.json",
      withPosts(await currentFile(site), { type: "text", max: 120 }),
    );
    await applyOK(site, v1);

    await withServer(site, ["--schema", v1], async (url, token) => {
      for (const title of ["", "kept", ""]) {
        const created = await api(url, token, "POST", "/api/collections/posts/records", {
          title,
        });
        expect(created.status).toBe(200);
      }
    });

    // title may not be empty: two records break it
    const next = withPosts(await currentFile(site));
    const v2 = writeFile(site, "v2.json", next);
    const bytes = dataDB(site);

    const planned = await plan(site, v2);
    expect(planned.exitCode).toBe(1);
    expect(planned.stdout).toContain("posts.title: required, 2 records empty.");
    expect(planned.stdout).toContain("the schema would not apply");

    const refused = await applyFails(site, v2);
    expect(refused.stderr).toContain("schema not applied; the database is unchanged");
    expect(refused.stderr).toContain("posts.title: required, 2 records empty.");
    expect(sameBytes(bytes, dataDB(site))).toBe(true);
    // the backup is made before the transaction, and it stays
    expect(preSchemaBackups(site).length).toBe(2);
  });

  test("schema plan changes nothing, and says so when the file is up to date", async () => {
    const site = await createSite();
    const v1 = writeFile(site, "v1.json", withPosts(await currentFile(site)));
    const bytes = dataDB(site);

    const changed = await plan(site, v1);
    expect(changed.exitCode).toBe(0);
    expect(changed.stdout).toContain("+ posts (base)");
    expect(sameBytes(bytes, dataDB(site))).toBe(true);
    expect(preSchemaBackups(site)).toEqual([]);

    await applyOK(site, v1);
    const upToDate = await plan(site, v1);
    expect(upToDate.exitCode).toBe(0);
    expect(upToDate.stdout).toContain("the schema is up to date: nothing would change");
  });

  test("the data-loss guard refuses to delete data, and --allow-data-loss lets it", async () => {
    const site = await createSite();
    const v1 = writeFile(site, "v1.json", withPosts(await currentFile(site)));
    await applyOK(site, v1);
    await withServer(site, ["--schema", v1], async (url, token) => {
      expect(
        (await api(url, token, "POST", "/api/collections/posts/records", { title: "a" })).status,
      ).toBe(200);
    });

    // the file drops the field and the index that names it
    const next = withPosts(await currentFile(site));
    (collectionsOf(next).posts as Json).indexes = [];
    delete ((collectionsOf(next).posts as Json).fields as Json).title;
    ((collectionsOf(next).posts as Json).fields as Json).title2 = { type: "text" };
    const v2 = writeFile(site, "v2.json", next);
    const backups = preSchemaBackups(site).length;
    const bytes = dataDB(site);

    const planned = await plan(site, v2);
    expect(planned.exitCode).toBe(1);
    expect(planned.stdout).toContain("posts.title: 1 values would be deleted");
    expect(planned.stdout).toContain("--allow-data-loss");

    const refused = await applyFails(site, v2);
    expect(refused.stderr).toContain("posts.title: 1 values would be deleted");
    expect(preSchemaBackups(site).length).toBe(backups);
    expect(sameBytes(bytes, dataDB(site))).toBe(true);

    // with the flag, the field goes and the new one is there
    const allowed = await plan(site, v2, ["--allow-data-loss"]);
    expect(allowed.exitCode).toBe(0);
    await applyOK(site, v2, ["--allow-data-loss"]);
    const after = await pulled(site);
    const posts = after.collections.find((c) => c.name === "posts");
    expect(posts?.fields.map((f) => f.name)).toContain("title2");
    expect(posts?.fields.map((f) => f.name)).not.toContain("title");
  });

  test("a start with nothing to change makes no backup", async () => {
    const site = await createSite();
    const v1 = writeFile(site, "v1.json", withPosts(await currentFile(site)));
    await applyOK(site, v1);
    expect(preSchemaBackups(site).length).toBe(1);

    await applyOK(site, v1);
    expect(preSchemaBackups(site).length).toBe(1);
  });

  test("a failed backup refuses the start, and the schema is not applied", async () => {
    const site = await createSite();
    // the backups directory cannot be made: a file is in its place
    writeFileSync(join(site.dataDir, "backups"), "not a directory");
    const v1 = writeFile(site, "v1.json", withPosts(await currentFile(site)));

    const refused = await applyFails(site, v1);
    expect(refused.stderr).toContain("the pre-schema backup");
    expect(refused.stderr).toContain("so the schema is not applied");
    expect(tableNames(site)).not.toContain("posts");
  });

  test("the retention keeps the three newest pre-schema backups", async () => {
    const site = await createSite();
    let file = await currentFile(site);
    for (const name of ["f1", "f2", "f3", "f4"]) {
      // backups are named by the second, so each apply waits for the next one
      await Bun.sleep(1100);
      const next = structuredClone(file);
      ((collectionsOf(next).users as Json).fields as Json)[name] = { type: "text" };
      file = next;
      await applyOK(site, writeFile(site, `${name}.json`, next));
    }
    const kept = preSchemaBackups(site);
    expect(kept.length).toBe(3);
    // the newest three: the second, third and fourth applies (names sort by time)
    expect(kept.every((name) => name.startsWith("pre-schema-"))).toBe(true);
  });

  test("a pending JavaScript migration runs inside the apply, and that the file lists", async () => {
    const site = await createSite();
    mkdirSync(join(site.root, "pb_migrations"), { recursive: true });
    writeFileSync(
      join(site.root, "pb_migrations", "1_legacy.js"),
      `migrate((app) => {
        const c = new Collection({ name: "legacy", type: "base", fields: [{ name: "label", type: "text" }] });
        app.save(c);
      })`,
    );
    const file = withPosts(await currentFile(site));
    collectionsOf(file).legacy = { type: "base", fields: { label: { type: "text" } } };
    const path = writeFile(site, "v1.json", file);

    // plan lists the migration, and rolls it back
    const bytes = dataDB(site);
    const planned = await plan(site, path, ["--migrationsDir", join(site.root, "pb_migrations")]);
    expect(planned.exitCode).toBe(0);
    expect(planned.stdout).toContain("migrations that would run:");
    expect(planned.stdout).toContain("1_legacy.js");
    expect(sameBytes(bytes, dataDB(site))).toBe(true);

    await applyOK(site, path, ["--migrationsDir", join(site.root, "pb_migrations")]);
    expect(tableNames(site)).toContain("legacy");
    expect(await pulled(site)).toEqual(described(JSON.stringify(file)));
  });

  test("a unique index over repeated values stops the apply, with the database's refusal", async () => {
    const site = await createSite();
    const v1 = writeFile(site, "v1.json", withPosts(await currentFile(site)));
    await applyOK(site, v1);
    await withServer(site, ["--schema", v1], async (url, token) => {
      for (const title of ["same", "same"]) {
        expect(
          (await api(url, token, "POST", "/api/collections/posts/records", { title })).status,
        ).toBe(200);
      }
    });

    const next = withPosts(await currentFile(site));
    (collectionsOf(next).posts as Json).indexes = [
      "CREATE UNIQUE INDEX `idx_posts_title` ON `posts` (`title`)",
    ];
    const v2 = writeFile(site, "v2.json", next);
    const bytes = dataDB(site);

    const refused = await applyFails(site, v2);
    expect(refused.stderr).toContain("a unique index cannot be created");
    expect(refused.stderr).toContain("UNIQUE constraint failed");
    expect(sameBytes(bytes, dataDB(site))).toBe(true);
  });

  test("the apply keeps the OAuth2 providers and the token secrets of an auth collection", async () => {
    const site = await createSite();
    const v1 = writeFile(site, "v1.json", withPosts(await currentFile(site)));
    await applyOK(site, v1);
    await withServer(site, ["--schema", v1], async (url, token) => {
      const patched = await api(url, token, "PATCH", "/api/collections/users", {
        oauth2: {
          enabled: true,
          providers: [{ name: "github", clientId: "client-id", clientSecret: "kept-secret" }],
        },
      });
      expect(patched.status).toBe(200);
    });
    const stored = (): { secret: string; providers: string } => {
      const row = storedCollection(site, "users");
      const options = JSON.parse(String(row.options)) as Json;
      return {
        secret: ((options.authToken as Json).secret as string) ?? "",
        providers: JSON.stringify(((options.oauth2 as Json).providers as unknown) ?? null),
      };
    };
    const secrets = stored();
    expect(secrets.providers).toContain("kept-secret");

    // a change of the users options, which the file holds without any secret
    const next = await currentFile(site);
    (collectionsOf(next).users as Json).authAlert = { enabled: false };
    await applyOK(site, writeFile(site, "v2.json", next));
    expect(stored().providers).toBe(secrets.providers);
    expect(stored().secret).toBe(secrets.secret);
  });

  test("a restart after a restore applies the file again", async () => {
    const site = await createSite();
    const schema = withPosts(await currentFile(site));
    const path = writeFile(site, "schema.json", schema);
    await applyOK(site, path);

    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const shutdown = new AbortController();
    let restarted!: () => void;
    const restartCalled = new Promise<void>((resolve) => (restarted = resolve));
    const ctx: CliContext = {
      args: ["serve", "--http", `127.0.0.1:${port}`, "--dir", site.dataDir, "--schema", path],
      argv0: "iglo-base",
      cwd: site.root,
      isCompiled: true,
      out: { stdout: () => {}, stderr: () => {}, now: () => new Date(), color: false },
      shutdown: shutdown.signal,
      // the restart returns: the serve loop bootstraps the data again
      restart: () => restarted(),
    };
    const finished = runCli(ctx);
    try {
      let token = "";
      for (let i = 0; i < 200 && token === ""; i++) {
        token = await login(url).catch(() => "");
        if (token === "") {
          await Bun.sleep(50);
        }
      }
      expect(token).not.toBe("");

      // the backup holds the schema as it is now
      const created = await api(url, token, "POST", "/api/backups", { name: "restore.zip" });
      expect(created.status).toBe(204);

      // the file the restart reads wants one more field
      const wanted = structuredClone(schema);
      ((collectionsOf(wanted).posts as Json).fields as Json).restored = { type: "text" };
      writeFileSync(path, JSON.stringify(wanted, null, 2));

      const restoring = await fetch(`${url}/api/backups/restore.zip/restore`, {
        method: "POST",
        headers: { Authorization: token },
      });
      expect(restoring.status).toBe(204);
      await restartCalled;

      // the server serves again, on the data the file was applied to
      token = "";
      for (let i = 0; i < 200 && token === ""; i++) {
        token = await login(url).catch(() => "");
        if (token === "") {
          await Bun.sleep(50);
        }
      }
      expect(token).not.toBe("");
      const collection = await api(url, token, "GET", "/api/collections/posts");
      const fields = ((collection.json as Json).fields as Json[]).map((f) => f.name);
      expect(fields).toContain("restored");
    } finally {
      shutdown.abort();
      await finished;
    }
    expect(preSchemaBackups(site).length).toBeGreaterThan(1);
  });
});
