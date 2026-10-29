// Upstream: apis/record_auth_impersonate.go

import type { RequestEvent } from "@/app/event-request";
import { findAuthCollection } from "@/apis/record-auth";
import { recordAuthResponse } from "@/apis/record-helpers";
import type { Record } from "@/records/record-model";
import { findRecordById } from "@/records/record-query";
import { newStaticAuthToken } from "@/records/record-tokens";
import { ApiError } from "@/server/error";
import type { HandlerResult } from "@/server/handler";
import { structOf } from "@/server/unmarshal-request-data";
import { Min } from "@/validation/minmax";
import { Field, ValidateStruct } from "@/validation/struct";

// note: for now allow superusers but it may change in the future to allow access
// also to users with "Manage API" rule access depending on the use cases that will arise
export async function recordAuthImpersonate(e: RequestEvent): Promise<HandlerResult> {
  if (!e.hasSuperuserAuth()) {
    return e.forbiddenError("", null);
  }

  const collection = findAuthCollection(e);
  if (collection instanceof ApiError) {
    return collection;
  }

  let record: Record;
  try {
    record = findRecordById(e.app, collection, e.request.pathValue("id"));
  } catch (err) {
    return e.notFoundError("", err);
  }

  const form: ImpersonateForm = { Duration: 0 };
  const bindErr = await e.bindBody(form as unknown as { [key: string]: unknown }, impersonateType);
  if (bindErr) {
    return e.badRequestError("An error occurred while loading the submitted data.", bindErr);
  }
  const validateErr = validateImpersonateForm(form);
  if (validateErr) {
    return e.badRequestError("An error occurred while validating the submitted data.", validateErr);
  }

  let token: string;
  try {
    // time.Duration(form.Duration) * time.Second, with Go's int64 wrap
    const duration = BigInt.asIntN(64, BigInt(form.Duration) * 1_000_000_000n);
    token = newStaticAuthToken(record, duration, e.app.clock);
  } catch (err) {
    return e.internalServerError("Failed to generate static auth token", err);
  }

  return recordAuthResponse(e, record, token, "", undefined);
}

// -------------------------------------------------------------------

const impersonateType = structOf([
  // Duration is the optional custom token duration in seconds.
  { name: "Duration", type: "int64", tags: { form: "duration", json: "duration" } },
]);

interface ImpersonateForm {
  Duration: number | bigint;
}

function validateImpersonateForm(form: ImpersonateForm): Error | null {
  return ValidateStruct(Field("duration", form.Duration, Min(0)));
}
