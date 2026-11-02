// Crash and restart (M5.9): SIGKILL during a backup, to the local backups
// directory and to S3 (versitygw). Afterwards both servers must open the data,
// and every backup they list must be a whole zip. Upstream killed at the same
// point is the reference for the leftovers. Not part of `bun test`: run
// `bun run test:reference`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomFillSync } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  api,
  asSuperuser,
  extras,
  freshDataDir,
  launch,
  patchSettings,
  s3Settings,
  verifyAfterKill,
  waitFor,
  walk,
  type Kind,
  type Target,
} from "@test/differential/crash/harness";
import { startVersitygw, type Versitygw } from "@test/support/versitygw";
import { centralEntries } from "@test/tools/archive/central-directory";

const timeout = 120_000;
const roots: string[] = [];
let gw: Versitygw;

beforeAll(async () => {
  gw = await startVersitygw();
});

afterAll(async () => {
  await gw.stop();
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

type Storage = "local" | "s3";
type Point = "temp-zip" | "persisting";

const name = "crash_backup.zip";

// every listed backup downloads as a whole zip with the database in it
export async function backupsInspect(target: Target): Promise<unknown> {
  const listed = await api(target, "GET", "/api/backups");
  expect(listed.status).toBe(200);
  const items = (await listed.json()) as Array<{ key: string; size: number }>;
  const tokenRes = await fetch(`${target.url}/api/files/token`, {
    method: "POST",
    headers: asSuperuser,
  });
  const { token } = (await tokenRes.json()) as { token: string };
  for (const item of items) {
    // a half-written file of the local storage is listed as it is by both
    // servers (the blob writer's temp file next to the final name)
    if (/\.[0-9a-f]{16}\.tmp$/.test(item.key)) {
      continue;
    }
    const res = await fetch(`${target.url}/api/backups/${item.key}?token=${token}`);
    expect(res.status).toBe(200);
    const zip = new Uint8Array(await res.arrayBuffer());
    expect(zip.length).toBe(item.size);
    const names = centralEntries(zip).map((e) => e.name);
    expect(names).toContain("data.db");
    expect(names).toContain("auxiliary.db");
  }
  return items.map((i) => ({
    key: i.key.replace(/[0-9a-f]{16}\.tmp$/, "X.tmp"),
    size: i.size > 0,
  }));
}

// Runs a backup and kills the server at the point; returns the killed data.
async function crashedBackup(kind: Kind, storage: Storage, point: Point): Promise<string> {
  const { root, dataDir } = freshDataDir();
  roots.push(root);
  // enough incompressible data to give the compression some time
  const bulk = Buffer.alloc(24 * 1024 * 1024);
  randomFillSync(bulk);
  writeFileSync(join(dataDir, "bulk.bin"), bulk);

  const server = await launch(kind, dataDir);
  if (storage === "s3") {
    await patchSettings(server, { backups: { s3: s3Settings(gw) } });
  }
  const tempDir = join(dataDir, ".pb_temp_to_delete");
  const request = fetch(`${server.url}/api/backups`, {
    method: "POST",
    headers: { ...asSuperuser, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }).catch(() => undefined);

  if (point === "temp-zip") {
    await waitFor("the temp zip", () => walk(tempDir).some((p) => /^pb_backup_\w+$/.test(p)));
  } else {
    // the zip is whole, and the copy to its place has begun
    await waitFor("the persisting", () =>
      storage === "local"
        ? walk(join(dataDir, "backups")).length > 0
        : walk(gw.posixRoot).some((p) => p.includes(name) || p.includes(".sgwtmp/")),
    );
  }
  await server.kill();
  await request;
  return dataDir;
}

// the leftovers with what is random in a name replaced
function normalized(paths: string[]): string[] {
  return paths
    .filter((p) => p !== "bulk.bin")
    .map((p) => p.replace(/[0-9a-f]{16}\.tmp/g, "X.tmp").replace(/pb_backup_\w{6}/g, "pb_backup_X"))
    .sort();
}

for (const storage of ["local", "s3"] as const) {
  describe(`crash: backup to ${storage} storage`, () => {
    for (const point of ["temp-zip", "persisting"] as const) {
      test(
        `a kill at ${point}`,
        async () => {
          const dataDir = await crashedBackup("iglo", storage, point);
          const outcome = await verifyAfterKill(dataDir, { inspect: backupsInspect });
          // the records are the fixture's
          expect(outcome.records).toHaveLength(3);
          expect(outcome.leftovers.filter((p) => p.startsWith(".pb_temp_to_delete"))).toEqual([]);

          const refDir = await crashedBackup("upstream", storage, point);
          await verifyAfterKill(refDir, { inspect: backupsInspect });
          const mine = normalized(extras(dataDir));
          const theirs = normalized(extras(refDir));
          for (const p of mine) {
            expect(theirs).toContain(p);
          }
          if (mine.length > 0) {
            console.warn(`leftovers after a kill at ${point} (${storage}):`, { mine, theirs });
          }
          // what a half-made backup left must not be taken for a backup
          const kept = readFileSync(join(dataDir, "data.db")).length;
          expect(kept).toBeGreaterThan(0);
        },
        timeout,
      );
    }
  });
}
