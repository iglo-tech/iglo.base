// The changes between two schema descriptions (D40, S.3). Not an upstream
// file, and pure: no database. The apply (src/schema/apply.ts) compares the
// file with the database's description through this, and the plan prints it.
//
// Fields are matched by name, as the file has no ids. A field of the same
// name with another type is a replacement: it is removed and added again,
// which the apply does in one save (the dashboard cannot change a field's
// type, upstream's validator refuses it). Indexes are compared by their
// definition, not their name (D40): an index with the same definition under
// another name is the same index, and it keeps its stored name.

import { explicitIndexes, isImpliedIndex } from "@/schema/implied";
import { providerChanges } from "@/schema/providers";
import type {
  SchemaCollection,
  SchemaDescription,
  SchemaField,
  SchemaObject,
} from "@/schema/types";
import { jsonEqual } from "@/schema/values";
import { parseIndex } from "@/tools/dbutils/index";

export type FieldChangeKind = "added" | "removed" | "changed" | "replaced";

export interface FieldChange {
  name: string;
  kind: FieldChangeKind;
  // a system field is implied by the collection's type (id, tokenKey, ...)
  system: boolean;
  // the type after the change, or the type it had when removed
  type: string;
  // what differs: option names, or "type" and "system"
  details: string[];
}

export interface IndexChange {
  // "rebuilt": the plan's kind for an index the file keeps, which a rename
  // drops and creates again (apply.ts shownChanges); the apply's own changes
  // never have it
  kind: "added" | "removed" | "rebuilt";
  statement: string;
  // the rows of the collection's table, set by the apply for an added or
  // rebuilt index
  rows?: number;
}

export interface CollectionChange {
  name: string;
  kind: "added" | "removed" | "changed";
  type: string;
  fields: FieldChange[];
  // the listed fields are in another order
  fieldOrder: boolean;
  // rule keys (list, view, ...) that differ
  rules: string[];
  // option names that differ; "query" for a view, "system" and "type" too
  options: string[];
  // the providers that differ, as lines that name the provider and the key
  // (src/schema/providers.ts); never a value
  providers: string[];
  indexes: IndexChange[];
}

export interface SchemaChanges {
  collections: CollectionChange[];
}

