// The declared renames of the pending TypeScript migrations (D40, S.5). Not an
// upstream file.
//
// A rename is checked against the database as it is when the renames run
// (after the JavaScript migrations) and against the file. The checks return
// problems, so `schema plan` shows every refusal and the apply stops before its
// backup. Collisions are refused: two renames that give one name, a name that
// is renamed again, or the same old name twice.

import type { Problem } from "@/schema/report";
import type { SchemaDescription } from "@/schema/types";
import type { SchemaMigration } from "@/schema/migration-files";

export interface FieldRename {
  file: string;
  collection: string;
  from: string;
  to: string;
}

export interface CollectionRename {
  file: string;
  from: string;
  to: string;
}

export interface DeclaredRenameSet {
  fields: FieldRename[];
  collections: CollectionRename[];
}

// the renames the given migration files declare, in file order
export function declaredRenameSet(migrations: readonly SchemaMigration[]): DeclaredRenameSet {
  const fields: FieldRename[] = [];
  const collections: CollectionRename[] = [];
  for (const migration of migrations) {
    for (const [collection, pairs] of Object.entries(migration.renames)) {
      for (const [from, to] of Object.entries(pairs)) {
        fields.push({ file: migration.file, collection, from, to });
      }
    }
    for (const [from, to] of Object.entries(migration.renameCollections)) {
      collections.push({ file: migration.file, from, to });
    }
  }
  return { fields, collections };
}

// the collection's name after the renames, by the name it has before them
export function renamedCollectionName(renames: DeclaredRenameSet, name: string): string {
  return renames.collections.find((rename) => rename.from === name)?.to ?? name;
}

