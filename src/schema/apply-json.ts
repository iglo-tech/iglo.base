// The description of the schema file as the collections API takes it (D40,
// S.3). Not an upstream file: the apply sends these objects through the same
// path the dashboard and the collections API use (unmarshalJSON, then
// saveCollection), so the stored result is the dashboard's.
//
// Fields are matched to the stored ones by name and type, and the stored id
// goes in with them (a new field gets its id from the save, as upstream does).
// A relation's target is given by its id, looked up by the apply.

import type { SchemaCollection, SchemaField, SchemaObject } from "@/schema/types";
import { ruleKeys } from "@/schema/types";
import { isPlainObject } from "@/schema/values";

// the id of a collection by its name
export type CollectionIdOf = (name: string) => string;

// rule name (list, view, ...) → the API's key (listRule, viewRule, ...)
const apiRuleKey: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(ruleKeys).map(([apiKey, rule]) => [rule, apiKey])),
);

// one field, as the API's field JSON; id "" leaves it to the save
export function fieldJSON(
  field: SchemaField,
  id: string,
  collectionIdOf: CollectionIdOf,
): SchemaObject {
  const json: SchemaObject = {};
  if (id !== "") {
    json.id = id;
  }
  json.name = field.name;
  json.type = field.type;
  json.system = field.system;
  for (const [key, value] of Object.entries(field.options)) {
    if (key !== "collection") {
      json[key] = value;
    }
  }
  if (field.type === "relation") {
    json.collectionId = collectionIdOf(String(field.options.collection));
  }
  return json;
}

// the rules and the options of a collection, as the API's flat keys (no
// fields, indexes or id); the view query for a view
export function settingsJSON(collection: SchemaCollection): SchemaObject {
  const json: SchemaObject = {};
  for (const [rule, value] of Object.entries(collection.rules)) {
    const key = apiRuleKey[rule];
    if (key !== undefined) {
      json[key] = value;
    }
  }
  for (const [key, value] of Object.entries(collection.options)) {
    json[key] = value;
  }
  if (collection.type === "view") {
    json.viewQuery = collection.query ?? "";
  }
  // the providers the file lists, with the values read from the environment
  // (the apply resolves them); the save merges them as the API's do
  if (collection.type === "auth" && collection.providers !== undefined) {
    const oauth2 = isPlainObject(json.oauth2) ? json.oauth2 : {};
    json.oauth2 = { ...oauth2, providers: collection.providers };
  }
  return json;
}

// the collection object that the save takes: id, name, type and system, with
// the given members
export function collectionJSON(
  collection: SchemaCollection,
  id: string,
  members: SchemaObject,
): SchemaObject {
  return {
    id,
    name: collection.name,
    type: collection.type,
    system: collection.system,
    ...members,
  };
}
