// Upstream: core/backup_restore.go
//
// The extract runs in the backup worker. The two moves are synchronous on
// the main thread, where a write transaction never spans an event loop turn,
// so upstream's wrapping transactions (they only keep other writes out) have
// no counterpart.
//
// Beyond upstream: a data.db or auxiliary.db the app cannot open is refused
// before anything moves, with the check bootstrap runs (upstream restarts on
// it and does not come back). The revert runs when the restart reports its
// failure, on closed databases; the app re-bootstraps afterwards on the
// reverted data, where upstream bootstraps first (app.restart, src/cli/serve.ts).
//
// With backups in S3 the zip is downloaded to a temp file in pb_data first,
// and upstream's 10 minute limit covers that read. The moves below touch no
// network.
//
// The OnBackupRestore hook is not ported (D5).

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { StoreKeyActiveBackup } from "@/apis/health";
import type { App } from "@/app/app";
import { LocalBackupsDirName, LocalTempDirName } from "@/app/filesystem";
import { ErrBackupActive } from "@/backups/create";
import {
  assertNoOpenRestore,
  removeRestoreTemp,
  restoreExclude,
  rollbackRestore,
  setRestorePhase,
  startRestorePhase,
} from "@/backups/restore-phase";
import { BackupWorker } from "@/backups/worker-client";
import { auxDBFilename, dataDBFilename } from "@/db/base";
import { goQuote } from "@/fields/field";
import { checkExistingDataDir } from "@/migrations/system-migrations";
import { goBase } from "@/tools/filesystem/file";
import type { System } from "@/tools/filesystem/filesystem";
import { moveDirContent } from "@/tools/osutils/dir";
import { S3System } from "@/tools/filesystem/s3-system";
import { pseudorandomString } from "@/tools/security/random";

// wait max 10 minutes to fetch the backup
const fetchBackupTimeoutMs = 10 * 60 * 1000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Whether the new image will be able to start on the extracted directory.
function checkExtractedData(dir: string): void {
  // ensure that at least a database file exists
  try {
    statSync(join(dir, dataDBFilename));
    checkExistingDataDir(dir);

    const auxPath = join(dir, auxDBFilename);
    if (existsSync(auxPath)) {
      const conn = new Database(auxPath, { readonly: true });
      try {
        conn.query("SELECT count(*) FROM sqlite_schema").get();
      } finally {
        conn.close();
      }
    }
  } catch (err) {
    throw new Error(`data.db file is missing or invalid: ${errorText(err)}`, { cause: err });
  }
}

// RestoreBackup restores the backup with the specified name and restarts
// the current running application process.
//
// To safely perform the restore it is recommended to have free disk space
// for at least 2x the size of the restored pb_data backup.
//
// The performed steps are:
//
//  1. Extract the backup in a temp directory inside the app "pb_data"
//     (eg. "pb_data/.pb_temp_to_delete/pb_restore").
//
//  2. Move the current app "pb_data" content (excluding the local backups and the special temp dir)
//     under another temp sub dir that will be deleted on the next app start up
//     (eg. "pb_data/.pb_temp_to_delete/old_pb_data").
//     This is because on some environments it may not be allowed
//     to delete the currently open "pb_data" files.
//
//  3. Move the extracted dir content to the app "pb_data".
//
//  4. Restart the app (on successful app bootstrap it will also remove the old pb_data).
//
// If a failure occur during the restore process the dir changes are reverted.
// If for whatever reason the revert is not possible, the error goes to the
// caller of the restart, which fails the restore; the interrupted restore is
// rolled back (or the start refused) at the next start, so pb_data is never
// served half-reverted. A shutdown during the restart window does not revert.
export async function restoreBackup(app: App, name: string): Promise<void> {
  if (app.store.has(StoreKeyActiveBackup)) {
    throw new Error(ErrBackupActive);
  }

  app.store.set(StoreKeyActiveBackup, name);

  try {
    // the log writer holds no batch and no connection to files that are
    // replaced (D31); after a restart it belongs to the closed app and
    // resume does nothing
    await app.logger.suspend();
    try {
      await restoreLocked(app, name);
    } finally {
      app.logger.resume();
    }
  } finally {
    app.store.remove(StoreKeyActiveBackup);
  }
}