// The problems of the renames, against the database (current) and the file
// (desired). Empty when every rename can run.
export function renameProblems(
  current: SchemaDescription,
  desired: SchemaDescription,
  renames: DeclaredRenameSet,
): Problem[] {
  const problems: Problem[] = [];
  const stored = new Map(current.collections.map((collection) => [collection.name, collection]));
  const wanted = new Set(desired.collections.map((collection) => collection.name));

  // collections
  const seenFrom = new Map<string, string>();
  const seenTo = new Map<string, string>();
  const collectionPairs: { from: string; to: string; where: string; file: string }[] = [];
  for (const rename of renames.collections) {
    const where = rename.from;
    const from = stored.get(rename.from);
    const note = `(declared in ${rename.file})`;
    if (from === undefined) {
      problems.push({
        where,
        message: `renameCollections: there is no collection ${JSON.stringify(rename.from)} to rename ${note}`,
        next: "Check the old name, or remove the declaration once the rename has run.",
      });
      continue;
    }
    if (from.system) {
      problems.push({ where, message: `a system collection cannot be renamed ${note}` });
      continue;
    }
    if (from.type === "view") {
      problems.push({
        where,
        message: `a view collection cannot be renamed ${note}`,
        next: "Remove the view and add one under the new name.",
      });
      continue;
    }
    if (rename.to === rename.from) {
      problems.push({
        where,
        message: `renameCollections: ${rename.from} is renamed to itself ${note}`,
      });
      continue;
    }
    if (stored.has(rename.to)) {
      problems.push({
        where,
        message: `renameCollections: the collection ${JSON.stringify(rename.to)} already exists ${note}`,
        next: "Rename the other collection first, or choose another name.",
      });
    }
    if (!wanted.has(rename.to)) {
      problems.push({
        where,
        message: `renameCollections: the schema file has no collection ${JSON.stringify(rename.to)} ${note}`,
        next: "Name the collection in the file as the rename does.",
      });
    }
    collide(seenFrom, rename.from, rename.to, "collection", where, problems);
    collide(seenTo, rename.to, rename.from, "collection name", where, problems);
    collectionPairs.push({ from: rename.from, to: rename.to, where, file: rename.file });
  }
  chainProblems(collectionPairs, problems);

  // fields, keyed by the collection's name before the apply
  const fieldFrom = new Map<string, Map<string, string>>();
  const fieldTo = new Map<string, Map<string, string>>();
  const fieldPairs = new Map<string, { from: string; to: string; where: string; file: string }[]>();
  for (const rename of renames.fields) {
    const where = `${rename.collection}.${rename.from}`;
    const note = `(declared in ${rename.file})`;
    const collection = stored.get(rename.collection);
    if (collection === undefined) {
      problems.push({
        where,
        message: `renames: there is no collection ${JSON.stringify(rename.collection)} ${note}`,
        next: "Key the rename by the collection's name before the apply.",
      });
      continue;
    }
    if (collection.type === "view") {
      problems.push({
        where,
        message: `a view's fields come from its query, so they cannot be renamed ${note}`,
      });
      continue;
    }
    const field = collection.fields.find((f) => f.name === rename.from);
    if (field === undefined) {
      problems.push({
        where,
        message: `renames: the collection ${rename.collection} has no field ${JSON.stringify(rename.from)} ${note}`,
        next: "Check the old name, or remove the declaration once the rename has run.",
      });
      continue;
    }
    if (field.system) {
      problems.push({ where, message: `a system field cannot be renamed ${note}` });
      continue;
    }
    if (rename.to === rename.from) {
      problems.push({ where, message: `renames: the field is renamed to itself ${note}` });
      continue;
    }
    if (collection.fields.some((f) => f.name === rename.to)) {
      problems.push({
        where,
        message: `renames: the collection ${rename.collection} already has a field ${JSON.stringify(rename.to)} ${note}`,
        next: "Remove or rename that field first, or choose another name.",
      });
    }
    const target = renamedCollectionName(renames, rename.collection);
    const desiredCollection = desired.collections.find((c) => c.name === target);
    if (
      desiredCollection === undefined ||
      !desiredCollection.fields.some((f) => f.name === rename.to)
    ) {
      problems.push({
        where,
        message: `renames: the schema file has no field ${JSON.stringify(rename.to)} in ${target} ${note}`,
        next: "Name the field in the file as the rename does.",
      });
    }
    collide(scoped(fieldFrom, rename.collection), rename.from, rename.to, "field", where, problems);
    collide(
      scoped(fieldTo, rename.collection),
      rename.to,
      rename.from,
      "field name",
      where,
      problems,
    );
    const pairs = fieldPairs.get(rename.collection) ?? [];
    pairs.push({ from: rename.from, to: rename.to, where, file: rename.file });
    fieldPairs.set(rename.collection, pairs);
  }
  for (const pairs of fieldPairs.values()) {
    chainProblems(pairs, problems);
  }
  return problems;
}

// the map of one collection's pairs, made when first used
function scoped(maps: Map<string, Map<string, string>>, collection: string): Map<string, string> {
  let map = maps.get(collection);
  if (map === undefined) {
    map = new Map();
    maps.set(collection, map);
  }
  return map;
}

// A name that two renames share, or a name that is renamed again: the rename
// that comes second is refused, with the first one named.
function collide(
  seen: Map<string, string>,
  key: string,
  value: string,
  what: string,
  where: string,
  problems: Problem[],
): void {
  const other = seen.get(key);
  if (other !== undefined) {
    problems.push({
      where,
      message: `renames collide: the ${what} ${JSON.stringify(key)} is used by two renames (${JSON.stringify(other)})`,
      next: "Declare each name once, and do not rename a name that another rename creates.",
    });
    return;
  }
  seen.set(key, value);
}

// A name that another rename of the same scope creates is renamed again (a
// chain): the apply does not guess the order, so the rename is refused.
function chainProblems(
  pairs: readonly { from: string; to: string; where: string; file: string }[],
  problems: Problem[],
): void {
  for (const pair of pairs) {
    const next = pairs.find((other) => other !== pair && other.from === pair.to);
    if (next !== undefined) {
      problems.push({
        where: pair.where,
        message: `renames collide: ${JSON.stringify(pair.to)} is created by this rename and renamed again (declared in ${next.file})`,
        next: "Rename each name once, in a migration of its own.",
      });
    }
  }
}
