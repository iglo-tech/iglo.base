// Upstream: core/base.go (NewFilesystem, NewBackupsFilesystem, the Local*
// directory names, the
// "__pbFilesManagerDelete__" handler of registerBaseHooks and
// supportFiles)
//
// The app's file storage: newFilesystem() opens pb_data/storage
// (filesystem.NewLocal). With S3 enabled in the settings it throws until
// M5.4 brings the S3 storage; every caller fails then as upstream's do
// when its S3 storage cannot be reached (an upload fails the save with a
// 400, a delete leaves the files and logs the error).
// newBackupsFilesystem() is the same for pb_data/backups and backups.s3.
//
// deleteModelFiles is the storage cleanup after a record or collection is
// deleted (upstream's OnModelAfterDeleteSuccess handler, called directly by
// the record and collection delete paths, D5): the model's storage
// directory is deleted in the background ("optimistic" delete: the
// delete request does not wait for it), with at most
// PB_FILES_DELETE_MAX_WORKERS (default 2000) deletes running at once. A
// delete that finds every worker busy waits for one, as upstream's
// semaphore Acquire does; the returned promise settles once the delete has
// a worker (a synchronous caller does not wait for it). A worker deletes
// the files page by page and gives the event loop back between pages.

import type { ErrorLogger } from "@/app/app";
import { toInt64 } from "@/records/cast";
import type { Settings } from "@/settings/settings-model";
import { type FilesystemWatcher, NewLocal, type System } from "@/tools/filesystem/filesystem";

export const LocalStorageDirName = "storage";
export const LocalBackupsDirName = "backups";
export const LocalAutocertCacheDirName = ".autocert_cache";
export const LocalNotifyDirName = ".notify";
// temp pb_data sub directory that will be deleted on each app.Bootstrap()
export const LocalTempDirName = ".pb_temp_to_delete";
export const lostFoundDirName = "lost+found";

// the field types of a deleted model's collection (supportFiles)
export interface FilesModel {
  // BaseFilesPath returns the storage dir path used by the model.
  baseFilesPath(): string;
  // the types of the model collection's fields
  fieldTypes(): Iterable<string>;
}

export interface AppFilesystem {
  // NewFilesystem creates a new local or S3 filesystem instance for
  // managing regular app files (ex. record uploads) based on the current
  // app settings.
  //
  // NB! Make sure to call close() on the returned result after you are
  // done working with it.
  newFilesystem(): System;
  // NewBackupsFilesystem creates a new local or S3 filesystem instance for
  // managing app backups based on the current app settings.
  //
  // NB! Make sure to call close() on the returned result after you are
  // done working with it.
  newBackupsFilesystem(): System;
  // sets (null: clears) the watcher of the app's file storage
  watch(watcher: FilesystemWatcher | null): void;
  // deletes the storage files of a deleted record or collection in the
  // background (see the top of the file)
  deleteModelFiles(model: FilesModel): void | Promise<void>;
}

export interface AppFilesystemConfig {
  dataDir: string;
  // the current settings (S3)
  settings: () => Pick<Settings, "S3" | "Backups">;
  getenv: (name: string) => string;
  logger: ErrorLogger;
}

export function newAppFilesystem(config: AppFilesystemConfig): AppFilesystem {
  let watcher: FilesystemWatcher | null = null;

  const newFilesystem = (): System => {
    if (config.settings().S3.Enabled) {
      throw new Error("the S3 file storage is not supported yet (M5.4)");
    }
    // local filesystem
    return NewLocal(config.dataDir + "/" + LocalStorageDirName, () => watcher);
  };

  const newBackupsFilesystem = (): System => {
    if (config.settings().Backups.S3.Enabled) {
      throw new Error("the S3 backups storage is not supported yet (M5.4)");
    }
    // fallback to local filesystem
    return NewLocal(config.dataDir + "/" + LocalBackupsDirName);
  };

  // cast.ToInt64 (Go integer literals, 0 when it does not parse); a
  // count past 2^53 is as unlimited as Go's int64 weight
  let maxFilesDeleteWorkers = Math.min(
    Number(toInt64(config.getenv("PB_FILES_DELETE_MAX_WORKERS"))),
    Number.MAX_SAFE_INTEGER,
  );
  if (maxFilesDeleteWorkers <= 0) {
    maxFilesDeleteWorkers = 2000; // the value is arbitrary chosen and may change in the future
  }
  const deleteSem = new Semaphore(maxFilesDeleteWorkers);

  const deletePrefix = async (prefix: string): Promise<void> => {
    const fs = newFilesystem();
    try {
      const steps = fs.deletePrefixSteps(prefix);
      for (;;) {
        const r = steps.next();
        if (r.done === true) {
          if (r.value.length > 0) {
            throw new Error("failed to delete the files at " + prefix, {
              cause: new AggregateError(r.value),
            });
          }
          return;
        }
        // give the event loop back between pages
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      fs.close();
    }
  };

  const fireAndForget = (prefix: string): void => {
    // run in the background for "optimistic" delete to avoid blocking the
    // delete transaction
    setImmediate(() => {
      deletePrefix(prefix)
        .catch((err: unknown) => {
          config.logger.error(
            `Failed to delete storage prefix (non critical error; usually could happen because of S3 api limits): ${prefix}`,
            err,
          );
        })
        .finally(() => deleteSem.release());
    });
  };

  return {
    newFilesystem,
    newBackupsFilesystem,
    watch(newWatcher: FilesystemWatcher | null): void {
      watcher = newWatcher;
    },
    deleteModelFiles(model: FilesModel): void | Promise<void> {
      const base = model.baseFilesPath();
      if (base === "" || !supportFiles(model)) {
        return;
      }

      // ensure that there is a trailing slash so that the list iterator
      // could start walking from the prefix dir
      const prefix = base.replace(/\/+$/, "") + "/";

      if (deleteSem.tryAcquire()) {
        fireAndForget(prefix);
        return;
      }
      return deleteSem.acquire().then(() => fireAndForget(prefix));
    },
  };
}

// supportFiles: whether the model's collection has a file field
function supportFiles(model: FilesModel): boolean {
  for (const t of model.fieldTypes()) {
    if (t === "file") {
      return true;
    }
  }
  return false;
}

// semaphore.Weighted with weight 1 per acquire
class Semaphore {
  #free: number;
  readonly #waiters: (() => void)[] = [];

  constructor(size: number) {
    this.#free = size;
  }

  tryAcquire(): boolean {
    if (this.#free > 0 && this.#waiters.length === 0) {
      this.#free--;
      return true;
    }
    return false;
  }

  acquire(): Promise<void> {
    if (this.tryAcquire()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  release(): void {
    const next = this.#waiters.shift();
    if (next !== undefined) {
      next(); // the slot passes to the waiter
      return;
    }
    this.#free++;
  }
}
