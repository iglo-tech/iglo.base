// Upstream: apis/backup_create.go

import { StoreKeyActiveBackup } from "@/apis/health";
import { firstApiError } from "@/apis/record-helpers";
import type { RequestEvent } from "@/app/event-request";
import { ErrBackupsS3NotSupported } from "@/app/filesystem";
import { createBackup } from "@/backups/create";
import { structOf } from "@/server/unmarshal-request-data";
import { mustCompile } from "@/tools/regexp/regexp";
import { NewError } from "@/validation/error";
import { Length } from "@/validation/length";
import { Match } from "@/validation/match";
import { Field, ValidateStruct } from "@/validation/struct";
import { By } from "@/validation/validation";

const backupNameRegex = mustCompile(String.raw`^[a-z0-9_-]+\.zip$`);

const backupCreateFormType = structOf([
  { name: "Name", type: "string", tags: { form: "name", json: "name" } },
]);

interface BackupCreateForm {
  Name: string;
}

export async function backupCreate(e: RequestEvent): Promise<Error | undefined> {
  if (e.app.store.has(StoreKeyActiveBackup)) {
    return e.badRequestError(
      "Try again later - another backup/restore process has already been started",
      null,
    );
  }

  const form: BackupCreateForm = { Name: "" };

  const bindErr = await e.bindBody(
    form as unknown as Record<string, unknown>,
    backupCreateFormType,
  );
  if (bindErr) {
    return firstApiError(
      bindErr,
      e.badRequestError("An error occurred while loading the submitted data.", bindErr),
    );
  }

  const validateErr = validateBackupCreateForm(e, form);
  if (validateErr !== null) {
    return firstApiError(
      validateErr,
      e.badRequestError("An error occurred while validating the submitted data.", validateErr),
    );
  }

  try {
    await createBackup(e.app, form.Name);
  } catch (err) {
    return e.badRequestError(
      err === ErrBackupsS3NotSupported
        ? `Failed to create backup. Raw error: \n${ErrBackupsS3NotSupported.message}`
        : "Failed to create backup.",
      err,
    );
  }

  // we don't retrieve the generated backup file because it may not be
  // available yet due to the eventually consistent nature of some S3 providers
  return e.noContent(204);
}

// -------------------------------------------------------------------

function validateBackupCreateForm(e: RequestEvent, form: BackupCreateForm): Error | null {
  return ValidateStruct(
    Field(
      "name",
      form.Name,
      Length(1, 150),
      Match(backupNameRegex),
      By((value) => checkUniqueName(e, value)),
    ),
  );
}

function checkUniqueName(e: RequestEvent, value: unknown): Error | null {
  const v = typeof value === "string" ? value : "";
  if (v === "") {
    return null; // nothing to check
  }

  let fsys;
  try {
    fsys = e.app.filesystem.newBackupsFilesystem();
  } catch (err) {
    // createBackup reports the S3 error (until M5.4)
    return err === ErrBackupsS3NotSupported ? null : (err as Error);
  }

  try {
    let exists: boolean;
    try {
      exists = fsys.exists(v);
    } catch {
      exists = true;
    }
    if (exists) {
      return NewError(
        "validation_backup_name_exists",
        "The backup file name is invalid or already exists.",
      );
    }
    return null;
  } finally {
    fsys.close();
  }
}
