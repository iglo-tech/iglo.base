// Upstream: apis/record_auth_with_password.go
//
// The OnRecordAuthWithPasswordRequest hook is not ported (no extension
// surface): its default action runs directly.

import {
  type RequestEvent,
  RequestEventKeyInfoContext,
  RequestInfoContextPasswordAuth,
} from "@/app/event-request";
import { findAuthCollection } from "@/apis/record-auth";
import { firstApiError, recordAuthResponseWithNewToken } from "@/apis/record-helpers";
import type { Collection } from "@/collections/collection-model";
import { equalFold } from "@/collections/go-strings";
import { type Expression, HashExp, newExp } from "@/db/dbx/expression";
import { FieldNameEmail } from "@/fields/field";
import { MFAMethodPassword } from "@/records/mfa-model";
import type { Record } from "@/records/record-model";
import { recordQuery, recordTarget, type RecordsApp } from "@/records/record-query";
import { isNoRows } from "@/records/record-save";
import { ApiError } from "@/server/error";
import type { HandlerResult } from "@/server/handler";
import { structOf } from "@/server/unmarshal-request-data";
import { findSingleColumnUniqueIndex } from "@/tools/dbutils/index";
import { In } from "@/validation/in";
import { EmailFormat } from "@/validation/is/rules";
import { Length } from "@/validation/length";
import { Required } from "@/validation/required";
import { Field, ValidateStruct } from "@/validation/struct";
import { Validate } from "@/validation/validation";

export async function recordAuthWithPassword(e: RequestEvent): Promise<HandlerResult> {
  const collection = findAuthCollection(e);
  if (collection instanceof ApiError) {
    return collection;
  }

  if (!collection.passwordAuth.enabled) {
    return e.forbiddenError(
      "The collection is not configured to allow password authentication.",
      null,
    );
  }

  const form: AuthWithPasswordForm = { Identity: "", Password: "", IdentityField: "" };
  const bindErr = await e.bindBody(
    form as unknown as { [key: string]: unknown },
    authWithPasswordType,
  );
  if (bindErr) {
    return firstApiError(
      bindErr,
      e.badRequestError("An error occurred while loading the submitted data.", bindErr),
    );
  }
  const validateErr = validateAuthWithPasswordForm(form, collection);
  if (validateErr) {
    return firstApiError(
      validateErr,
      e.badRequestError("An error occurred while validating the submitted data.", validateErr),
    );
  }

  e.set(RequestEventKeyInfoContext, RequestInfoContextPasswordAuth);

  let foundRecord: Record | undefined;
  let foundErr: unknown = null;

  const find = (field: string): void => {
    foundRecord = undefined;
    foundErr = null;
    try {
      foundRecord = findRecordByIdentityField(e.app, collection, field, form.Identity);
    } catch (err) {
      foundErr = err;
    }
  };

  if (form.IdentityField !== "") {
    find(form.IdentityField);
  } else {
    let identityFields = collection.passwordAuth.identityFields;

    // @todo consider removing with the stable release or moving it in the collection save
    //
    // prioritize email lookup to minimize breaking changes with earlier versions
    if (identityFields.length > 1 && identityFields[0] !== FieldNameEmail) {
      identityFields = identityFields.toSorted((a, b) => {
        if (a === "email") {
          return -1;
        }
        if (b === "email") {
          return 1;
        }
        return 0;
      });
    }

    for (const name of identityFields) {
      if (name === FieldNameEmail && Validate(form.Identity, EmailFormat) !== null) {
        continue; // no need to query the database if we know that the submitted value is not an email
      }

      find(name);
      if (foundErr === null) {
        break;
      }
    }
  }

  // ignore not found errors to allow custom record find implementations
  if (foundErr !== null && !isNoRows(foundErr)) {
    return e.internalServerError("", foundErr);
  }

  // the OnRecordAuthWithPasswordRequest default action
  const record = foundRecord as Record | undefined;
  if (record === undefined || !record.validatePassword(form.Password)) {
    // dummy password check to minimize enumeration side-channel attacks
    if (record === undefined) {
      dummyPasswordCheck(e.app, collection);
    }

    return e.badRequestError("Failed to authenticate.", new Error("invalid login credentials"));
  }

  return recordAuthResponseWithNewToken(e, record, MFAMethodPassword, undefined);
}

// -------------------------------------------------------------------

const authWithPasswordType = structOf([
  { name: "Identity", type: "string", tags: { form: "identity", json: "identity" } },
  { name: "Password", type: "string", tags: { form: "password", json: "password" } },
  // IdentityField specifies the field to use to search for the identity
  // (leave it empty for "auto" detection).
  { name: "IdentityField", type: "string", tags: { form: "identityField", json: "identityField" } },
]);

interface AuthWithPasswordForm {
  Identity: string;
  Password: string;
  IdentityField: string;
}

function validateAuthWithPasswordForm(
  form: AuthWithPasswordForm,
  collection: Collection,
): Error | null {
  return ValidateStruct(
    Field("identity", form.Identity, Required, Length(1, 255)),
    Field("password", form.Password, Required, Length(1, 255)),
    Field(
      "identityField",
      form.IdentityField,
      Length(1, 255),
      In(...collection.passwordAuth.identityFields),
    ),
  );
}

// dummy password check to minimize side-channel attacks
// (performed with the collection configured field cost)
function dummyPasswordCheck(app: RecordsApp, collection: Collection): void {
  let record: Record;

  // find any random existing record
  try {
    record = recordQuery(app, collection).limit(1).one<Record>(recordTarget);
  } catch {
    return;
  }

  // the value and result doesn't matter, we just need a constant-time check
  record.validatePassword("");
}

function findRecordByIdentityField(
  app: RecordsApp,
  collection: Collection,
  field: string,
  value: unknown,
): Record {
  if (!collection.passwordAuth.identityFields.includes(field)) {
    throw new Error("invalid identity field " + field);
  }

  const [index, ok] = findSingleColumnUniqueIndex(collection.indexes, field);
  if (!ok) {
    throw new Error("missing " + field + " unique index constraint");
  }

  let expr: Expression;
  if (equalFold(index.columns[0]?.collate ?? "", "nocase")) {
    // case-insensitive search
    expr = newExp("[[" + field + "]] = {:identity} COLLATE NOCASE", { identity: value });
  } else {
    expr = new HashExp({ [field]: value });
  }

  return recordQuery(app, collection).andWhere(expr).limit(1).one<Record>(recordTarget);
}
