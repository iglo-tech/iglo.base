// The record finders the ported model tests use, until M1.8b ports
// RecordQuery: upstream's tests load their records with app.FindRecordById
// and app.FindAuthRecordByEmail; here the row is read with the db builder
// and turned into a Record with newRecordFromNullStringMap, as RecordQuery
// does. The app is a writable temporary copy of the vendored fixture
// (test/collections/app.ts).

import { findCollectionByNameOrId } from "@/collections/collection-query";
import type { Collection } from "@/collections/collection-model";
import { HashExp, newExp } from "@/db/dbx/expression";
import {
  type Record,
  newRecordFromNullStringMap,
  nullStringMapFromRow,
} from "@/records/record-model";

import type { TestCollectionsApp } from "@test/collections/app";

function collectionOf(app: TestCollectionsApp, c: Collection | string): Collection {
  return typeof c === "string" ? findCollectionByNameOrId(app, c) : c;
}

// FindRecordById
export function findRecordById(
  app: TestCollectionsApp,
  collectionModelOrIdentifier: Collection | string,
  recordId: string,
): Record {
  const collection = collectionOf(app, collectionModelOrIdentifier);
  const row = app.databases
    .concurrentDB()
    .select(`${collection.name}.*`)
    .from(collection.name)
    .where(new HashExp({ id: recordId }))
    .limit(1)
    .one();
  return newRecordFromNullStringMap(collection, nullStringMapFromRow(row));
}

// FindAuthRecordByEmail
export function findAuthRecordByEmail(
  app: TestCollectionsApp,
  collectionModelOrIdentifier: Collection | string,
  email: string,
): Record {
  const collection = collectionOf(app, collectionModelOrIdentifier);
  const row = app.databases
    .concurrentDB()
    .select(`${collection.name}.*`)
    .from(collection.name)
    .where(newExp("[[email]] = {:email} COLLATE NOCASE", { email }))
    .limit(1)
    .one();
  return newRecordFromNullStringMap(collection, nullStringMapFromRow(row));
}
