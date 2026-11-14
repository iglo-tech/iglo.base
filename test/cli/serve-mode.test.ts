// The modes of serve with a schema file (D40, D41, S.6), through the compiled
// executable and the API, on mktemp data. Production: the file is applied at
// startup and the collections and settings are locked (403). Development: the
// dashboard's and the API's collection changes are written back to the file and
// the types, the file's edits and new migration files are applied while the
// server runs, and a failed edit changes nothing. Without --schema nothing
// changes in either mode.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { run, startServer, tempDir, type RunningServer } from "@test/support/executable";

const email = "modes@example.test";
const password = "1234567890";

interface Site {
  root: string;
  dataDir: string;
  schemaPath: string;
  typesPath: string;
  migrationsDir: string;
}

// a data directory with a superuser and a schema file with a posts collection
async function newSite(): Promise<Site> {
  const root = tempDir();
  const dataDir = join(root, "pb_data");
  const created = await run(["--dir", dataDir, "superuser", "upsert", email, password]);
  expect(created.exitCode).toBe(0);
  const schemaPath = join(root, "iglo.schema.json");
  writeFileSync(schemaPath, JSON.stringify(postsFile(["title"]), null, 2));
  const migrationsDir = join(root, "migrations");
  mkdirSync(migrationsDir);
  return { root, dataDir, schemaPath, typesPath: join(root, "iglo.types.ts"), migrationsDir };
}

// the schema file with posts holding the named text fields
function postsFile(fields: string[], extra: Record<string, unknown> = {}): object {
  return {
    collections: {
      posts: {
        type: "base",
        fields: Object.fromEntries(fields.map((name) => [name, { type: "text" }])),
        ...extra,
      },
    },
  };
}

// a TypeScript migration that creates one post, or throws (a failing apply)
function seedMigration(title: string, fail = false): string {
  const body = fail
    ? `throw new Error("boom");`
    : `tx.create("posts", { title: ${JSON.stringify(title)} });`;
  return `export default {\n  up(tx) {\n    ${body}\n  },\n};\n`;
}

async function hasPost(url: string, token: string, title: string): Promise<boolean> {
  const list = await api(url, token, "GET", "/api/collections/posts/records");
  return ((list.json.items as { title: string }[] | undefined) ?? []).some(
    (item) => item.title === title,
  );
}