// The key of an index by its definition: uniqueness, columns with their
// collation and sort order, and the WHERE clause. Names and quoting do not
// count. A statement that does not parse is its own key.
export function indexKey(statement: string): string {
  const index = parseIndex(statement);
  if (!index.isValid()) {
    return "raw:" + statement.trim();
  }
  return JSON.stringify({
    unique: index.unique,
    columns: index.columns.map((column) => [
      column.name.replace(/[`"[\]\s]/g, "").toLowerCase(),
      column.collate.toUpperCase(),
      column.sort.toUpperCase(),
    ]),
    where: index.where.replace(/[`"\s]/g, ""),
  });
}

// the statements without a repeated definition, the first one kept
export function distinctIndexes(statements: readonly string[]): string[] {
  const seen = new Set<string>();
  return statements.filter((statement) => {
    const key = indexKey(statement);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

// The statement the database keeps for a desired index: the stored statement
// with the same definition when there is one (so its name stays), else the
// desired statement.
export function keepStoredIndexes(desired: readonly string[], stored: readonly string[]): string[] {
  const byKey = new Map(stored.map((statement) => [indexKey(statement), statement]));
  return desired.map((statement) => byKey.get(indexKey(statement)) ?? statement);
}

const ruleOrder = ["list", "view", "create", "update", "delete", "auth", "manage"];

function sameRule(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

// the option keys of a field that differ
function fieldOptionDiff(current: SchemaObject, desired: SchemaObject): string[] {
  const keys = new Set([...Object.keys(current), ...Object.keys(desired)]);
  return [...keys].filter((key) => !jsonEqual(current[key], desired[key])).toSorted();
}

function fieldChanges(current: SchemaCollection, desired: SchemaCollection): FieldChange[] {
  const currentByName = new Map(current.fields.map((field) => [field.name, field]));
  const desiredByName = new Map(desired.fields.map((field) => [field.name, field]));
  const changes: FieldChange[] = [];

  for (const field of desired.fields) {
    const before = currentByName.get(field.name);
    if (before === undefined) {
      changes.push({
        name: field.name,
        kind: "added",
        type: field.type,
        system: field.system,
        details: [],
      });
    } else if (before.type !== field.type) {
      changes.push({
        name: field.name,
        kind: "replaced",
        type: field.type,
        system: field.system,
        details: ["type"],
      });
    } else {
      const details = fieldOptionDiff(before.options, field.options);
      if (before.system !== field.system) {
        details.push("system");
      }
      if (details.length > 0) {
        changes.push({
          name: field.name,
          kind: "changed",
          type: field.type,
          system: field.system,
          details,
        });
      }
    }
  }
  for (const field of current.fields) {
    if (!desiredByName.has(field.name)) {
      changes.push({
        name: field.name,
        kind: "removed",
        type: field.type,
        system: field.system,
        details: [],
      });
    }
  }
  return changes;
}

// whether the fields both have are in the same order
function fieldsReordered(current: SchemaCollection, desired: SchemaCollection): boolean {
  const desiredNames = new Set(desired.fields.map((field) => field.name));
  const currentNames = new Set(current.fields.map((field) => field.name));
  const before = current.fields.map((f) => f.name).filter((name) => desiredNames.has(name));
  const after = desired.fields.map((f) => f.name).filter((name) => currentNames.has(name));
  return before.some((name, i) => name !== after[i]);
}

// The indexes of a collection that the change compares: the explicit ones. An
// implied index (upstream's own, on an auth collection) is not compared, whether
// the file lists it or not: the save restores a missing one and keeps the stored
// one (D40).
function indexChanges(current: SchemaCollection, desired: SchemaCollection): IndexChange[] {
  const currentIndexes = explicitIndexes(current.indexes, current);
  const desiredIndexes = explicitIndexes(desired.indexes, desired);
  const currentKeys = new Set(currentIndexes.map(indexKey));
  const desiredKeys = new Set(desiredIndexes.map(indexKey));
  const changes: IndexChange[] = [];
  for (const statement of desiredIndexes) {
    if (!currentKeys.has(indexKey(statement))) {
      changes.push({ kind: "added", statement });
    }
  }
  for (const statement of currentIndexes) {
    if (!desiredKeys.has(indexKey(statement))) {
      changes.push({ kind: "removed", statement });
    }
  }
  return changes;
}

// the option names of a collection that differ, with type, system and query
function optionDiff(current: SchemaCollection, desired: SchemaCollection): string[] {
  const diff: string[] = [];
  if (current.type !== desired.type) {
    diff.push("type");
  }
  if (current.system !== desired.system) {
    diff.push("system");
  }
  if (current.type === "view" && desired.type === "view" && current.query !== desired.query) {
    diff.push("query");
  }
  const keys = new Set([...Object.keys(current.options), ...Object.keys(desired.options)]);
  for (const key of [...keys].toSorted()) {
    if (!jsonEqual(current.options[key], desired.options[key])) {
      diff.push(key);
    }
  }
  return diff;
}

function ruleDiff(current: SchemaCollection, desired: SchemaCollection): string[] {
  const keys = new Set([...Object.keys(current.rules), ...Object.keys(desired.rules)]);
  return [...keys]
    .filter((key) => !sameRule(current.rules[key], desired.rules[key]))
    .toSorted((a, b) => ruleOrder.indexOf(a) - ruleOrder.indexOf(b));
}

// The changes that turn the current description into the desired one. Only
// the collections that change are listed; a collection that is equal, in
// every part the file holds, is not.
export function diffSchemas(current: SchemaDescription, desired: SchemaDescription): SchemaChanges {
  const currentByName = new Map(current.collections.map((c) => [c.name, c]));
  const desiredByName = new Map(desired.collections.map((c) => [c.name, c]));
  const collections: CollectionChange[] = [];

  for (const collection of desired.collections) {
    const before = currentByName.get(collection.name);
    if (before === undefined) {
      collections.push({
        name: collection.name,
        kind: "added",
        type: collection.type,
        fields: collection.fields.map((field: SchemaField) => ({
          name: field.name,
          kind: "added",
          type: field.type,
          system: field.system,
          details: [],
        })),
        fieldOrder: false,
        rules: [],
        options: [],
        providers: providerChanges([], collection.providers ?? []),
        indexes: explicitIndexes(collection.indexes, collection).map((statement) => ({
          kind: "added",
          statement,
        })),
      });
      continue;
    }

    const change: CollectionChange = {
      name: collection.name,
      kind: "changed",
      type: collection.type,
      fields: collection.type === "view" ? [] : fieldChanges(before, collection),
      fieldOrder: collection.type === "view" ? false : fieldsReordered(before, collection),
      rules: ruleDiff(before, collection),
      options: optionDiff(before, collection),
      providers:
        collection.providers === undefined
          ? []
          : providerChanges(before.providers ?? [], collection.providers),
      indexes: collection.type === "view" ? [] : indexChanges(before, collection),
    };
    if (
      change.fields.length > 0 ||
      change.fieldOrder ||
      change.rules.length > 0 ||
      change.options.length > 0 ||
      change.providers.length > 0 ||
      change.indexes.length > 0
    ) {
      collections.push(change);
    }
  }

  for (const collection of current.collections) {
    if (!desiredByName.has(collection.name)) {
      collections.push({
        name: collection.name,
        kind: "removed",
        type: collection.type,
        fields: collection.fields.map((field) => ({
          name: field.name,
          kind: "removed",
          type: field.type,
          system: field.system,
          details: [],
        })),
        fieldOrder: false,
        rules: [],
        options: [],
        providers: [],
        indexes: [],
      });
    }
  }

  return { collections };
}

// The field changes that lose the values of a field: a removal or a
// replacement (the old column goes).
export function lostFields(change: CollectionChange): FieldChange[] {
  return change.fields.filter((f) => f.kind === "removed" || f.kind === "replaced");
}

// the fields that are new or change, which the record check validates
export function checkedFields(change: CollectionChange): string[] {
  return change.fields
    .filter((f) => f.kind === "added" || f.kind === "changed" || f.kind === "replaced")
    .map((f) => f.name);
}

// the indexes a collection keeps on its own (upstream's implied ones), as
// the stored statements
export function impliedStatements(
  stored: readonly string[],
  collection: SchemaCollection,
): string[] {
  return stored.filter((statement) => isImpliedIndex(statement, collection));
}

export function isEmptyChanges(changes: SchemaChanges): boolean {
  return changes.collections.length === 0;
}
