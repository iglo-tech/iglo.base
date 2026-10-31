// Upstream: tools/osutils/dir.go (MoveDirContent)

import { mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";

// MoveDirContent moves the src dir content, that is not listed in the exclude list,
// to dest dir (it will be created if missing).
//
// The rootExclude argument is used to specify a list of src root entries to exclude.
//
// Note that this method doesn't delete the old src dir.
//
// It is an alternative to os.Rename() for the cases where we can't
// rename/delete the src dir (see https://ganigeorgiev.com/pocketbase/discussions/2519).
export function moveDirContent(src: string, dest: string, ...rootExclude: string[]): void {
  const entries = readdirSync(src);

  // make sure that the dest dir exist
  let manuallyCreatedDestDir = false;
  try {
    statSync(dest);
  } catch {
    mkdirSync(dest, { mode: 0o777 });
    manuallyCreatedDestDir = true;
  }

  const moved = new Map<string, string>();

  const tryRollback = (): unknown[] => {
    const errs: unknown[] = [];

    for (const [oldPath, newPath] of moved) {
      try {
        renameSync(newPath, oldPath);
      } catch (err) {
        errs.push(err);
      }
    }

    // try to delete manually the created dest dir if all moved files were restored
    if (manuallyCreatedDestDir && errs.length === 0) {
      try {
        rmdirSync(dest);
      } catch (err) {
        errs.push(err);
      }
    }

    return errs;
  };

  for (const basename of entries) {
    if (rootExclude.includes(basename)) {
      continue;
    }

    const oldPath = join(src, basename);
    const newPath = join(dest, basename);

    try {
      renameSync(oldPath, newPath);
    } catch (err) {
      const errs = [...tryRollback(), err];
      throw errs.length > 1 ? new AggregateError(errs, errs.map(String).join("\n")) : err;
    }

    moved.set(oldPath, newPath);
  }
}