async function login(url: string): Promise<string> {
  const res = await fetch(`${url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: email, password }),
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
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

// polls until the check holds, for up to ms milliseconds
async function until(check: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error("the condition did not hold in time");
    }
    await Bun.sleep(25);
  }
}

async function fieldNames(url: string, token: string, name: string): Promise<string[]> {
  const res = await api(url, token, "GET", `/api/collections/${name}`);
  const fields = (res.json.fields as { name: string }[] | undefined) ?? [];
  return fields.map((field) => field.name);
}

async function startWith(
  site: Site,
  args: string[],
): Promise<{ server: RunningServer; url: string; token: string }> {
  const server = await startServer(args, site.dataDir);
  return { server, url: server.url, token: await login(server.url) };
}

describe("production mode", () => {
  test("the collection and settings writes answer 403, superusers too; records keep working", async () => {
    const site = await newSite();
    const { server, url, token } = await startWith(site, [
      "--mode",
      "prod",
      "--schema",
      site.schemaPath,
    ]);
    try {
      const created = await api(url, token, "POST", "/api/collections", {
        name: "notes",
        type: "base",
      });
      expect(created.status).toBe(403);
      expect(String(created.json.message)).toContain("managed by the schema file");
      expect(created.json.status).toBe(403);

      expect(
        (await api(url, token, "PATCH", "/api/collections/posts", { name: "posts" })).status,
      ).toBe(403);
      expect((await api(url, token, "DELETE", "/api/collections/posts")).status).toBe(403);
      expect(
        (
          await api(url, token, "PUT", "/api/collections/import", {
            collections: [],
            deleteMissing: false,
          })
        ).status,
      ).toBe(403);
      const settings = await api(url, token, "PATCH", "/api/settings", {
        meta: { appName: "changed" },
      });
      expect(settings.status).toBe(403);
      expect(String(settings.json.message)).toContain("managed by the schema file");
      expect(String(settings.json.message)).toContain("pb_migrations");

      // the reads and the records work as usual
      expect((await api(url, token, "GET", "/api/collections")).status).toBe(200);
      expect((await api(url, token, "GET", "/api/settings")).status).toBe(200);
      const record = await api(url, token, "POST", "/api/collections/posts/records", {
        title: "hello",
      });
      expect(record.status).toBe(200);
      const list = await api(url, token, "GET", "/api/collections/posts/records");
      expect((list.json.items as unknown[]).length).toBe(1);

      // the health check tells the dashboard why the screens are read-only
      const health = await api(url, token, "GET", "/api/health");
      expect((health.json.data as Record<string, unknown>).schemaLocked).toBe(true);
    } finally {
      await server.stop();
    }
  });

  test("the start applies the file, then locks: a collection the file adds is there", async () => {
    const site = await newSite();
    writeFileSync(
      site.schemaPath,
      JSON.stringify({
        collections: {
          posts: { type: "base", fields: { title: { type: "text" } } },
          tags: { type: "base", fields: { label: { type: "text" } } },
        },
      }),
    );
    const { server, url, token } = await startWith(site, [
      "--mode",
      "prod",
      "--schema",
      site.schemaPath,
    ]);
    try {
      expect((await api(url, token, "GET", "/api/collections/tags")).status).toBe(200);
      expect((await api(url, token, "DELETE", "/api/collections/tags")).status).toBe(403);
    } finally {
      await server.stop();
    }
  });

  test("a restore restarts the server, and the file is applied again", async () => {
    const site = await newSite();
    const { server, url, token } = await startWith(site, [
      "--mode",
      "prod",
      "--schema",
      site.schemaPath,
    ]);
    try {
      // a backup of the data, then a restore: the process restarts and the file is applied
      const backup = await api(url, token, "POST", "/api/backups", { name: "before.zip" });
      expect([200, 204]).toContain(backup.status);
      const restored = await fetch(`${url}/api/backups/before.zip/restore`, {
        method: "POST",
        headers: { Authorization: token },
      });
      expect(restored.status).toBe(204);
      await until(async () => {
        try {
          const health = await api(url, await login(url), "GET", "/api/health");
          return (
            health.status === 200 &&
            (health.json.data as Record<string, unknown>).schemaLocked === true
          );
        } catch {
          return false;
        }
      });
    } finally {
      await server.stop();
    }
  });

  test("in production, users sign in and files are uploaded as usual", async () => {
    const site = await newSite();
    // the whole schema, as schema pull writes it (users included), plus a file field
    const pulled = await run(["--dir", site.dataDir, "schema", "pull"]);
    expect(pulled.exitCode).toBe(0);
    const file = JSON.parse(pulled.stdout) as {
      collections: Record<string, Record<string, unknown>>;
    };
    file.collections.posts = {
      type: "base",
      fields: { title: { type: "text" }, image: { type: "file", maxSelect: 1 } },
    };
    // the users sign-in and its first record are open to everyone (the file's default is superusers only)
    const users = file.collections.users as { rules?: Record<string, unknown> };
    users.rules = { ...users.rules, auth: "", create: "" };
    writeFileSync(site.schemaPath, JSON.stringify(file));

    const { server, url, token } = await startWith(site, [
      "--mode",
      "prod",
      "--schema",
      site.schemaPath,
    ]);
    try {
      // a user, created by a superuser, signs in with a password
      const created = await api(url, token, "POST", "/api/collections/users/records", {
        email: "reader@example.test",
        password: "reader-password-1",
        passwordConfirm: "reader-password-1",
      });
      expect(created.status).toBe(200);
      const signedIn = await fetch(`${url}/api/collections/users/auth-with-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity: "reader@example.test", password: "reader-password-1" }),
      });
      expect(signedIn.status).toBe(200);

      // a record with a file upload
      const form = new FormData();
      form.append("title", "with a file");
      form.append("image", new File(["pixels"], "photo.txt", { type: "text/plain" }));
      const uploaded = await fetch(`${url}/api/collections/posts/records`, {
        method: "POST",
        headers: { Authorization: token },
        body: form,
      });
      expect(uploaded.status).toBe(200);
      const record = (await uploaded.json()) as { image: string };
      expect(record.image).toMatch(/^photo.*\.txt$/);
    } finally {
      await server.stop();
    }
  });

  test("invalidating the tokens is a JavaScript migration in production: it changes the token secret", async () => {
    const site = await newSite();
    // the whole schema, as schema pull writes it (users included)
    const pulled = await run(["--dir", site.dataDir, "schema", "pull"]);
    expect(pulled.exitCode).toBe(0);
    writeFileSync(site.schemaPath, pulled.stdout);
    const secretOf = (): string => {
      const db = new Database(join(site.dataDir, "data.db"), { readonly: true });
      try {
        const row = db.query("SELECT options FROM _collections WHERE name = 'users'").get() as {
          options: string;
        };
        return (JSON.parse(row.options) as { authToken: { secret: string } }).authToken.secret;
      } finally {
        db.close();
      }
    };
    const before = secretOf();
    expect(before).not.toBe("");

    // the migration, as the operations guide shows it: it runs once, at the next start
    const migrations = join(site.root, "pb_migrations");
    mkdirSync(migrations);
    writeFileSync(
      join(migrations, "1700000000_invalidate_user_tokens.js"),
      `migrate((app) => {\n  const users = app.findCollectionByNameOrId("users");\n  users.authToken.secret = $security.randomString(50);\n  app.save(users);\n}, (app) => {});\n`,
    );
    const { server } = await startWith(site, ["--mode", "prod", "--schema", site.schemaPath]);
    await server.stop();
    const after = secretOf();
    expect(after).not.toBe(before);
    expect(after.length).toBe(50);
  });

  test("settings change through a JavaScript migration at the restart, under --mode prod --schema", async () => {
    const site = await newSite();
    // the whole schema, as schema pull writes it (users included)
    const pulled = await run(["--dir", site.dataDir, "schema", "pull"]);
    expect(pulled.exitCode).toBe(0);
    writeFileSync(site.schemaPath, pulled.stdout);

    // the first start: the settings are locked
    const first = await startWith(site, ["--mode", "prod", "--schema", site.schemaPath]);
    try {
      const refused = await api(first.url, first.token, "PATCH", "/api/settings", {
        meta: { appName: "Changed by a migration" },
      });
      expect(refused.status).toBe(403);
    } finally {
      await first.server.stop();
    }

    // the operator adds the migration, and restarts: it changes the settings once
    const migrations = join(site.root, "pb_migrations");
    mkdirSync(migrations);
    writeFileSync(
      join(migrations, "1700000000_app_name.js"),
      `migrate((app) => {\n  const settings = app.settings();\n  settings.meta.appName = "Changed by a migration";\n  app.save(settings);\n}, (app) => {});\n`,
    );
    const second = await startWith(site, ["--mode", "prod", "--schema", site.schemaPath]);
    try {
      const settings = await api(second.url, second.token, "GET", "/api/settings");
      expect((settings.json.meta as { appName: string }).appName).toBe("Changed by a migration");
      const health = await api(second.url, second.token, "GET", "/api/health");
      expect((health.json.data as Record<string, unknown>).schemaLocked).toBe(true);
    } finally {
      await second.server.stop();
    }
  });

  test("without --schema nothing is locked, in either mode", async () => {
    for (const mode of [undefined, "prod", "dev"]) {
      const site = await newSite();
      const args = mode === undefined ? [] : ["--mode", mode];
      const { server, url, token } = await startWith(site, args);
      try {
        const settings = await api(url, token, "PATCH", "/api/settings", {
          meta: { appName: "free" },
        });
        expect(settings.status).toBe(200);
        const health = await api(url, token, "GET", "/api/health");
        expect((health.json.data as Record<string, unknown>).schemaLocked).toBeUndefined();
      } finally {
        await server.stop();
      }
    }
  });

  test("the flags are checked: an unknown mode and --types without --schema are errors", async () => {
    const site = await newSite();
    const mode = await run([
      "--dir",
      site.dataDir,
      "serve",
      "--mode",
      "staging",
      "--http",
      "127.0.0.1:1",
    ]);
    expect(mode.exitCode).toBe(1);
    expect(mode.stderr).toContain("--mode must be dev or prod");
    const types = await run([
      "--dir",
      site.dataDir,
      "serve",
      "--types",
      site.typesPath,
      "--http",
      "127.0.0.1:1",
    ]);
    expect(types.exitCode).toBe(1);
    expect(types.stderr).toContain("--types needs --schema");
  });
});

