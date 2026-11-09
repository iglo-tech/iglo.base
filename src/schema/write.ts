// The writer of the schema file (D40): a description becomes the file text.
// Not an upstream file.
//
// The text is deterministic: collections sorted by name, a collection's
// fields in their stored order, every object's keys in the order below,
// two-space indent, a final newline. Options and fields equal to their
// defaults are left out (src/schema/defaults.ts), and so are the system
// collections that equal theirs and the system fields implied by the
// collection type. A field whose name is integer-like cannot keep its place
// (JSON objects order those names first), so the writer refuses it.
//
// Extras (descriptions and tsType) are not in the database. A pull that
// writes over an existing file keeps them, from extractExtras.

import { objectValue, parseJSONTree, type JSONNode } from "@/schema/json-tree";
import { defaultCollectionDescription, impliedFieldCount, fieldDefault } from "@/schema/defaults";
import { isPlainObject, isIntegerLike, jsonEqual, withKeyOrder } from "@/schema/values";
import {
  type SchemaCollection,
  type SchemaCollectionExtra,
  type SchemaDescription,
  type SchemaExtras,
  type SchemaField,
  type SchemaFieldExtra,
  type SchemaObject,
  type SchemaValue,
} from "@/schema/types";

// the order of the keys of a collection and of a field in the file; the rest
// follow in code unit order
const collectionKeyOrder = ["type", "description", "system", "rules", "query", "indexes", "fields"];
const fieldKeyOrder = ["type", "description", "tsType"];

// options that differ from their default
const changed = Symbol("unchanged");

export interface FormatOptions {
  // the value of "$schema" in the file
  schemaURL: string;
  extras?: SchemaExtras;
}

// The file text of a description.
export function formatSchema(description: SchemaDescription, options: FormatOptions): string {
  const collections: SchemaObject = {};
  for (const collection of description.collections) {
    const extra = options.extras?.collections.get(collection.name);
    const defaults = defaultCollectionDescription(collection.type, collection.name);
    // a system collection that equals its default is not written, unless it
    // carries extras
    if (collection.system && extra === undefined && sameCollection(collection, defaults)) {
      continue;
    }
    if (isIntegerLike(collection.name)) {
      throw new Error(
        `collection name ${JSON.stringify(collection.name)} is made of digits; a schema file cannot keep the order of such names`,
      );
    }
    collections[collection.name] = formatCollection(collection, defaults, extra);
  }
  const file: SchemaObject = { $schema: options.schemaURL, collections };
  return JSON.stringify(file, null, 2) + "\n";
}

// the description with its extra keys left out
function core(collection: SchemaCollection): SchemaCollection {
  const { description: _description, ...rest } = collection;
  return {
    ...rest,
    fields: rest.fields.map((field) => coreField(field)),
  };
}

function coreField(field: SchemaField): SchemaField {
  return { name: field.name, type: field.type, system: field.system, options: field.options };
}

function sameCollection(collection: SchemaCollection, defaults: SchemaCollection): boolean {
  return jsonEqual(core(collection), core(defaults));
}

function formatCollection(
  collection: SchemaCollection,
  defaults: SchemaCollection,
  extra: SchemaCollectionExtra | undefined,
): SchemaObject {
  const out: SchemaObject = { type: collection.type };
  if (extra?.description !== undefined) {
    out.description = extra.description;
  }
  // a system collection that is not one of the builtin ones keeps its flag
  if (collection.system !== defaults.system) {
    out.system = collection.system;
  }

  const rules: SchemaObject = {};
  for (const [rule, value] of Object.entries(collection.rules)) {
    if (!jsonEqual(value, defaults.rules[rule])) {
      rules[rule] = value;
    }
  }
  if (Object.keys(rules).length > 0) {
    out.rules = withKeyOrder(rules, []);
  }

  if (collection.type === "view") {
    if (collection.query !== defaults.query) {
      out.query = collection.query ?? "";
    }
  } else {
    if (!jsonEqual(collection.indexes, defaults.indexes)) {
      out.indexes = collection.indexes;
    }
    const fields = formatFields(collection, defaults, extra);
    if (Object.keys(fields).length > 0) {
      out.fields = fields;
    }
  }

  for (const [key, value] of Object.entries(collection.options)) {
    const diff = diffValue(value, defaults.options[key]);
    if (diff !== changed) {
      out[key] = diff;
    }
  }

  return withKeyOrder(out, collectionKeyOrder);
}

