// JavaScript migrations through the compiled executable: the JS cases of
// upstream's plugins/migratecmd/migratecmd_test.go (driven through
// /api/collections), the startup behavior, and what a migration file sees.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expectedTemplates } from "@test/migrations/automigrate-templates";
import {
  executable,
  freePort,
  run,
  startServer,
  tempDir,
  type RunningServer,
} from "@test/support/executable";

const superuser = { identity: "admin@example.com", password: "1234567890" };

interface Site {
  root: string;
  dataDir: string;
  migrationsDir: string;
}

function newSite(): Site {
  const root = tempDir();
  return {
    root,
    dataDir: join(root, "pb_data"),
    migrationsDir: join(root, "pb_migrations"),
  };
}

function writeMigrations(site: Site, files: Record<string, string>): void {
  mkdirSync(site.migrationsDir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(site.migrationsDir, name), text);
  }
}

function rows<T>(site: Site, sql: string): T[] {
  const db = new Database(join(site.dataDir, "data.db"), { readonly: true });
  try {
    return db.query(sql).all() as T[];
  } finally {
    db.close();
  }
}

function yesFile(site: Site): string {
  const path = join(site.root, "yes.txt");
  writeFileSync(path, "y\n");
  return path;
}

function userMigrations(site: Site): string[] {
  return rows<{ file: string }>(
    site,
    "SELECT file FROM _migrations WHERE file NOT LIKE '%.go' ORDER BY rowid",
  ).map((r) => r.file);
}

function migrate(site: Site, ...args: string[]) {
  return run(["migrate", ...args, "--dir", site.dataDir], { cwd: site.root });
}

async function withServer(
  site: Site,
  args: string[],
  fn: (server: RunningServer, token: string) => Promise<void>,
): Promise<void> {
  const upsert = await run(
    ["superuser", "upsert", superuser.identity, superuser.password, "--dir", site.dataDir],
    { cwd: site.root },
  );
  expect(upsert.exitCode).toBe(0);

  const server = await startServer(["--automigrate=true", ...args], site.dataDir);
  try {
    const res = await fetch(`${server.url}/api/collections/_superusers/auth-with-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(superuser),
    });
    const { token } = (await res.json()) as { token: string };
    await fn(server, token);
  } finally {
    await server.stop();
  }
}

async function api(
  server: RunningServer,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method,
    headers: { authorization: token, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function matchesTemplate(actual: string, expected: string): boolean {
  const pattern = expected
    .trim()
    .replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
    .replaceAll("@TEST_RANDOM", "\\w+");
  return new RegExp(`^${pattern}$`).test(actual.trim());
}

function generated(site: Site): { name: string; text: string }[] {
  return readdirSync(site.migrationsDir)
    .toSorted()
    .map((name) => ({ name, text: readFileSync(join(site.migrationsDir, name), "utf8") }));
}

const secret = (c: string): { secret: string } => ({ secret: c.repeat(30) });

const secrets = (c: string) => ({
  authToken: secret(c),
  fileToken: secret(c),
  emailChangeToken: secret(c),
  passwordResetToken: secret(c),
  verificationToken: secret(c),
});

const provider = { name: "gitlab", clientId: "abc", clientSecret: "123" };

const baseAuth = {
  listRule: "@request.auth.id != '' && 1 != 2",
  viewRule: 'id = "1"',
  updateRule: 'id = "2"',
  createRule: null,
  deleteRule: 'id = "3"',
  manageRule: "1 != 2",
  indexes: ["create index test1 on test123 (f1_name)"],
};

const baseFields = [
  { id: "f1_id", name: "f1_name", type: "text", required: true },
  { id: "f2_id", name: "f2_name", type: "number", min: 10 },
  { id: "f3_id", name: "f3_name", type: "bool" },
];

describe("TestAutomigrateCollectionCreate", () => {
  test("js", async () => {
    const site = newSite();
    await withServer(site, [], async (server, token) => {
      const res = await api(server, token, "POST", "/api/collections", {
        type: "auth",
        name: "new_name",
        system: true,
        listRule: "@request.auth.id != '' && 1 > 0 || 'backtick`test' = 0",
        viewRule: 'id = "1"',
        indexes: ["create index test on new_name (id)"],
        manageRule: "1 != 2",
        oauth2: { providers: [provider] },
        ...secrets("a"),
      });
      expect(res.status).toBe(200);
    });

    const files = generated(site);
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toContain("_created_new_name.js");
    expect(matchesTemplate(files[0]?.text ?? "", expectedTemplates.create)).toBe(true);
    expect(userMigrations(site)).toEqual([files[0]?.name ?? ""]);
  });
});

