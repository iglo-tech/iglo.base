// Upstream: apis/record_auth_password_reset_confirm.go
//
// The OnRecordConfirmPasswordResetRequest hook is not ported (no extension
// surface): its default action runs directly. The handler never runs in a
// transaction, so execAfterSuccessTx is the plain response write.

import type { App } from "@/app/app";
import type { RequestEvent } from "@/app/event-request";
import { findAuthCollection } from "@/apis/record-auth";
import { getPasswordResetResendKey } from "@/apis/record-auth-password-reset-request";
import { firstApiError } from "@/apis/record-helpers";
import type { Collection } from "@/collections/collection-model";
import { FieldNamePassword } from "@/fields/field";
import { PasswordField } from "@/fields/password";
import type { Record } from "@/records/record-model";
import { findAuthRecordByToken } from "@/records/record-query";
import { saveRecord } from "@/records/record-save";
import { TokenClaimEmail, TokenTypePasswordReset } from "@/records/record-tokens";
import { ApiError } from "@/server/error";
import type { HandlerResult } from "@/server/handler";
import { structOf } from "@/server/unmarshal-request-data";
import { parseUnverifiedJWT } from "@/tools/security/jwt";
import { toString } from "@/tools/types/cast";
import { NewError } from "@/validation/error";
import { Length } from "@/validation/length";
import { Required } from "@/validation/required";
import { Field, ValidateStruct } from "@/validation/struct";
import { By, type RuleFunc } from "@/validation/validation";
import { Equal } from "@/validators/equal";

export async function recordConfirmPasswordReset(e: RequestEvent): Promise<HandlerResult> {
  const collection = findAuthCollection(e);
  if (collection instanceof ApiError) {
    return collection;
  }

  const form: RecordConfirmPasswordResetForm = { Token: "", Password: "", PasswordConfirm: "" };
  const bindErr = await e.bindBody(
    form as unknown as { [key: string]: unknown },
    recordConfirmPasswordResetType,
  );
  if (bindErr) {
    return e.badRequestError("An error occurred while loading the submitted data.", bindErr);
  }
  const validateErr = validateRecordConfirmPasswordResetForm(form, e.app, collection);
  if (validateErr) {
    return firstApiError(
      validateErr,
      e.badRequestError("An error occurred while validating the submitted data.", validateErr),
    );
  }

  let authRecord: Record;
  try {
    authRecord = findAuthRecordByToken(e.app, form.Token, TokenTypePasswordReset);
  } catch (err) {
    return firstApiError(err, e.badRequestError("Invalid or expired password reset token.", err));
  }

  // the OnRecordConfirmPasswordResetRequest default action
  authRecord.setPassword(form.Password);

  if (!authRecord.verified() && tokenEmailMatches(e.app, form.Token, authRecord)) {
    // mark as verified if the email hasn't changed
    authRecord.setVerified(true);
  }

  try {
    await saveRecord(e.app, authRecord);
  } catch (err) {
    return firstApiError(err, e.badRequestError("Failed to set new password.", err));
  }

  e.app.store.remove(getPasswordResetResendKey(authRecord));

  return e.noContent(204);
}

function tokenEmailMatches(app: App, token: string, authRecord: Record): boolean {
  try {
    const payload = parseUnverifiedJWT(token, app.clock);
    return (
      authRecord.email() ===
      (Object.hasOwn(payload, TokenClaimEmail) ? toString(payload[TokenClaimEmail]) : "")
    );
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------

const recordConfirmPasswordResetType = structOf([
  { name: "Token", type: "string", tags: { form: "token", json: "token" } },
  { name: "Password", type: "string", tags: { form: "password", json: "password" } },
  {
    name: "PasswordConfirm",
    type: "string",
    tags: { form: "passwordConfirm", json: "passwordConfirm" },
  },
]);

interface RecordConfirmPasswordResetForm {
  Token: string;
  Password: string;
  PasswordConfirm: string;
}

function validateRecordConfirmPasswordResetForm(
  form: RecordConfirmPasswordResetForm,
  app: App,
  collection: Collection,
): Error | null {
  let min = 1;
  const passField = collection.fields.getByName(FieldNamePassword);
  if (passField instanceof PasswordField && passField.min > 0) {
    min = Number(passField.min);
  }

  return ValidateStruct(
    Field("token", form.Token, Required, By(checkToken(app, collection))),
    // the FieldPassword validator will check further the specicic length constraints
    Field("password", form.Password, Required, Length(min, 255)),
    Field("passwordConfirm", form.PasswordConfirm, Required, By(Equal(form.Password))),
  );
}

function checkToken(app: App, collection: Collection): RuleFunc {
  return (value) => {
    const v = typeof value === "string" ? value : "";
    if (v === "") {
      return null;
    }

    let record: Record;
    try {
      record = findAuthRecordByToken(app, v, TokenTypePasswordReset);
    } catch {
      return NewError("validation_invalid_token", "Invalid or expired token.");
    }

    if (record.collection().id !== collection.id) {
      return NewError(
        "validation_token_collection_mismatch",
        "The provided token is for different auth collection.",
      );
    }

    return null;
  };
}
