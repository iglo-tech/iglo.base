// Upstream: apis/record_auth_with_otp.go
//
// The OnRecordAuthWithOTPRequest hook is not ported (no extension
// surface): its default action runs directly.

import {
  type RequestEvent,
  RequestEventKeyInfoContext,
  RequestInfoContextOTP,
} from "@/app/event-request";
import { findAuthCollection } from "@/apis/record-auth";
import { firstApiError, recordAuthResponseWithNewToken } from "@/apis/record-helpers";
import { checkRateLimit } from "@/middlewares/rate-limit";
import { MFAMethodOTP } from "@/records/mfa-model";
import { deleteOTP, type OTP } from "@/records/otp-model";
import { findOTPById } from "@/records/otp-query";
import type { Record } from "@/records/record-model";
import { findRecordById } from "@/records/record-query";
import { saveRecord } from "@/records/record-save";
import { ApiError } from "@/server/error";
import type { HandlerResult } from "@/server/handler";
import { structOf } from "@/server/unmarshal-request-data";
import { Length } from "@/validation/length";
import { Required } from "@/validation/required";
import { Field, ValidateStruct } from "@/validation/struct";

export async function recordAuthWithOTP(e: RequestEvent): Promise<HandlerResult> {
  const collection = findAuthCollection(e);
  if (collection instanceof ApiError) {
    return collection;
  }

  if (!collection.otp.enabled) {
    return e.forbiddenError("The collection is not configured to allow OTP authentication.", null);
  }

  const form: AuthWithOTPForm = { OTPId: "", Password: "" };
  const bindErr = await e.bindBody(form as unknown as { [key: string]: unknown }, authWithOTPType);
  if (bindErr) {
    return firstApiError(
      bindErr,
      e.badRequestError("An error occurred while loading the submitted data.", bindErr),
    );
  }
  const validateErr = validateAuthWithOTPForm(form);
  if (validateErr) {
    return firstApiError(
      validateErr,
      e.badRequestError("An error occurred while validating the submitted data.", validateErr),
    );
  }

  e.set(RequestEventKeyInfoContext, RequestInfoContextOTP);

  // extra validations
  // (note: returns a generic 400 as a very basic OTPs enumeration protection)
  // ---
  let otp: OTP;
  try {
    otp = findOTPById(e.app, form.OTPId);
  } catch (err) {
    return e.badRequestError("Invalid or expired OTP", err);
  }

  if (otp.collectionRef() !== collection.id) {
    return e.badRequestError(
      "Invalid or expired OTP",
      new Error("the OTP is for a different collection"),
    );
  }

  if (otp.hasExpired(collection.otp.durationTime(), e.app.clock)) {
    return e.badRequestError("Invalid or expired OTP", new Error("the OTP is expired"));
  }

  let record: Record;
  try {
    record = findRecordById(e.app, otp.collectionRef(), otp.recordRef());
  } catch (err) {
    return e.badRequestError(
      "Invalid or expired OTP",
      new Error(`missing auth record: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      }),
    );
  }

  // since otps are usually simple digit numbers, enforce an extra rate limit rule as basic enumeration protection
  const rateLimitErr = checkRateLimit(e, "@pb_otp_" + record.id, {
    Label: "",
    Audience: "",
    Duration: 180,
    MaxRequests: 5,
  });
  if (rateLimitErr) {
    return e.tooManyRequestsError(
      "Too many attempts, please try again later with a new OTP.",
      null,
    );
  }

  if (!otp.validatePassword(form.Password)) {
    return e.badRequestError("Invalid or expired OTP", new Error("incorrect password"));
  }
  // ---

  // the OnRecordAuthWithOTPRequest default action
  const otpId = otp.id;
  const otpSentTo = otp.sentTo();

  // eagerly delete the OTP to avoid unnecessary double delete model hook calls
  // triggered by the password change below
  try {
    await deleteOTP(e.app, otp);
  } catch (err) {
    e.app.logger.error(`Failed to delete used OTP (otpId ${otpId})`, err);
  }

  // update the user email verified state in case the OTP originate from an email address matching the current record one
  //
  // note: don't wait for success auth response (it could fail because of MFA) and because we already validated the OTP above
  if (!record.verified() && otpSentTo !== "" && record.email() === otpSentTo) {
    record.setVerified(true);

    // this is technically not required but we enforce password
    // reset on verified upgrades in case the OTP is used on its own
    // since this makes it less error prone to pre-hijacking attacks
    if (!record.collection().mfa.enabled) {
      record.setRandomPassword();
    }

    try {
      await saveRecord(e.app, record);
    } catch (err) {
      e.app.logger.error(
        `Failed to update record verified state after successful OTP validation (otpId ${otpId}, recordId ${record.id})`,
        err,
      );
    }
  }

  return recordAuthResponseWithNewToken(e, record, MFAMethodOTP, undefined);
}

// -------------------------------------------------------------------

const authWithOTPType = structOf([
  { name: "OTPId", type: "string", tags: { form: "otpId", json: "otpId" } },
  { name: "Password", type: "string", tags: { form: "password", json: "password" } },
]);

interface AuthWithOTPForm {
  OTPId: string;
  Password: string;
}

function validateAuthWithOTPForm(form: AuthWithOTPForm): Error | null {
  return ValidateStruct(
    Field("otpId", form.OTPId, Required, Length(1, 255)),
    Field("password", form.Password, Required, Length(1, 71)),
  );
}
