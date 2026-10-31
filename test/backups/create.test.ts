// Upstream: core/backup_test.go, the scenarios of apis/backup_test.go that
// preset the active backup, the concurrency notes of core/backup_create.go
// and registerAutobackupHooks (core/backup.go).
//
// In-process: the zip is read back from the backups directory.

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { StoreKeyActiveBackup } from "@/apis/health";
import { newRouter } from "@/apis/base";
import { loadAutobackupJob } from "@/backups/autobackup";
import { createBackup, generateBackupName } from "@/backups/create";
import { restoreBackup } from "@/backups/restore";
import { extract } from "@/tools/archive/extract";

import { openFixtureApp, type TestApp } from "@test/app/app";
import { createTestBackups } from "@test/scenarios/backup";
import { superuserToken } from "@test/scenarios/cron";
import { tempDir } from "@test/support/executable";
import { serveTest } from "@test/support/router";
import { sharedSmtpSink } from "@test/support/smtp-sink";
import { centralEntries } from "@test/tools/archive/central-directory";

let opened: TestApp[] = [];
let dirs: string[] = [];

afterEach(async () => {
  for (const app of opened) {
    await app.cleanup();
  }
  opened = [];
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

async function open(options: Parameters<typeof openFixtureApp>[0] = {}): Promise<TestApp> {
  const app = await openFixtureApp(options);
  opened.push(app);
  return app;
}

function send(app: TestApp, method: string, target: string, body?: string): Promise<Response> {
  return serveTest(newRouter(app).buildMux(), {
    method,
    target,
    headers: { Authorization: superuserToken, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body }),
  });
}

function backupsDir(app: TestApp): string {
  return join(app.dataDir, "backups");
}

function zipNames(app: TestApp, name: string): string[] {
  return centralEntries(readFileSync(join(backupsDir(app), name))).map((e) => e.name);
}

// waits, turn by turn, until a file shows up
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("timed out");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const storageKey = "9n89pl5vkct6330/la4y2w4o98acwuj/300_uh2gpr1ghu5w.txt";

function addStorageFile(app: TestApp, key: string, content: Uint8Array | string): void {
  const fs = app.filesystem.newFilesystem();
  fs.upload(typeof content === "string" ? new TextEncoder().encode(content) : content, key);
  fs.close();
}

function deleteStorageFile(app: TestApp, key: string): void {
  const fs = app.filesystem.newFilesystem();
  fs.delete(key);
  fs.close();
}

// data.db and auxiliary.db slow enough to catch their copies under way
function growDatabases(app: TestApp): void {
  const blob = crypto.getRandomValues(new Uint8Array(1 << 20));
  for (const file of ["data.db", "auxiliary.db"]) {
    const db = new Database(join(app.dataDir, file));
    db.run("CREATE TABLE IF NOT EXISTS _test_fill (b BLOB)");
    for (let i = 0; i < 30; i++) {
      db.query("INSERT INTO _test_fill VALUES (?)").run(blob);
    }
    db.close();
  }
}

function tempFile(app: TestApp, name: string): string {
  return join(app.dataDir, ".pb_temp_to_delete", name);
}

describe("TestCreateBackup", () => {
  test("names, replace and the content", async () => {
    const app = await open();

    // set some long app name with spaces and special characters
    app.settings.Meta.AppName = "test @! " + "a".repeat(100);
    const expectedAppNamePrefix = "test_" + "a".repeat(45);

    // test pending error
    app.store.set(StoreKeyActiveBackup, "");
    await expect(createBackup(app, "test.zip")).rejects.toThrow("try again later");
    app.store.remove(StoreKeyActiveBackup);

    // create with auto generated name
    await createBackup(app, "");
    // create with custom name
    await createBackup(app, "custom");
    // create new with the same name (aka. replace)
    await createBackup(app, "custom");

    const entries = readdirSync(backupsDir(app)).toSorted();
    expect(entries).toHaveLength(4);
    expect(entries[0]).toBe("custom");
    expect(entries[1]).toBe("custom.attrs");
    expect(entries[2]).toMatch(new RegExp(`^pb_backup_${expectedAppNamePrefix}_\\d{14}\\.zip$`));
    expect(entries[3]).toBe(`${entries[2]}.attrs`);

    for (const name of [entries[0] as string, entries[2] as string]) {
      const dir = tempDir();
      dirs.push(dir);
      await extract(join(backupsDir(app), name), dir);
      expect(readdirSync(dir).toSorted()).toEqual([
        ".gitignore",
        "auxiliary.db",
        "data.db",
        "storage",
      ]);
    }

    // the sidecar as the backups filesystem writes it
    const attrs = JSON.parse(readFileSync(join(backupsDir(app), "custom.attrs"), "utf8"));
    expect(attrs["user.content_type"]).toBe("application/zip");
    expect(attrs["user.metadata"]).toEqual({ "original-filename": "custom" });
  });

  test("the name comes from Snakecase and a byte cut of 50", async () => {
    const now = new Date("2026-10-31T01:02:03.456Z");
    const app = await open({ clock: { now: () => now } });

    app.settings.Meta.AppName = "MyTestDB żółć";
    expect(generateBackupName(app, "pb_backup_")).toBe("pb_backup_my_test_db_20261031010203.zip");

    // Snakecase drops every non-ASCII character, so a cut splits none
    app.settings.Meta.AppName = "ż".repeat(100);
    expect(generateBackupName(app, "x_")).toBe("x__20261031010203.zip");

    app.settings.Meta.AppName = "a".repeat(49) + "ż" + "b".repeat(9);
    expect(generateBackupName(app, "x_")).toBe(`x_${"a".repeat(49)}__20261031010203.zip`);
  });

  test("the excluded root entries and the WAL files stay out", async () => {
    const app = await open();
    for (const dir of [".notify", ".autocert_cache", "lost+found", "backups"]) {
      mkdirSync(join(app.dataDir, dir), { recursive: true });
      writeFileSync(join(app.dataDir, dir, "x"), "x");
    }
    writeFileSync(join(app.dataDir, "kept"), "x");
    utimesSync(join(app.dataDir, "kept"), 1_600_000_000, 1_600_000_000);

    await createBackup(app, "a.zip");

    const entries = centralEntries(readFileSync(join(backupsDir(app), "a.zip")));
    const names = entries.map((e) => e.name);
    expect(names.slice(0, 2)).toEqual(["data.db", "auxiliary.db"]);
    expect(names).toContain("kept");
    expect(entries.find((e) => e.name === "kept")?.modTime).toBe(1_600_000_000);
    for (const name of names) {
      expect(name).not.toMatch(
        /(-wal|-shm)$|^(backups|\.pb_temp_to_delete|\.notify|\.autocert_cache|lost\+found)\//,
      );
    }
    // nothing stays behind
    expect(readdirSync(join(app.dataDir, ".pb_temp_to_delete"))).toEqual([]);
  });

  test("the copies are complete with writes in the WAL", async () => {
    const app = await open();
    app.databases
      .nonconcurrentDB()
      .newQuery("UPDATE users SET name = 'in the wal' WHERE id = '4q1xlclmfloku33'")
      .execute();

    await createBackup(app, "a.zip");

    const dir = tempDir();
    dirs.push(dir);
    await extract(join(backupsDir(app), "a.zip"), dir);
    const db = new Database(join(dir, "data.db"), { readonly: true });
    expect(db.query("SELECT name FROM users WHERE id = '4q1xlclmfloku33'").get()).toEqual({
      name: "in the wal",
    });
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    db.close();
  });
});

describe("concurrency semantics", () => {
  test("a file deleted while data.db is copied is still in the zip", async () => {
    const app = await open();
    growDatabases(app);
    addStorageFile(app, "col/rec/deleted.txt", "deleted");

    const backup = createBackup(app, "a.zip");
    await until(() => existsSync(tempFile(app, "data.db")));
    deleteStorageFile(app, "col/rec/deleted.txt");
    await backup;

    expect(existsSync(join(app.dataDir, "storage/col/rec/deleted.txt"))).toBe(false);
    const names = zipNames(app, "a.zip");
    expect(names.filter((n) => n === "storage/col/rec/deleted.txt")).toHaveLength(1);
    expect(names).toContain("storage/col/rec/deleted.txt.attrs");

    const dir = tempDir();
    dirs.push(dir);
    await extract(join(backupsDir(app), "a.zip"), dir);
    expect(readFileSync(join(dir, "storage/col/rec/deleted.txt"), "utf8")).toBe("deleted");
  });

  test("a file created from step 4 on is not in the zip, one created before is", async () => {
    const app = await open();
    growDatabases(app);
    addStorageFile(app, "col/rec/before.txt", "before");

    const backup = createBackup(app, "a.zip");
    await until(() => existsSync(tempFile(app, "data.db")));
    addStorageFile(app, "col/rec/during-step-2.txt", "during");
    await until(() => existsSync(tempFile(app, "auxiliary.db")));
    addStorageFile(app, "col/rec/new.txt", "new");
    await backup;

    const names = zipNames(app, "a.zip");
    expect(names).toContain("storage/col/rec/before.txt");
    expect(names).toContain("storage/col/rec/during-step-2.txt");
    expect(names).not.toContain("storage/col/rec/new.txt");
    expect(names).not.toContain("storage/col/rec/new.txt.attrs");
  });

  test("files deleted during the walk: once each, whichever side of the walk", async () => {
    const app = await open();
    growDatabases(app);
    // a large file the walk spends its time in, between two small ones
    addStorageFile(app, "col/rec/a-before.txt", "before");
    addStorageFile(app, "col/rec/b-large.bin", crypto.getRandomValues(new Uint8Array(1 << 25)));
    addStorageFile(app, "col/rec/c-after.txt", "after");

    const backup = createBackup(app, "a.zip");
    await until(() => existsSync(tempFile(app, "auxiliary.db")));
    await until(() => !existsSync(tempFile(app, "auxiliary.db")));
    deleteStorageFile(app, "col/rec/a-before.txt");
    deleteStorageFile(app, "col/rec/c-after.txt");
    await backup;

    const names = zipNames(app, "a.zip");
    for (const file of ["a-before.txt", "b-large.bin", "c-after.txt"]) {
      expect(names.filter((n) => n === `storage/col/rec/${file}`)).toHaveLength(1);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  test("a blob being written is not zipped", async () => {
    const app = await open();
    mkdirSync(join(app.dataDir, "storage/col/rec"), { recursive: true });
    writeFileSync(join(app.dataDir, "storage/col/rec/x.txt.18a2b3c4d5e6f708.tmp"), "partial");

    await createBackup(app, "a.zip");

    expect(zipNames(app, "a.zip").filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("concurrent writes neither fail nor corrupt the backup", async () => {
    const app = await open();
    growDatabases(app);

    let done = false;
    const backup = createBackup(app, "a.zip").finally(() => {
      done = true;
    });
    let i = 0;
    while (!done) {
      addStorageFile(app, `col/rec/w${i}.txt`, "x");
      app.databases
        .nonconcurrentDB()
        .newQuery(`UPDATE users SET name = 'n${i}' WHERE id = '4q1xlclmfloku33'`)
        .execute();
      if (i > 0) {
        deleteStorageFile(app, `col/rec/w${i - 1}.txt`);
      }
      i++;
      await Bun.sleep(1);
    }
    await backup;

    const dir = tempDir();
    dirs.push(dir);
    await extract(join(backupsDir(app), "a.zip"), dir);
    const db = new Database(join(dir, "data.db"), { readonly: true });
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    db.close();
  });
});

describe("one backup or restore at a time", () => {
  test("the second one fails and canBackup flips", async () => {
    const app = await open();
    growDatabases(app);

    const before = (await (await send(app, "GET", "/api/health")).json()) as {
      data: { canBackup: boolean };
    };
    expect(before.data.canBackup).toBe(true);

    const backup = createBackup(app, "a.zip");
    await expect(createBackup(app, "b.zip")).rejects.toThrow(
      "try again later - another backup/restore operation has already been started",
    );
    await expect(restoreBackup(app, "a.zip")).rejects.toThrow("try again later");

    const during = (await (await send(app, "GET", "/api/health")).json()) as {
      data: { canBackup: boolean };
    };
    expect(during.data.canBackup).toBe(false);

    await backup;

    const after = (await (await send(app, "GET", "/api/health")).json()) as {
      data: { canBackup: boolean };
    };
    expect(after.data.canBackup).toBe(true);
    expect(existsSync(join(backupsDir(app), "b.zip"))).toBe(false);
  });

  test("the active flag clears when the backup fails", async () => {
    const app = await open();
    // the temp directory cannot be created
    writeFileSync(join(app.dataDir, ".pb_temp_to_delete"), "");

    await expect(createBackup(app, "a.zip")).rejects.toThrow();
    expect(app.store.has(StoreKeyActiveBackup)).toBe(false);

    rmSync(join(app.dataDir, ".pb_temp_to_delete"));
    await createBackup(app, "a.zip");
    expect(existsSync(join(backupsDir(app), "a.zip"))).toBe(true);
  });

  test("the active flag clears when the database copy fails", async () => {
    const app = await open();
    // VACUUM INTO refuses a directory as its target
    mkdirSync(tempFile(app, "data.db"), { recursive: true });

    await expect(createBackup(app, "a.zip")).rejects.toThrow();
    expect(app.store.has(StoreKeyActiveBackup)).toBe(false);
    expect(readdirSync(backupsDir(app))).toEqual([]);
  });
});

describe("TestRestoreBackup", () => {
  test("pending and missing errors", async () => {
    const app = await open();
    await createBackup(app, "test");

    // test pending error
    app.store.set(StoreKeyActiveBackup, "");
    await expect(restoreBackup(app, "test")).rejects.toThrow("try again later");
    app.store.remove(StoreKeyActiveBackup);

    // missing backup
    await expect(restoreBackup(app, "missing")).rejects.toThrow(
      `missing or invalid backup file "missing" to restore`,
    );
    expect(app.store.has(StoreKeyActiveBackup)).toBe(false);
  });

  test("a failed restart reverts pb_data", async () => {
    const app = await open();
    await createBackup(app, "test");
    writeFileSync(join(app.dataDir, "after-backup.txt"), "local");
    const before = readdirSync(app.dataDir).toSorted();

    // no restart under a test app: it fails after the moves
    await expect(restoreBackup(app, "test")).rejects.toThrow("failed to restart the app process");

    expect(readdirSync(app.dataDir).toSorted()).toEqual(before);
    expect(app.store.has(StoreKeyActiveBackup)).toBe(false);
    expect(readdirSync(join(app.dataDir, ".pb_temp_to_delete"))).toEqual([]);
  });
});

describe("apis/backup_test.go scenarios with a preset active backup", () => {
  const scenarios: {
    name: string;
    method: string;
    url: string;
    active: string;
    status: number;
    message: string;
    backups: number;
  }[] = [
    {
      name: "TestBackupsCreate: authorized as superuser (pending backup)",
      method: "POST",
      url: "/api/backups",
      active: "",
      status: 400,
      message: "Try again later - another backup/restore process has already been started.",
      backups: 4,
    },
    {
      name: "TestBackupsDelete: authorized as superuser (existing file with matching active backup)",
      method: "DELETE",
      url: "/api/backups/test1.zip",
      active: "test1.zip",
      status: 400,
      message: "The backup is currently being used and cannot be deleted.",
      backups: 4,
    },
    {
      name: "TestBackupsDelete: authorized as superuser (existing file and no matching active backup)",
      method: "DELETE",
      url: "/api/backups/test1.zip",
      active: "new.zip",
      status: 204,
      message: "",
      backups: 3,
    },
    {
      name: "TestBackupsRestore: authorized as superuser (active backup process)",
      method: "POST",
      url: "/api/backups/test1.zip/restore",
      active: "",
      status: 400,
      message: "Try again later - another backup/restore process has already been started.",
      backups: 4,
    },
  ];

  for (const scenario of scenarios) {
    test(scenario.name, async () => {
      const app = await open();
      createTestBackups(app.dataDir);
      app.store.set(StoreKeyActiveBackup, scenario.active);

      const res = await send(app, scenario.method, scenario.url);

      expect(res.status).toBe(scenario.status);
      if (scenario.status === 400) {
        expect(await res.json()).toEqual({ data: {}, message: scenario.message, status: 400 });
      }
      const fs = app.filesystem.newBackupsFilesystem();
      expect(fs.list("")).toHaveLength(scenario.backups);
      fs.close();
    });
  }
});

describe("backups.s3 enabled", () => {
  async function s3App(): Promise<TestApp> {
    const app = await open();
    await createBackup(app, "local.zip");
    app.settings.Backups.S3.Enabled = true;
    return app;
  }

  test("every endpoint fails and nothing is written", async () => {
    const app = await s3App();
    const before = readdirSync(backupsDir(app)).toSorted();
    const token = "?token=x";

    const expected: [string, string, string | undefined, number][] = [
      ["GET", "/api/backups", undefined, 400],
      ["POST", "/api/backups", "{}", 400],
      ["POST", "/api/backups", `{"name":"new.zip"}`, 400],
      ["POST", "/api/backups/upload", undefined, 500],
      ["DELETE", "/api/backups/local.zip", undefined, 500],
      ["POST", "/api/backups/local.zip/restore", undefined, 500],
    ];
    for (const [method, url, body, status] of expected) {
      const res = await send(app, method, url, body);
      expect([method, url, res.status]).toEqual([method, url, status]);
    }
    expect((await send(app, "GET", `/api/backups/local.zip${token}`)).status).toBe(403);

    expect(readdirSync(backupsDir(app)).toSorted()).toEqual(before);
    expect(app.store.has(StoreKeyActiveBackup)).toBe(false);
  });

  test("createBackup and restoreBackup give the clear error", async () => {
    const app = await s3App();
    const message = "the S3 backups storage is not supported yet (M5.4)";
    await expect(createBackup(app, "new.zip")).rejects.toThrow(message);
    await expect(restoreBackup(app, "local.zip")).rejects.toThrow(message);
    expect(existsSync(join(backupsDir(app), "new.zip"))).toBe(false);
    expect(readdirSync(join(app.dataDir, ".pb_temp_to_delete"))).toEqual([]);
  });

  test("the job logs and alerts, and writes no local backup", async () => {
    const app = await s3App();
    useSmtpSink(app);
    const sink = sharedSmtpSink();
    const sent = sink.messages.length;
    app.settings.Backups.Cron = "0 3 * * *";
    loadAutobackupJob(app);

    await runJob(app);

    expect(app.logged.map((l) => l.message).join()).toContain("Failed to create backup");
    expect(String((app.logged[0]?.cause as Error).message)).toContain("not supported yet (M5.4)");
    expect(sink.messages.length).toBeGreaterThan(sent);
    expect(readdirSync(backupsDir(app)).filter((f) => f.startsWith("@auto"))).toEqual([]);
  });
});

function useSmtpSink(app: TestApp): void {
  const { port } = sharedSmtpSink();
  Object.assign(app.settings.SMTP, { Enabled: true, Host: "127.0.0.1", Port: port });
}

async function runJob(app: TestApp): Promise<void> {
  const job = app.cron.jobs().find((j) => j.id === "__pbAutoBackup__");
  await job?.run();
}

describe("__pbAutoBackup__", () => {
  test("removed without a schedule, added with one", async () => {
    const app = await open();
    expect(app.cron.jobs().some((j) => j.id === "__pbAutoBackup__")).toBe(false);

    app.settings.Backups.Cron = "0 3 * * *";
    loadAutobackupJob(app);
    expect(app.cron.jobs().at(-1)?.id).toBe("__pbAutoBackup__");

    app.settings.Backups.Cron = "";
    loadAutobackupJob(app);
    expect(app.cron.jobs().some((j) => j.id === "__pbAutoBackup__")).toBe(false);
  });

  test("the name, and cronMaxKeep keeps the newest auto backups", async () => {
    let time = Date.parse("2026-10-31T01:02:03Z");
    const app = await open({ clock: { now: () => new Date(time) } });
    app.settings.Meta.AppName = "My App";
    app.settings.Backups.Cron = "0 3 * * *";
    app.settings.Backups.CronMaxKeep = 2;
    loadAutobackupJob(app);

    // a backup of the user's stays
    await createBackup(app, "manual.zip");

    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      await runJob(app);
      const name = generateBackupName(app, "@auto_pb_backup_");
      names.push(name);
      // the mod times decide, and they have one in the past for the oldest
      utimesSync(join(backupsDir(app), name), 1_700_000_000 + i, 1_700_000_000 + i);
      time += 1000;
    }

    expect(names[0]).toBe("@auto_pb_backup_my_app_20261031010203.zip");

    await runJob(app);
    const newest = generateBackupName(app, "@auto_pb_backup_");

    const left = readdirSync(backupsDir(app)).filter((f) => !f.endsWith(".attrs"));
    expect(left.toSorted()).toEqual([names[2], newest, "manual.zip"].map(String).toSorted());
  });

  test("a failure sends the alert to the superusers, and pruning still runs", async () => {
    const app = await open();
    useSmtpSink(app);
    const sink = sharedSmtpSink();
    const sent = sink.messages.length;
    app.settings.Meta.AppName = "<App>";
    app.settings.Backups.Cron = "0 3 * * *";
    loadAutobackupJob(app);
    writeFileSync(join(app.dataDir, ".pb_temp_to_delete"), "");

    await runJob(app);

    rmSync(join(app.dataDir, ".pb_temp_to_delete"));
    const messages = sink.messages.slice(sent);
    expect(messages.length).toBeGreaterThan(0);
    const text = messages[0]?.data ?? "";
    expect(text).toContain("Subject:");
    expect(text).toContain("Failed to create/upload automated backup");
    expect(text).toContain("&lt;App&gt; system alert occurred:");
  });
});
