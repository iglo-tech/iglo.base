// Upstream: none. The step record of a restore (src/backups/restore.ts).
//
// Upstream moves the old pb_data content aside, moves the extracted content in
// and restarts. A process killed between two of those renames leaves a pb_data
// that is partly the old and partly the new data (or none), and the next
// start opens it and deletes the old content with the temp directory. Here the
// restore records its step in a marker file inside the temp directory, and the
// next bootstrap puts the old content back if the restore did not get to its
// end. The result of a kill is then the old data or the restored data, never
// a mix and never an empty pb_data.
//
// The step is the NAME of the marker, `restore_phase.<phase>`, so that a step
// changes with one rename: atomic, needs no free space and has no moment where
// the record is empty or half written.
//
//   moving-old  the old content is moving aside (pb_data: a subset of the old
//               content, the old dir: the rest)
//   moving-new  the old content is all in the old dir; pb_data holds none, a
//               part or all of the extracted content (the rest is in the
//               extracted dir)
//   swapped     both moves are done, pb_data is the restored data
//   reverted    pb_data is the old data again
//
// swapped and reverted are final: the old dir is no longer the only copy and
// may be deleted. The old dir is never deleted in any other step.
//
// A rollback is two re-runnable steps: moving-new moves what is in pb_data to
// the extracted dir and then becomes moving-old; moving-old moves the old dir
// content back and then becomes reverted. A rollback killed at any point, and
// run again any number of times, converges on the old data.

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import {
  LocalAutocertCacheDirName,
  LocalBackupsDirName,
  LocalTempDirName,
  lostFoundDirName,
} from "@/app/filesystem";
import { moveDirContent } from "@/tools/osutils/dir";

export type RestorePhase = "moving-old" | "moving-new" | "swapped" | "reverted";

const phases: readonly string[] = ["moving-old", "moving-new", "swapped", "reverted"];

// default root dir entries to exclude from the backup restore
export const restoreExclude = [
  LocalBackupsDirName,
  LocalTempDirName,
  LocalAutocertCacheDirName,
  lostFoundDirName,
];

export const restorePhaseFile = "restore_phase";
export const oldDirPrefix = "old_pb_data_";
export const extractedDirPrefix = "pb_restore_";

function markerPath(tempDir: string, phase: RestorePhase): string {
  return join(tempDir, `${restorePhaseFile}.${phase}`);
}

function syncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Throws when an earlier restore left its record open (a rollback that failed
// at a step): the record and the old dir may hold the only copy of the old
// data, and a new restore would delete the record. Nothing is changed.
export function assertNoOpenRestore(tempDir: string): void {
  const { phase, unknown } = readPhase(tempDir);
  if (isFinal(phase) || (phase === undefined && unknown.length === 0)) {
    return;
  }
  const record = phase === undefined ? unknown.join(", ") : `${restorePhaseFile}.${phase}`;
  throw new Error(
    `an earlier restore did not finish (${record} in ${tempDir}); its old data may be ` +
      `the only copy, so no new restore is started. Restart the app to roll it back`,
  );
}

// Creates the record, before the first move; pb_data is untouched.
export function startRestorePhase(tempDir: string): void {
  for (const name of readdirSync(tempDir)) {
    if (name === restorePhaseFile || name.startsWith(restorePhaseFile + ".")) {
      rmSync(join(tempDir, name), { force: true });
    }
  }
  const fd = openSync(markerPath(tempDir, "moving-old"), "w");
  try {
    writeSync(fd, "");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDir(tempDir);
}

// One atomic rename. The disk state of the step is durable first.
export function setRestorePhase(
  tempDir: string,
  dataDir: string,
  from: RestorePhase,
  to: RestorePhase,
): void {
  syncDir(dataDir);
  syncDir(tempDir);
  renameSync(markerPath(tempDir, from), markerPath(tempDir, to));
  syncDir(tempDir);
}

interface PhaseRecord {
  // undefined: no marker, or one this code does not know
  phase: RestorePhase | undefined;
  unknown: string[];
}

function readPhase(tempDir: string): PhaseRecord {
  const found: RestorePhase[] = [];
  const unknown: string[] = [];
  for (const name of readdirSync(tempDir)) {
    if (name === restorePhaseFile) {
      // a plain file: not what this code writes
      unknown.push(name);
    } else if (name.startsWith(restorePhaseFile + ".")) {
      const value = name.slice(restorePhaseFile.length + 1);
      if (phases.includes(value)) {
        found.push(value as RestorePhase);
      } else {
        unknown.push(name);
      }
    }
  }
  if (found.length === 1 && unknown.length === 0) {
    return { phase: found[0], unknown };
  }
  return {
    phase: undefined,
    unknown: [...unknown, ...found.map((p) => `${restorePhaseFile}.${p}`)],
  };
}

function isFinal(phase: RestorePhase | undefined): boolean {
  return phase === "swapped" || phase === "reverted";
}

function nonEmpty(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function oldDirs(tempDir: string): string[] {
  return readdirSync(tempDir)
    .filter((n) => n.startsWith(oldDirPrefix))
    .map((n) => join(tempDir, n));
}

// Puts the old content back, from the step the marker names. Safe to run again
// after an interruption or an error at any point.
export function rollbackRestore(dataDir: string, tempDir: string): void {
  const { phase } = readPhase(tempDir);
  if (phase === undefined || isFinal(phase)) {
    return;
  }
  const dirs = oldDirs(tempDir);
  if (dirs.length > 1) {
    throw new Error(`more than one old data directory in ${tempDir}`);
  }
  const oldDir = dirs[0];
  if (oldDir === undefined) {
    if (phase === "moving-new") {
      throw new Error(`the old data directory is missing from ${tempDir}`);
    }
    // moving-old: nothing moved aside
    setRestorePhase(tempDir, dataDir, "moving-old", "reverted");
    return;
  }
  const suffix = oldDir.slice(join(tempDir, oldDirPrefix).length);
  const extractedDir = join(tempDir, extractedDirPrefix + suffix);

  if (phase === "moving-new") {
    // what moved in goes back to the extracted dir
    moveDirContent(dataDir, extractedDir, ...restoreExclude);
    setRestorePhase(tempDir, dataDir, "moving-new", "moving-old");
  }
  moveDirContent(oldDir, dataDir, ...restoreExclude);
  setRestorePhase(tempDir, dataDir, "moving-old", "reverted");
}

// Runs on the closed data dir, before the databases open: puts the old
// content back when a restore was interrupted before it was done.
export function recoverInterruptedRestore(dataDir: string): void {
  const tempDir = join(dataDir, LocalTempDirName);
  if (!existsSync(tempDir)) {
    return;
  }
  const { phase, unknown } = readPhase(tempDir);
  const holding = oldDirs(tempDir).filter(nonEmpty);

  if (phase === undefined) {
    // no record at all: not a restore of ours (each writes its record before
    // the first move) but upstream's, which writes none and is done once its
    // moves are; start as upstream does, on the restored data. A record that
    // exists but cannot be read is ours: the old data may be the only copy,
    // so neither open the pb_data that is there nor delete this
    if (holding.length > 0 && unknown.length > 0) {
      throw new Error(
        `a restore left the old data in ${holding.join(", ")} but its step record ` +
          `(${unknown.join(", ")}) is not readable` +
          `; not starting. Move its content back to ${dataDir} (or delete ` +
          `${tempDir} if ${dataDir} is the data to keep) and start again`,
      );
    }
    return;
  }

  try {
    rollbackRestore(dataDir, tempDir);
  } catch (err) {
    // a pb_data that is neither the old nor the new one must not be opened
    throw new Error(
      `failed to roll back the interrupted restore (the old data is in ${
        holding.length > 0 ? holding.join(", ") : tempDir
      } and in ${dataDir}): ` + (err instanceof Error ? err.message : String(err)),
      { cause: err },
    );
  }
}

// Removes the old dir and the record, when the old dir is no longer the only
// copy (the record is final), or when there is nothing in it. The record goes
// last, so that a kill in the middle leaves a final record. Returns false when
// something that may hold the only copy was kept.
export function removeRestoreTemp(tempDir: string): boolean {
  if (!existsSync(tempDir)) {
    return true;
  }
  const { phase, unknown } = readPhase(tempDir);
  const dirs = oldDirs(tempDir);
  // no record at all is upstream's finished restore, whose temp dir it clears
  const upstreams = phase === undefined && unknown.length === 0;
  if (!isFinal(phase) && !upstreams && dirs.some(nonEmpty)) {
    return false;
  }
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const name of readdirSync(tempDir)) {
    if (name === restorePhaseFile || name.startsWith(restorePhaseFile + ".")) {
      rmSync(join(tempDir, name), { force: true });
    }
  }
  return true;
}
