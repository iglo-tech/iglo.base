// iglo.base's schema description of collections as the API shows them
// (D40). Not an upstream file: upstream's collection JSON
// (core/collection_model.go MarshalJSON) is the input, and the output is the
// description in types.ts.
//
// The description keeps the API's option values and drops what the file
// never holds: ids, timestamps, the OAuth2 providers (they hold secrets, D40),
// the implied indexes of an auth collection (src/schema/implied.ts) and the
// view's derived fields. A relation's target id becomes the target's name.

import type { Collection } from "@/collections/collection-model";
import { explicitIndexes } from "@/schema/implied";
import { isPlainObject } from "@/schema/values";
import type { SchemaDescription } from "@/schema/types";
import {
  type CollectionType,
  type SchemaCollection,
  type SchemaField,
  type SchemaObject,
  type SchemaValue,
  ruleKeys,
} from "@/schema/types";

// the name of a collection by its id ("" for no collection)
export type NameOf = (collectionId: string) => string;

// the keys of the collection JSON that are not options
const collectionOwnKeys = new Set([
  "id",
  "created",
  "updated",
  "name",
  "type",
  "system",
  "fields",
  "indexes",
  "viewQuery",
  ...Object.keys(ruleKeys),
]);

// the keys of a field JSON that are not options
const fieldOwnKeys = new Set(["id", "name", "type", "system"]);

// the description of one collection from its API JSON (the object
// MarshalJSON returns, parsed)
export function describeCollectionJSON(api: SchemaObject, nameOf: NameOf): SchemaCollection {
  const type = api.type as CollectionType;
  const rules: Record<string, string | null> = {};
  for (const [apiKey, rule] of Object.entries(ruleKeys)) {
    if (Object.hasOwn(api, apiKey)) {
      rules[rule] = api[apiKey] as string | null;
    }
  }

  const options: SchemaObject = {};
  for (const [key, value] of Object.entries(api)) {
    if (!collectionOwnKeys.has(key)) {
      options[key] = value;
    }
  }
  // the providers list is never in the file (it holds secrets, D40)
  const oauth2 = options.oauth2;
  if (isPlainObject(oauth2)) {
    const { providers: _providers, ...rest } = oauth2;
    options.oauth2 = rest;
  }

  const name = api.name as string;
  const collection: SchemaCollection = {
    name,
    type,
    system: api.system === true,
    rules,
    indexes: explicitIndexes((api.indexes as string[] | undefined) ?? [], { name, type }),
    fields:
      type === "view"
        ? []
        : ((api.fields as SchemaObject[] | undefined) ?? []).map((field) =>
            describeFieldJSON(field, nameOf),
          ),
    options,
  };
  if (type === "view") {
    collection.query = api.viewQuery as string;
  }
  return collection;
}

// the description of one field from its API JSON
export function describeFieldJSON(api: SchemaObject, nameOf: NameOf): SchemaField {
  const options: SchemaObject = {};
  for (const [key, value] of Object.entries(api)) {
    if (fieldOwnKeys.has(key)) {
      continue;
    }
    if (key === "collectionId") {
      options.collection = nameOf(value as string);
      continue;
    }
    options[key] = value as SchemaValue;
  }
  return {
    name: api.name as string,
    type: api.type as string,
    system: api.system === true,
    options,
  };
}

// the description of a collection model (its marshaled JSON)
export function describeCollectionModel(collection: Collection, nameOf: NameOf): SchemaCollection {
  return describeCollectionJSON(JSON.parse(collection.marshalJSON()) as SchemaObject, nameOf);
}

// the name of a relation target by the id of its collection
export function collectionNameOf(collections: readonly Collection[]): NameOf {
  const names = new Map(collections.map((collection) => [collection.id, collection.name]));
  return (collectionId) => {
    if (collectionId === "") {
      return "";
    }
    const name = names.get(collectionId);
    if (name === undefined) {
      throw new Error(
        `a relation points to the missing collection ${JSON.stringify(collectionId)}`,
      );
    }
    return name;
  };
}

// the description of a set of collections, sorted by name
export function describeCollections(collections: readonly Collection[]): SchemaDescription {
  const nameOf = collectionNameOf(collections);
  const described = collections.map((collection) => describeCollectionModel(collection, nameOf));
  return {
    collections: described.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}
