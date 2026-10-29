// Upstream: core/auth_origin_model.go
//
// AuthOrigin is a record proxy of the `_authOrigins` collection, as
// upstream's struct that embeds *Record: the accessors read and write the
// proxied record, which is what src/records/record-save.ts saves and
// deletes. saveAuthOrigin runs PreValidate first, as app.Save does for a
// PreValidator model.
//
// registerAuthOriginHooks: the record ref checks, the delete on auth
// record and collection delete and on password change are in
// src/records/record-auth-refs.ts and src/collections/collection-save.ts.

import { findCachedCollectionByNameOrId } from "@/collections/collection-query";
import { type Collection, newBaseCollection } from "@/collections/collection-model";
import { CollectionNameAuthOrigins } from "@/records/record-auth-refs";
import { newRecord, type Record } from "@/records/record-model";
import type { RecordsApp } from "@/records/record-query";
import { deleteRecord, saveRecord, validateRecord } from "@/records/record-save";
import type { DateTime } from "@/tools/types/datetime";

// AuthOrigin defines a Record proxy for working with the authOrigins collection.
export class AuthOrigin {
  // the proxied record; undefined is Go's nil *Record
  record: Record | undefined;

  constructor(record?: Record) {
    this.record = record;
  }

  // PreValidate implements the [PreValidator] interface and checks
  // whether the proxy is properly loaded.
  preValidate(): Error | undefined {
    if (this.record === undefined || this.record.collection().name !== CollectionNameAuthOrigins) {
      return new Error("missing or invalid AuthOrigin ProxyRecord");
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

  // Fingerprint returns the "fingerprint" record field value.
  fingerprint(): string {
    return this.#rec().getString("fingerprint");
  }

  // SetFingerprint updates the "fingerprint" record field value.
  setFingerprint(fingerprint: string): void {
    this.#rec().set("fingerprint", fingerprint);
  }

  // Created returns the "created" record field value.
  created(): DateTime {
    return this.#rec().getDateTime("created");
  }

  // Updated returns the "updated" record field value.
  updated(): DateTime {
    return this.#rec().getDateTime("updated");
  }

  // a nil *Record dereference panics upstream
  #rec(): Record {
    if (this.record === undefined) {
      throw new TypeError("invalid memory address or nil pointer dereference");
    }
    return this.record;
  }
}

// NewAuthOrigin instantiates and returns a new blank *AuthOrigin model.
//
// Example usage:
//
//	const origin = newAuthOrigin(app)
//	origin.setRecordRef(user.id)
//	origin.setCollectionRef(user.collection().id)
//	origin.setFingerprint("...")
//	await saveAuthOrigin(app, origin)
export function newAuthOrigin(app: RecordsApp): AuthOrigin {
  let c: Collection;
  try {
    c = findCachedCollectionByNameOrId(app, CollectionNameAuthOrigins);
  } catch {
    c = newBaseCollection("@___invalid___");
  }

  return new AuthOrigin(newRecord(c));
}

// app.Validate(authOrigin)
export async function validateAuthOrigin(app: RecordsApp, m: AuthOrigin): Promise<void> {
  throwIf(m.preValidate());
  await validateRecord(app, m.record as Record);
}

// app.Save(authOrigin)
export async function saveAuthOrigin(app: RecordsApp, m: AuthOrigin): Promise<void> {
  throwIf(m.preValidate());
  await saveRecord(app, m.record as Record);
}

// app.Delete(authOrigin)
export async function deleteAuthOrigin(app: RecordsApp, m: AuthOrigin): Promise<void> {
  await deleteRecord(app, m.proxyRecord() as Record);
}

function throwIf(err: Error | undefined): void {
  if (err) {
    throw err;
  }
}
