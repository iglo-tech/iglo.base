// The reader of the schema file (D40): the file text becomes a complete
// description, or a list of errors that name their JSON path. Not an
// upstream file.
//
// The reader does not touch a database: the apply (S.3) checks the
// description against the database, and runs the full validation of the
// collection model there (rule syntax, patterns, index statements). Here
// the checks are the file's own: the shape of the JSON, the names, the
// option types, the references by name, duplicates, and the values the
// file must not hold (secrets, OAuth2 providers, system flags).
//
// Missing options take their defaults (src/schema/defaults.ts). A system
// collection the file leaves out is its default. The leading system fields
// of a collection the file leaves out are placed first, in their default
// order, as the writer assumes (src/schema/write.ts). The indexes upstream
// adds to an auth collection are not in the file and not in the description
// (src/schema/implied.ts); the apply restores them.

import { fieldFactory } from "@/fields/fields";
import { SystemDynamicFieldNames } from "@/fields/field";
import { JSONSyntaxError, parseJSONTree, type JSONNode } from "@/schema/json-tree";
import {
  builtinCollectionType,
  defaultCollectionDescription,
  fieldDefault,
  impliedFieldCount,
  systemCollectionNames,
} from "@/schema/defaults";
import {
  collectionTypes,
  type CollectionType,
  type SchemaCollection,
  type SchemaDescription,
  type SchemaField,
  type SchemaObject,
  type SchemaValue,
} from "@/schema/types";
import { isArrayIndexName, isPlainObject } from "@/schema/values";

// one problem in the file: where it is and what is wrong
export interface SchemaIssue {
  path: string;
  message: string;
}

export type SchemaReadResult =
  | { ok: true; schema: SchemaDescription }
  | { ok: false; errors: SchemaIssue[] };

type Segment = string | number;

// the JSON path of a segment list, as "$.collections.posts.fields[0]"
export function jsonPath(segments: readonly Segment[]): string {
  let out = "$";
  for (const segment of segments) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else if (/^[A-Za-z_]\w*$/.test(segment)) {
      out += `.${segment}`;
    } else {
      out += `[${JSON.stringify(segment)}]`;
    }
  }
  return out;
}

// the names of the reserved field names (upstream's excludeNames, core/field.go)
const reservedFieldNames = new Set([
  "null",
  "true",
  "false",
  "_rowid_",
  ...SystemDynamicFieldNames,
]);

// Reads the text of a schema file.
export function readSchema(text: string): SchemaReadResult {
  let root: JSONNode;
  try {
    root = parseJSONTree(text);
  } catch (err) {
    if (err instanceof JSONSyntaxError) {
      return { ok: false, errors: [{ path: "$", message: `not valid JSON: ${err.message}` }] };
    }
    throw err;
  }
  const reader = new Reader();
  const schema = reader.document(root);
  if (reader.errors.length > 0 || schema === undefined) {
    return { ok: false, errors: reader.errors };
  }
  return { ok: true, schema };
}

interface DraftCollection {
  collection: SchemaCollection;
  segments: Segment[];
}

class Reader {
  readonly errors: SchemaIssue[] = [];

  private add(segments: readonly Segment[], message: string): void {
    this.errors.push({ path: jsonPath(segments), message });
  }

  // the members of an object, with the duplicates reported (the first one
  // is kept); `what` names the duplicated thing in the message
  private members(
    node: JSONNode,
    segments: readonly Segment[],
    what: string,
  ): Map<string, JSONNode> {
    const map = new Map<string, JSONNode>();
    if (node.kind !== "object") {
      return map;
    }
    for (const member of node.members) {
      if (map.has(member.key)) {
        this.add([...segments, member.key], `duplicate ${what} ${JSON.stringify(member.key)}`);
        continue;
      }
      map.set(member.key, member.value);
    }
    return map;
  }

  // the root object
  document(root: JSONNode): SchemaDescription | undefined {
    if (root.kind !== "object") {
      this.add([], "must be a JSON object");
      return undefined;
    }
    const members = this.members(root, [], "property");
    for (const key of members.keys()) {
      if (key !== "$schema" && key !== "collections") {
        this.add([key], "unknown property");
      }
    }
    const schemaURL = members.get("$schema");
    if (schemaURL !== undefined && schemaURL.kind !== "string") {
      this.add(["$schema"], "must be a string");
    }
    const collections = members.get("collections");
    if (collections === undefined) {
      this.add(["collections"], "is required");
      return undefined;
    }
    return this.collections(collections);
  }

