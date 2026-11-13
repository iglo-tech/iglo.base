// The backup that an apply makes before its transaction, and its retention
// (D40, S.3). Not an upstream file: the backup is upstream's
// (src/backups/create.ts), written to the configured backup storage under a
// name of its own.
//
// The name is pre-schema-<UTC time with milliseconds>.zip, for example
// pre-schema-20261113T172429.123Z.zip. Two applies in the same second get
// different names. If a backup with the name already exists (two applies in
// the same millisecond), the time moves on by one millisecond until the name is
// free, so no backup is ever replaced. Retention keeps the three newest
// pre-schema backups, after every apply that made one (a successful one, or
// one that failed after its backup); cronMaxKeep prunes only the automatic
// backups, so it never touches these.

import { readdirSync, lstatSync, statfsSync } from "node:fs";
import { join } from "node:path";

import type { App } from "@/app/app";
import { LocalBackupsDirName, LocalTempDirName } from "@/app/filesystem";
import { createBackup } from "@/backups/create";

export const preSchemaPrefix = "pre-schema-";

// how many pre-schema backups are kept
export const preSchemaKeep = 3;

const bytesPerMiB = 1024 * 1024;

// the time as the backup name carries it: 20261113T172429.123Z (the ISO time
// without its separators, so it still sorts by time)
export function preSchemaBackupName(now: Date): string {
  return `${preSchemaPrefix}${now.toISOString().replace(/[-:]/g, "")}.zip`;
}

// the names of the pre-schema backups in the backups storage, sorted by name
// (which is the time, so the newest sorts last)
async function listPreSchema(app: App): Promise<string[]> {
  const fsys = app.filesystem.newBackupsFilesystem();
  try {
    const files = await fsys.list(preSchemaPrefix);
    return files
      .map((file) => file.key)
      .filter((key) => key.startsWith(preSchemaPrefix))
      .toSorted();
  } finally {
    fsys.close();
  }
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
// backup fails (the schema is not changed then). The name is free: a backup
// with the same name is never replaced (see the header).
export async function makePreSchemaBackup(app: App): Promise<string> {
  let name: string;
  try {
    const taken = new Set(await listPreSchema(app));
    let time = app.clock.now();
    name = preSchemaBackupName(time);
    while (taken.has(name)) {
      time = new Date(time.getTime() + 1);
      name = preSchemaBackupName(time);
    }
  } catch (err) {
    throw new Error(
      `the pre-schema backup could not be named, so the schema is not applied: ${errorText(err)}`,
      { cause: err },
    );
  }
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

// Keeps the newest preSchemaKeep pre-schema backups and deletes the others. It
// runs after every apply that made a backup, so at most preSchemaKeep exist
// once the apply returns. A failure is logged: the apply's own result stands.
export async function prunePreSchemaBackups(app: App): Promise<void> {
  try {
    const keys = await listPreSchema(app);
    const fsys = app.filesystem.newBackupsFilesystem();
    try {
      for (const key of keys.toReversed().slice(preSchemaKeep)) {
        try {
          await fsys.delete(key);
        } catch (err) {
          app.logger.error("[schema] failed to remove an old pre-schema backup", {
            key,
            error: err,
          });
        }
      }
    } finally {
      fsys.close();
    }
  } catch (err) {
    app.logger.error("[schema] failed to prune the pre-schema backups", { error: err });
  }
}
