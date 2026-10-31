// Upstream: apis/record_auth_email_change_confirm.go
//
// The OnRecordConfirmEmailChangeRequest hook is not ported (no extension
// surface): its default action runs directly. The handler never runs in a
// transaction, so execAfterSuccessTx is the plain response write.

import type { App } from "@/app/app";
import type { RequestEvent } from "@/app/event-request";
import { findAuthCollection } from "@/apis/record-auth";
import { firstApiError } from "@/apis/record-helpers";
import type { Collection } from "@/collections/collection-model";
import type { Record } from "@/records/record-model";
import { CollectionNameSuperusers } from "@/records/record-model-superusers";
import { findAuthRecordByEmail, findAuthRecordByToken } from "@/records/record-query";
import { saveRecord } from "@/records/record-save";
import {
  parseUnverifiedClaims,
  TokenClaimNewEmail,
  TokenTypeEmailChange,
} from "@/records/record-tokens";
import { ApiError } from "@/server/error";
import type { HandlerResult } from "@/server/handler";
import { structOf } from "@/server/unmarshal-request-data";
import { type Error as ValidationError, NewError } from "@/validation/error";
import { Length } from "@/validation/length";
import { Required } from "@/validation/required";
import { Field, ValidateStruct } from "@/validation/struct";
import { By } from "@/validation/validation";

export async function recordConfirmEmailChange(e: RequestEvent): Promise<HandlerResult> {
  const collection = findAuthCollection(e);
  if (collection instanceof ApiError) {
    return collection;
  }

  if (collection.name === CollectionNameSuperusers) {
    return e.badRequestError("All superusers can change their emails directly.", null);
  }

  const form: EmailChangeConfirmForm = { Token: "", Password: "" };
  const bindErr = await e.bindBody(
    form as unknown as { [key: string]: unknown },
    emailChangeConfirmType,
  );
  if (bindErr) {
    return firstApiError(
      bindErr,
      e.badRequestError("An error occurred while loading the submitted data.", bindErr),
    );
  }
  const validateErr = validateEmailChangeConfirmForm(form, e.app, collection);
  if (validateErr) {
    return firstApiError(
      validateErr,
      e.badRequestError("An error occurred while validating the submitted data.", validateErr),
    );
  }

  const parsed = parseToken(form, e.app, collection);
  if ("err" in parsed) {
    return firstApiError(parsed.err, e.badRequestError("Invalid or expired token.", parsed.err));
  }
  const { authRecord, newEmail } = parsed;

  // the OnRecordConfirmEmailChangeRequest default action
  authRecord.setEmail(newEmail);
  authRecord.setVerified(true);

  try {
    await saveRecord(e.app, authRecord);
  } catch (err) {
    return firstApiError(err, e.badRequestError("Failed to confirm email change.", err));
  }

  return e.noContent(204);
}

// -------------------------------------------------------------------

const emailChangeConfirmType = structOf([
  { name: "Token", type: "string", tags: { form: "token", json: "token" } },
  { name: "Password", type: "string", tags: { form: "password", json: "password" } },
]);

interface EmailChangeConfirmForm {
  Token: string;
  Password: string;
}

function validateEmailChangeConfirmForm(
  form: EmailChangeConfirmForm,
  app: App,
  collection: Collection,
): Error | null {
  return ValidateStruct(
    Field(
      "token",
      form.Token,
      Required,
      By(() => {
        const parsed = parseToken(form, app, collection);
        return "err" in parsed ? parsed.err : null;
      }),
    ),
    Field(
      "password",
      form.Password,
      Required,
      Length(1, 100),
      By((value) => {
        const v = typeof value === "string" ? value : "";
        if (v === "") {
          return null; // nothing to check
        }

        const parsed = parseToken(form, app, collection);
        if ("err" in parsed || !parsed.authRecord.validatePassword(v)) {
          return NewError(
            "validation_invalid_password",
            "Missing or invalid auth record password.",
          );
        }

        return null;
      }),
    ),
  );
}

function parseToken(
  form: EmailChangeConfirmForm,
  app: App,
  collection: Collection,
): { authRecord: Record; newEmail: string } | { err: ValidationError } {
  // check token payload
  const claims = parseUnverifiedClaims(form.Token, app.clock);
  const claim = Object.hasOwn(claims, TokenClaimNewEmail) ? claims[TokenClaimNewEmail] : undefined;
  const newEmail = typeof claim === "string" ? claim : "";
  if (newEmail === "") {
    return {
      err: NewError(
        "validation_invalid_token_payload",
        "Invalid token payload - newEmail must be set.",
      ),
    };
  }

  // verify that the token is not expired and its signature is valid
  let authRecord: Record;
  try {
    authRecord = findAuthRecordByToken(app, form.Token, TokenTypeEmailChange);
  } catch {
    return { err: NewError("validation_invalid_token", "Invalid or expired token.") };
  }

  if (authRecord.collection().id !== collection.id) {
    return {
      err: NewError(
        "validation_token_collection_mismatch",
        "The provided token is for different auth collection.",
      ),
    };
  }

  // check if there are other users with the new email
  try {
    findAuthRecordByEmail(app, collection, newEmail);
  } catch {
    return { authRecord, newEmail };
  }

  return { err: NewError("validation_invalid_token_email", "The new email address is invalid.") };
}
