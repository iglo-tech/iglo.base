// The backup that an apply makes before its transaction, and its retention
// (D40, S.3). Not an upstream file: the backup is upstream's
// (src/backups/create.ts), written to the configured backup storage under a
// name of its own.
//
// The name is pre-schema-<UTC time>.zip. Retention keeps the three newest
// pre-schema backups, after a successful apply; cronMaxKeep prunes only the
// automatic backups, so it never touches these.

import { readdirSync, lstatSync, statfsSync } from "node:fs";
import { join } from "node:path";

import type { App } from "@/app/app";
import { LocalBackupsDirName, LocalTempDirName } from "@/app/filesystem";
import { createBackup } from "@/backups/create";

export const preSchemaPrefix = "pre-schema-";

// how many pre-schema backups are kept
export const preSchemaKeep = 3;

const bytesPerMiB = 1024 * 1024;

// the time as the backup name carries it: 20261112T101500Z
export function preSchemaBackupName(now: Date): string {
  const time = now
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/[-:]/g, "");
  return `${preSchemaPrefix}${time}.zip`;
}

// the bytes of pb_data that a backup holds (the backups and temp directories
// are not in it); a walk, so it runs only on the failure path
function dataSize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === LocalBackupsDirName || entry.name === LocalTempDirName) {
      continue;
    }
    const path = join(dir, entry.name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      total += dataSize(path);
    } else if (stat.isFile()) {
      total += stat.size;
    }
  }
  return total;
}

function isNoSpace(err: unknown): boolean {
  const text =
    err instanceof Error ? `${err.message} ${(err as { code?: string }).code ?? ""}` : String(err);
  return /ENOSPC|no space left/i.test(text);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The disk-space failure says how much room the backup needs, the size of the
// data it copies, and how much is free.
function noSpaceMessage(app: App): string {
  let needed = "";
  try {
    needed = `${(dataSize(app.dataDir) / bytesPerMiB).toFixed(1)} MiB`;
  } catch {
    needed = "about the size of the data directory";
  }
  let free = "";
  try {
    const stat = statfsSync(app.dataDir);
    free = `, ${((Number(stat.bavail) * Number(stat.bsize)) / bytesPerMiB).toFixed(1)} MiB free`;
  } catch {
    // no free-space figure
  }
  return (
    `not enough disk space for the pre-schema backup: it needs ${needed} ` +
    `(the size of the data directory${free}). Free that space or set a backup storage with room, then start again`
  );
}

// Makes the pre-schema backup. It throws, and the apply stops, when the
// backup fails (the schema is not changed then).
export async function makePreSchemaBackup(app: App): Promise<string> {
  const name = preSchemaBackupName(app.clock.now());
  try {
    await createBackup(app, name);
  } catch (err) {
    if (isNoSpace(err)) {
      throw new Error(noSpaceMessage(app), { cause: err });
    }
    throw new Error(
      `the pre-schema backup ${name} failed, so the schema is not applied: ${errorText(err)}`,
      { cause: err },
    );
  }
  return name;
}

// Keeps the newest preSchemaKeep pre-schema backups and deletes the others. A
// failure is logged: the apply itself has succeeded.
export async function prunePreSchemaBackups(app: App): Promise<void> {
  let fsys;
  try {
    fsys = app.filesystem.newBackupsFilesystem();
  } catch (err) {
    app.logger.error("[schema] failed to initialize the backup filesystem", { error: err });
    return;
  }
  try {
    const files = await fsys.list(preSchemaPrefix);
    // the names carry their UTC time, so the newest sorts last
    const keys = files
      .map((file) => file.key)
      .filter((key) => key.startsWith(preSchemaPrefix))
      .toSorted((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    for (const key of keys.slice(preSchemaKeep)) {
      try {
        await fsys.delete(key);
      } catch (err) {
        app.logger.error("[schema] failed to remove an old pre-schema backup", {
          key,
          error: err,
        });
      }
    }
  } catch (err) {
    app.logger.error("[schema] failed to list the pre-schema backups", { error: err });
  } finally {
    fsys.close();
  }
}
