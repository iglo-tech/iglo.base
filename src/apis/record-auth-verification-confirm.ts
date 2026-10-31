// Upstream: apis/record_auth_verification_confirm.go
//
// The OnRecordConfirmVerificationRequest hook is not ported (no extension
// surface): its default action runs directly. The handler never runs in a
// transaction, so execAfterSuccessTx is the plain response write.

import type { App } from "@/app/app";
import type { RequestEvent } from "@/app/event-request";
import { findAuthCollection } from "@/apis/record-auth";
import { getVerificationResendKey } from "@/apis/record-auth-verification-request";
import { firstApiError } from "@/apis/record-helpers";
import type { Collection } from "@/collections/collection-model";
import type { Record } from "@/records/record-model";
import { CollectionNameSuperusers } from "@/records/record-model-superusers";
import { findAuthRecordByToken } from "@/records/record-query";
import { saveRecord } from "@/records/record-save";
import {
  parseUnverifiedClaims,
  TokenClaimEmail,
  TokenTypeVerification,
} from "@/records/record-tokens";
import { ApiError } from "@/server/error";
import type { HandlerResult } from "@/server/handler";
import { structOf } from "@/server/unmarshal-request-data";
import { toString } from "@/tools/types/cast";
import { NewError } from "@/validation/error";
import { Required } from "@/validation/required";
import { Field, ValidateStruct } from "@/validation/struct";
import { By, type RuleFunc } from "@/validation/validation";

export async function recordConfirmVerification(e: RequestEvent): Promise<HandlerResult> {
  const collection = findAuthCollection(e);
  if (collection instanceof ApiError) {
    return collection;
  }

  if (collection.name === CollectionNameSuperusers) {
    return e.badRequestError("All superusers are verified by default.", null);
  }

  const form: RecordConfirmVerificationForm = { Token: "" };
  const bindErr = await e.bindBody(
    form as unknown as { [key: string]: unknown },
    recordConfirmVerificationType,
  );
  if (bindErr) {
    return firstApiError(
      bindErr,
      e.badRequestError("An error occurred while loading the submitted data.", bindErr),
    );
  }
  const validateErr = validateRecordConfirmVerificationForm(form, e.app, collection);
  if (validateErr) {
    return firstApiError(
      validateErr,
      e.badRequestError("An error occurred while validating the submitted data.", validateErr),
    );
  }

  let record: Record;
  try {
    record = findAuthRecordByToken(e.app, form.Token, TokenTypeVerification);
  } catch (err) {
    return e.badRequestError("Invalid or expired verification token.", err);
  }

  const wasVerified = record.verified();

  // the OnRecordConfirmVerificationRequest default action
  if (!wasVerified) {
    record.setVerified(true);

    // similar to the OTP auth, we enforce an extra password reset
    // guard as this way is less prone to pre-hijacking attacks
    // in case the password auth is eventually enabled later
    if (!record.collection().passwordAuth.enabled) {
      record.setRandomPassword();
    }

    try {
      await saveRecord(e.app, record);
    } catch (err) {
      return firstApiError(
        err,
        e.badRequestError("An error occurred while saving the verified state.", err),
      );
    }
  }

  e.app.store.remove(getVerificationResendKey(record));

  return e.noContent(204);
}

// -------------------------------------------------------------------

const recordConfirmVerificationType = structOf([
  { name: "Token", type: "string", tags: { form: "token", json: "token" } },
]);

interface RecordConfirmVerificationForm {
  Token: string;
}

function validateRecordConfirmVerificationForm(
  form: RecordConfirmVerificationForm,
  app: App,
  collection: Collection,
): Error | null {
  return ValidateStruct(Field("token", form.Token, Required, By(checkToken(app, collection))));
}

function checkToken(app: App, collection: Collection): RuleFunc {
  return (value) => {
    const v = typeof value === "string" ? value : "";
    if (v === "") {
      return null; // nothing to check
    }

    const claims = parseUnverifiedClaims(v, app.clock);
    const email = Object.hasOwn(claims, TokenClaimEmail) ? toString(claims[TokenClaimEmail]) : "";
    if (email === "") {
      return NewError("validation_invalid_token_claims", "Missing email token claim.");
    }

    let record: Record;
    try {
      record = findAuthRecordByToken(app, v, TokenTypeVerification);
    } catch {
      return NewError("validation_invalid_token", "Invalid or expired token.");
    }

    if (record.collection().id !== collection.id) {
      return NewError(
        "validation_token_collection_mismatch",
        "The provided token is for different auth collection.",
      );
    }

    if (record.email() !== email) {
      return NewError(
        "validation_token_email_mismatch",
        "The record email doesn't match with the requested token claims.",
      );
    }

    return null;
  };
}
