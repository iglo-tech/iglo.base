// Upstream: core/mfa_model.go
//
// MFA is a record proxy of the `_mfas` collection, as upstream's struct
// that embeds *Record: the accessors read and write the proxied record,
// which is what src/records/record-save.ts saves and deletes.
// saveMFA and deleteMFA run PreValidate first, as app.Save does for a
// PreValidator model.
//
// registerMFAHooks: the record ref checks, the delete on auth record and
// collection delete and on password change are in
// src/records/record-auth-refs.ts and src/collections/collection-save.ts;
// the hourly `__pbMFACleanup__` cron job (DeleteExpiredMFAs) is in
// src/app/crons.ts.

import type { Clock } from "@/app/clock";
import { findCachedCollectionByNameOrId } from "@/collections/collection-query";
import { type Collection, newBaseCollection } from "@/collections/collection-model";
import { CollectionNameMFAs } from "@/records/record-auth-refs";
import { newRecord, type Record } from "@/records/record-model";
import type { RecordsApp } from "@/records/record-query";
import { deleteRecord, saveRecord, validateRecord } from "@/records/record-save";
import type { DateTime } from "@/tools/types/datetime";

export const MFAMethodPassword = "password";
export const MFAMethodOAuth2 = "oauth2";
export const MFAMethodOTP = "otp";

// MFA defines a Record proxy for working with the mfas collection.
export class MFA {
  // the proxied record; undefined is Go's nil *Record
  record: Record | undefined;

  constructor(record?: Record) {
    this.record = record;
  }

  // PreValidate implements the [PreValidator] interface and checks
  // whether the proxy is properly loaded.
  preValidate(): Error | undefined {
    if (this.record === undefined || this.record.collection().name !== CollectionNameMFAs) {
      return new Error("missing or invalid mfa ProxyRecord");
    }

    return undefined;
  }

  // ProxyRecord returns the proxied Record model.
  proxyRecord(): Record | undefined {
    return this.record;
  }

  // SetProxyRecord loads the specified record model into the current proxy.
  setProxyRecord(record: Record): void {
    this.record = record;
  }

  get id(): string {
    return this.#rec().id;
  }

  set id(id: string) {
    this.#rec().id = id;
  }

  isNew(): boolean {
    return this.#rec().isNew();
  }

  // CollectionRef returns the "collectionRef" field value.
  collectionRef(): string {
    return this.#rec().getString("collectionRef");
  }

  // SetCollectionRef updates the "collectionRef" record field value.
  setCollectionRef(collectionId: string): void {
    this.#rec().set("collectionRef", collectionId);
  }

  // RecordRef returns the "recordRef" record field value.
  recordRef(): string {
    return this.#rec().getString("recordRef");
  }

  // SetRecordRef updates the "recordRef" record field value.
  setRecordRef(recordId: string): void {
    this.#rec().set("recordRef", recordId);
  }

  // Method returns the "method" record field value.
  method(): string {
    return this.#rec().getString("method");
  }

  // SetMethod updates the "method" record field value.
  setMethod(method: string): void {
    this.#rec().set("method", method);
  }

  // Created returns the "created" record field value.
  created(): DateTime {
    return this.#rec().getDateTime("created");
  }

  // Updated returns the "updated" record field value.
  updated(): DateTime {
    return this.#rec().getDateTime("updated");
  }

  // HasExpired checks if the mfa is expired, aka. whether it has been
  // more than maxElapsed (Go's time.Duration in nanoseconds) since its
  // creation.
  hasExpired(maxElapsed: bigint, clock: Clock): boolean {
    const createdMs = this.created().time().getTime();
    const elapsedNs = BigInt(clock.now().getTime() - createdMs) * 1_000_000n;
    return elapsedNs > maxElapsed;
  }

  // a nil *Record dereference panics upstream
  #rec(): Record {
    if (this.record === undefined) {
      throw new TypeError("invalid memory address or nil pointer dereference");
    }
    return this.record;
  }
}

// NewMFA instantiates and returns a new blank *MFA model.
//
// Example usage:
//
//	const mfa = newMFA(app)
//	mfa.setRecordRef(user.id)
//	mfa.setCollectionRef(user.collection().id)
//	mfa.setMethod(MFAMethodPassword)
//	await saveMFA(app, mfa)
export function newMFA(app: RecordsApp): MFA {
  let c: Collection;
  try {
    c = findCachedCollectionByNameOrId(app, CollectionNameMFAs);
  } catch {
    c = newBaseCollection("@__invalid__");
  }

  return new MFA(newRecord(c));
}

// app.Validate(mfa)
export async function validateMFA(app: RecordsApp, m: MFA): Promise<void> {
  throwIf(m.preValidate());
  await validateRecord(app, m.record as Record);
}

// app.Save(mfa)
export async function saveMFA(app: RecordsApp, m: MFA): Promise<void> {
  throwIf(m.preValidate());
  await saveRecord(app, m.record as Record);
}

// app.Delete(mfa)
export async function deleteMFA(app: RecordsApp, m: MFA): Promise<void> {
  await deleteRecord(app, m.proxyRecord() as Record);
}

function throwIf(err: Error | undefined): void {
  if (err) {
    throw err;
  }
}
