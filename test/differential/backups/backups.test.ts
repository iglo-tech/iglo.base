// Upstream: apis/backup.go, core/backup_create.go, core/backup_restore.go.
// Zips made by one server restored by the other through
// POST /api/backups/{key}/restore on the running servers, what the two
// servers put in a zip, and the __pbAutoBackup__ job in GET /api/crons.
// Not part of `bun test`: run `bun run test:reference`.

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

import { eventually, superuserToken } from "@test/scenarios/cron";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { startServer, tempDir } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";
import { centralEntries } from "@test/tools/archive/central-directory";

const timeout = 60_000;

const asSuperuser = { Authorization: superuserToken };

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Server {
  url: string;
  dataDir: string;
  stop(): Promise<unknown>;
}

function fixtureCopy(): string {
  const root = tempDir();
  roots.push(root);
  const dataDir = join(root, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  return dataDir;
}

function start(kind: "upstream" | "iglo", dataDir: string): Promise<Server> {
  return kind === "upstream"
    ? startUpstream({ dataDir })
    : startServer([], dataDir).then((s) => ({ ...s, dataDir }));
}

// what a zip may not take along, and a file with its own mode and mod time
function addLocalEntries(dataDir: string): void {
  for (const dir of [".notify", ".autocert_cache", "lost+found", ".pb_temp_to_delete"]) {
    mkdirSync(join(dataDir, dir), { recursive: true });
    writeFileSync(join(dataDir, dir, "left-out.txt"), "left out");
  }
  writeFileSync(join(dataDir, "notes.txt"), "kept", { mode: 0o640 });
  utimesSync(join(dataDir, "notes.txt"), 1_600_000_000, 1_600_000_000);
  writeFileSync(join(dataDir, "unicode-ż.txt"), "kept");
  const aux = new Database(join(dataDir, "auxiliary.db"));
  aux.run(
    `INSERT INTO _logs (id, level, message, data, created)
     VALUES ('backuplog000000', 0, 'kept', '{}', ?)`,
    // upstream's settings reload deletes logs past logs.maxDays
    [new Date().toISOString().replace("T", " ")],
  );
  aux.close();
}

async function createBackup(server: Server, name: string): Promise<void> {
  const res = await fetch(`${server.url}/api/backups`, {
    method: "POST",
    headers: { ...asSuperuser, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(204);
}

async function fileToken(server: Server): Promise<string> {
  const res = await fetch(`${server.url}/api/files/token`, {
    method: "POST",
    headers: asSuperuser,
  });
  return ((await res.json()) as { token: string }).token;
}

async function download(server: Server, name: string): Promise<Uint8Array> {
  const res = await fetch(`${server.url}/api/backups/${name}?token=${await fileToken(server)}`);
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}

async function upload(server: Server, name: string, zip: Uint8Array): Promise<void> {
  const body = new FormData();
  body.set("file", new File([zip as Uint8Array<ArrayBuffer>], name, { type: "application/zip" }));
  const res = await fetch(`${server.url}/api/backups/upload`, {
    method: "POST",
    headers: asSuperuser,
    body,
  });
  expect(res.status).toBe(204);
}

function tableRows(path: string): Record<string, unknown[]> {
  const db = new Database(path, { readonly: true });
  try {
    const result: Record<string, unknown[]> = {
      sqlite_schema: db
        .query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name")
        .all(),
    };
    const tables = db
      .query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      result[name] = db.query(`SELECT * FROM "${name}" ORDER BY 1`).all();
    }
    return result;
  } finally {
    db.close();
  }
}

function fileHashes(dir: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const path = join(dir, entry);
    if (statSync(path).isFile()) {
      hashes[relative(dir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  return hashes;
}

// what a restored pb_data must read back
function snapshot(dataDir: string): {
  data: Record<string, unknown[]>;
  logs: unknown[];
  storage: Record<string, string>;
} {
  return {
    data: tableRows(join(dataDir, "data.db")),
    logs: tableRows(join(dataDir, "auxiliary.db"))._logs ?? [],
    storage: fileHashes(join(dataDir, "storage")),
  };
}

async function restoreAndWait(server: Server, name: string): Promise<void> {
  // a superuser created here must be gone after the restart
  const marker = `backup-marker-${name}@example.com`.replace(".zip", "");
  const created = await fetch(`${server.url}/api/collections/_superusers/records`, {
    method: "POST",
    headers: { ...asSuperuser, "Content-Type": "application/json" },
    body: JSON.stringify({ email: marker, password: "1234567890", passwordConfirm: "1234567890" }),
  });
  expect(created.status).toBe(200);
  const { id } = (await created.json()) as { id: string };

  const res = await fetch(`${server.url}/api/backups/${name}/restore`, {
    method: "POST",
    headers: asSuperuser,
  });
  expect(res.status).toBe(204);

  const restarted = await eventually(async () => {
    try {
      const r = await fetch(`${server.url}/api/collections/_superusers/records/${id}`, {
        headers: asSuperuser,
      });
      return r.status === 404;
    } catch {
      return false; // the server is between the two images
    }
  });
  expect(restarted).toBe(true);
}

describe("a zip restored by the other server", () => {
  for (const [from, to] of [
    ["iglo", "upstream"],
    ["upstream", "iglo"],
  ] as const) {
    test(
      `made by ${from}, restored by ${to}`,
      async () => {
        const sourceDir = fixtureCopy();
        addLocalEntries(sourceDir);
        const source = await start(from, sourceDir);
        let zip: Uint8Array;
        try {
          await createBackup(source, "cross.zip");
          zip = await download(source, "cross.zip");
        } finally {
          await source.stop();
        }
        const expected = snapshot(sourceDir);

        const targetDir = fixtureCopy();
        const target = await start(to, targetDir);
        try {
          await upload(target, "cross.zip", zip);
          await restoreAndWait(target, "cross.zip");

          // the local backups dir survives
          const list = await fetch(`${target.url}/api/backups`, { headers: asSuperuser });
          const keys = ((await list.json()) as { key: string }[]).map((b) => b.key);
          expect(keys).toEqual(["cross.zip"]);

          const settings = await fetch(`${target.url}/api/settings`, { headers: asSuperuser });
          expect(settings.status).toBe(200);
        } finally {
          await target.stop();
        }

        const actual = snapshot(targetDir);
        expect(actual.data).toEqual(expected.data);
        expect(actual.storage).toEqual(expected.storage);
        const logged = (logs: unknown[]): unknown[] =>
          logs.filter((l) => (l as { id: string }).id === "backuplog000000");
        expect(logged(actual.logs)).toEqual(logged(expected.logs));
        expect(logged(actual.logs)).toHaveLength(1);
        expect(readFileSync(join(targetDir, "notes.txt"), "utf8")).toBe("kept");
        expect(statSync(join(targetDir, "notes.txt")).mode & 0o777).toBe(0o640);
        expect(existsSync(join(targetDir, "backups", "cross.zip"))).toBe(true);
        expect(existsSync(join(targetDir, "backups", "cross.zip.attrs"))).toBe(true);
        // old data is removed at the next start
        expect(existsSync(join(targetDir, ".pb_temp_to_delete"))).toBe(false);
      },
      timeout,
    );
  }
});

describe("what a zip has", () => {
  test(
    "the same entries, modes and mod times on both servers",
    async () => {
      const dataDir = fixtureCopy();
      addLocalEntries(dataDir);
      const upstreamDir = join(dataDir, "..", "upstream", "pb_data");
      const igloDir = join(dataDir, "..", "iglo", "pb_data");
      copyDataDir(dataDir, upstreamDir);
      copyDataDir(dataDir, igloDir);

      const [upstream, iglo] = await Promise.all([
        start("upstream", upstreamDir),
        start("iglo", igloDir),
      ]);
      try {
        await Promise.all([createBackup(upstream, "a.zip"), createBackup(iglo, "a.zip")]);
        const [upZip, igZip] = await Promise.all([
          download(upstream, "a.zip"),
          download(iglo, "a.zip"),
        ]);

        const entries = (zip: Uint8Array): unknown[] =>
          centralEntries(zip)
            .map((e) => ({
              name: e.name,
              method: e.method,
              flags: e.flags,
              mode: e.mode,
              // the databases are new copies
              modTime: /^(data|auxiliary)\.db$/.test(e.name) ? 0 : e.modTime,
            }))
            .toSorted((a, b) => (a.name < b.name ? -1 : 1));

        // upstream's prebuilt binary writes types.d.ts into pb_data at start
        const upEntries = entries(upZip).filter(
          (e) => (e as { name: string }).name !== "types.d.ts",
        );
        expect(entries(igZip)).toEqual(upEntries);
        const names = centralEntries(igZip).map((e) => e.name);
        expect(names).toContain("data.db");
        expect(names).toContain("auxiliary.db");
        expect(names).toContain("notes.txt");
        expect(names).toContain("unicode-ż.txt");
        for (const name of names) {
          expect(name).not.toMatch(
            /-wal$|-shm$|\\|^(backups|\.pb_temp_to_delete|\.notify|\.autocert_cache|lost\+found)\//,
          );
        }
      } finally {
        await Promise.all([upstream.stop(), iglo.stop()]);
      }
    },
    timeout,
  );
});

describe("GET /api/crons with __pbAutoBackup__", () => {
  test(
    "the same list after setting, changing and clearing backups.cron",
    async () => {
      const [upstream, iglo] = await Promise.all([
        start("upstream", fixtureCopy()),
        start("iglo", fixtureCopy()),
      ]);
      const crons = async (server: Server): Promise<string> =>
        (await fetch(`${server.url}/api/crons`, { headers: asSuperuser })).text();
      const setCron = async (server: Server, cron: string): Promise<void> => {
        const res = await fetch(`${server.url}/api/settings`, {
          method: "PATCH",
          headers: { ...asSuperuser, "Content-Type": "application/json" },
          body: JSON.stringify({ backups: { cron, cronMaxKeep: 3 } }),
        });
        expect(`${res.status} ${await res.text()}`).toStartWith("200");
      };

      try {
        for (const cron of ["0 3 * * *", "*/5 * * * *", ""]) {
          await Promise.all([setCron(upstream, cron), setCron(iglo, cron)]);
          const [up, ig] = await Promise.all([crons(upstream), crons(iglo)]);
          expect(ig).toBe(up);
          expect(ig.includes("__pbAutoBackup__")).toBe(cron !== "");
        }
        // at bootstrap too
        await Promise.all([setCron(upstream, "0 4 * * *"), setCron(iglo, "0 4 * * *")]);
      } finally {
        await Promise.all([upstream.stop(), iglo.stop()]);
      }
      const [upstream2, iglo2] = await Promise.all([
        start("upstream", upstream.dataDir),
        start("iglo", iglo.dataDir),
      ]);
      try {
        const [up, ig] = await Promise.all([crons(upstream2), crons(iglo2)]);
        expect(ig).toBe(up);
        expect(ig).toContain("__pbAutoBackup__");
      } finally {
        await Promise.all([upstream2.stop(), iglo2.stop()]);
      }
    },
    timeout,
  );
});
