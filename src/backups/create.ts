// Upstream: core/backup_create.go, generateBackupName of core/backup.go
//
// The zip work runs in the backup worker, and this side decides what goes
// in: the walk over pb_data, and the checks against the excluded list,
// are on the main thread, so a file delete or create (synchronous here, D8)
// is seen before the walk reaches that file, without any race between
// threads.
//
// A file that is deleted during a backup is kept with a hard link in the
// temp directory, so the delete takes no longer than a stat and a link; the
// link is zipped at the end. Upstream copies the file into the zip before
// the delete goes on and stops listening once data.db is copied (step 3), so
// a delete during step 6 fails its backup. Here the listening goes on until
// the walk ends, and a file the walk has passed is left alone. Its
// `.attrs` sidecar is kept with it, and a new file's sidecar is excluded with
// it. Blob temporary files are never zipped.
//
// The OnBackupCreate hook is not ported (D5). A local backup with S3 enabled
// fails before anything is written (newBackupsFilesystem, until M5.4).

import { copyFileSync, linkSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { StoreKeyActiveBackup } from "@/apis/health";
import type { App } from "@/app/app";
import { LocalBackupsDirName, LocalStorageDirName } from "@/app/filesystem";
import {
  LocalAutocertCacheDirName,
  LocalNotifyDirName,
  LocalTempDirName,
  lostFoundDirName,
} from "@/app/filesystem";
import { BackupWorker } from "@/backups/worker-client";
import { auxDBFilename, dataDBFilename } from "@/db/base";
import { NewFileFromPath } from "@/tools/filesystem/file";
import type { FilesystemWatcher } from "@/tools/filesystem/filesystem";
import { snakecase } from "@/tools/inflector/inflector";
import { pseudorandomString } from "@/tools/security/random";

export const ErrBackupActive =
  "try again later - another backup/restore operation has already been started";

// a blob being written (fileblob's createTemp): "<path>.<UnixNano hex>.tmp"
const blobTempFile = /\.[0-9a-f]{16}\.tmp$/;

// generateBackupName generates a new backup name based on the app name and
// current date. Snakecase leaves ASCII only, so the cut splits no character.
export function generateBackupName(app: App, prefix: string): string {
  const appName = snakecase(app.settings.Meta.AppName).slice(0, 50);

  // the UTC time as "20060102150405"
  const time = app.clock
    .now()
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/\D/g, "");

  return `${prefix}${appName}_${time}.zip`;
}

// the order of two walk positions: by path segment, as the walk goes
function comparePaths(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as string;
    const y = b[i] as string;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return a.length - b.length;
}

// What goes in the zip: the excluded list, the files kept from a delete, and
// the walk's position.
class BackupTracker implements FilesystemWatcher {
  readonly #app: App;
  readonly #logPrefix: string;
  readonly #heldDir: string;
  // normalizePathExclude'd entries; a path is excluded with all below it
  readonly #excluded = new Set<string>();
  // zip path -> its hard link in heldDir
  readonly held = new Map<string, string>();
  #position: string[] = [];
  #nextHeld = 0;
  #trackNewFiles = false;

  constructor(app: App, logPrefix: string, heldDir: string, exclude: string[]) {
    this.#app = app;
    this.#logPrefix = logPrefix;
    this.#heldDir = heldDir;
    for (const name of exclude) {
      this.exclude(name);
    }
  }

  exclude(zipPath: string): void {
    this.#excluded.add(zipPath);
  }

  // strings.HasPrefix over the normalizePathExclude'd list: the path
  // itself or one of its parent directories is listed
  isExcluded(zipPath: string): boolean {
    let path = zipPath;
    for (;;) {
      if (this.#excluded.has(path)) {
        return true;
      }
      const i = path.lastIndexOf("/");
      if (i === -1) {
        return false;
      }
      path = path.slice(0, i);
    }
  }

  // step 4
  trackNewFiles(): void {
    this.#trackNewFiles = true;
  }

  setPosition(zipPath: string): void {
    this.#position = zipPath.split("/");
  }

