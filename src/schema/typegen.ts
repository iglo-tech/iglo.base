// The TypeScript types of the collections (D40, S.4, `schema types`). Not an
// upstream file: upstream has no generator.
//
// The input is the collections as the API returns them (upstream's
// MarshalJSON, core/collection_model.go, parsed), so a view collection has
// its resolved fields, and the field types and modifiers are upstream's
// (core/field_*.go). The file's extra keys (a description, and a json field's
// tsType) come from the schema file, because the database does not hold them
// (D40). The output is deterministic and laid out the way oxfmt lays out
// TypeScript (.oxfmtrc.json), so a formatter run on it changes nothing and
// `schema types --check` and the pre-commit hook agree.

import type { SchemaCollection, SchemaDescription, SchemaObject } from "@/schema/types";

// the package the generated file takes the client types from: the published
// SDK (sdk/package.json), the name its users install
export const sdkPackage = "@iglo.tech/iglo.base";

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
// MyPosts). A name that starts with an underscore keeps it (`_superusers` is
// _Superusers), as system collections do, so no user collection can take its
// name; a name that starts with a digit gets one too.
export function typeBase(name: string): string {
  const base = name
    .split("_")
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
  if (base === "") {
    throw new TypesError(`the collection ${JSON.stringify(name)} has no name for a type`);
  }
  return name.startsWith("_") || /^\d/.test(base) ? `_${base}` : base;
}

// A member of a union: a type as written, or an array of a union of types
// (`(a | b)[]`; an array of one type is written `a[]`)
type Member = string | { of: string[] };

// A type: the members of a union (none is `never`). A json field's tsType is
// verbatim: it is written as the schema file has it, behind a formatter-ignore
// comment, because only the user knows where its line breaks belong.
interface TypeOf {
  members: Member[];
  verbatim?: boolean;
}

// a property of an object type
interface Prop {
  key: string;
  optional: boolean;
  doc: string | undefined;
  type: TypeOf;
}

// the type of one plain member
function plain(...members: string[]): TypeOf {
  return { members };
}

// the text of a member on one line
function memberText(member: Member): string {
  if (typeof member === "string") {
    return member;
  }
  const of = membersOf(member.of);
  return of.length === 1 ? `${of[0]}[]` : `(${of.join(" | ")})[]`;
}

// the members of a union, with `never` for a union with none
function membersOf(members: readonly string[]): string[] {
  return members.length === 0 ? ["never"] : [...members];
}