// The fields a file lists: the stored fields after the leading system fields
// that equal their defaults. A field with extras is listed with the system
// fields before it, so that they keep their order.
function formatFields(
  collection: SchemaCollection,
  defaults: SchemaCollection,
  extra: SchemaCollectionExtra | undefined,
): SchemaObject {
  const implied = impliedFieldCount(defaults);
  const extrasInImplied = [...(extra?.fields.keys() ?? [])].some((name) =>
    defaults.fields.slice(0, implied).some((field) => field.name === name),
  );
  let skip = 0;
  if (!extrasInImplied) {
    while (
      skip < implied &&
      skip < collection.fields.length &&
      sameField(collection.fields[skip], defaults.fields[skip])
    ) {
      skip++;
    }
  }

  const fields: SchemaObject = {};
  for (const field of collection.fields.slice(skip)) {
    if (isIntegerLike(field.name)) {
      throw new Error(
        `field name ${JSON.stringify(field.name)} is made of digits; a schema file cannot keep the order of such names`,
      );
    }
    const base = fieldDefault(defaults, field.type, field.name);
    fields[field.name] = formatField(field, base, extra?.fields.get(field.name));
  }
  return fields;
}

function sameField(field: SchemaField | undefined, defaultField: SchemaField | undefined): boolean {
  return (
    field !== undefined &&
    defaultField !== undefined &&
    jsonEqual(coreField(field), coreField(defaultField))
  );
}

function formatField(
  field: SchemaField,
  base: SchemaField,
  extra: SchemaFieldExtra | undefined,
): SchemaObject {
  const out: SchemaObject = { type: field.type };
  if (extra?.description !== undefined) {
    out.description = extra.description;
  }
  if (field.type === "json" && extra?.tsType !== undefined) {
    out.tsType = extra.tsType;
  }
  for (const [key, value] of Object.entries(field.options)) {
    if (!jsonEqual(value, base.options[key])) {
      out[key] = value;
    }
  }
  return withKeyOrder(out, fieldKeyOrder);
}

// The part of a value that differs from its default. Objects are compared
// key by key (so a nested option like mappedFields.name is written alone);
// everything else is written whole.
function diffValue(
  value: SchemaValue,
  base: SchemaValue | undefined,
): SchemaValue | typeof changed {
  if (jsonEqual(value, base)) {
    return changed;
  }
  if (isPlainObject(value) && isPlainObject(base)) {
    const out: SchemaObject = {};
    for (const key of Object.keys(base)) {
      if (!Object.hasOwn(value, key)) {
        // a key the default has and the value lacks cannot be left out
        return value;
      }
    }
    for (const [key, item] of Object.entries(value)) {
      const diff = diffValue(item, base[key]);
      if (diff !== changed) {
        out[key] = diff;
      }
    }
    return out;
  }
  return value;
}

// The extra keys of an existing schema file, by collection and field name.
// Throws a JSONSyntaxError when the text is not JSON.
export function extractExtras(text: string): SchemaExtras {
  const extras: SchemaExtras = { collections: new Map() };
  const root = parseJSONTree(text);
  const collections = childObject(root, "collections");
  if (collections === undefined) {
    return extras;
  }
  for (const member of collections.members) {
    if (member.value.kind !== "object") {
      continue;
    }
    const entry: SchemaCollectionExtra = { fields: new Map() };
    const description = stringMember(member.value, "description");
    if (description !== undefined) {
      entry.description = description;
    }
    const fields = childObject(member.value, "fields");
    for (const field of fields?.members ?? []) {
      if (field.value.kind !== "object") {
        continue;
      }
      const fieldExtra: SchemaFieldExtra = {};
      const fieldDescription = stringMember(field.value, "description");
      if (fieldDescription !== undefined) {
        fieldExtra.description = fieldDescription;
      }
      const tsType = stringMember(field.value, "tsType");
      if (tsType !== undefined) {
        fieldExtra.tsType = tsType;
      }
      if (fieldExtra.description !== undefined || fieldExtra.tsType !== undefined) {
        entry.fields.set(field.key, fieldExtra);
      }
    }
    if (entry.description !== undefined || entry.fields.size > 0) {
      extras.collections.set(member.key, entry);
    }
  }
  return extras;
}

function childObject(
  node: JSONNode,
  key: string,
): Extract<JSONNode, { kind: "object" }> | undefined {
  const child = objectValue(node).get(key);
  return child?.kind === "object" ? child : undefined;
}

function stringMember(node: JSONNode, key: string): string | undefined {
  const child = objectValue(node).get(key);
  return child?.kind === "string" ? child.value : undefined;
}
