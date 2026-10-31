// Upstream: apis/record_auth_otp_request.go
//
// The OnRecordRequestOTPRequest hook is not ported (no extension surface):
// its default action runs directly. The handler never runs in a
// transaction, so execAfterSuccessTx is the plain response write. The
// email goes out in the background after the row is written, as upstream's
// routine.FireAndForget; a failed send removes the OTP and leaves the
// response unchanged.

import type { RequestEvent } from "@/app/event-request";
import { findAuthCollection } from "@/apis/record-auth";
import { firstApiError } from "@/apis/record-helpers";
import { joinErrors } from "@/collections/view";
import { generateDefaultRandomId } from "@/db/db";
import { sendRecordOTP } from "@/mail/mails/record";
import { deleteOTP, newOTP, type OTP, saveOTP } from "@/records/otp-model";
import { findAllOTPsByRecord } from "@/records/otp-query";
import type { Record } from "@/records/record-model";
import { findAuthRecordByEmail } from "@/records/record-query";
import { isNoRows } from "@/records/record-save";
import { ApiError } from "@/server/error";
import type { HandlerResult } from "@/server/handler";
import { structOf } from "@/server/unmarshal-request-data";
import { randomStringWithAlphabet } from "@/tools/security/random";
import { EmailFormat } from "@/validation/is/rules";
import { Length } from "@/validation/length";
import { Required } from "@/validation/required";
import { Field, ValidateStruct } from "@/validation/struct";

export async function recordRequestOTP(e: RequestEvent): Promise<HandlerResult> {
  const collection = findAuthCollection(e);
  if (collection instanceof ApiError) {
    return collection;
  }

  if (!collection.otp.enabled) {
    return e.forbiddenError("The collection is not configured to allow OTP authentication.", null);
  }

  const form: CreateOTPForm = { Email: "" };
  const bindErr = await e.bindBody(form as unknown as { [key: string]: unknown }, createOTPType);
  if (bindErr) {
    return firstApiError(
      bindErr,
      e.badRequestError("An error occurred while loading the submitted data.", bindErr),
    );
  }
  const validateErr = validateCreateOTPForm(form);
  if (validateErr) {
    return firstApiError(
      validateErr,
      e.badRequestError("An error occurred while validating the submitted data.", validateErr),
    );
  }

  let record: Record | undefined;
  try {
    record = findAuthRecordByEmail(e.app, collection, form.Email);
  } catch (err) {
    // ignore not found errors to allow custom record find implementations
    if (!isNoRows(err)) {
      return e.internalServerError("", err);
    }
  }

  const password = randomStringWithAlphabet(Number(collection.otp.length), "1234567890");

  // the OnRecordRequestOTPRequest default action
  if (record === undefined) {
    // write a dummy 200 response as a very rudimentary emails enumeration "protection"
    e.json(200, { otpId: generateDefaultRandomId() });

    return new Error(
      `missing or invalid ${collection.name} OTP auth record with email ${form.Email}`,
    );
  }

  let otp: OTP | undefined;

  // limit the new OTP creations for a single user
  if (!e.app.isDev) {
    let otps: OTP[];
    try {
      otps = findAllOTPsByRecord(e.app, record);
    } catch (err) {
      return firstApiError(
        err,
        e.internalServerError("Failed to fetch previous record OTPs.", err),
      );
    }

    let totalRecent = 0;
    for (const existingOTP of otps) {
      if (!existingOTP.hasExpired(collection.otp.durationTime(), e.app.clock)) {
        totalRecent++;
      }
      // use the last issued one
      if (totalRecent > 9) {
        otp = otps[0]; // otps are DESC sorted
        e.app.logger.error(
          `Too many OTP requests - reusing the last issued (email ${form.Email}, recordId ${record.id}, otpId ${existingOTP.id})`,
        );
        break;
      }
    }
  }

  if (otp === undefined) {
    // create new OTP
    // ---
    otp = newOTP(e.app);
    otp.setCollectionRef(record.collection().id);
    otp.setRecordRef(record.id);
    otp.setPassword(password);
    try {
      await saveOTP(e.app, otp);
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }

    // send OTP email
    // (in the background as a very basic timing attacks and emails enumeration protection)
    // ---
    void sendOTPInBackground(e, record, otp, password);
  }

  return e.json(200, { otpId: otp.id });
}

async function sendOTPInBackground(
  e: RequestEvent,
  record: Record,
  otp: OTP,
  password: string,
): Promise<void> {
  const app = e.app;
  try {
    await sendRecordOTP(app, record, otp.id, password);
  } catch (sendErr) {
    const errs = [sendErr];
    try {
      await deleteOTP(app, otp);
    } catch (deleteErr) {
      errs.push(deleteErr);
    }
    app.logger.error("Failed to send OTP email", joinErrors(errs));
  }
}

// -------------------------------------------------------------------

const createOTPType = structOf([
  { name: "Email", type: "string", tags: { form: "email", json: "email" } },
]);

interface CreateOTPForm {
  Email: string;
}

function validateCreateOTPForm(form: CreateOTPForm): Error | null {
  return ValidateStruct(Field("email", form.Email, Required, Length(1, 255), EmailFormat));
}
