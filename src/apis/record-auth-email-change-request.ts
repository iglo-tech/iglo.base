// Upstream: apis/record_auth_email_change_request.go
//
// The OnRecordRequestEmailChangeRequest hook is not ported (no extension
// surface): its default action runs directly. The handler never runs in a
// transaction, so execAfterSuccessTx is the plain response write. Unlike the
// other two request endpoints, the email goes out before the response and
// a failed send is the response.

import type { RequestEvent } from "@/app/event-request";
import { findAuthCollection } from "@/apis/record-auth";
import { firstApiError } from "@/apis/record-helpers";
import { sendRecordChangeEmail } from "@/mail/mails/record";
import type { Record } from "@/records/record-model";
import { CollectionNameSuperusers } from "@/records/record-model-superusers";
import { findAuthRecordByEmail, type RecordsApp } from "@/records/record-query";
import { ApiError } from "@/server/error";
import type { HandlerResult } from "@/server/handler";
import { structOf } from "@/server/unmarshal-request-data";
import { NewError } from "@/validation/error";
import { EmailFormat } from "@/validation/is/rules";
import { Length } from "@/validation/length";
import { NotIn } from "@/validation/not-in";
import { Required } from "@/validation/required";
import { Field, ValidateStruct } from "@/validation/struct";
import { By, type RuleFunc } from "@/validation/validation";

export async function recordRequestEmailChange(e: RequestEvent): Promise<HandlerResult> {
  const collection = findAuthCollection(e);
  if (collection instanceof ApiError) {
    return collection;
  }

  if (collection.name === CollectionNameSuperusers) {
    return e.badRequestError("All superusers can change their emails directly.", null);
  }

  const record = e.auth;
  if (record === undefined) {
    return e.unauthorizedError("The request requires valid auth record.", null);
  }

  const form: EmailChangeRequestForm = { NewEmail: "" };
  const bindErr = await e.bindBody(
    form as unknown as { [key: string]: unknown },
    emailChangeRequestType,
  );
  if (bindErr) {
    return firstApiError(
      bindErr,
      e.badRequestError("An error occurred while loading the submitted data.", bindErr),
    );
  }
  const validateErr = validateEmailChangeRequestForm(form, e.app, record);
  if (validateErr) {
    return firstApiError(
      validateErr,
      e.badRequestError("An error occurred while validating the submitted data.", validateErr),
    );
  }

  // the OnRecordRequestEmailChangeRequest default action
  try {
    await sendRecordChangeEmail(e.app, record, form.NewEmail);
  } catch (err) {
    return firstApiError(err, e.badRequestError("Failed to request email change.", err));
  }

  return e.noContent(204);
}

// -------------------------------------------------------------------

const emailChangeRequestType = structOf([
  { name: "NewEmail", type: "string", tags: { form: "newEmail", json: "newEmail" } },
]);

interface EmailChangeRequestForm {
  NewEmail: string;
}

function validateEmailChangeRequestForm(
  form: EmailChangeRequestForm,
  app: RecordsApp,
  record: Record,
): Error | null {
  return ValidateStruct(
    Field(
      "newEmail",
      form.NewEmail,
      Required,
      Length(1, 255),
      EmailFormat,
      NotIn(record.email()),
      By(checkUniqueEmail(app, record)),
    ),
  );
}

function checkUniqueEmail(app: RecordsApp, record: Record): RuleFunc {
  return (value) => {
    const v = typeof value === "string" ? value : "";
    if (v === "") {
      return null;
    }

    let found: Record | undefined;
    try {
      found = findAuthRecordByEmail(app, record.collection(), v);
    } catch {
      // not found (or failed): nothing to compare with
    }
    if (found !== undefined && found.id !== record.id) {
      return NewError("validation_invalid_new_email", "Invalid new email address.");
    }

    return null;
  };
}