describe("TestAutomigrateCollectionDelete", () => {
  test("js", async () => {
    const site = newSite();
    await withServer(site, ["--automigrate=false"], async (server, token) => {
      const res = await api(server, token, "POST", "/api/collections", {
        type: "auth",
        name: "test123",
        listRule: "@request.auth.id != '' && 1 > 0 || 'backtick`test' = 0",
        viewRule: 'id = "1"',
        indexes: ["create index test on test123 (id)"],
        manageRule: "1 != 2",
        oauth2: { providers: [provider] },
        ...secrets("a"),
      });
      expect(res.status).toBe(200);
    });
    expect(existsSync(site.migrationsDir)).toBe(false);

    await withServer(site, [], async (server, token) => {
      const res = await api(server, token, "DELETE", "/api/collections/test123");
      expect(res.status).toBe(204);
    });

    const files = generated(site);
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toContain("_deleted_test123.js");
    expect(matchesTemplate(files[0]?.text ?? "", expectedTemplates.delete)).toBe(true);
  });
});

describe("TestAutomigrateCollectionUpdate", () => {
  test("js", async () => {
    const site = newSite();
    await withServer(site, ["--automigrate=false"], async (server, token) => {
      await api(server, token, "POST", "/api/collections", { type: "auth", name: "test123" });
      const scaffold = (await (
        await api(server, token, "GET", "/api/collections/test123")
      ).json()) as { fields: unknown[] };
      const res = await api(server, token, "PATCH", "/api/collections/test123", {
        ...baseAuth,
        fields: [...scaffold.fields, ...baseFields],
      });
      expect(res.status).toBe(200);
    });

    await withServer(site, [], async (server, token) => {
      const current = (await (
        await api(server, token, "GET", "/api/collections/test123")
      ).json()) as {
        fields: { id: string; name: string }[];
      };
      const res = await api(server, token, "PATCH", "/api/collections/test123", {
        name: "test123_update",
        listRule: "@request.auth.id != ''",
        viewRule: 'id = "1"',
        updateRule: 'id = "2_update"',
        createRule: 'id = "nil_update"',
        deleteRule: null,
        indexes: ["create index test1 on test123_update (f1_name)"],
        fields: [
          ...current.fields
            .filter((f) => f.id !== "f3_id")
            .map((f) => (f.id === "f2_id" ? { ...f, name: "f2_name_new" } : f)),
          { id: "f4_id", name: "f4_name", type: "text", pattern: "`test backtick`123" },
        ],
        oauth2: { enabled: true, providers: [provider] },
        fileToken: { duration: 10, secret: "b".repeat(30) },
        authToken: secret("b"),
        emailChangeToken: secret("b"),
        passwordResetToken: secret("b"),
        verificationToken: secret("b"),
      });
      expect(res.status).toBe(200);
    });

    const files = generated(site);
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toContain("_updated_test123.js");
    expect(matchesTemplate(files[0]?.text ?? "", expectedTemplates.update)).toBe(true);
  });
});

describe("TestAutomigrateCollectionNoChanges", () => {
  test("js", async () => {
    const site = newSite();
    await withServer(site, ["--automigrate=false"], async (server, token) => {
      const res = await api(server, token, "POST", "/api/collections", {
        type: "auth",
        name: "test123",
      });
      expect(res.status).toBe(200);
    });

    await withServer(site, [], async (server, token) => {
      const res = await api(server, token, "PATCH", "/api/collections/test123", {
        oauth2: { providers: [provider] },
        ...secrets("b"),
      });
      expect(res.status).toBe(200);
    });

    expect(existsSync(site.migrationsDir)).toBe(false);
  });
});

