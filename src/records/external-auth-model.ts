// Upstream: core/external_auth_model.go
//
// ExternalAuth is a record proxy of the `_externalAuths` collection, as
// upstream's struct that embeds *Record: the accessors read and write the
// proxied record, which is what src/records/record-save.ts saves and
// deletes. The save functions run PreValidate first where app.Save does for a
// PreValidator model.
//
// registerExternalAuthHooks: the record ref and provider checks, the delete
// on auth record and collection delete and on a verified upgrade are in
// src/records/record-auth-refs.ts and src/collections/collection-save.ts.

import { type Collection, newBaseCollection } from "@/collections/collection-model";
import { findCachedCollectionByNameOrId } from "@/collections/collection-query";
import { CollectionNameExternalAuths } from "@/records/record-auth-refs";
import { newRecord, type Record } from "@/records/record-model";
import type { RecordsApp } from "@/records/record-query";
import { deleteRecord, saveRecord, saveRecordSync, validateRecord } from "@/records/record-save";
import type { DateTime } from "@/tools/types/datetime";

// ExternalAuth defines a Record proxy for working with the externalAuths collection.
export class ExternalAuth {
  // the proxied record; undefined is Go's nil *Record
  record: Record | undefined;

  constructor(record?: Record) {
    this.record = record;
  }

  // PreValidate implements the [PreValidator] interface and checks
  // whether the proxy is properly loaded.
  preValidate(): Error | undefined {
    if (
      this.record === undefined ||
      this.record.collection().name !== CollectionNameExternalAuths
    ) {
      return new Error("missing or invalid ExternalAuth ProxyRecord");
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

  // Provider returns the "provider" record field value.
  provider(): string {
    return this.#rec().getString("provider");
  }

  // SetProvider updates the "provider" record field value.
  setProvider(provider: string): void {
    this.#rec().set("provider", provider);
  }

  // ProviderId returns the "providerId" record field value.
  providerId(): string {
    return this.#rec().getString("providerId");
  }

  // SetProviderId updates the "providerId" record field value.
  setProviderId(providerId: string): void {
    this.#rec().set("providerId", providerId);
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

// NewExternalAuth instantiates and returns a new blank *ExternalAuth model.
//
// Example usage:
//
//	const ea = newExternalAuth(app)
//	ea.setRecordRef(user.id)
//	ea.setCollectionRef(user.collection().id)
//	ea.setProvider("google")
//	ea.setProviderId("...")
//	await saveExternalAuth(app, ea)
export function newExternalAuth(app: RecordsApp): ExternalAuth {
  let c: Collection;
  try {
    c = findCachedCollectionByNameOrId(app, CollectionNameExternalAuths);
  } catch {
    // this is just to make tests easier since it is a system collection and it is expected to be always accessible
    // (note: the loaded record is further checked on ExternalAuth.PreValidate())
    c = newBaseCollection("@__invalid__");
  }

  return new ExternalAuth(newRecord(c));
}

// app.Validate(ea)
export async function validateExternalAuth(app: RecordsApp, m: ExternalAuth): Promise<void> {
  throwIf(m.preValidate());
  await validateRecord(app, m.record as Record);
}

// app.Save(ea)
export async function saveExternalAuth(app: RecordsApp, m: ExternalAuth): Promise<void> {
  throwIf(m.preValidate());
  await saveRecord(app, m.record as Record);
}

// app.Save(ea) inside a transaction
export function saveExternalAuthSync(app: RecordsApp, m: ExternalAuth): void {
  throwIf(m.preValidate());
  saveRecordSync(app, m.record as Record);
}

// app.Delete(ea)
export async function deleteExternalAuth(app: RecordsApp, m: ExternalAuth): Promise<void> {
  await deleteRecord(app, m.proxyRecord() as Record);
}

function throwIf(err: Error | undefined): void {
  if (err) {
    throw err;
  }
}
