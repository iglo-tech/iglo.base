// Upstream: apis/backup_upload.go
//
// The file parts come through the multipart spill (D27), and the file is
// written in blocks with the event loop given back between them.

import { firstApiError } from "@/apis/record-helpers";
import type { RequestEvent } from "@/app/event-request";
import { uploadBackupFile } from "@/backups/create";
import type { File } from "@/tools/filesystem/file";
import type { System } from "@/tools/filesystem/filesystem";
import type { S3System } from "@/tools/filesystem/s3-system";
import { NewError } from "@/validation/error";
import { Required } from "@/validation/required";
import { Field, ValidateStruct } from "@/validation/struct";
import { By } from "@/validation/validation";
import { UploadedFileMimeType } from "@/validators/file";

export async function backupUpload(e: RequestEvent): Promise<Error | undefined> {
  let fsys: System | S3System;
  try {
    fsys = e.app.filesystem.newBackupsFilesystem();
  } catch (err) {
    return err as Error;
  }

  try {
    let file: File | null = null;
    try {
      file = (await e.findUploadedFiles("file"))[0] ?? null;
    } catch {
      // the file stays missing
    }

    const validateErr = await validateBackupUploadForm(fsys, file);
    if (validateErr !== null || file === null) {
      return firstApiError(
        validateErr as Error,
        e.badRequestError("An error occurred while validating the submitted data.", validateErr),
      );
    }

    try {
      await uploadBackupFile(fsys, file, file.originalName);
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

// The name check is the field's last rule; it runs apart as it may go over
// the network.
async function validateBackupUploadForm(
  fsys: System | S3System,
  file: File | null,
): Promise<Error | null> {
  const err = ValidateStruct(
    Field("file", file, Required, By(UploadedFileMimeType(["application/zip"]))),
  );
  if (err !== null || file === null) {
    return err;
  }

  const nameErr = await checkUniqueName(fsys, file);
  return ValidateStruct(
    Field(
      "file",
      file,
      By(() => nameErr),
    ),
  );
}

async function checkUniqueName(fsys: System | S3System, file: File): Promise<Error | null> {
  // note: we use the original name because that is what we upload
  let exists: boolean;
  try {
    exists = await fsys.exists(file.originalName);
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
