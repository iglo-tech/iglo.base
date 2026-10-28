// Upstream: the record handlers of core/external_auth_model.go
// (registerExternalAuthHooks), core/mfa_model.go (registerMFAHooks),
// core/otp_model.go (registerOTPHooks) and core/auth_origin_model.go
// (registerAuthOriginHooks, recordRefHooks), with validateCollectionId and
// validateRecordId (core/db.go) and the FindAll*ByRecord /
// DeleteAll*ByRecord queries of core/{external_auth,mfa,otp,auth_origin}_query.go
// on plain Records
//
// These handlers are part of every record's save and delete chain: an
// auth record's delete removes the _externalAuths, _mfas, _otps and
// _authOrigins records that point to it, a password change removes its
// MFAs and auth origins, a token key change its OTPs, and a verified
// upgrade its external auths; the four collections' records are checked
// for a valid collectionRef and recordRef (and _externalAuths for a known
// provider). There is no hook system (D5): src/records/record-save.ts calls
// the steps below at their place in the chain.
//
// The ExternalAuth, MFA, OTP and AuthOrigin models (record proxies with
// their own accessors) and the auth flows that create those records come
// with the auth tasks (M4.x); the queries here return Records. Not here:
// their OnCollectionDeleteExecute handlers (the collection delete path),
// the expired MFA/OTP cron jobs and the models' PreValidate checks (only
// for the proxies).

import { CollectionTypeAuth, Collection } from "@/collections/collection-model";
import {
  collectionQuery,
  findCachedCollectionByNameOrId,
  runInAppTransaction,
} from "@/collections/collection-query";
import { joinErrors, wrapError } from "@/collections/view";
import { HashExp } from "@/db/dbx/expression";
import { FieldNamePassword, goQuote } from "@/fields/field";
import { isProviderName } from "@/oauth2/provider-names";
import type { Record } from "@/records/record-model";
import {
  findAllRecords,
  recordQuery,
  recordsTarget,
  type RecordsApp,
} from "@/records/record-query";
import { deleteStep, type Next, runSync, type Step } from "@/records/record-save";
import { Errors, NewError } from "@/validation/error";
import { ErrInInvalid } from "@/validation/in";
import { Required } from "@/validation/required";
import { By, type RuleFunc, Validate } from "@/validation/validation";

export const CollectionNameExternalAuths = "_externalAuths";
export const CollectionNameMFAs = "_mfas";
export const CollectionNameOTPs = "_otps";
export const CollectionNameAuthOrigins = "_authOrigins";

// the collections with recordRefHooks, in their registration order
const refCollectionNames = [
  CollectionNameExternalAuths,
  CollectionNameMFAs,
  CollectionNameOTPs,
  CollectionNameAuthOrigins,
] as const;

// -------------------------------------------------------------------
// OnRecordValidate (99)

// the OnRecordValidate handlers of the four collections: the collectionRef
// and recordRef checks (recordRefHooks), and for _externalAuths the
// provider check. Throws the validation Errors.
export function validateRefs(app: RecordsApp, record: Record): void {
  const name = record.collection().name;
  if (!(refCollectionNames as readonly string[]).includes(name)) {
    return;
  }

  const collectionId = record.getString("collectionRef");
  let err = Validate(collectionId, Required, By(validateCollectionId(app, CollectionTypeAuth)));
  if (err !== null) {
    throw new Errors({ collectionRef: err });
  }

  const recordId = record.getString("recordRef");
  err = Validate(recordId, Required, By(validateRecordId(app, collectionId)));
  if (err !== null) {
    throw new Errors({ recordRef: err });
  }

  if (name === CollectionNameExternalAuths) {
    const provider = record.getString("provider");
    // validation.In(providerNames...): the keys of auth.Providers
    err = Validate(
      provider,
      Required,
      By((v) => (isProviderName(v as string) ? null : ErrInInvalid)),
    );
    if (err !== null) {
      throw new Errors({ provider: err });
    }
  }
}

// core/db.go validateCollectionId
function validateCollectionId(app: RecordsApp, ...optTypes: string[]): RuleFunc {
  return (value) => {
    const id = typeof value === "string" ? value : "";
    if (id === "") {
      return null;
    }

    const collection = new Collection();
    try {
      collectionQuery(app).model(id, collection);
    } catch {
      return NewError("validation_invalid_collection_id", "Missing or invalid collection.");
    }

    if (optTypes.length > 0 && !optTypes.includes(collection.type)) {
      return NewError(
        "validation_invalid_collection_type",
        `Invalid collection type - must be ${optTypes.join(", ")}.`,
      );
    }

    return null;
  };
}

// core/db.go validateRecordId
function validateRecordId(app: RecordsApp, collectionNameOrId: string): RuleFunc {
  return (value) => {
    const id = typeof value === "string" ? value : "";
    if (id === "") {
      return null;
    }

    let collection: Collection;
    try {
      collection = findCachedCollectionByNameOrId(app, collectionNameOrId);
    } catch {
      return NewError("validation_invalid_collection", "Missing or invalid collection.");
    }

    let exists = 0;
    try {
      const [v] = app.databases
        .concurrentDB()
        .select("(1)")
        .from(collection.name)
        .andWhere(new HashExp({ id }))
        .limit(1)
        .row();
      exists = Number(v);
    } catch {
      exists = 0;
    }

    if (exists === 0) {
      return NewError("validation_invalid_record", "Missing or invalid record.");
    }

    return null;
  };
}

// -------------------------------------------------------------------
// OnRecordUpdate (99)

