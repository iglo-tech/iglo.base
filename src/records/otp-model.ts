// Upstream: core/otp_model.go
//
// OTP is a record proxy of the `_otps` collection, as upstream's struct
// that embeds *Record: the accessors read and write the proxied record,
// which is what src/records/record-save.ts saves and deletes. saveOTP and
// deleteOTP run PreValidate first where app.Save and app.Delete do for a
// PreValidator model.
//
// registerOTPHooks: the record ref checks, the delete on auth record and
// collection delete and on tokenKey change are in
// src/records/record-auth-refs.ts and src/collections/collection-save.ts;
// the hourly `__pbOTPCleanup__` cron job (DeleteExpiredOTPs) is bound by
// the cron scheduler task (M5.6).

import type { Clock } from "@/app/clock";
import { findCachedCollectionByNameOrId } from "@/collections/collection-query";
import { type Collection, newBaseCollection } from "@/collections/collection-model";
import { CollectionNameOTPs } from "@/records/record-auth-refs";
import { newRecord, type Record } from "@/records/record-model";
import type { RecordsApp } from "@/records/record-query";
import { deleteRecord, saveRecord, validateRecord } from "@/records/record-save";
import type { DateTime } from "@/tools/types/datetime";

// OTP defines a Record proxy for working with the otps collection.
export class OTP {
  // the proxied record; undefined is Go's nil *Record
  record: Record | undefined;

  constructor(record?: Record) {
    this.record = record;
  }

  // PreValidate implements the [PreValidator] interface and checks
  // whether the proxy is properly loaded.
  preValidate(): Error | undefined {
    if (this.record === undefined || this.record.collection().name !== CollectionNameOTPs) {
      return new Error("missing or invalid otp ProxyRecord");
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

  // SentTo returns the "sentTo" record field value.
  //
  // It could be any string value (email, phone, message app id, etc.)
  // and usually is used as part of the auth flow to update the verified
  // user state in case for example the sentTo value matches with the user record email.
  sentTo(): string {
    return this.#rec().getString("sentTo");
  }

  // SetSentTo updates the "sentTo" record field value.
  setSentTo(val: string): void {
    this.#rec().set("sentTo", val);
  }

  // SetPassword sets the "password" record field value.
  setPassword(password: string): void {
    this.#rec().setPassword(password);
  }

  // ValidatePassword validates a plain password against the "password" record field.
  validatePassword(password: string): boolean {
    return this.#rec().validatePassword(password);
  }

  // Created returns the "created" record field value.
  created(): DateTime {
    return this.#rec().getDateTime("created");
  }

  // Updated returns the "updated" record field value.
  updated(): DateTime {
    return this.#rec().getDateTime("updated");
  }

  // HasExpired checks if the otp is expired, aka. whether it has been
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

// NewOTP instantiates and returns a new blank *OTP model.
//
// Example usage:
//
//	const otp = newOTP(app)
//	otp.setRecordRef(user.id)
//	otp.setCollectionRef(user.collection().id)
//	otp.setPassword(randomStringWithAlphabet(6, "1234567890"))
//	await saveOTP(app, otp)
export function newOTP(app: RecordsApp): OTP {
  let c: Collection;
  try {
    c = findCachedCollectionByNameOrId(app, CollectionNameOTPs);
  } catch {
    // this is just to make tests easier since otp is a system collection and it is expected to be always accessible
    // (note: the loaded record is further checked on OTP.PreValidate())
    c = newBaseCollection("__invalid__");
  }

  return new OTP(newRecord(c));
}

// app.Validate(otp)
export async function validateOTP(app: RecordsApp, m: OTP): Promise<void> {
  throwIf(m.preValidate());
  await validateRecord(app, m.record as Record);
}

// app.Save(otp)
export async function saveOTP(app: RecordsApp, m: OTP): Promise<void> {
  throwIf(m.preValidate());
  await saveRecord(app, m.record as Record);
}

// app.Delete(otp)
export async function deleteOTP(app: RecordsApp, m: OTP): Promise<void> {
  await deleteRecord(app, m.proxyRecord() as Record);
}

function throwIf(err: Error | undefined): void {
  if (err) {
    throw err;
  }
}
