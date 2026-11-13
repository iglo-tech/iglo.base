// The TypeScript types of the collections (D40, S.4, `schema types`). Not an
// upstream file: upstream has no generator.
//
// The input is the collections as the API returns them (upstream's
// MarshalJSON, core/collection_model.go, parsed), so a view collection has
// its resolved fields, and the field types and modifiers are upstream's
// (core/field_*.go). The file's extra keys (a description, and a json field's
// tsType) come from the schema file, because the database does not hold them
// (D40). The output is deterministic and laid out as oxfmt lays it out, so
// `schema types --check` and the pre-commit hook agree.

import type { SchemaCollection, SchemaDescription, SchemaObject } from "@/schema/types";

// the package the generated file takes the client types from: the SDK of
// this repository (sdk/package.json; its npm name changes with P.14)
export const sdkPackage = "iglo.base";

// the line length of oxfmt (.oxfmtrc.json)
const printWidth = 100;

// a generation that cannot name a type stops with this error
export class TypesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypesError";
  }
}

// one collection or field of the API, as parsed JSON
type Json = SchemaObject;

// The type name of a collection: its words in Pascal case (`my_posts` is
// MyPosts). A name that starts with a digit gets a leading underscore.
export function typeBase(name: string): string {
  const base = name
    .split("_")
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
  if (base === "") {
    throw new TypesError(`the collection ${JSON.stringify(name)} has no name for a type`);
  }
  return /^\d/.test(base) ? `_${base}` : base;
}

// A type: the members of a union, or an array of them. A single member is
// written as it is; several are joined with " | " and, as an array, in
// parentheses.
interface TypeOf {
  members: string[];
  array: boolean;
}

// a property of an object type
interface Prop {
  key: string;
  optional: boolean;
  doc: string | undefined;
  type: TypeOf;
}

// the members of a union with no member is never
function membersOf(members: readonly string[]): string[] {
  return members.length === 0 ? ["never"] : [...members];
}

// the type on one line
function typeText(type: TypeOf): string {
  const members = membersOf(type.members);
  if (!type.array) {
    return members.join(" | ");
  }
  return members.length === 1 ? `${members[0]}[]` : `(${members.join(" | ")})[]`;
}

const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// a property key: as written when it is an identifier, quoted otherwise
function keyText(key: string): string {
  return identifierPattern.test(key) ? key : JSON.stringify(key);
}

// the JSDoc lines of a description, at an indent
function docLines(doc: string, indent: string): string[] {
  const text = doc.replace(/\*\//g, "*\\/");
  const lines = text.split(/\r?\n/);
  if (lines.length === 1) {
    return [`${indent}/** ${text} */`];
  }
  return [`${indent}/**`, ...lines.map((line) => `${indent} * ${line}`.trimEnd()), `${indent} */`];
}

// the lines of one property; a type too long for a line breaks the way oxfmt
// breaks it: a union with a leading "| " on each member, an array of a union
// with its members in parentheses
function propLines(prop: Prop, indent: string): string[] {
  const doc = prop.doc === undefined ? [] : docLines(prop.doc, indent);
  const head = `${indent}${keyText(prop.key)}${prop.optional ? "?" : ""}`;
  const line = `${head}: ${typeText(prop.type)};`;
  const members = membersOf(prop.type.members);
  if (line.length <= printWidth || members.length === 1) {
    return [...doc, line];
  }
  if (!prop.type.array) {
    return [
      ...doc,
      `${head}:`,
      ...members.map(
        (member, index) => `${indent}  | ${member}${index === members.length - 1 ? ";" : ""}`,
      ),
    ];
  }
  return [
    ...doc,
    `${head}: (`,
    ...members.map((member) => `${indent}  | ${member}`),
    `${indent})[];`,
  ];
}

// the members of a select's values, or "never" when it has none
function valueMembers(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => JSON.stringify(value));
}

function isMultiple(field: Json): boolean {
  return typeof field.maxSelect === "number" && field.maxSelect > 1;
}

function fieldName(field: Json): string {
  if (typeof field.name !== "string" || typeof field.type !== "string") {
    throw new TypesError("a field of the API has no name or type");
  }
  return field.name;
}

// the schema file's extra keys of a field
interface FileField {
  description?: string;
  tsType?: string;
}

