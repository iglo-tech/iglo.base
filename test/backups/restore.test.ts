// Upstream: core/backup_restore.go, the Restart of core/base.go and the
// routine of apis/backup.go. POST /api/backups/{key}/restore on the running
// compiled executable: the process image is replaced, and a zip that cannot
// be restored leaves the server and pb_data as they were.

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { create } from "@/tools/archive/create";
import { NewLocal } from "@/tools/filesystem/filesystem";

import { eventually, superuserToken } from "@test/scenarios/cron";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import {
  executable,
  freePort,
  startServer,
  tempDir,
  type RunningServer,
} from "@test/support/executable";

const asSuperuser = { Authorization: superuserToken };

// a little past upstream's 1 second before the restore starts
const restoreDelayMs = 1200;

let cleanups: (() => void | Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
  cleanups = [];
});

function fixtureCopy(): string {
  const root = tempDir();
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  return dataDir;
}

async function start(dataDir: string): Promise<RunningServer> {
  const server = await startServer([], dataDir);
  let stopped: ReturnType<RunningServer["stop"]> | undefined;
  const stop: RunningServer["stop"] = () => (stopped ??= server.stop());
  cleanups.push(stop);
  return { ...server, stop };
}

async function post(url: string): Promise<number> {
  return (await fetch(url, { method: "POST", headers: asSuperuser })).status;
}

async function canBackup(url: string): Promise<boolean> {
  const res = await fetch(`${url}/api/health`, { headers: asSuperuser });
  return ((await res.json()) as { data: { canBackup: boolean } }).data.canBackup;
}

async function userName(url: string): Promise<string> {
  const res = await fetch(`${url}/api/collections/users/records/4q1xlclmfloku33`, {
    headers: asSuperuser,
  });
  return ((await res.json()) as { name: string }).name;
}

