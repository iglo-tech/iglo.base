// Upstream: apis/record_auth_password_reset_request.go
//
// The OnRecordRequestPasswordResetRequest hook is not ported (no extension
// surface): its default action runs directly. The handler never runs in a
// transaction, so execAfterSuccessTx is the plain response write. The email
// goes out in the background, as upstream's routine.FireAndForget; its
// result never reaches the client, and only a sent email blocks the next
// one.

import type { RequestEvent } from "@/app/event-request";
import { findAuthCollection } from "@/apis/record-auth";
import { firstApiError } from "@/apis/record-helpers";
import { wrapError } from "@/collections/view";
import { sendRecordPasswordReset } from "@/mail/mails/record";
import type { Record } from "@/records/record-model";
import { findAuthRecordByEmail } from "@/records/record-query";
import { ApiError } from "@/server/error";
import type { HandlerResult } from "@/server/handler";
import { structOf } from "@/server/unmarshal-request-data";
import { EmailFormat } from "@/validation/is/rules";
import { Length } from "@/validation/length";
import { Required } from "@/validation/required";
import { Field, ValidateStruct } from "@/validation/struct";

// how long a sent email blocks the next one (time.AfterFunc in upstream)
const resendLimitMs = 2 * 60 * 1000;

export async function recordRequestPasswordReset(e: RequestEvent): Promise<HandlerResult> {
  const collection = findAuthCollection(e);
  if (collection instanceof ApiError) {
    return collection;
  }

  if (!collection.passwordAuth.enabled) {
    return e.badRequestError(
      "The collection is not configured to allow password authentication.",
      null,
    );
  }

  const form: RecordRequestPasswordResetForm = { Email: "" };
  const bindErr = await e.bindBody(
    form as unknown as { [key: string]: unknown },
    recordRequestPasswordResetType,
  );
  if (bindErr) {
    return firstApiError(
      bindErr,
      e.badRequestError("An error occurred while loading the submitted data.", bindErr),
    );
  }
  const validateErr = validateRecordRequestPasswordResetForm(form);
  if (validateErr) {
    return firstApiError(
      validateErr,
      e.badRequestError("An error occurred while validating the submitted data.", validateErr),
    );
  }

  let record: Record;
  try {
    record = findAuthRecordByEmail(e.app, collection, form.Email);
  } catch (err) {
    // eagerly write 204 response as a very basic measure against emails enumeration
    e.noContent(204);
    return wrapError(`failed to fetch ${collection.name} record with email ${form.Email}`, err);
  }

  const resendKey = getPasswordResetResendKey(record);
  if (e.app.store.has(resendKey)) {
    // eagerly write 204 response as a very basic measure against emails enumeration
    e.noContent(204);
    return new Error("try again later - you've already requested a password reset email");
  }

  // the OnRecordRequestPasswordResetRequest default action:
  // run in background because we don't need to show the result to the client
  void sendPasswordResetInBackground(e, record, resendKey);

  return e.noContent(204);
}

async function sendPasswordResetInBackground(
  e: RequestEvent,
  record: Record,
  resendKey: string,
): Promise<void> {
  const app = e.app;
  try {
    await sendRecordPasswordReset(app, record);
  } catch (err) {
    app.logger.error("Failed to send password reset email", err);
    return;
  }

  app.store.set(resendKey, {});
  setTimeout(() => {
    app.store.remove(resendKey);
  }, resendLimitMs).unref();
}

// -------------------------------------------------------------------

const recordRequestPasswordResetType = structOf([
  { name: "Email", type: "string", tags: { form: "email", json: "email" } },
]);

interface RecordRequestPasswordResetForm {
  Email: string;
}

function validateRecordRequestPasswordResetForm(
  form: RecordRequestPasswordResetForm,
): Error | null {
  return ValidateStruct(Field("email", form.Email, Required, Length(1, 255), EmailFormat));
}

export function getPasswordResetResendKey(record: Record): string {
  return "@limitPasswordResetEmail_" + record.collection().id + record.id;
}