// the type of a field's stored value, as the API returns it
function storedType(field: Json, file: FileField | undefined, collection: string): TypeOf {
  const name = fieldName(field);
  const type = field.type as string;
  switch (type) {
    case "text":
    case "editor":
    case "email":
    case "url":
    case "date":
    case "autodate":
    case "password":
      return { members: ["string"], array: false };
    case "number":
      return { members: ["number"], array: false };
    case "bool":
      return { members: ["boolean"], array: false };
    case "select": {
      const values = valueMembers(field.values);
      if (isMultiple(field)) {
        return { members: values, array: true };
      }
      // an unset single select reads as "", the API's empty value, unless it is required
      return { members: field.required === true ? values : ['""', ...values], array: false };
    }
    case "relation":
    case "file":
      return { members: ["string"], array: isMultiple(field) };
    case "json":
      return { members: [file?.tsType ?? "unknown"], array: false };
    case "geoPoint":
      return { members: ["{ lon: number; lat: number }"], array: false };
    default:
      throw new TypesError(
        `the field ${JSON.stringify(name)} of ${JSON.stringify(collection)} has the type ${JSON.stringify(type)}, which schema types does not know`,
      );
  }
}

// the type a request sets a field to: a file is an upload
function inputType(field: Json, file: FileField | undefined, collection: string): TypeOf {
  if (field.type === "file") {
    return { members: ["File", "Blob"], array: isMultiple(field) };
  }
  return storedType(field, file, collection);
}

// whether a field can be set through the API: the server sets autodate
// fields, and an auth collection's tokenKey is its own secret
function isWritable(field: Json, collectionType: string): boolean {
  if (field.type === "autodate") {
    return false;
  }
  return !(collectionType === "auth" && field.name === "tokenKey");
}

// a create takes a field optional when the server fills it: the id, a text
// field with an autogenerate pattern, or any field that is not required
function isOptionalOnCreate(field: Json): boolean {
  if (field.name === "id") {
    return true;
  }
  if (
    field.type === "text" &&
    typeof field.autogeneratePattern === "string" &&
    field.autogeneratePattern !== ""
  ) {
    return true;
  }
  return field.required !== true;
}

// an optional property of a type, for an update's modifier
function modifierProp(key: string, type: TypeOf): Prop {
  return { key, optional: true, doc: undefined, type };
}

// the modifiers an update takes for a field (upstream's FindSetter): the
// number increments and decrements, the select, relation and file values are
// added, prepended or removed
function modifiersOf(field: Json): Prop[] {
  const name = fieldName(field);
  switch (field.type) {
    case "number":
      return [
        modifierProp(`${name}+`, { members: ["number"], array: false }),
        modifierProp(`${name}-`, { members: ["number"], array: false }),
      ];
    case "select":
    case "relation": {
      // a value, or an array of values, the way the field takes it
      const values = field.type === "select" ? valueMembers(field.values) : ["string"];
      const value: TypeOf = {
        members: [...membersOf(values), typeText({ members: values, array: true })],
        array: false,
      };
      return [
        modifierProp(`+${name}`, value),
        modifierProp(`${name}+`, value),
        modifierProp(`${name}-`, value),
      ];
    }
    case "file": {
      const upload: TypeOf = {
        members: ["File", "Blob", "(File | Blob)[]"],
        array: false,
      };
      const remove: TypeOf = { members: ["string", "string[]"], array: false };
      return [
        modifierProp(`+${name}`, upload),
        modifierProp(`${name}+`, upload),
        modifierProp(`${name}-`, remove),
      ];
    }
    default:
      return [];
  }
}

// the lines of a declaration with its properties
function declaration(
  head: string,
  props: readonly Prop[],
  doc: string | undefined,
  tail: string,
): string[] {
  const lines: string[] = doc === undefined ? [] : docLines(doc, "");
  lines.push(head);
  for (const prop of props) {
    lines.push(...propLines(prop, "  "));
  }
  lines.push(tail);
  return lines;
}

