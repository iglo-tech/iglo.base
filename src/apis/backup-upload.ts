// Upstream: apis/backup_upload.go
//
// The file parts come through the multipart spill (D27), and the file is
// written in blocks with the event loop given back between them.

import { loadFailure } from "@/apis/backup-load";
import { firstApiError } from "@/apis/record-helpers";
import type { RequestEvent } from "@/app/event-request";
import { ErrBackupsS3NotSupported } from "@/app/filesystem";
import type { File } from "@/tools/filesystem/file";
import type { System } from "@/tools/filesystem/filesystem";
import { NewError } from "@/validation/error";
import { Required } from "@/validation/required";
import { Field, ValidateStruct } from "@/validation/struct";
import { By } from "@/validation/validation";
import { UploadedFileMimeType } from "@/validators/file";

export async function backupUpload(e: RequestEvent): Promise<Error | undefined> {
  let fsys: System;
  try {
    fsys = e.app.filesystem.newBackupsFilesystem();
  } catch (err) {
    if (err === ErrBackupsS3NotSupported) {
      return e.internalServerError(loadFailure(err), err);
    }
    return err as Error;
  }

  try {
    let file: File | null = null;
    try {
      file = (await e.findUploadedFiles("file"))[0] ?? null;
    } catch {
      // the file stays missing
    }

    const validateErr = validateBackupUploadForm(fsys, file);
    if (validateErr !== null || file === null) {
      return firstApiError(
        validateErr as Error,
        e.badRequestError("An error occurred while validating the submitted data.", validateErr),
      );
    }

    try {
      for (const _ of fsys.uploadFileSteps(file, file.originalName)) {
        // give the event loop back between blocks
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch (err) {
      return e.badRequestError("Failed to upload backup.", err);
    }

    // we don't retrieve the generated backup file because it may not be
    // available yet due to the eventually consistent nature of some S3 providers
    return e.noContent(204);
  } finally {
    fsys.close();
  }
}

// -------------------------------------------------------------------

function validateBackupUploadForm(fsys: System, file: File | null): Error | null {
  return ValidateStruct(
    Field(
      "file",
      file,
      Required,
      By(UploadedFileMimeType(["application/zip"])),
      By((value) => checkUniqueName(fsys, value)),
    ),
  );
}

function checkUniqueName(fsys: System, value: unknown): Error | null {
  if (value === null) {
    return null; // nothing to check
  }

  // note: we use the original name because that is what we upload
  let exists: boolean;
  try {
    exists = fsys.exists((value as File).originalName);
  } catch {
    exists = true;
  }
  if (exists) {
    return NewError(
      "validation_backup_name_exists",
      "Backup file with the specified name already exists.",
    );
  }
  return null;
}
