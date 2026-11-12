// The defaults the schema file is measured against (D40). Not an upstream
// file.
//
// The defaults of a collection are those of its name and type. The five
// system collections are the ones a fresh install creates
// (migrations/baseline.ts). Every other collection, `users` included,
// starts from the factory defaults of its type (core/collection_model.go
// New*Collection, what a new empty collection of that type is). So the same
// block in a file means the same schema whatever the collection's name.
// Options and fields equal to their default are left out of the file; the
// reader restores them from the same defaults.
//
// System fields are implied: a collection's leading run of system fields
// (`id`, and for auth collections `password`, `tokenKey`, `email`,
// `emailVisibility`, `verified`, and the system collections' timestamps)
// is written only when it differs from the default, as the writer and the
// reader agree (src/schema/write.ts, src/schema/read.ts). `created` and
// `updated` are ordinary autodate fields, as upstream makes them. The
// indexes upstream adds to an auth collection are implied too
// (src/schema/implied.ts), so the defaults hold no index.

import { type CollectionType, type SchemaCollection, type SchemaField } from "@/schema/types";
import { type Collection, newCollection } from "@/collections/collection-model";
import { fieldFactory } from "@/fields/fields";
import { defaultCollections } from "@/migrations/baseline";
import {
  CollectionNameAuthOrigins,
  CollectionNameExternalAuths,
  CollectionNameMFAs,
  CollectionNameOTPs,
} from "@/records/record-auth-refs";
import { CollectionNameSuperusers } from "@/records/record-model-superusers";
import { describeCollectionModel, describeFieldJSON, type NameOf } from "@/schema/describe";
import type { SchemaObject } from "@/schema/types";

// the system collections a file may leave out (they are never dropped, D40)
export const systemCollectionNames: readonly string[] = Object.freeze([
  CollectionNameSuperusers,
  CollectionNameExternalAuths,
  CollectionNameMFAs,
  CollectionNameOTPs,
  CollectionNameAuthOrigins,
]);

// defaults have no relations, so no collection name is looked up
const noRelations: NameOf = (collectionId) => {
  if (collectionId !== "") {
    throw new Error(`a default collection has a relation to ${JSON.stringify(collectionId)}`);
  }
  return "";
};

// The default of a collection of this name and type, described: the builtin
// system collection of that name, or the factory default of the type.
export function defaultCollectionDescription(type: CollectionType, name: string): SchemaCollection {
  const builtin = builtinCollection(name);
  return describeCollectionModel(
    builtin?.type === type ? builtin : newCollection(type, name),
    noRelations,
  );
}

// The type of a system collection (one a fresh install creates), or
// undefined for any other name.
export function builtinCollectionType(name: string): CollectionType | undefined {
  return builtinCollection(name)?.type as CollectionType | undefined;
}

function builtinCollection(name: string): Collection | undefined {
  if (!systemCollectionNames.includes(name)) {
    return undefined;
  }
  return defaultCollections().find((collection) => collection.name === name);
}

// The factory default of a field of this type, described under this name.
export function factoryFieldDescription(type: string, name: string): SchemaField {
  const factory = fieldFactory(type);
  if (factory === undefined) {
    throw new Error(`unknown field type ${JSON.stringify(type)}`);
  }
  const api = JSON.parse(factory().marshalJSON()) as SchemaObject;
  return describeFieldJSON({ ...api, name, type }, noRelations);
}

// The default of one field of a collection: the collection's own default
// field of that name and type, or the factory default of the type.
export function fieldDefault(
  collection: SchemaCollection,
  type: string,
  name: string,
): SchemaField {
  const own = collection.fields.find((field) => field.name === name && field.type === type);
  return own ?? factoryFieldDescription(type, name);
}

// How many of a collection's default fields are system fields at its start,
// in their default order: the ones a file leaves out while they are
// unchanged.
export function impliedFieldCount(defaults: SchemaCollection): number {
  let count = 0;
  while (count < defaults.fields.length && defaults.fields[count]?.system === true) {
    count++;
  }
  return count;
}
