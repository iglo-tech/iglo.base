// Upstream: apis/record_auth_verification_request.go
//
// The OnRecordRequestVerificationRequest hook is not ported (no extension
// surface): its default action runs directly. The handler never runs in a
// transaction, so execAfterSuccessTx is the plain response write. The email
// goes out in the background, as upstream's routine.FireAndForget; its
// result never reaches the client.

import type { RequestEvent } from "@/app/event-request";
import { findAuthCollection } from "@/apis/record-auth";
import { firstApiError } from "@/apis/record-helpers";
import { wrapError } from "@/collections/view";
import { sendRecordVerification } from "@/mail/mails/record";
import type { Record } from "@/records/record-model";
import { CollectionNameSuperusers } from "@/records/record-model-superusers";
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

export async function recordRequestVerification(e: RequestEvent): Promise<HandlerResult> {
  const collection = findAuthCollection(e);
  if (collection instanceof ApiError) {
    return collection;
  }

  if (collection.name === CollectionNameSuperusers) {
    return e.badRequestError("All superusers are verified by default.", null);
  }

  const form: RecordRequestVerificationForm = { Email: "" };
  const bindErr = await e.bindBody(
    form as unknown as { [key: string]: unknown },
    recordRequestVerificationType,
  );
  if (bindErr) {
    return firstApiError(
      bindErr,
      e.badRequestError("An error occurred while loading the submitted data.", bindErr),
    );
  }
  const validateErr = validateRecordRequestVerificationForm(form);
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

  const resendKey = getVerificationResendKey(record);
  if (!record.verified() && e.app.store.has(resendKey)) {
    // eagerly write 204 response as a very basic measure against emails enumeration
    e.noContent(204);
    return new Error("try again later - you've already requested a verification email");
  }

  // the OnRecordRequestVerificationRequest default action
  if (record.verified()) {
    return e.noContent(204);
  }

  // run in background because we don't need to show the result to the client
  void sendVerificationInBackground(e, record, resendKey);

  return e.noContent(204);
}

async function sendVerificationInBackground(
  e: RequestEvent,
  record: Record,
  resendKey: string,
): Promise<void> {
  const app = e.app;
  try {
    await sendRecordVerification(app, record);
  } catch (err) {
    app.logger.error("Failed to send verification email", err);
  }

  app.store.set(resendKey, {});
  setTimeout(() => {
    app.store.remove(resendKey);
  }, resendLimitMs).unref();
}

// -------------------------------------------------------------------

const recordRequestVerificationType = structOf([
  { name: "Email", type: "string", tags: { form: "email", json: "email" } },
]);

interface RecordRequestVerificationForm {
  Email: string;
}

function validateRecordRequestVerificationForm(form: RecordRequestVerificationForm): Error | null {
  return ValidateStruct(Field("email", form.Email, Required, Length(1, 255), EmailFormat));
}

export function getVerificationResendKey(record: Record): string {
  return "@limitVerificationEmail_" + record.collection().id + record.id;
}
