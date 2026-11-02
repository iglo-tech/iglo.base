// Crash and restart (M5.9): SIGKILL during a restore. After the kill the
// server must come back with the old data or the restored data, never a mix.
// The real kills land where the test can see the restore's directories; the
// moves between them are microseconds wide, so every state a kill between two
// renames can leave is also built by hand from the zip and compared on both
// servers. Not part of `bun test`: run `bun run test:reference`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  api,
  asSuperuser,
  checkDatabases,
  freshDataDir,
  launch,
  listRecords,
  patchSettings,
  s3Settings,
  verifyAfterKill,
  waitFor,
  walk,
  type Kind,
  type Outcome,
} from "@test/differential/crash/harness";
import { tempDir } from "@test/support/executable";
import { startVersitygw, type Versitygw } from "@test/support/versitygw";

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

let counter = 0;
// the S3 bucket is shared by the runs of a file: a name of its own for each
let backupName = "restore_base.zip";
const marker = "after-backup";

type Storage = "local" | "s3";
type Point = "extracting" | "downloaded" | "swapping" | "swapped";

// a server with a backup, then a record the backup does not have
async function withBackup(kind: Kind, storage: Storage) {
  const { root, dataDir } = freshDataDir();
  roots.push(root);
  backupName = `restore_base_${counter++}.zip`;
  const server = await launch(kind, dataDir);
  if (storage === "s3") {
    await patchSettings(server, { backups: { s3: s3Settings(gw) } });
  }
  const made = await api(server, "POST", "/api/backups", { name: backupName });
  expect(`${made.status} ${made.status === 204 ? "" : await made.text()}`).toBe("204 ");
  const created = await api(server, "POST", "/api/collections/demo1/records", { text: marker });
  expect(created.status).toBe(200);
  return { server, dataDir };
}

function tempEntries(dataDir: string): string[] {
  return walk(join(dataDir, ".pb_temp_to_delete"));
}

async function crashedRestore(kind: Kind, storage: Storage, point: Point): Promise<string> {
  const { server, dataDir } = await withBackup(kind, storage);
  const request = fetch(`${server.url}/api/backups/${backupName}/restore`, {
    method: "POST",
    headers: asSuperuser,
  }).catch(() => undefined);

  const seen = (): boolean => {
    const entries = tempEntries(dataDir);
    switch (point) {
      case "extracting":
        return entries.some((p) => /^pb_restore_\w+\/./.test(p));
      case "downloaded":
        return entries.some((p) => /^pb_restore_zip\w+$/.test(p));
      case "swapping":
        return entries.some((p) => /^old_pb_data_\w+$/.test(p));
      case "swapped":
        return (
          entries.some((p) => /^old_pb_data_\w+\/data\.db$/.test(p)) &&
          !entries.some((p) => /^pb_restore_\w+\/data\.db$/.test(p))
        );
    }
  };
  // a very fast restore may pass the point before a poll sees it: the state
  // is then checked as any other
  await waitFor("the restore step", () => seen(), 20_000).catch(() => undefined);
  await server.kill();
  await request;
  return dataDir;
}

// old: the record made after the backup is there; restored: it is not
function dataState(outcome: Outcome): "old" | "restored" {
  const texts = outcome.records.map((r) => r["text"]);
  const hasMarker = texts.includes(marker);
  // the fixture's three records, and the marker if old
  expect(outcome.records).toHaveLength(hasMarker ? 4 : 3);
  return hasMarker ? "old" : "restored";
}

const states: Array<[Storage, Point]> = [
  ["local", "extracting"],
  ["local", "swapping"],
  ["local", "swapped"],
  ["s3", "downloaded"],
  ["s3", "swapping"],
  ["s3", "swapped"],
];

describe("crash: restore", () => {
  for (const [storage, point] of states) {
    test(
      `a kill at ${point} (${storage}) leaves the old or the restored data`,
      async () => {
        const dataDir = await crashedRestore("iglo", storage, point);
        const outcome = await verifyAfterKill(dataDir, { skipFixtureFiles: false });
        const state = dataState(outcome);
        // an interrupted restore is not finished by the next start
        expect(["old", "restored"]).toContain(state);

        const refDir = await crashedRestore("upstream", storage, point);
        const ref = await verifyAfterKill(refDir);
        const refState = dataState(ref);
        console.warn(
          `restore killed at ${point} (${storage}): iglo ${state}, upstream ${refState}`,
        );
        // the temp directory is cleared at the start by both
        expect(outcome.leftovers.filter((p) => p.startsWith(".pb_temp_to_delete"))).toEqual([]);
      },
      timeout,
    );
  }
});

