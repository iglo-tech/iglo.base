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
// The OnBackupRestore hook is not ported (D5). The S3 branch comes with M5.4;
// with S3 enabled newBackupsFilesystem throws.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { StoreKeyActiveBackup } from "@/apis/health";
import type { App } from "@/app/app";
import {
  LocalAutocertCacheDirName,
  LocalBackupsDirName,
  LocalTempDirName,
  lostFoundDirName,
} from "@/app/filesystem";
import { ErrBackupActive } from "@/backups/create";
import { BackupWorker } from "@/backups/worker-client";
import { auxDBFilename, dataDBFilename } from "@/db/base";
import { goQuote } from "@/fields/field";
import { checkExistingDataDir } from "@/migrations/system-migrations";
import { goBase } from "@/tools/filesystem/file";
import { moveDirContent } from "@/tools/osutils/dir";
import { pseudorandomString } from "@/tools/security/random";

// default root dir entries to exclude from the backup restore
const restoreExclude = [
  LocalBackupsDirName,
  LocalTempDirName,
  LocalAutocertCacheDirName,
  lostFoundDirName,
];

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
// If for whatever reason the revert is not possible, it throws out of the
// restart and takes the process down (upstream's panic).
export async function restoreBackup(app: App, name: string): Promise<void> {
  if (app.store.has(StoreKeyActiveBackup)) {
    throw new Error(ErrBackupActive);
  }

  app.store.set(StoreKeyActiveBackup, name);

  try {
    // make sure that the special temp directory exists
    // note: it needs to be inside the current pb_data to avoid "cross-device link" errors
    const localTempDir = join(app.dataDir, LocalTempDirName);
    const fsys = app.filesystem.newBackupsFilesystem();

    let exists: boolean;
    try {
      exists = fsys.exists(name);
    } catch {
      exists = false;
    } finally {
      fsys.close();
    }
    if (!exists) {
      throw new Error(`missing or invalid backup file ${goQuote(name)} to restore`);
    }

    mkdirSync(localTempDir, { recursive: true, mode: 0o777 });

    const extractedDataDir = join(localTempDir, `pb_restore_${pseudorandomString(8)}`);
    const oldTempDataDir = join(localTempDir, `old_pb_data_${pseudorandomString(8)}`);

    try {
      // extract the zip
      const worker = new BackupWorker();
      try {
        await worker.call({
          op: "extract",
          src: join(app.dataDir, LocalBackupsDirName, goBase(name)),
          dest: extractedDataDir,
        });
      } finally {
        worker.close();
      }

      checkExtractedData(extractedDataDir);

      // move the current pb_data content to a special temp location
      // that will hold the old data between dirs replace
      // (the temp dir will be automatically removed on the next app start)
      try {
        moveDirContent(app.dataDir, oldTempDataDir, ...restoreExclude);
      } catch (err) {
        throw new Error(
          `failed to move the current pb_data content to a temp location: ${errorText(err)}`,
          { cause: err },
        );
      }

      // move the extracted archive content to the app's pb_data
      try {
        moveDirContent(extractedDataDir, app.dataDir, ...restoreExclude);
      } catch (err) {
        // upstream's transaction fails here and the first move stays; a
        // restore that fails must leave pb_data as it was
        moveDirContent(oldTempDataDir, app.dataDir, ...restoreExclude);
        throw new Error(
          `failed to move the extracted archive content to pb_data: ${errorText(err)}`,
          { cause: err },
        );
      }

      const revertDataDirChanges = (): void => {
        try {
          moveDirContent(app.dataDir, extractedDataDir, ...restoreExclude);
        } catch (err) {
          throw new Error(`failed to revert the extracted dir change: ${errorText(err)}`, {
            cause: err,
          });
        }

        try {
          moveDirContent(oldTempDataDir, app.dataDir, ...restoreExclude);
        } catch (err) {
          throw new Error(`failed to revert old pb_data dir change: ${errorText(err)}`, {
            cause: err,
          });
        }
      };

      // restart the app
      try {
        await app.restart(revertDataDirChanges);
      } catch (err) {
        throw new Error(`failed to restart the app process: ${errorText(err)}`, { cause: err });
      }
    } finally {
      await rm(extractedDataDir, { recursive: true, force: true });
      await rm(oldTempDataDir, { recursive: true, force: true });
    }
  } finally {
    app.store.remove(StoreKeyActiveBackup);
  }
}