async function setUserName(url: string, name: string): Promise<void> {
  const res = await fetch(`${url}/api/collections/users/records/4q1xlclmfloku33`, {
    method: "PATCH",
    headers: { ...asSuperuser, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(200);
}

// puts a directory, zipped, in the backups dir as name
function storeZip(dataDir: string, src: string, name: string): void {
  const zipPath = join(tempDir(), "backup.zip");
  create(src, zipPath);
  const fsys = NewLocal(join(dataDir, "backups"));
  fsys.upload(readFileSync(zipPath), name);
  fsys.close();
}

async function restored(url: string, name: string): Promise<boolean> {
  return eventually(async () => {
    try {
      return (await userName(url)) === name;
    } catch {
      return false; // between the two images
    }
  });
}

describe("restore", () => {
  test("replaces the process: same pid, arguments, environment and port", async () => {
    const dataDir = fixtureCopy();
    const server = await start(dataDir);
    const before = await userName(server.url);
    expect((await post(`${server.url}/api/backups`)).valueOf()).toBe(204);
    const [{ key }] = (await (
      await fetch(`${server.url}/api/backups`, { headers: asSuperuser })
    ).json()) as [{ key: string }];
    await setUserName(server.url, "changed after the backup");
    const cmdline = readFileSync(`/proc/${server.pid}/cmdline`, "utf8");
    const environ = readFileSync(`/proc/${server.pid}/environ`, "utf8");

    expect(await post(`${server.url}/api/backups/${key}/restore`)).toBe(204);
    expect(await restored(server.url, before)).toBe(true);

    expect(readFileSync(`/proc/${server.pid}/cmdline`, "utf8")).toBe(cmdline);
    expect(readFileSync(`/proc/${server.pid}/environ`, "utf8")).toBe(environ);
    // the bootstrap of the new image
    expect(existsSync(join(dataDir, ".pb_temp_to_delete"))).toBe(false);
    expect(existsSync(join(dataDir, "backups", key))).toBe(true);
    expect(await canBackup(server.url)).toBe(true);
    await server.waitForOutput("Server started at");

    const { exitCode, stdout } = await server.stop();
    expect(exitCode).toBe(0);
    // the new image prints the banner, as upstream's does
    expect(stdout.match(/Server started at/g)).toHaveLength(2);
    expect(stdout.match(/> REST API: /g)).toHaveLength(2);
  }, 30_000);

  const refused: [string, (dir: string) => void][] = [
    ["a zip without data.db", (dir) => writeFileSync(join(dir, "x.txt"), "x")],
    ["a data.db that is no database", (dir) => writeFileSync(join(dir, "data.db"), "garbage")],
    [
      "an auxiliary.db that is no database",
      (dir) => {
        copyFileSync(join(fixtureDir, "data.db"), join(dir, "data.db"));
        writeFileSync(join(dir, "auxiliary.db"), "garbage".repeat(1000));
      },
    ],
    [
      "data older than the app can open",
      (dir) => {
        const db = new Database(join(dir, "data.db"), { create: true });
        db.run("CREATE TABLE _migrations (file TEXT PRIMARY KEY, applied INTEGER)");
        db.run("INSERT INTO _migrations VALUES ('1640988000_init.go', 1)");
        db.close();
      },
    ],
  ];

  for (const [name, fill] of refused) {
    test(`${name} is refused before anything moves`, async () => {
      const dataDir = fixtureCopy();
      const zipDir = tempDir();
      cleanups.push(() => rmSync(zipDir, { recursive: true, force: true }));
      fill(zipDir);
      storeZip(dataDir, zipDir, "bad.zip");
      const server = await start(dataDir);
      await setUserName(server.url, "still here");
      const entries = readdirSync(dataDir).toSorted();
      entries.push(".pb_temp_to_delete");

      expect(await post(`${server.url}/api/backups/bad.zip/restore`)).toBe(204);

      await Bun.sleep(restoreDelayMs);
      expect(await eventually(() => canBackup(server.url))).toBe(true);
      expect(await userName(server.url)).toBe("still here");
      expect(readdirSync(dataDir).toSorted()).toEqual(entries.toSorted());
      expect(readdirSync(join(dataDir, ".pb_temp_to_delete"))).toEqual([]);

      const { stderr } = await server.stop();
      expect(stderr).toContain("Failed to restore backup: bad.zip");
    }, 30_000);
  }

  test("garbage bytes as a zip leave the server up", async () => {
    const dataDir = fixtureCopy();
    mkdirSync(join(dataDir, "backups"));
    writeFileSync(join(dataDir, "backups", "bad.zip"), "this is no zip");
    const server = await start(dataDir);

    expect(await post(`${server.url}/api/backups/bad.zip/restore`)).toBe(204);
    await Bun.sleep(restoreDelayMs);

    expect(await eventually(() => canBackup(server.url))).toBe(true);
    expect((await server.stop()).stderr).toContain("zip: not a valid zip file");
  }, 30_000);

  test("a failed execve reverts pb_data and the app bootstraps again", async () => {
    const dataDir = fixtureCopy();
    const root = tempDir();
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const binary = join(root, "iglo-base");
    copyFileSync(await executable(), binary);
    Bun.spawnSync(["chmod", "+x", binary]);

    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const proc = Bun.spawn(
      [binary, "serve", "--http", `127.0.0.1:${port}`, "--dir", dataDir, "--automigrate=false"],
      { cwd: root, stdout: "ignore", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } },
    );
    cleanups.push(() => {
      proc.kill();
      return proc.exited;
    });
    expect(
      await eventually(async () => {
        try {
          return (await fetch(`${url}/api/health`)).ok;
        } catch {
          return false;
        }
      }),
    ).toBe(true);

    expect(await post(`${url}/api/backups`)).toBe(204);
    const [{ key }] = (await (
      await fetch(`${url}/api/backups`, { headers: asSuperuser })
    ).json()) as [{ key: string }];
    await setUserName(url, "not restored");

    // execve finds no file
    rmSync(binary);

    expect(await post(`${url}/api/backups/${key}/restore`)).toBe(204);
    await Bun.sleep(restoreDelayMs);
    expect(
      await eventually(async () => {
        try {
          return (await userName(url)) === "not restored" && (await canBackup(url));
        } catch {
          return false;
        }
      }),
    ).toBe(true);
    expect(existsSync(join(dataDir, "data.db"))).toBe(true);
    expect(proc.exitCode).toBe(null);
  }, 30_000);
});