  // mark for exclude even if the writer eventually fails
  // (all record files have random name so collisions are unlikely)
  onNewWriter(fileKey: string): void {
    if (this.#trackNewFiles) {
      const zipPath = `${LocalStorageDirName}/${fileKey}`;
      this.exclude(zipPath);
      this.exclude(`${zipPath}.attrs`);
    }
  }

  // keep before delete
  onDelete(fileKey: string): void {
    const zipPath = `${LocalStorageDirName}/${fileKey}`;
    this.#hold(zipPath);
    this.#hold(`${zipPath}.attrs`);
  }

  #hold(zipPath: string): void {
    if (this.isExcluded(zipPath) || comparePaths(zipPath.split("/"), this.#position) < 0) {
      return; // not to be zipped, or already in the zip
    }

    const localPath = join(this.#app.dataDir, zipPath);
    const heldPath = join(this.#heldDir, String(this.#nextHeld++));
    try {
      // it is ok to ignore directories
      if (!lstatSync(localPath).isFile()) {
        return;
      }
      try {
        linkSync(localPath, heldPath);
      } catch {
        // pb_data/storage on a mount of its own
        copyFileSync(localPath, heldPath);
      }
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") {
        this.#app.logger.warn(
          `${this.#logPrefix}failed to keep file for the backup zip before delete: ${zipPath}`,
          err,
        );
      }
      return;
    }

    // mark that it was already taken care of
    this.exclude(zipPath);
    this.held.set(zipPath, heldPath);
  }
}

// whether a file went away between the walk's listing and its read
function isNotExist(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "ENOENT";
}