describe("automigrate", () => {
  test("a name ending with test gets an extra underscore", async () => {
    const site = newSite();
    await withServer(site, [], async (server, token) => {
      await api(server, token, "POST", "/api/collections", { type: "base", name: "myTest" });
    });
    expect(generated(site)[0]?.name).toEndWith("_created_myTest_.js");
  });

  test("--automigrate=false writes nothing; --migrationsDir moves the files", async () => {
    const site = newSite();
    await withServer(site, ["--automigrate=false"], async (server, token) => {
      await api(server, token, "POST", "/api/collections", { type: "base", name: "one" });
    });
    expect(existsSync(site.migrationsDir)).toBe(false);

    const other = join(site.root, "elsewhere", "migrations");
    await withServer(site, ["--migrationsDir", other], async (server, token) => {
      await api(server, token, "POST", "/api/collections", { type: "base", name: "two" });
    });
    expect(readdirSync(other)).toHaveLength(1);
    expect(existsSync(site.migrationsDir)).toBe(false);
  });

  test("a collection import writes nothing", async () => {
    const site = newSite();
    await withServer(site, [], async (server, token) => {
      const res = await api(server, token, "PUT", "/api/collections/import", {
        collections: [{ type: "base", name: "imported" }],
      });
      expect(res.status).toBe(204);
    });
    expect(existsSync(site.migrationsDir)).toBe(false);
  });
});