// the four declarations of one collection
function collectionDeclarations(
  api: Json,
  base: string,
  file: SchemaCollection | undefined,
): string[] {
  const name = String(api.name);
  const type = String(api.type);
  const fields = Array.isArray(api.fields) ? (api.fields as Json[]) : [];
  const fileFields = new Map((file?.fields ?? []).map((field) => [field.name, field]));
  const fileOf = (field: Json): FileField | undefined => fileFields.get(fieldName(field));
  const docOf = (field: Json): string | undefined => fileOf(field)?.description;

  // the record: every stored field
  const record: Prop[] = fields.map((field) => ({
    key: fieldName(field),
    optional: false,
    doc: docOf(field),
    type: storedType(field, fileOf(field), name),
  }));

  // the response: the id, the collection and the fields the API returns (not
  // the hidden ones), and the expanded relations
  const response: Prop[] = [
    { key: "id", optional: false, doc: undefined, type: { members: ["string"], array: false } },
    {
      key: "collectionId",
      optional: false,
      doc: undefined,
      type: { members: ["string"], array: false },
    },
    {
      key: "collectionName",
      optional: false,
      doc: undefined,
      type: { members: [JSON.stringify(name)], array: false },
    },
  ];
  for (const field of fields) {
    if (field.name === "id" || field.hidden === true) {
      continue;
    }
    // an auth collection's email is returned only when it is visible or the
    // requester owns the record (emailVisibility), so it is optional
    response.push({
      key: fieldName(field),
      optional: type === "auth" && field.name === "email",
      doc: docOf(field),
      type: storedType(field, fileOf(field), name),
    });
  }
  response.push({
    key: "expand",
    optional: true,
    doc: "The relations that the request expanded, by field name.",
    type: { members: ["Expand"], array: false },
  });

  // the create and the update: the fields the request sets
  const create: Prop[] = [];
  const update: Prop[] = [];
  for (const field of fields) {
    if (!isWritable(field, type)) {
      continue;
    }
    const key = fieldName(field);
    const doc = docOf(field);
    const input = inputType(field, fileOf(field), name);
    if (key === "id") {
      // a record id is set on create only
      create.push({ key, optional: true, doc, type: input });
      continue;
    }
    create.push({ key, optional: isOptionalOnCreate(field), doc, type: input });
    update.push({ key, optional: true, doc, type: input });
    if (type === "auth" && key === "password") {
      create.push({
        key: "passwordConfirm",
        optional: true,
        doc: undefined,
        type: { members: ["string"], array: false },
      });
      update.push({
        key: "passwordConfirm",
        optional: true,
        doc: undefined,
        type: { members: ["string"], array: false },
      });
      update.push({
        key: "oldPassword",
        optional: true,
        doc: undefined,
        type: { members: ["string"], array: false },
      });
    }
    update.push(...modifiersOf(field));
  }

  return [
    ...declaration(`export interface ${base}Record {`, record, file?.description, "}"),
    "",
    ...declaration(
      `export interface ${base}Response<Expand = {}> {`,
      response,
      file?.description,
      "}",
    ),
    "",
    ...declaration("export type " + base + "Create = {", create, file?.description, "};"),
    "",
    ...declaration("export type " + base + "Update = {", update, file?.description, "};"),
  ];
}

// the Collections enum: each collection's name, by its type name
function enumLines(names: readonly { base: string; name: string }[]): string[] {
  return [
    "export enum Collections {",
    ...names.map(({ base, name }) => `  ${base} = ${JSON.stringify(name)},`),
    "}",
  ];
}

// TypedPocketBase: the client with a collection method for each collection's
// name, so a name that is not in the schema is a type error
function typedClientLines(names: readonly { base: string; name: string }[]): string[] {
  const overloads = names.flatMap(({ base, name }) => {
    const line = `  collection(idOrName: ${JSON.stringify(name)} | Collections.${base}): RecordService<${base}Response>;`;
    if (line.length <= printWidth) {
      return [line];
    }
    return [
      "  collection(",
      `    idOrName: ${JSON.stringify(name)} | Collections.${base},`,
      `  ): RecordService<${base}Response>;`,
    ];
  });
  return ['export type TypedPocketBase = Omit<PocketBase, "collection"> & {', ...overloads, "};"];
}

// The generated file: the types of every collection, the Collections enum and
// TypedPocketBase. `collections` are the API's collection objects; `schema`,
// when given, is the file the types come from, for its descriptions and tsType.
export function generateTypes(collections: readonly Json[], schema?: SchemaDescription): string {
  const fileCollections = new Map(
    (schema?.collections ?? []).map((collection) => [collection.name, collection]),
  );
  const sorted = [...collections].toSorted((a, b) => {
    const left = String(a.name);
    const right = String(b.name);
    return left < right ? -1 : left > right ? 1 : 0;
  });

  // two names with one type name cannot both be generated: an error names both
  const bases = new Map<string, string>();
  const names: { base: string; name: string }[] = [];
  const parts: string[][] = [
    [
      "// Generated by `iglo-base schema types` (D40). Do not edit: change the schema and run the command again.",
      `import type PocketBase from "${sdkPackage}";`,
      `import type { RecordService } from "${sdkPackage}";`,
    ],
  ];
  for (const api of sorted) {
    if (typeof api.name !== "string") {
      throw new TypesError("a collection of the API has no name");
    }
    const base = typeBase(api.name);
    const other = bases.get(base);
    if (other !== undefined) {
      throw new TypesError(
        `the collections ${JSON.stringify(other)} and ${JSON.stringify(api.name)} both give the type name ${base}; rename one of them`,
      );
    }
    bases.set(base, api.name);
    names.push({ base, name: api.name });
    parts.push(collectionDeclarations(api, base, fileCollections.get(api.name)));
  }
  if (names.length > 0) {
    parts.push(enumLines(names), typedClientLines(names));
  }
  return parts.map((lines) => lines.join("\n")).join("\n\n") + "\n";
}
