// Upstream: core/field_file.go (processFilesToUpload), split around a
// transaction
//
// Upstream uploads a record's files from inside the save, so also from inside
// a batch's or an OAuth2 sign-up's transaction. Network calls never run in a
// write transaction (AGENTS.md), and those transactions run synchronously
// (D8, D28). So with S3 enabled their callers store the files here first, and
// the save only checks on the File what happened to them (src/fields/file.ts):
//
//   - a file is stored under its record's id: the one the request gave, or one
//     reserved here that the new record takes (src/records/record-save.ts);
//   - a failed upload is kept on the File and reported by the save that
//     reaches it, so what the client gets is what upstream's order gives:
//     an earlier item's validation error goes first;
//   - after the first failure nothing more is sent: the rest get its error;
//   - finish() deletes what no committed record refers to.
//
// A file the save will refuse is not sent when that is known here: the
// record's id cannot be used, or the file is over its field's size limit.
// Then the save fails in its validation, before it looks for the upload.
//
// Files of a rejected request do reach S3 for as long as the request runs,
// which upstream's order avoids: a rule is only evaluated in the transaction.

import type { App } from "@/app/app";
import type { Collection } from "@/collections/collection-model";
import { FieldNameId } from "@/fields/field";
import { TextField } from "@/fields/text";
import { findRecordById } from "@/records/record-query";
import type { File } from "@/tools/filesystem/file";
import { randomStringByRegex } from "@/tools/security/random-by-regex";

export interface UploadTarget {
  collection: Collection;
  // "" for a record whose id is generated
  recordId: string;
  files: File[];
}

// the files stored for one transaction
export class PreUploads {
  readonly #app: App;
  readonly #files: File[];

  constructor(app: App, files: File[]) {
    this.#app = app;
    this.#files = files;
  }

  // Deletes the stored files that no record of the ended transaction refers
  // to. A failed delete is logged, as the failed cleanup of a save is.
  async finish(committed: boolean): Promise<void> {
    const leftover = this.#files.filter((file) => {
      const preUpload = file.preUpload;
      return preUpload !== null && preUpload.error === null && !(committed && preUpload.saved);
    });
    if (leftover.length === 0) {
      return;
    }

    let fsys;
    try {
      fsys = this.#app.filesystem.newFilesystem();
    } catch (err) {
      this.#logFailure(leftover, err);
      return;
    }

    try {
      for (const file of leftover) {
        const key = (file.preUpload as NonNullable<File["preUpload"]>).key;
        file.preUpload = null;
        try {
          await fsys.delete(key);
        } catch (err) {
          this.#logFailure([file], err);
        }
      }
    } finally {
      fsys.close();
    }
  }

  #logFailure(files: File[], err: unknown): void {
    this.#app.logger.error(
      `Failed to cleanup the new uploaded file after record db write failure: ${files.map((f) => f.name).join(", ")}`,
      err,
    );
  }
}

// the id a target's files are stored under, or null when the save cannot get
// to its upload with it. The id field checks only a new record's id: an
// existing one may come from an import (core/field_text.go).
function targetRecordId(app: App, target: UploadTarget): string | null {
  const field = target.collection.fields.getByName(FieldNameId);
  if (!(field instanceof TextField)) {
    return null;
  }

  let id = target.recordId;
  if (id === "") {
    if (field.autogeneratePattern === "") {
      return null;
    }
    id = randomStringByRegex(field.autogeneratePattern);
  }

  return field.validatePlainValue(id) === null || recordExists(app, target, id) ? id : null;
}

function recordExists(app: App, target: UploadTarget, id: string): boolean {
  try {
    findRecordById(app, target.collection, id);
    return true;
  } catch {
    return false;
  }
}

// Stores the targets' files, before the transaction that saves them opens. A
// local storage is written by the save itself, inside the transaction.
export async function preUploadFiles(
  app: App,
  targets: readonly UploadTarget[],
): Promise<PreUploads> {
  const stored: File[] = [];
  if (!app.settings.S3.Enabled) {
    return new PreUploads(app, stored);
  }

  let failure: unknown = null;
  let fsys;
  try {
    fsys = app.filesystem.newFilesystem();
  } catch (err) {
    failure = err;
  }

  try {
    for (const target of targets) {
      const recordId = targetRecordId(app, target);
      if (recordId === null) {
        continue;
      }

      for (const file of target.files) {
        const key = target.collection.baseFilesPath() + "/" + recordId + "/" + file.name;
        const preUpload = { recordId, key, error: failure, saved: false };
        file.preUpload = preUpload;
        if (failure !== null || fsys === undefined) {
          continue;
        }

        stored.push(file);
        try {
          await fsys.uploadFile(file, key);
        } catch (err) {
          preUpload.error = err;
          failure = err;
        }
      }
    }
  } finally {
    fsys?.close();
  }

  return new PreUploads(app, stored);
}
