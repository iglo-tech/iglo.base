// The in-memory model of the schema file (D40, issue #77). Not an upstream
// file.
//
// A SchemaDescription is complete: the reader fills every option the file
// leaves out with its default and adds the system collections it does not
// list, so the description is what the database holds once the file is
// applied (ids and timestamps aside). The writer leaves out what equals its
// default, so a description and the file it writes read back as the same
// description. Option names are the dashboard's (`help`, `minSelect`,
// `authToken`, ...), except the file's own shape for rules (`rules`), views
// (`query`) and relations (`collection`, the target's name).

export const collectionTypes = ["base", "auth", "view"] as const;

export type CollectionType = (typeof collectionTypes)[number];

// a JSON value, with plain objects only
export type SchemaValue = null | boolean | number | string | SchemaValue[] | SchemaObject;

export interface SchemaObject {
  [key: string]: SchemaValue;
}

export interface SchemaField {
  name: string;
  type: string;
  // system fields are implied by the collection type (see defaults.ts)
  system: boolean;
  // extra keys for generated types; not stored in the database
  description?: string;
  tsType?: string;
  // every other option of the field, as the dashboard names it
  options: SchemaObject;
}

export interface SchemaCollection {
  name: string;
  type: CollectionType;
  // the five upstream system collections are system by name; a file writes
  // the flag of any other collection that has it
  system: boolean;
  // extra key for editors and generated types; not stored in the database
  description?: string;
  // list, view, create, update and delete; auth collections also auth and
  // manage. null means superusers only, "" everyone.
  rules: Record<string, string | null>;
  // the SELECT query of a view collection
  query?: string;
  indexes: string[];
  // a view's fields come from its query, so a view has none here
  fields: SchemaField[];
  // the auth options of an auth collection (passwordAuth, oauth2, ...); none
  // for the other types
  options: SchemaObject;
  // the OAuth2 providers, when the file lists them (undefined: the stored ones
  // stay). In a file's description the secrets are environment references;
  // in the apply they are the values read from the environment, and in the
  // database description the stored values (src/schema/providers.ts)
  providers?: SchemaObject[];
}

export interface SchemaDescription {
  // sorted by name
  collections: SchemaCollection[];
}

// The extra keys of a schema file, read back by the writer so a pull keeps
// them (they are not in the database).
export interface SchemaFieldExtra {
  description?: string;
  tsType?: string;
}

export interface SchemaCollectionExtra {
  description?: string;
  fields: Map<string, SchemaFieldExtra>;
}

export interface SchemaExtras {
  collections: Map<string, SchemaCollectionExtra>;
}

// The keys of a collection's rules, in the file and in the description, by
// the dashboard's rule field.
export const ruleKeys: Readonly<Record<string, string>> = Object.freeze({
  listRule: "list",
  viewRule: "view",
  createRule: "create",
  updateRule: "update",
  deleteRule: "delete",
  authRule: "auth",
  manageRule: "manage",
});
