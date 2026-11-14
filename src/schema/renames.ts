// The declared renames of the pending TypeScript migrations (D40, S.5). Not an
// upstream file.
//
// The pending files run in name order, each one's renames against the
// database as the files before it left it (a chain across files works). So a
// file's keys are the names its collections have when its turn comes, which is
// the collection's name before that file's own renames: a collection renamed in
// the same file is keyed by its old name. The check of one file is `fileProblems`,
// against that state. The check that every rename ends in a name the schema file
// has is `applied` in apply.ts, once all files ran: an intermediate name of a
// chain is not in the file.
//
// Problems are returned, not thrown, so `schema plan` shows them and the apply
// stops before anything is kept. A collision inside one file is refused: two
// renames that give one name, a name that the same file renames again, or the
// same old name twice.
//
// Collection and field names are unique without regard to case (upstream checks
// them lowercased, and SQLite compares column and table names so), so a new name
// that equals another item's name in any case is refused, with that item named.
// A rename that only changes the case of its own name is allowed: it keeps the
// data, as upstream's table sync does.

import type { Problem } from "@/schema/report";
import type { SchemaDescription } from "@/schema/types";
import type { SchemaMigration } from "@/schema/migration-files";

// the problems of one pending file's renames, against the database as it is
// when the file's turn comes (`stored`)
export function fileProblems(stored: SchemaDescription, file: SchemaMigration): Problem[] {
  const problems: Problem[] = [];
  const collections = new Map(
    stored.collections.map((collection) => [collection.name, collection]),
  );

  // collections
  const seenFrom = new Map<string, string>();
  const seenTo = new Map<string, string>();
  const collectionPairs: Pair[] = [];
  for (const [from, to] of Object.entries(file.renameCollections)) {
    const where = from;
    const note = `(declared in ${file.file})`;
    const collection = collections.get(from);
    if (collection === undefined) {
      const created = Object.entries(file.renameCollections).find(
        ([, value]) => value.toLowerCase() === from.toLowerCase(),
      );
      problems.push(
        created === undefined
          ? {
              where,
              message: `renameCollections: there is no collection ${JSON.stringify(from)} to rename ${note}`,
              next: "Check the old name, or remove the declaration once the rename has run.",
            }
          : chainMessage(from, created[0], where, note),
      );
      continue;
    }
    if (collection.system) {
      problems.push({ where, message: `a system collection cannot be renamed ${note}` });
      continue;
    }
    if (collection.type === "view") {
      problems.push({
        where,
        message: `a view collection cannot be renamed ${note}`,
        next: "Remove the view and add one under the new name.",
      });
      continue;
    }
    if (to === from) {
      problems.push({ where, message: `renameCollections: ${from} is renamed to itself ${note}` });
      continue;
    }
    const clash = clashing(stored.collections, from, to);
    if (clash !== undefined) {
      problems.push({
        where,
        message: `renameCollections: the collection ${JSON.stringify(clash.name)} already exists ${note}`,
        next: "Rename the other collection first, or choose another name. Names are compared without regard to case.",
      });
    }
    collide(seenFrom, from, to, "collection", where, problems);
    collide(seenTo, to, from, "collection name", where, problems);
    collectionPairs.push({ from, to, where, file: file.file });
  }
  chainProblems(collectionPairs, problems);

  // fields, keyed by the collection's name before the file's renames
  const fieldPairs = new Map<string, Pair[]>();
  for (const [collectionName, pairs] of Object.entries(file.renames)) {
    const scopedFrom = new Map<string, string>();
    const scopedTo = new Map<string, string>();
    for (const [from, to] of Object.entries(pairs)) {
      const where = `${collectionName}.${from}`;
      const note = `(declared in ${file.file})`;
      const collection = collections.get(collectionName);
      if (collection === undefined) {
        problems.push({
          where,
          message: `renames: there is no collection ${JSON.stringify(collectionName)} ${note}`,
          next: "Key the rename by the collection's name before the apply (a collection renamed in the same file keeps its old name here).",
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
      const field = collection.fields.find((f) => f.name === from);
      if (field === undefined) {
        const created = Object.entries(pairs).find(([, value]) => value === from);
        problems.push(
          created === undefined
            ? {
                where,
                message: `renames: the collection ${collectionName} has no field ${JSON.stringify(from)} ${note}`,
                next: "Check the old name, or remove the declaration once the rename has run.",
              }
            : chainMessage(from, created[0], where, note),
        );
        continue;
      }
      if (field.system) {
        problems.push({ where, message: `a system field cannot be renamed ${note}` });
        continue;
      }
      if (to === from) {
        problems.push({ where, message: `renames: the field is renamed to itself ${note}` });
        continue;
      }
      const clash = clashing(collection.fields, from, to);
      if (clash !== undefined) {
        problems.push({
          where,
          message: `renames: the collection ${collectionName} already has a field ${JSON.stringify(clash.name)} ${note}`,
          next: "Remove or rename that field first, or choose another name. Names are compared without regard to case.",
        });
      }
      collide(scopedFrom, from, to, "field", where, problems);
      collide(scopedTo, to, from, "field name", where, problems);
      const list = fieldPairs.get(collectionName) ?? [];
      list.push({ from, to, where, file: file.file });
      fieldPairs.set(collectionName, list);
    }
  }
  for (const pairs of fieldPairs.values()) {
    chainProblems(pairs, problems);
  }
  return problems;
}

interface Pair {
  from: string;
  to: string;
  where: string;
  file: string;
}

// the item of `items` that the name `to` clashes with: another item whose name
// is `to` in any case. The item `from` is renamed does not clash with itself
// (a rename that only changes case).
function clashing<T extends { name: string }>(
  items: readonly T[],
  from: string,
  to: string,
): T | undefined {
  const lower = to.toLowerCase();
  return items.find((item) => item.name !== from && item.name.toLowerCase() === lower);
}

// A name that two renames share, or a name that is renamed again: the rename
// that comes second is refused, with the first one named. Names are compared
// without regard to case.
function collide(
  seen: Map<string, string>,
  key: string,
  value: string,
  what: string,
  where: string,
  problems: Problem[],
): void {
  const other = seen.get(key.toLowerCase());
  if (other !== undefined) {
    problems.push({
      where,
      message: `renames collide: the ${what} ${JSON.stringify(key)} is used by two renames (${JSON.stringify(other)})`,
      next: "Declare each name once, and do not rename a name that another rename creates in the same file.",
    });
    return;
  }
  seen.set(key.toLowerCase(), value);
}

// A name that another rename of the same file creates is renamed again (a
// chain within one file): the apply does not guess the order, so it is refused.
// A chain across files is fine: each file runs against the names the earlier
// ones left. Names are compared without regard to case.
function chainProblems(pairs: readonly Pair[], problems: Problem[]): void {
  for (const pair of pairs) {
    const next = pairs.find(
      (other) => other !== pair && other.from.toLowerCase() === pair.to.toLowerCase(),
    );
    if (next !== undefined) {
      problems.push({
        where: pair.where,
        message: `renames collide: ${JSON.stringify(pair.to)} is created by this rename and renamed again in the same file (${next.where})`,
        next: "Put the second rename in a migration of its own, so it runs after this one.",
      });
    }
  }
}

// A rename whose old name is the new name of another rename in the same file:
// the file's keys are the names before its own renames, so the chain cannot
// run in one file. The message names both renames.
function chainMessage(name: string, creator: string, where: string, note: string): Problem {
  return {
    where,
    message: `renames collide: ${JSON.stringify(name)} is created by the rename of ${JSON.stringify(creator)} in this file and renamed again in the same file ${note}`,
    next: "Put the second rename in a migration of its own, so it runs after this one. A file's keys are the names before its own renames.",
  };
}