async function restoreLocked(app: App, name: string): Promise<void> {
  // make sure that the special temp directory exists
  // note: it needs to be inside the current pb_data to avoid "cross-device link" errors
  const localTempDir = join(app.dataDir, LocalTempDirName);
  const fsys = app.filesystem.newBackupsFilesystem(AbortSignal.timeout(fetchBackupTimeoutMs));

  try {
    let exists: boolean;
    try {
      exists = await fsys.exists(name);
    } catch {
      exists = false;
    }
    if (!exists) {
      throw new Error(`missing or invalid backup file ${goQuote(name)} to restore`);
    }

    mkdirSync(localTempDir, { recursive: true, mode: 0o777 });
    assertNoOpenRestore(localTempDir);

    await extractAndReplace(app, fsys, name, localTempDir);
  } finally {
    fsys.close();
  }
}

// a temp file for the zip of a backup stored in S3
function tempZipPath(localTempDir: string): string {
  return join(localTempDir, `pb_restore_zip${pseudorandomString(10)}`);
}

async function extractBackup(
  fsys: System | S3System,
  localZip: string,
  name: string,
  dest: string,
  tempZip: string,
): Promise<void> {
  let src = localZip;
  if (fsys instanceof S3System) {
    await fsys.download(name, tempZip);
    src = tempZip;
  }

  const worker = new BackupWorker();
  try {
    await worker.call({ op: "extract", src, dest });
  } finally {
    worker.close();
  }
}

async function extractAndReplace(
  app: App,
  fsys: System | S3System,
  name: string,
  localTempDir: string,
): Promise<void> {
  // the two share their suffix, for the roll back of an interrupted restore
  const suffix = pseudorandomString(8);
  const extractedDataDir = join(localTempDir, `pb_restore_${suffix}`);
  const oldTempDataDir = join(localTempDir, `old_pb_data_${suffix}`);
  const tempZip = tempZipPath(localTempDir);
  // pb_data may be neither the old nor the restored content (a step is open)
  let unsafe = false;

  try {
    // extract the zip
    await extractBackup(
      fsys,
      join(app.dataDir, LocalBackupsDirName, goBase(name)),
      name,
      extractedDataDir,
      tempZip,
    );

    // the zip is no longer needed (the app may restart below)
    try {
      await rm(tempZip, { force: true });
    } catch (err) {
      app.logger.warn("[RestoreBackup] Failed to remove the temp zip backup file", {
        file: tempZip,
        error: err,
      });
    }

    checkExtractedData(extractedDataDir);

    // From here pb_data may not hold the old content until a step ends it.
    // Nothing below removes the old dir while unsafe: it may be the only copy.
    startRestorePhase(localTempDir);
    unsafe = true;

    // move the current pb_data content to a special temp location
    // that will hold the old data between dirs replace
    // (the temp dir will be automatically removed on the next app start)
    try {
      try {
        moveDirContent(app.dataDir, oldTempDataDir, ...restoreExclude);
      } catch (err) {
        throw new Error(
          `failed to move the current pb_data content to a temp location: ${errorText(err)}`,
          { cause: err },
        );
      }
      setRestorePhase(localTempDir, app.dataDir, "moving-old", "moving-new");

      // move the extracted archive content to the app's pb_data
      try {
        moveDirContent(extractedDataDir, app.dataDir, ...restoreExclude);
      } catch (err) {
        throw new Error(
          `failed to move the extracted archive content to pb_data: ${errorText(err)}`,
          { cause: err },
        );
      }
      setRestorePhase(localTempDir, app.dataDir, "moving-new", "swapped");
    } catch (err) {
      // upstream's transaction fails here and the first move stays; a restore
      // that fails (a failed move or a failed record) must leave pb_data as it was
      try {
        rollbackRestore(app.dataDir, localTempDir);
        unsafe = false;
      } catch (rollbackErr) {
        throw new Error(
          `${errorText(err)}; and failed to put the old data back (it is in ${oldTempDataDir}): ` +
            errorText(rollbackErr),
          { cause: rollbackErr },
        );
      }
      throw err;
    }
    unsafe = false;

    const revertDataDirChanges = (): void => {
      // a kill in the middle of the revert is rolled back at the next start
      unsafe = true;
      try {
        setRestorePhase(localTempDir, app.dataDir, "swapped", "moving-new");
        rollbackRestore(app.dataDir, localTempDir);
      } catch (err) {
        throw new Error(`failed to revert the data dir changes: ${errorText(err)}`, {
          cause: err,
        });
      }
      unsafe = false;
    };

    // restart the app
    try {
      await app.restart(revertDataDirChanges);
    } catch (err) {
      throw new Error(`failed to restart the app process: ${errorText(err)}`, { cause: err });
    }
  } finally {
    await rm(tempZip, { force: true });
    if (!unsafe) {
      // the restore is over, done or reverted: the old dir is no longer the
      // only copy and goes with the record, which goes last
      await rm(extractedDataDir, { recursive: true, force: true });
      removeRestoreTemp(localTempDir);
    }
  }
}