// CreateBackup creates a new backup of the current app pb_data directory.
//
// If name is empty, it will be autogenerated.
// If backup with the same name exists, the new backup file will replace it.
//
// To safely perform the backup, it is recommended to have free disk space
// for at least 2x the size of the pb_data directory.
//
// By default backups are stored in pb_data/backups
// (the backups directory itself is excluded from the generated backup).
//
// When using S3 storage for the uploaded collection files, you have to
// take care manually to backup those since they are not part of the pb_data.
//
// DB write locks are minimal and isolated only for the duration of the
// VACUUM INTO statement that creates a live copy of the app database.
//
// The backup works as follow:
//
//  1. Start listening for DELETED storage files.
//
//  2. Copy the main database with VACUUM INTO, write it in the zip and mark it as "excluded".
//
//  3. (Keep listening, see the top of this file.)
//
//  4. Start listening for NEW storage files and mark all new files from this point as "excluded".
//
//  5. Copy the logs database with VACUUM INTO, write it in the zip and mark it as "excluded".
//
//  6. Copy the rest of the pb_data files in the zip while ignoring the "excluded" list.
//
//  7. Stop listening.
export async function createBackup(app: App, name = ""): Promise<void> {
  if (app.store.has(StoreKeyActiveBackup)) {
    throw new Error(ErrBackupActive);
  }

  app.store.set(StoreKeyActiveBackup, name);

  try {
    const fsys = app.filesystem.newBackupsFilesystem();
    try {
      const backupName = name === "" ? generateBackupName(app, "pb_backup_") : name;

      // create backup zip
      // (it needs to be inside the current pb_data to avoid "cross-device link" errors)
      // -----------------------------------------------------------
      const tempZipPath = join(app.dataDir, LocalTempDirName, `pb_backup_${pseudorandomString(6)}`);

      try {
        await createZip(app, backupName, tempZipPath);

        // persist the backup in the backups filesystem
        // -----------------------------------------------------------
        const file = await NewFileFromPath(tempZipPath);
        file.originalName = backupName;
        file.name = backupName;

        for (const _ of fsys.uploadFileSteps(file, file.name)) {
          // give the event loop back between blocks
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } finally {
        await rm(tempZipPath, { force: true });
      }
    } finally {
      fsys.close();
    }
  } finally {
    app.store.remove(StoreKeyActiveBackup);
  }
}

async function createZip(app: App, name: string, tempZipPath: string): Promise<void> {
  const logPrefix = `[${name}] `;

  // make sure that the special temp directory exists
  const localTempDir = join(app.dataDir, LocalTempDirName);
  const heldDir = `${tempZipPath}_held`;
  mkdirSync(heldDir, { recursive: true, mode: 0o777 });

  const worker = new BackupWorker();

  const tracker = new BackupTracker(app, logPrefix, heldDir, [
    LocalBackupsDirName,
    LocalTempDirName,
    LocalNotifyDirName,
    LocalAutocertCacheDirName,
    lostFoundDirName,
  ]);

  try {
    await worker.call({ op: "zipOpen", path: tempZipPath });

    // init deleted files tracker
    // ---------------------------------------------------------------
    app.filesystem.watch(tracker);

    const copyDB = async (filename: string): Promise<void> => {
      const tempDBPath = join(localTempDir, filename);
      try {
        await worker.call({
          op: "vacuum",
          src: join(app.dataDir, filename),
          dest: tempDBPath,
        });
        await worker.call({ op: "zipAdd", localPath: tempDBPath, zipPath: filename });
      } finally {
        await rm(tempDBPath, { force: true });
      }

      tracker.exclude(filename);
      tracker.exclude(`${filename}-wal`);
      tracker.exclude(`${filename}-shm`);
    };

    // copy data.db
    // ---------------------------------------------------------------
    await copyDB(dataDBFilename);

    // init to-be-created files tracker
    // ---------------------------------------------------------------
    tracker.trackNewFiles();

    // copy auxiliary.db
    // ---------------------------------------------------------------
    await copyDB(auxDBFilename);

    // try to run manual checkpoints to ensure that all wal writes during the
    // previous VACUUM INTO are transferred and don't accumulate
    // ---------------------------------------------------------------
    await worker.call({ op: "checkpoint", path: join(app.dataDir, dataDBFilename) });
    await worker.call({ op: "checkpoint", path: join(app.dataDir, auxDBFilename) });

    // copy the rest of the pb_data
    // ---------------------------------------------------------------
    await copyDirToZip(app, worker, tracker, "");

    // the files deleted along the way
    for (const [zipPath, heldPath] of tracker.held) {
      await worker.call({ op: "zipAdd", localPath: heldPath, zipPath });
    }

    await worker.call({ op: "zipClose" });
  } catch (err) {
    // the worker's file handle outlives the worker
    await worker.call({ op: "zipAbort" }).catch(() => {});
    throw err;
  } finally {
    app.filesystem.watch(null);
    worker.close();
    await rm(heldDir, { recursive: true, force: true });
  }
}

// fs.WalkDir's order: by name, depth first. A directory or file that
// went away is skipped; it is no reason to fail the backup.
async function copyDirToZip(
  app: App,
  worker: BackupWorker,
  tracker: BackupTracker,
  dir: string,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(join(app.dataDir, dir), { withFileTypes: true });
  } catch (err) {
    if (isNotExist(err)) {
      return;
    }
    throw err;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    const name = dir === "" ? entry.name : `${dir}/${entry.name}`;

    // skip excluded prefixes (refetched for each entry: a new file adds to them)
    if (tracker.isExcluded(name)) {
      continue;
    }

    if (entry.isDirectory()) {
      await copyDirToZip(app, worker, tracker, name);
      continue;
    }

    if (name.startsWith(`${LocalStorageDirName}/`) && blobTempFile.test(name)) {
      continue;
    }

    tracker.setPosition(name);

    try {
      await worker.call({ op: "zipAdd", localPath: join(app.dataDir, name), zipPath: name });
    } catch (err) {
      if (isNotExist(err)) {
        continue; // the held link has it, if it was a tracked delete
      }
      throw err;
    }

    // deleted while the worker read it: the zip has it already
    const heldPath = tracker.held.get(name);
    if (heldPath !== undefined) {
      tracker.held.delete(name);
      rmSync(heldPath, { force: true });
    }
  }
}