// The directories a kill between two renames of the restore leaves, built from
// the data and its backup: n of the old entries moved aside, then m of the
// extracted entries moved in. `restore_phase` in the temp directory is the
// record the restore keeps of its step (docs/design/07-files-mail-backups-jobs.md):
// before the first move "moving-old", before the second "moving-new" and
// after it "swapped".
const rootExclude = new Set(["backups", ".pb_temp_to_delete", ".autocert_cache", "lost+found"]);

async function craftedState(
  moveOld: number | "all",
  moveNew: number | "all",
  phase: "moving-old" | "moving-new" | "swapped",
): Promise<string> {
  const { server, dataDir } = await withBackup("iglo", "local");
  const zip = join(dataDir, "backups", backupName);
  // stop cleanly, so that there are no -wal files to move apart from the db
  await server.stop();

  const temp = join(dataDir, ".pb_temp_to_delete");
  const extracted = join(temp, "pb_restore_crafted1");
  mkdirSync(extracted, { recursive: true });
  const unzip = Bun.spawnSync(["unzip", "-q", zip, "-d", extracted]);
  expect(unzip.exitCode).toBe(0);
  writeFileSync(join(temp, "restore_phase"), phase);

  const oldDir = join(temp, "old_pb_data_crafted1");
  mkdirSync(oldDir);
  const oldNames = readdirSync(dataDir)
    .filter((n) => !rootExclude.has(n))
    .sort();
  const take = moveOld === "all" ? oldNames.length : moveOld;
  for (const n of oldNames.slice(0, take)) {
    renameSync(join(dataDir, n), join(oldDir, n));
  }
  const newNames = readdirSync(extracted)
    .filter((n) => !rootExclude.has(n))
    .sort();
  const takeNew = moveNew === "all" ? newNames.length : moveNew;
  for (const n of newNames.slice(0, takeNew)) {
    renameSync(join(extracted, n), join(dataDir, n));
  }
  return dataDir;
}

async function readState(kind: Kind, dataDir: string): Promise<string> {
  const server = await launch(kind, dataDir);
  try {
    const records = await listRecords(server);
    return `${records.length}:${records.some((r) => r["text"] === marker)}`;
  } finally {
    await server.stop();
  }
}

describe("crash: restore directory states", () => {
  const stages: Array<
    [string, number | "all", number | "all", "moving-old" | "moving-new" | "swapped"]
  > = [
    ["old content partly moved aside", 1, 0, "moving-old"],
    ["old content moved aside, nothing moved in yet", "all", 0, "moving-new"],
    ["extracted content partly moved in", "all", 1, "moving-new"],
    ["extracted content moved in, step not yet recorded", "all", "all", "moving-new"],
    ["extracted content moved in, restart pending", "all", "all", "swapped"],
  ];
  for (const [label, moveOld, moveNew, phase] of stages) {
    test(
      label,
      async () => {
        const dataDir = await craftedState(moveOld, moveNew, phase);
        const copyRoot = tempDir();
        roots.push(copyRoot);
        const copy = join(copyRoot, "pb_data");
        cpSync(dataDir, copy, { recursive: true });

        const igloState = await readState("iglo", dataDir);
        // never a mix: the fixture with or without the marker record
        expect(["4:true", "3:false"]).toContain(igloState);
        // what iglo.base leaves is read by upstream the same way
        const afterRoot = tempDir();
        roots.push(afterRoot);
        const after = join(afterRoot, "pb_data");
        cpSync(dataDir, after, { recursive: true });
        checkDatabases(after);
        expect(await readState("upstream", after)).toBe(igloState);

        const upstreamState = await readState("upstream", copy).catch((e) => `fails: ${e}`);
        console.warn(
          `${label}: iglo ${igloState}, upstream on the same directory ${upstreamState}`,
        );
      },
      timeout,
    );
  }
});