describe("startup", () => {
  test("pending files apply in file-name order before the server accepts requests", async () => {
    const site = newSite();
    writeMigrations(site, {
      "2_second.js": `migrate((app) => { app.db().newQuery("INSERT INTO m (v) VALUES ('second')").execute() })`,
      "1_first.js": `migrate((app) => { app.db().newQuery("CREATE TABLE m (v TEXT)").execute() })`,
      "notes.txt": `not a migration`,
      "3_ts.ts": `migrate((app) => { app.db().newQuery("INSERT INTO m (v) VALUES ('third')").execute() })`,
    });

    const server = await startServer([], site.dataDir);
    await server.stop();

    expect(userMigrations(site)).toEqual(["1_first.js", "2_second.js", "3_ts.ts"]);
    expect(rows<{ v: string }>(site, "SELECT v FROM m ORDER BY rowid").map((r) => r.v)).toEqual([
      "second",
      "third",
    ]);
  });

  test("a failing up rolls back every pending file and stops the start", async () => {
    const site = newSite();
    await migrate(site, "up");
    writeMigrations(site, {
      "1_ok.js": `migrate((app) => { app.db().newQuery("CREATE TABLE ok (v TEXT)").execute() })`,
      "2_fail.js": `migrate((app) => { throw new Error("boom") })`,
    });

    const port = await freePort();
    const result = await run(["serve", "--http", `127.0.0.1:${port}`, "--dir", site.dataDir], {
      cwd: site.root,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("failed to apply migration 2_fail.js: Error: boom at ");
    expect(userMigrations(site)).toEqual([]);
    expect(rows(site, "SELECT name FROM sqlite_schema WHERE name = 'ok'")).toEqual([]);
  });

  test("every file loads, also when applied: a syntax error stops every command", async () => {
    const site = newSite();
    writeMigrations(site, { "1_ok.js": `migrate((app) => {})` });
    expect((await migrate(site, "up")).exitCode).toBe(0);

    writeFileSync(join(site.migrationsDir, "1_ok.js"), `migrate((app) => {`);

    for (const args of [["migrate", "up"], ["serve"], ["--help"], ["superuser", "--help"]]) {
      const result = await run([...args, "--dir", site.dataDir], { cwd: site.root });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toStartWith(
        "panic: registerMigrations: failed to run migration 1_ok.js: SyntaxError: ",
      );
    }
  });

  test("a promise from up fails, and what it runs later cannot reach the transaction", async () => {
    const site = newSite();
    writeMigrations(site, {
      "1_async.js": `migrate(async (app) => {
        app.db().newQuery("CREATE TABLE early (v TEXT)").execute();
        await null;
        app.db().newQuery("CREATE TABLE late (v TEXT)").execute();
      })`,
    });

    const result = await migrate(site, "up");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "failed to apply migration 1_async.js: could not convert [object Promise] to error",
    );
    expect(result.stderr).toContain("must be synchronous");
    expect(rows(site, "SELECT name FROM sqlite_schema WHERE name IN ('early', 'late')")).toEqual(
      [],
    );
    expect(userMigrations(site)).toEqual([]);
  });

  test("down keeps a system migration without a down, and refuses one with a down", async () => {
    const site = newSite();
    await migrate(site, "up");
    const count = (): unknown => rows(site, "SELECT count(*) AS n FROM _migrations");
    const before = count();

    const one =
      await Bun.$`${await executable()} migrate down 1 --dir ${site.dataDir} < ${yesFile(site)}`
        .quiet()
        .nothrow();
    expect(one.exitCode).toBe(0);
    expect(one.text()).toContain("Reverted 1778828400_normalize_indexes.go");
    expect(count()).toEqual(before);

    const two =
      await Bun.$`${await executable()} migrate down 2 --dir ${site.dataDir} < ${yesFile(site)}`
        .quiet()
        .nothrow();
    expect(two.exitCode).toBe(1);
    expect(two.stderr.toString()).toContain(
      "failed to revert migration 1763020353_update_default_auth_alert_templates.go: iglo.base does not revert system migrations",
    );
    expect(count()).toEqual(before);
  });

  test("migrate with no pending file changes nothing", async () => {
    const site = newSite();
    const result = await migrate(site, "up");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("No new migrations to apply.\n");
  });
});

describe("what a migration file sees", () => {
  test("console, process, Buffer, require and isolation from the app", async () => {
    const site = newSite();
    writeFileSync(join(site.root, "helper.js"), `exports.hash = (v) => $security.md5(v);`);
    writeFileSync(join(site.root, "data.json"), `{"n":1}`);
    writeMigrations(site, {
      "1_globals.js": `
leaked = 1;
migrate((app) => {
  console.log("hash", require("./helper.js").hash("a"), require("./data.json").n);
  console.log(typeof process.env.PATH, Buffer.from("hi").toString("base64"));
  console.log(typeof Bun, typeof fetch, typeof setTimeout, typeof $app, typeof routerAdd, typeof module);
  console.log(typeof globalThis.leaked, leaked, app.dataDir().length > 0);
}, null)`,
      "2_other.js": `migrate((app) => { console.log(typeof leaked) }, null)`,
    });

    const result = await migrate(site, "up");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout
      .trimEnd()
      .split("\n")
      .map((line) => line.replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} /, ""));
    expect(lines).toEqual([
      "hash 0cc175b9c0f1b6a831c399e269772661 1",
      "string aGk=",
      "undefined undefined undefined undefined undefined undefined",
      "number 1 true",
      "undefined",
      "Applied 1_globals.js",
      "Applied 2_other.js",
    ]);
  });

  for (const [global, use] of [
    ["$http", "$http.send({ url: 'http://example.com' })"],
    ["$mails", "$mails.sendRecordOTP(app, null, '', '')"],
    ["$template", "$template.loadFiles('x')"],
    ["$filesystem", "$filesystem.s3()"],
    ["MailerMessage", "new MailerMessage({})"],
    ["RecordUpsertForm", "new RecordUpsertForm(app, null)"],
  ]) {
    test(`${global} fails with an error that names it`, async () => {
      const site = newSite();
      writeMigrations(site, { "1_x.js": `migrate((app) => { ${use} })` });
      const result = await migrate(site, "up");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`${global} is not available in iglo.base migrations`);
      expect(userMigrations(site)).toEqual([]);
    });
  }

  test("$http says why it is left out", async () => {
    const site = newSite();
    writeMigrations(site, { "1_x.js": `migrate((app) => { $http.send({}) })` });
    const result = await migrate(site, "up");
    expect(result.stderr).toContain("no network calls run inside a write transaction");
  });

  test("a core.App method that is not bound fails with an error that names it", async () => {
    const site = newSite();
    writeMigrations(site, { "1_x.js": `migrate((app) => { app.newBackupsFilesystem() })` });
    const result = await migrate(site, "up");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("app.newBackupsFilesystem is not available");
  });

  test("a migration leaves no iglo-specific schema or rows", async () => {
    const plain = newSite();
    await migrate(plain, "up");
    const site = newSite();
    writeMigrations(site, { "1_x.js": `migrate((app) => {}, null)` });
    await migrate(site, "up");

    const schema = (s: Site): unknown[] =>
      rows(s, "SELECT type, name, sql FROM sqlite_schema ORDER BY name");
    expect(schema(site)).toEqual(schema(plain));
    expect(userMigrations(site)).toEqual(["1_x.js"]);
    expect(rows(site, "SELECT count(*) AS n FROM _params")).toEqual(
      rows(plain, "SELECT count(*) AS n FROM _params"),
    );
  });
});