// registerMFAHooks: delete existing mfas on password change
export function* mfasOnUpdate(app: RecordsApp, record: Record, next: Next): Step {
  yield* next(app);

  if (!record.collection().isAuth()) {
    return;
  }

  const oldHash = record.original().getString(FieldNamePassword + ":hash");
  const newHash = record.getString(FieldNamePassword + ":hash");
  if (oldHash !== newHash) {
    try {
      yield* deleteAllRefsByRecord(app, CollectionNameMFAs, record);
    } catch (err) {
      throw wrapError(
        `[${record.collection().name}] failed to delete all previous MFAs for record ${goQuote(record.id)}`,
        err,
      );
    }
  }
}

// registerAuthOriginHooks: delete existing auth origins on password change
export function* authOriginsOnUpdate(app: RecordsApp, record: Record, next: Next): Step {
  yield* next(app);

  if (!record.collection().isAuth()) {
    return;
  }

  const oldHash = record.original().getString(FieldNamePassword + ":hash");
  const newHash = record.getString(FieldNamePassword + ":hash");
  if (oldHash !== newHash) {
    try {
      yield* deleteAllRefsByRecord(app, CollectionNameAuthOrigins, record);
    } catch (err) {
      app.logger.error(
        `Failed to delete all previous auth origin fingerprints (recordId ${record.id}, collectionId ${record.collection().id})`,
        err,
      );
    }
  }
}

// -------------------------------------------------------------------
// OnRecordUpdateExecute (99)

// registerExternalAuthHooks: delete all pre-existing external auths on
// verified upgrade
export function* externalAuthsOnUpdateExecute(app: RecordsApp, record: Record, next: Next): Step {
  if (!record.collection().isAuth()) {
    yield* next(app);
    return;
  }

  const original = record.original();
  const hasUpgradedVerified = !original.isNew() && !original.verified() && record.verified();

  if (!hasUpgradedVerified) {
    yield* next(app);
    return;
  }

  runInAppTransaction(app, (txApp) => {
    const externalAuths = findAllRefsByRecord(txApp, CollectionNameExternalAuths, record);
    if (externalAuths.length > 0) {
      // delete all pre-existing external auths
      runSync(deleteAllRefsByRecord(txApp, CollectionNameExternalAuths, record));

      // force refresh tokens reset (if not already)
      record.refreshTokenKey();
    }

    runSync(next(txApp));
  });
}

// registerOTPHooks: delete all record OTPs on tokenKey change to minimize
// the risk of hijacking attacks
export function* otpsOnUpdateExecute(app: RecordsApp, record: Record, next: Next): Step {
  yield* next(app);

  if (!record.collection().isAuth()) {
    return;
  }

  const original = record.original();
  if (!original.isNew() && original.tokenKey() !== record.tokenKey()) {
    try {
      yield* deleteAllRefsByRecord(app, CollectionNameOTPs, record);
    } catch (err) {
      throw wrapError(
        `[${record.collection().name}] failed to delete all previous OTPs for record ${goQuote(record.id)}`,
        err,
      );
    }
  }
}

// -------------------------------------------------------------------
// OnRecordDeleteExecute (99)

// recordRefHooks of the four collections, in their registration order:
// each deletes, in a transaction, the records of its collection that
// point to the deleted auth record, after the rest of the chain.
export function* refsOnDeleteExecute(app: RecordsApp, record: Record, next: Next): Step {
  yield* refOnDeleteExecute(app, record, 0, next);
}

function* refOnDeleteExecute(app: RecordsApp, record: Record, i: number, next: Next): Step {
  const collectionName = refCollectionNames[i];
  if (collectionName === undefined) {
    yield* next(app);
    return;
  }

  const nextRef: Next = (refApp) => refOnDeleteExecute(refApp, record, i + 1, next);

  if (
    record.collection().name === collectionName ||
    record.collection().type !== CollectionTypeAuth
  ) {
    yield* nextRef(app);
    return;
  }

  runInAppTransaction(app, (txApp) => {
    runSync(nextRef(txApp));

    const rels = findAllRecords(
      txApp,
      collectionName,
      new HashExp({
        collectionRef: record.collection().id,
        recordRef: record.id,
      }),
    );

    for (const rel of rels) {
      runSync(deleteStep(txApp, rel));
    }
  });
}

// -------------------------------------------------------------------
// queries

// FindAllExternalAuthsByRecord, FindAllMFAsByRecord, FindAllOTPsByRecord,
// FindAllAuthOriginsByRecord: the records of collectionName associated
// with the provided auth record, the newest first.
export function findAllRefsByRecord(
  app: RecordsApp,
  collectionName: string,
  authRecord: Record,
): Record[] {
  return recordQuery(app, collectionName)
    .andWhere(
      new HashExp({
        collectionRef: authRecord.collection().id,
        recordRef: authRecord.id,
      }),
    )
    .orderBy("created DESC")
    .all<Record>(recordsTarget);
}

// DeleteAllExternalAuthsByRecord, DeleteAllMFAsByRecord,
// DeleteAllOTPsByRecord, DeleteAllAuthOriginsByRecord: deletes all records
// of collectionName associated with the provided auth record.
//
// Throws a combined error with the failed deletes.
export function* deleteAllRefsByRecord(
  app: RecordsApp,
  collectionName: string,
  authRecord: Record,
): Step {
  const models = findAllRefsByRecord(app, collectionName, authRecord);

  const errs: unknown[] = [];
  for (const m of models) {
    try {
      yield* deleteStep(app, m);
    } catch (err) {
      errs.push(err);
    }
  }
  if (errs.length > 0) {
    throw joinErrors(errs);
  }
}