// the type on one line
function typeText(type: TypeOf): string {
  if (type.members.length === 0) {
    return "never";
  }
  return type.members.map(memberText).join(" | ");
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

// The lines of one member of a union that breaks, at the member's indent. An
// array of a union that does not fit breaks inside its parentheses, with its
// members four columns in and the closing parenthesis two columns in, as oxfmt
// lays it out.
function memberLines(member: Member, indent: string, suffix: string): string[] {
  const inline = `${indent}| ${memberText(member)}${suffix}`;
  if (
    typeof member === "string" ||
    inline.length <= printWidth ||
    membersOf(member.of).length === 1
  ) {
    return [inline];
  }
  return [
    `${indent}| (`,
    ...membersOf(member.of).map((value) => `${indent}    | ${value}`),
    `${indent}  )[]${suffix}`,
  ];
}

// the lines of one property. A type too long for a line breaks the way oxfmt
// breaks it: a union with a leading "| " on each member, and an array of a
// union with its members in parentheses.
function propLines(prop: Prop, indent: string): string[] {
  const doc = prop.doc === undefined ? [] : docLines(prop.doc, indent);
  const head = `${indent}${keyText(prop.key)}${prop.optional ? "?" : ""}`;
  const line = `${head}: ${typeText(prop.type)};`;
  if (prop.type.verbatim === true) {
    // oxfmt leaves the line behind the comment as it is
    return [...doc, `${indent}// oxfmt-ignore`, line];
  }
  if (line.length <= printWidth) {
    return [...doc, line];
  }
  const members = prop.type.members;
  if (members.length === 1) {
    // an array of a union breaks inside its parentheses; any other single type does not break
    const only = members[0];
    if (typeof only !== "string" && only !== undefined && only.of.length > 1) {
      return [
        ...doc,
        `${head}: (`,
        ...only.of.map((value) => `${indent}  | ${value}`),
        `${indent})[];`,
      ];
    }
    return [...doc, line];
  }
  return [
    ...doc,
    `${head}:`,
    ...members.flatMap((member, index) =>
      memberLines(member, `${indent}  `, index === members.length - 1 ? ";" : ""),
    ),
  ];
}

// A string literal as oxfmt writes it: double quotes, unless the value has more
// double quotes than single quotes, which take single quotes (prettier's rule).
// The escapes that JSON writes are the ones oxfmt keeps.
function stringLiteral(value: string): string {
  const doubles = value.split('"').length - 1;
  const singles = value.split("'").length - 1;
  if (doubles <= singles) {
    return JSON.stringify(value);
  }
  // every double quote in JSON's text is escaped by one backslash: unescape it
  const body = JSON.stringify(value).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'");
  return `'${body}'`;
}

// the members of a select's values
function valueMembers(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => stringLiteral(value));
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

// A json field's type: its tsType as written, or `unknown`. A field that is
// not required reads null when it is unset (upstream stores no value), so the
// type includes null. A tsType that binds looser than a union (a function, a
// constructor or a conditional type) is parenthesized before `| null`.
function jsonType(required: boolean, file: FileField | undefined): TypeOf {
  const tsType = file?.tsType;
  if (tsType === undefined) {
    return required ? plain("unknown") : plain("unknown", "null");
  }
  const looseBinding = /=>|\bnew\b|\bextends\b/.test(tsType);
  if (required) {
    return { members: [tsType], verbatim: true };
  }
  const text = looseBinding ? `(${tsType}) | null` : `${tsType} | null`;
  return { members: [text], verbatim: true };
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
      return plain("string");
    case "number":
      return plain("number");
    case "bool":
      return plain("boolean");
    case "select": {
      const values = valueMembers(field.values);
      if (isMultiple(field)) {
        return { members: [{ of: values }] };
      }
      // an unset single select reads as "", the API's empty value, unless it is required
      return { members: field.required === true ? values : ['""', ...values] };
    }
    case "relation":
    case "file":
      return isMultiple(field) ? { members: [{ of: ["string"] }] } : plain("string");
    case "json":
      return jsonType(field.required === true, file);
    case "geoPoint":
      return plain("{ lon: number; lat: number }");
    default:
      throw new TypesError(
        `the field ${JSON.stringify(name)} of ${JSON.stringify(collection)} has the type ${JSON.stringify(type)}, which schema types does not know`,
      );
  }
}

// What a request sets a file field to (upstream's FileField.setValue and its
// modifiers, core/field_file.go): a file, or for a multi-file field an array
// of them. An update also takes the name of a file the record has (a string
// keeps it, "" clears the field), and null clears a field that is not required.
function fileValue(field: Json, forUpdate: boolean): Member[] {
  const upload = forUpdate ? ["File", "Blob", "string"] : ["File", "Blob"];
  return isMultiple(field) ? [...upload, { of: upload }] : upload;
}