describe("development mode", () => {
  test("a collection change through the API reaches the file and the types within one second", async () => {
    const site = await newSite();
    const { server, url, token } = await startWith(site, [
      "--schema",
      site.schemaPath,
      "--types",
      site.typesPath,
    ]);
    try {
      const started = Date.now();
      const created = await api(url, token, "POST", "/api/collections", {
        name: "notes",
        type: "base",
        fields: [{ name: "body", type: "text" }],
      });
      expect(created.status).toBe(200);
      await until(() => readFileSync(site.schemaPath, "utf8").includes('"notes"'), 1000);
      await until(
        () => readFileSync(site.typesPath, "utf8").includes("export interface NotesRecord"),
        1000,
      );
      expect(Date.now() - started).toBeLessThan(1000);
      expect(readFileSync(site.schemaPath, "utf8")).toContain('"body"');

      // the file the server wrote is not applied again: its own write is ignored
      await Bun.sleep(800);
    } finally {
      const stopped = await server.stop();
      expect(stopped.stderr.match(/schema: applied/g)).toBeNull();
    }
  });

  test("an edit of the file applies while the server runs", async () => {
    const site = await newSite();
    const { server, url, token } = await startWith(site, ["--schema", site.schemaPath]);
    try {
      writeFileSync(site.schemaPath, JSON.stringify(postsFile(["title", "summary"])));
      await until(async () => (await fieldNames(url, token, "posts")).includes("summary"));
    } finally {
      const stopped = await server.stop();
      expect(stopped.stderr).toContain("schema: applied iglo.schema.json");
    }
  });

  test("a bad edit changes nothing and prints the error; the server keeps the old schema", async () => {
    const site = await newSite();
    const { server, url, token } = await startWith(site, ["--schema", site.schemaPath]);
    try {
      const before = await fieldNames(url, token, "posts");
      writeFileSync(
        site.schemaPath,
        JSON.stringify({
          collections: { posts: { type: "base", fields: { title: { type: "nosuch" } } } },
        }),
      );
      await Bun.sleep(800);
      expect(await fieldNames(url, token, "posts")).toEqual(before);
      expect((await api(url, token, "GET", "/api/health")).status).toBe(200);
    } finally {
      const stopped = await server.stop();
      expect(stopped.stderr).toContain("was not applied; the server keeps the old schema");
      expect(stopped.stderr).toContain("nosuch");
    }
  });

  test("a new migration file applies while the server runs", async () => {
    const site = await newSite();
    const { server, url, token } = await startWith(site, ["--schema", site.schemaPath]);
    try {
      writeFileSync(
        join(site.migrationsDir, "20261114101500_seed.ts"),
        `export default {\n  up(tx) {\n    tx.create("posts", { title: "from a migration" });\n  },\n};\n`,
      );
      await until(async () => {
        const list = await api(url, token, "GET", "/api/collections/posts/records");
        return ((list.json.items as { title: string }[] | undefined) ?? []).some(
          (item) => item.title === "from a migration",
        );
      });
    } finally {
      await server.stop();
    }
  });

  test("a migrations directory made after the start is watched: its migration files apply", async () => {
    const site = await newSite();
    rmSync(site.migrationsDir, { recursive: true });
    const { server, url, token } = await startWith(site, ["--schema", site.schemaPath]);
    try {
      mkdirSync(site.migrationsDir);
      // the directory is seen, and the apply of the empty directory has run
      await Bun.sleep(800);
      writeFileSync(
        join(site.migrationsDir, "20261114101500_seed.ts"),
        seedMigration("from a new directory"),
      );
      await until(() => hasPost(url, token, "from a new directory"), 3000);
    } finally {
      await server.stop();
    }
  });

  test("unrelated changes in the schema and migrations directories do not repeat a failed apply's report", async () => {
    const site = await newSite();
    const { server } = await startWith(site, ["--schema", site.schemaPath]);
    try {
      writeFileSync(
        join(site.migrationsDir, "20261114101500_seed.ts"),
        seedMigration("never created", true),
      );
      await Bun.sleep(800);
      for (let i = 0; i < 3; i++) {
        writeFileSync(join(site.root, `editor-${i}.swp`), "swap");
        writeFileSync(join(site.migrationsDir, `notes-${i}.md`), "notes");
        await Bun.sleep(400);
      }
    } finally {
      const stopped = await server.stop();
      expect(stopped.stderr.match(/was not applied/g)?.length).toBe(1);
    }
  });

  test("a failed migration fixed in place applies without a restart", async () => {
    const site = await newSite();
    const { server, url, token } = await startWith(site, ["--schema", site.schemaPath]);
    const file = join(site.migrationsDir, "20261114101500_seed.ts");
    try {
      writeFileSync(file, seedMigration("fixed later", true));
      await Bun.sleep(800);
      expect(await hasPost(url, token, "fixed later")).toBe(false);
      writeFileSync(file, seedMigration("fixed later"));
      await until(() => hasPost(url, token, "fixed later"), 3000);
    } finally {
      const stopped = await server.stop();
      expect(stopped.stderr).toContain("boom");
    }
  });

  test("a dashboard change does not hide a failing migration: the next apply reports it again", async () => {
    const site = await newSite();
    const { server, url, token } = await startWith(site, ["--schema", site.schemaPath]);
    try {
      writeFileSync(
        join(site.migrationsDir, "20261114101500_seed.ts"),
        seedMigration("never created", true),
      );
      await Bun.sleep(800);
      // the write-back of this change is the next apply: the migration is still failing
      const created = await api(url, token, "POST", "/api/collections", {
        name: "notes",
        type: "base",
      });
      expect(created.status).toBe(200);
      await Bun.sleep(800);
    } finally {
      const stopped = await server.stop();
      expect(stopped.stderr.match(/was not applied/g)?.length).toBe(2);
    }
  });

  test("a dashboard change made while a file edit is pending says that the pending edit replaces it", async () => {
    const site = await newSite();
    const { server, url, token } = await startWith(site, ["--schema", site.schemaPath]);
    const pending = "{ this edit does not parse";
    try {
      writeFileSync(site.schemaPath, pending);
      await Bun.sleep(800);
      const created = await api(url, token, "POST", "/api/collections", {
        name: "notes",
        type: "base",
      });
      expect(created.status).toBe(200);
      // the file is not written over: the edit stays until it is applied or reverted
      expect(readFileSync(site.schemaPath, "utf8")).toBe(pending);
    } finally {
      const stopped = await server.stop();
      expect(stopped.stderr).toContain(
        "the dashboard change to notes will be replaced by the pending file edit",
      );
    }
  });
});
