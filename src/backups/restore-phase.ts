// Upstream: none. The step record of a restore (src/backups/restore.ts).
//
// Upstream moves the old pb_data content aside, moves the extracted content in
// and restarts. A process killed between two of those renames leaves a pb_data
// that is partly the old and partly the new data (or none), and the next
// start opens it and deletes the old content with the temp directory. Here the
// restore records its step in `restore_phase` inside the temp directory, which
// the app clears at every start anyway, and the next bootstrap puts the old
// content back if the restore did not get to its end. The result of a kill is
// then the old data or the restored data, never a mix.
//
//   moving-old  written before the old content moves aside
//   moving-new  written before the extracted content moves in
//   swapped     written after both moves

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  LocalAutocertCacheDirName,
  LocalBackupsDirName,
  LocalTempDirName,
  lostFoundDirName,
} from "@/app/filesystem";
import { moveDirContent } from "@/tools/osutils/dir";

export type RestorePhase = "moving-old" | "moving-new" | "swapped";

// default root dir entries to exclude from the backup restore
export const restoreExclude = [
  LocalBackupsDirName,
  LocalTempDirName,
  LocalAutocertCacheDirName,
  lostFoundDirName,
];

const phaseFile = "restore_phase";
const oldDirPrefix = "old_pb_data_";
const extractedDirPrefix = "pb_restore_";

export function writeRestorePhase(tempDir: string, phase: RestorePhase): void {
  writeFileSync(join(tempDir, phaseFile), phase);
}

// Runs on the closed data dir, before the databases open: puts the old
// content back when a restore was interrupted before it was done.
export function recoverInterruptedRestore(dataDir: string): void {
  const tempDir = join(dataDir, LocalTempDirName);
  let phase: string;
  try {
    phase = readFileSync(join(tempDir, phaseFile), "utf8");
  } catch {
    return;
  }
  if (phase !== "moving-old" && phase !== "moving-new") {
    return;
  }

  // the old and the extracted directory of a restore share their suffix
  for (const name of readdirSync(tempDir)) {
    if (!name.startsWith(oldDirPrefix)) {
      continue;
    }
    const oldDir = join(tempDir, name);
    const extractedDir = join(tempDir, extractedDirPrefix + name.slice(oldDirPrefix.length));
    try {
      if (phase === "moving-new" && existsSync(oldDir)) {
        // what moved in goes back to the extracted dir
        moveDirContent(dataDir, extractedDir, ...restoreExclude);
      }
      moveDirContent(oldDir, dataDir, ...restoreExclude);
    } catch (err) {
      // a pb_data that is neither the old nor the new one must not be opened
      throw new Error(
        `failed to roll back the interrupted restore (the old data is in ${oldDir}): ` +
          (err instanceof Error ? err.message : String(err)),
        { cause: err },
      );
    }
  }
}