  private collections(node: JSONNode): SchemaDescription | undefined {
    if (node.kind !== "object") {
      this.add(["collections"], "must be an object keyed by collection name");
      return undefined;
    }
    const drafts: DraftCollection[] = [];
    for (const [name, value] of this.members(node, ["collections"], "collection name")) {
      const segments: Segment[] = ["collections", name];
      const problem = collectionNameProblem(name);
      if (problem !== undefined) {
        this.add(segments, problem);
        continue;
      }
      const collection = this.collection(name, value, segments);
      if (collection !== undefined) {
        drafts.push({ collection, segments });
      }
    }

    // a relation names a collection of the file, or a system collection
    const names = new Set([
      ...drafts.map((draft) => draft.collection.name),
      ...systemCollectionNames,
    ]);
    for (const { collection, segments } of drafts) {
      for (const field of collection.fields) {
        if (field.type !== "relation") {
          continue;
        }
        const target = field.options.collection;
        const path = [...segments, "fields", field.name, "collection"];
        if (typeof target !== "string" || target === "") {
          this.add(path, "a relation needs the name of its target collection");
        } else if (!names.has(target)) {
          this.add(path, `no collection named ${JSON.stringify(target)} in the file`);
        }
      }
    }

    const byName = new Map(drafts.map((draft) => [draft.collection.name, draft.collection]));
    for (const name of systemCollectionNames) {
      if (!byName.has(name)) {
        const type = builtinCollectionType(name) as CollectionType;
        byName.set(name, defaultCollectionDescription(type, name));
      }
    }
    const sorted = [...byName.values()].toSorted((a, b) => compareNames(a.name, b.name));
    return { collections: sorted };
  }

  private collection(
    name: string,
    node: JSONNode,
    segments: Segment[],
  ): SchemaCollection | undefined {
    if (node.kind !== "object") {
      this.add(segments, "must be an object");
      return undefined;
    }
    const members = this.members(node, segments, "property");

    const typeNode = members.get("type");
    const type = typeNode?.kind === "string" ? typeNode.value : undefined;
    if (type === undefined) {
      this.add(segments, `is missing "type" (one of ${collectionTypes.join(", ")})`);
      return undefined;
    }
    if (!isCollectionType(type)) {
      this.add([...segments, "type"], `must be one of ${collectionTypes.join(", ")}`);
      return undefined;
    }

    const builtinType = builtinCollectionType(name);
    if (systemCollectionNames.includes(name) && builtinType !== type) {
      this.add([...segments, "type"], `the system collection ${name} is "${builtinType}"`);
      return undefined;
    }

    const defaults = defaultCollectionDescription(type, name);
    const authOptionKeys = type === "auth" ? Object.keys(defaults.options) : [];
    const collection: SchemaCollection = {
      name,
      type,
      system: defaults.system,
      rules: { ...defaults.rules },
      indexes: defaults.indexes,
      fields: [],
      options: { ...defaults.options },
    };
    if (type === "view") {
      collection.query = "";
    }

    for (const [key, value] of members) {
      const path = [...segments, key];
      if (key === "type") {
        continue;
      }
      if (key === "description") {
        const description = this.string(value, path);
        if (description !== undefined) {
          collection.description = description;
        }
      } else if (key === "system") {
        const system = value.kind === "boolean" ? value.value : undefined;
        if (system === undefined) {
          this.add(path, "must be true or false");
        } else {
          collection.system = system;
        }
      } else if (key === "rules") {
        collection.rules = this.rules(value, path, defaults.rules);
      } else if (key === "indexes") {
        const indexes = this.stringArray(value, path);
        if (indexes !== undefined) {
          collection.indexes = indexes;
        }
      } else if (key === "query" && type === "view") {
        const query = this.string(value, path);
        if (query !== undefined) {
          collection.query = query;
        }
      } else if (key === "fields" && type !== "view") {
        collection.fields = this.fields(value, path, name, defaults);
      } else if (key === "fields") {
        this.add(path, "a view's fields come from its query, so they are not written");
      } else if (key === "query") {
        this.add(path, "only view collections have a query");
      } else if (authOptionKeys.includes(key)) {
        const option = this.value(value, defaults.options[key] as SchemaValue, path);
        if (option !== undefined) {
          collection.options[key] = option;
        }
      } else if (type !== "auth" && isAuthOption(key)) {
        this.add(path, "only auth collections have this property");
      } else {
        this.add(path, "unknown property");
      }
    }

    if (type !== "view") {
      collection.fields = this.withImpliedFields(collection.fields, defaults);
    }
    return collection;
  }

