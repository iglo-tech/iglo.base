// Upstream: apis/backup_create.go

import { StoreKeyActiveBackup } from "@/apis/health";
import { firstApiError } from "@/apis/record-helpers";
import type { RequestEvent } from "@/app/event-request";
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

  const validateErr = await validateBackupCreateForm(e, form);
  if (validateErr !== null) {
    return firstApiError(
      validateErr,
      e.badRequestError("An error occurred while validating the submitted data.", validateErr),
    );
  }

  try {
    await createBackup(e.app, form.Name);
  } catch (err) {
    return e.badRequestError("Failed to create backup.", err);
  }

  // we don't retrieve the generated backup file because it may not be
  // available yet due to the eventually consistent nature of some S3 providers
  return e.noContent(204);
}

// -------------------------------------------------------------------

// The name check is the field's last rule; it runs apart as it may go over
// the network.
async function validateBackupCreateForm(
  e: RequestEvent,
  form: BackupCreateForm,
): Promise<Error | null> {
  const err = ValidateStruct(Field("name", form.Name, Length(1, 150), Match(backupNameRegex)));
  if (err !== null || form.Name === "") {
    return err;
  }

  const nameErr = await checkUniqueName(e, form.Name);
  return ValidateStruct(
    Field(
      "name",
      form.Name,
      By(() => nameErr),
    ),
  );
}

async function checkUniqueName(e: RequestEvent, v: string): Promise<Error | null> {
  let fsys;
  try {
    fsys = e.app.filesystem.newBackupsFilesystem();
  } catch (err) {
    return err as Error;
  }

  try {
    let exists: boolean;
    try {
      exists = await fsys.exists(v);
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