// the type a request sets a field to
function inputType(
  field: Json,
  file: FileField | undefined,
  collection: string,
  forUpdate: boolean,
): TypeOf {
  if (field.type !== "file") {
    return storedType(field, file, collection);
  }
  const members = fileValue(field, forUpdate);
  if (forUpdate && field.required !== true) {
    members.push("null");
  }
  return { members };
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
function modifierProp(key: string, members: Member[]): Prop {
  return { key, optional: true, doc: undefined, type: { members } };
}

// the modifiers an update takes for a field (upstream's FindSetter): the
// number increments and decrements, the select, relation and file values are
// added, prepended or removed
function modifiersOf(field: Json): Prop[] {
  const name = fieldName(field);
  switch (field.type) {
    case "number":
      return [modifierProp(`${name}+`, ["number"]), modifierProp(`${name}-`, ["number"])];
    case "select":
    case "relation": {
      // a value, or an array of values, the way the field takes it
      const values = field.type === "select" ? valueMembers(field.values) : ["string"];
      const value: Member[] = [...membersOf(values), { of: values }];
      return [
        modifierProp(`+${name}`, value),
        modifierProp(`${name}+`, value),
        modifierProp(`${name}-`, value),
      ];
    }
    case "file": {
      const upload = fileValue(field, true);
      return [
        modifierProp(`+${name}`, upload),
        modifierProp(`${name}+`, upload),
        modifierProp(`${name}-`, ["string", { of: ["string"] }]),
      ];
    }
    default:
      return [];
  }
}

// the lines of a declaration: its JSDoc, its head, its properties and its tail
function declaration(
  heads: readonly string[],
  props: readonly Prop[],
  doc: string | undefined,
  tail: string,
  indent: string,
): string[] {
  const lines: string[] = doc === undefined ? [] : docLines(doc, "");
  lines.push(...heads);
  for (const prop of props) {
    lines.push(...propLines(prop, indent));
  }
  lines.push(tail);
  return lines;
}

// an object type alias (`export type XCreate = {`): when that head is too
// long for a line, oxfmt breaks after the `=` and indents the object
function objectAlias(name: string, props: readonly Prop[], doc: string | undefined): string[] {
  const head = `export type ${name} = {`;
  if (head.length <= printWidth) {
    return declaration([head], props, doc, "};", "  ");
  }
  return declaration([`export type ${name} =`, "  {"], props, doc, "  };", "    ");
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
    { key: "id", optional: false, doc: undefined, type: plain("string") },
    { key: "collectionId", optional: false, doc: undefined, type: plain("string") },
    {
      key: "collectionName",
      optional: false,
      doc: undefined,
      type: plain(JSON.stringify(name)),
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
    type: plain("Expand"),
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
    if (key === "id") {
      // a record id is set on create only
      create.push({ key, optional: true, doc, type: inputType(field, fileOf(field), name, false) });
      continue;
    }
    // a password is required on create, and so is its confirmation (upstream's
    // RecordUpsert: a new record needs both)
    const authPassword = type === "auth" && key === "password";
    create.push({
      key,
      optional: isOptionalOnCreate(field) && !authPassword,
      doc,
      type: inputType(field, fileOf(field), name, false),
    });
    update.push({ key, optional: true, doc, type: inputType(field, fileOf(field), name, true) });
    if (authPassword) {
      create.push({
        key: "passwordConfirm",
        optional: false,
        doc: undefined,
        type: plain("string"),
      });
      update.push({
        key: "passwordConfirm",
        optional: true,
        doc: undefined,
        type: plain("string"),
      });
      update.push({
        key: "oldPassword",
        optional: true,
        doc: undefined,
        type: plain("string"),
      });
    }
    update.push(...modifiersOf(field));
  }

  // the response's head takes its Expand parameter on its own line when it is too long
  const responseHead = `export interface ${base}Response<Expand = {}> {`;
  const responseHeads =
    responseHead.length <= printWidth
      ? [responseHead]
      : [`export interface ${base}Response<`, "  Expand = {},", "> {"];

  return [
    ...declaration([`export interface ${base}Record {`], record, file?.description, "}", "  "),
    "",
    ...declaration(responseHeads, response, file?.description, "}", "  "),
    "",
    ...objectAlias(`${base}Create`, create, file?.description),
    "",
    ...objectAlias(`${base}Update`, update, file?.description),
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
// name, so a name that is not in the schema is a type error. It is generic
// over the client, so a browser or server client keeps its own methods
// (`TypedPocketBase<BrowserClient>`); the default is the plain client.
function typedClientLines(names: readonly { base: string; name: string }[]): string[] {
  const overloads = names.flatMap(({ base, name }) => {
    const value = `${JSON.stringify(name)} | Collections.${base}`;
    const line = `  collection(idOrName: ${value}): RecordService<${base}Response>;`;
    if (line.length <= printWidth) {
      return [line];
    }
    // the parameter breaks too when it is still too long: its union goes one member a line
    const param = `    idOrName: ${value},`;
    return [
      "  collection(",
      ...(param.length <= printWidth
        ? [param]
        : ["    idOrName:", `      | ${JSON.stringify(name)}`, `      | Collections.${base},`]),
      `  ): RecordService<${base}Response>;`,
    ];
  });
  return [
    'export type TypedPocketBase<C = PocketBase> = Omit<C, "collection"> & {',
    ...overloads,
    "};",
  ];
}

// a method of the migration helpers, generic over the collection name C; a
// signature too long for a line is broken one parameter a line, as oxfmt does
function methodLines(name: string, params: readonly string[], returns: string): string[] {
  const head = `  ${name}<C extends keyof MigrationRecords>(`;
  const line = `${head}${params.join(", ")}): ${returns};`;
  if (line.length <= printWidth) {
    return [line];
  }
  return [head, ...params.map((param) => `    ${param},`), `  ): ${returns};`];
}

// The migration types (D40, S.5): the records of each collection by name, the
// helpers of a migration's up(tx), and Migration, which a migration file
// default-exports `satisfies`. A rename's new name must be a field of the
// generated record, so a rename to a name the file lacks is a type error. The
// helpers match src/schema/migration-tx.ts.
function migrationLines(names: readonly { base: string; name: string }[]): string[] {
  const map = (title: string, value: (base: string) => string): string[] =>
    names.length === 0
      ? [`export interface ${title} {}`]
      : [
          `export interface ${title} {`,
          ...names.map(({ base, name }) => `  ${keyText(name)}: ${value(base)};`),
          "}",
        ];
  return [
    "// a migration's up(tx) gets these helpers, on the apply transaction (synchronous)",
    ...map("MigrationRecords", (base) => `${base}Response`),
    "",
    ...map("MigrationCreates", (base) => `${base}Create`),
    "",
    ...map("MigrationUpdates", (base) => `${base}Update`),
    "",
    "export interface MigrationQuery {",
    "  filter?: string;",
    "  sort?: string;",
    "  params?: Record<string, unknown>;",
    "}",
    "",
    "export interface MigrationTx {",
    ...methodLines(
      "records",
      ["collection: C", "query?: MigrationQuery"],
      "Generator<MigrationRecords[C]>",
    ),
    ...methodLines(
      "findFirst",
      ["collection: C", "query?: MigrationQuery"],
      "MigrationRecords[C] | null",
    ),
    ...methodLines("findById", ["collection: C", "id: string"], "MigrationRecords[C] | null"),
    ...methodLines("create", ["collection: C", "data: MigrationCreates[C]"], "MigrationRecords[C]"),
    ...methodLines(
      "update",
      ["collection: C", "id: string", "data: MigrationUpdates[C]"],
      "MigrationRecords[C]",
    ),
    ...methodLines("delete", ["collection: C", "id: string"], "void"),
    "  sql(query: string, params?: Record<string, unknown>): Record<string, unknown>[];",
    "}",
    "",
    "export type Migration = {",
    "  renames?: {",
    `    [C in keyof MigrationRecords]?: Record<string, keyof MigrationRecords[C] & string>;`,
    "  };",
    "  renameCollections?: Record<string, keyof MigrationRecords & string>;",
    "  up?: (tx: MigrationTx) => void | Promise<never>;",
    "};",
  ];
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
  parts.push(migrationLines(names));
  return parts.map((lines) => lines.join("\n")).join("\n\n") + "\n";
}