  private rules(
    node: JSONNode,
    path: Segment[],
    defaults: Record<string, string | null>,
  ): Record<string, string | null> {
    const rules = { ...defaults };
    if (node.kind !== "object") {
      this.add(path, "must be an object");
      return rules;
    }
    for (const [key, value] of this.members(node, path, "property")) {
      const rulePath = [...path, key];
      if (!Object.hasOwn(defaults, key)) {
        this.add(
          rulePath,
          "unknown rule (rules are list, view, create, update, delete, and auth and manage on auth collections)",
        );
        continue;
      }
      if (value.kind === "null") {
        rules[key] = null;
      } else if (value.kind === "string") {
        rules[key] = value.value;
      } else {
        this.add(rulePath, "must be a string or null");
      }
    }
    return rules;
  }

  // the fields a file lists, in the order it lists them
  private fields(
    node: JSONNode,
    path: Segment[],
    collectionName: string,
    defaults: SchemaCollection,
  ): SchemaField[] {
    if (node.kind !== "object") {
      this.add(path, "must be an object keyed by field name");
      return [];
    }
    const fields: SchemaField[] = [];
    for (const [name, value] of this.members(node, path, "field name")) {
      const fieldPath = [...path, name];
      const problem = fieldNameProblem(name);
      if (problem !== undefined) {
        this.add(fieldPath, problem);
        continue;
      }
      const field = this.field(name, value, fieldPath, collectionName, defaults);
      if (field !== undefined) {
        fields.push(field);
      }
    }
    return fields;
  }

  // the fields the file leaves out and the file lists, in stored order: the
  // missing leading system fields first, then the listed fields
  private withImpliedFields(listed: SchemaField[], defaults: SchemaCollection): SchemaField[] {
    const listedNames = new Set(listed.map((field) => field.name));
    const implied = defaults.fields
      .slice(0, impliedFieldCount(defaults))
      .filter((field) => !listedNames.has(field.name));
    return [...implied, ...listed];
  }

  private field(
    name: string,
    node: JSONNode,
    path: Segment[],
    collectionName: string,
    defaults: SchemaCollection,
  ): SchemaField | undefined {
    if (node.kind !== "object") {
      this.add(path, "must be an object");
      return undefined;
    }
    const members = this.members(node, path, "property");
    const typeNode = members.get("type");
    if (typeNode?.kind !== "string") {
      this.add(path, 'is missing "type"');
      return undefined;
    }
    const type = typeNode.value;
    if (fieldFactory(type) === undefined) {
      this.add([...path, "type"], `unknown field type ${JSON.stringify(type)}`);
      return undefined;
    }

    const systemDefault = defaults.fields.find((field) => field.name === name && field.system);
    if (systemDefault !== undefined && systemDefault.type !== type) {
      this.add(
        [...path, "type"],
        `${name} is a system field of ${collectionName} and must be of type ${JSON.stringify(systemDefault.type)}`,
      );
      return undefined;
    }

    const base = fieldDefault(defaults, type, name);
    const field: SchemaField = {
      name,
      type,
      system: base.system,
      options: { ...base.options },
    };

    for (const [key, value] of members) {
      const optionPath = [...path, key];
      if (key === "type") {
        continue;
      }
      if (key === "description") {
        const description = this.string(value, optionPath);
        if (description !== undefined) {
          field.description = description;
        }
      } else if (key === "tsType") {
        if (type !== "json") {
          this.add(optionPath, "tsType is only for json fields");
          continue;
        }
        const tsType = this.string(value, optionPath);
        if (tsType !== undefined) {
          field.tsType = tsType;
        }
      } else if (key === "system" || key === "id" || key === "name") {
        this.add(
          optionPath,
          `is not written in the file (${key} is ${key === "name" ? "the key of the field" : "implied"})`,
        );
      } else if (Object.hasOwn(base.options, key)) {
        const option = this.value(value, base.options[key] as SchemaValue, optionPath);
        if (option !== undefined) {
          field.options[key] = option;
        }
      } else {
        this.add(optionPath, `unknown option for a ${type} field`);
      }
    }
    return field;
  }

  // the value of a JSON node, checked against the shape of its default and
  // merged onto it (an object keeps the default's members the file leaves
  // out)
  private value(node: JSONNode, base: SchemaValue, path: Segment[]): SchemaValue | undefined {
    if (isPlainObject(base)) {
      if (node.kind !== "object") {
        this.add(path, "must be an object");
        return undefined;
      }
      const merged: SchemaObject = { ...base };
      for (const [key, value] of this.members(node, path, "property")) {
        const memberPath = [...path, key];
        if (!Object.hasOwn(base, key)) {
          this.add(memberPath, unknownOptionMessage(key));
          continue;
        }
        const option = this.value(value, base[key] as SchemaValue, memberPath);
        if (option !== undefined) {
          merged[key] = option;
        }
      }
      return merged;
    }
    if (Array.isArray(base)) {
      return this.stringArray(node, path);
    }
    if (typeof base === "boolean") {
      if (node.kind === "boolean") {
        return node.value;
      }
      this.add(path, "must be true or false");
      return undefined;
    }
    if (typeof base === "string") {
      return this.string(node, path);
    }
    if (typeof base === "number") {
      if (node.kind === "number" && Number.isSafeInteger(node.value)) {
        return node.value;
      }
      this.add(path, "must be a whole number");
      return undefined;
    }
    // a null default is a nullable number (number min and max)
    if (node.kind === "null" || node.kind === "number") {
      return node.kind === "null" ? null : node.value;
    }
    this.add(path, "must be a number or null");
    return undefined;
  }

  private string(node: JSONNode, path: Segment[]): string | undefined {
    if (node.kind === "string") {
      return node.value;
    }
    this.add(path, "must be a string");
    return undefined;
  }

  private stringArray(node: JSONNode, path: Segment[]): string[] | undefined {
    if (node.kind !== "array") {
      this.add(path, "must be an array of strings");
      return undefined;
    }
    const out: string[] = [];
    for (const [i, item] of node.items.entries()) {
      if (item.kind === "string") {
        out.push(item.value);
      } else {
        this.add([...path, i], "must be a string");
      }
    }
    return out;
  }
}

function isCollectionType(value: string): value is CollectionType {
  return (collectionTypes as readonly string[]).includes(value);
}

function isAuthOption(key: string): boolean {
  return [
    "passwordAuth",
    "oauth2",
    "authAlert",
    "mfa",
    "otp",
    "authToken",
    "passwordResetToken",
    "emailChangeToken",
    "verificationToken",
    "fileToken",
    "verificationTemplate",
    "resetPasswordTemplate",
    "confirmEmailChangeTemplate",
  ].includes(key);
}

function unknownOptionMessage(key: string): string {
  if (key === "secret") {
    return "token secrets are not written in the schema file; remove this property";
  }
  if (key === "providers") {
    return "OAuth2 providers are not written in the schema file (they hold secrets); set them in the dashboard";
  }
  return "unknown property";
}

// a collection name: word characters, and not an array index (a JSON object
// orders those names first, so a file could not keep their order)
function collectionNameProblem(name: string): string | undefined {
  if (!/^\w+$/.test(name)) {
    return "collection names are letters, digits and underscores";
  }
  if (isArrayIndexName(name)) {
    return "collection names cannot be array indexes (whole numbers such as 0 or 12): a schema file cannot keep their order";
  }
  return undefined;
}

// a field name: word characters, 1 to 100 of them, not an array index and
// not reserved
function fieldNameProblem(name: string): string | undefined {
  if (!/^\w+$/.test(name) || name.length > 100) {
    return "field names are 1 to 100 letters, digits and underscores";
  }
  if (isArrayIndexName(name)) {
    return "field names cannot be array indexes (whole numbers such as 0 or 12): a schema file cannot keep their order";
  }
  if (reservedFieldNames.has(name)) {
    return `${name} is a reserved name`;
  }
  return undefined;
}

// code unit order, as the writer sorts
function compareNames(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}
