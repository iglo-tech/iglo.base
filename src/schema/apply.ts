// Applying the schema file to the database (D40, S.3). Not an upstream file.
//
// The steps, in D40's order:
//
//	before the transaction (read only): compute the changes. When nothing
//	changes and no JavaScript migration is pending, stop: no backup and no
//	record check. Otherwise refuse a data loss that the file would cause
//	(when no migration is pending, so that the state is known), then make the
//	pre-schema backup; a failed backup stops the apply.
//
//	in one write transaction:
//	  1. the pending JavaScript migrations (D23), with `up`, as serve ran them
//	     before; they may change the structure first
//	  2. renames (S.5; none yet)
//	  3. the changes against the file, again; the data-loss guard; the SQL
//	     views that the changes affect are dropped
//	  4. widen: new collections with their plain fields, and the new plain
//	     fields of the existing ones (a replaced field, same name with
//	     another type, waits for step 6, and the removed fields stay)
//	  5. widen: the new relation fields, once every target exists
//	  5a. TypeScript migrations (S.5; none yet)
//	  6. narrow: the new and changed collections in full (fields, indexes,
//	     rules, options); then the removed ones
//	  7. the SQL views of the affected view collections are created again
//	  8. the record check, for the fields the apply added or changed
//	  9. commit; or roll back, so that the database is unchanged
//
// Every save goes through the collection save path (saveCollection), as the
// dashboard does, so the stored result is the dashboard's. Nothing runs over
// the network inside the transaction.
//
// `plan` runs the same transaction and rolls it back, with no backup.

import type { App } from "@/app/app";
import { Collection, newCollection } from "@/collections/collection-model";
import {
  findAllCollections,
  findCollectionByNameOrId,
  reloadCachedCollections,
} from "@/collections/collection-query";
import { deleteCollection, saveCollection } from "@/collections/collection-save";
import type { Databases } from "@/db/base";
import { deleteView } from "@/db/table";
import { runInTransaction } from "@/db/tx";
import { collectionJSON, fieldJSON, settingsJSON, type CollectionIdOf } from "@/schema/apply-json";
import { makePreSchemaBackup, prunePreSchemaBackups } from "@/schema/backup";
import { countRows, countValues, recordProblems } from "@/schema/check";
import { describeCollections } from "@/schema/describe";
import {
  checkedFields,
  diffSchemas,
  impliedStatements,
  keepStoredIndexes,
  lostFields,
  type CollectionChange,
  type SchemaChanges,
} from "@/schema/diff";
import {
  formatReport,
  newReport,
  reportIsOK,
  type ApplyReport,
  type Problem,
} from "@/schema/report";
import { readSchema, type SchemaIssue } from "@/schema/read";
import type { SchemaCollection, SchemaDescription } from "@/schema/types";
import { isMigrationApplied, up, type Migration } from "@/migrations/migrations-runner";
import { Errors } from "@/validation/error";

// The file is not a valid schema: its problems, with their JSON paths.
export class SchemaFileError extends Error {
  constructor(readonly issues: SchemaIssue[]) {
    super(
      "the schema file is not valid:\n" +
        issues.map((issue) => `  ${issue.path}: ${issue.message}`).join("\n"),
    );
    this.name = "SchemaFileError";
  }
}

// The apply stopped before committing. The report says why, and the database
// is unchanged.
export class SchemaApplyError extends Error {
  constructor(readonly report: ApplyReport) {
    super("schema not applied; the database is unchanged\n" + formatReport(report));
    this.name = "SchemaApplyError";
  }
}

export interface ApplyOptions {
  // delete the fields and collections that hold data (the data-loss guard)
  allowDataLoss: boolean;
  // the JavaScript migrations of pb_migrations, in run order
  migrations: readonly Migration[];
}

// A save of a collection failed: the problem names the collection.
class SaveFailed extends Error {
  constructor(
    readonly collection: string,
    cause: unknown,
  ) {
    super(messageOf(cause), { cause });
    this.name = "SaveFailed";
  }
}

// the transaction stops: the problems are in the report already
class StopApply extends Error {}

// the plan's roll back, after the transaction ran to its end
class RollBack extends Error {}

// reads the file text; a file that is not valid stops here
export function parseSchemaFile(text: string): SchemaDescription {
  const result = readSchema(text);
  if (!result.ok) {
    throw new SchemaFileError(result.errors);
  }
  return result.schema;
}

// Applies the file, as serve does at startup. It throws a SchemaApplyError
// when the apply stops, and the database is unchanged then.
export async function applySchema(
  app: App,
  text: string,
  options: ApplyOptions,
): Promise<ApplyReport> {
  const desired = parseSchemaFile(text);
  const pending = pendingMigrations(app, options.migrations);

  // read only: when nothing changes, there is nothing to back up or check
  const current = describeCollections(findAllCollections(app));
  const changes = diffSchemas(current, desired);
  if (changes.collections.length === 0 && pending.length === 0) {
    return newReport("apply", options.allowDataLoss);
  }

  // a data loss that is known now stops before the backup
  if (pending.length === 0 && !options.allowDataLoss) {
    const known = newReport("apply", false);
    known.changes = changes;
    collectLost(app.databases, current, changes, known);
    if (!reportIsOK(known)) {
      throw new SchemaApplyError(known);
    }
  }

  const backup = await makePreSchemaBackup(app);

  const report = runTransaction(app, desired, options, "apply");
  report.backup = backup;
  if (!reportIsOK(report)) {
    throw new SchemaApplyError(report);
  }
  await prunePreSchemaBackups(app);
  return report;
}

// Plans the file: the report of the changes, the migrations and every
// problem, with the database unchanged. No backup is made.
export function planSchema(app: App, text: string, options: ApplyOptions): ApplyReport {
  const desired = parseSchemaFile(text);
  return runTransaction(app, desired, options, "plan");
}

// the names of the migrations that have not run yet
function pendingMigrations(app: App, migrations: readonly Migration[]): string[] {
  return migrations.filter((m) => !isMigrationApplied(app.databases, m.file)).map((m) => m.file);
}

// The transaction of an apply or a plan. A failure is a problem in the report,
// and the transaction rolls back. The cache is reloaded afterwards: the saves
// reloaded it inside the transaction.
function runTransaction(
  app: App,
  desired: SchemaDescription,
  options: ApplyOptions,
  mode: "apply" | "plan",
): ApplyReport {
  const report = newReport(mode, options.allowDataLoss);
  try {
    runInTransaction(app.databases, (txDatabases) => {
      const txApp = txDatabases === app.databases ? app : { ...app, databases: txDatabases };
      applyInTransaction(txApp, desired, options, report);
      if (mode === "plan") {
        throw new RollBack("plan");
      }
    });
    report.committed = mode === "apply" && reportIsOK(report);
  } catch (err) {
    if (err instanceof SaveFailed) {
      report.problems.push(saveProblem(err));
    } else if (!(err instanceof StopApply) && !(err instanceof RollBack)) {
      report.problems.push({ where: "schema", message: messageOf(err) });
    }
  } finally {
    try {
      reloadCachedCollections(app);
    } catch {
      // best effort: the next bootstrap loads the cache again
    }
  }
  return report;
}

// the problem of a collection that the save refused
function saveProblem(err: SaveFailed): Problem {
  const message = err.message;
  if (/UNIQUE constraint failed/i.test(message)) {
    return {
      where: err.collection,
      message:
        "a unique index cannot be created, because records share a value: " +
        message.replace(/^.*?UNIQUE constraint failed/i, "UNIQUE constraint failed"),
      next: "Make those values distinct (change or delete the duplicate records), or make the index not unique.",
    };
  }
  return { where: err.collection, message };
}

// the text of an error: a validation error lists its fields
function messageOf(err: unknown): string {
  if (err instanceof Errors) {
    return Object.entries(err.errors)
      .map(([key, value]) => `${key}: ${value === null ? "invalid" : messageOf(value)}`)
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

// the save of a collection, with a failure that names it
function saveAs(app: App, collection: Collection, name: string): void {
  try {
    saveCollection(app, collection);
  } catch (err) {
    throw new SaveFailed(name, err);
  }
}

// The steps of the transaction, in D40's order. A failed step throws; the
// checks add their problems to the report and stop.
function applyInTransaction(
  app: App,
  desired: SchemaDescription,
  options: ApplyOptions,
  report: ApplyReport,
): void {
  // 1. the pending JavaScript migrations
  report.migrations = up(app, options.migrations);

  // 2. renames (S.5)
  applyRenames();

  // 3. the changes, now that the migrations ran; the guard
  const current = describeCollections(findAllCollections(app));
  const changes = diffSchemas(current, desired);
  report.changes = changes;
  for (const change of changes.collections) {
    if (change.kind === "changed" && change.options.includes("type")) {
      const before = current.collections.find((c) => c.name === change.name);
      const after = desired.collections.find((c) => c.name === change.name);
      report.problems.push({
        where: change.name,
        message: `the collection type cannot change, from ${before?.type ?? "?"} to ${after?.type ?? "?"}`,
        next: "Keep the type in the file, or remove the collection and add one under another name.",
      });
    }
  }
  collectLost(app.databases, current, changes, report);
  if (report.problems.length > 0) {
    throw new StopApply("problems");
  }
  for (const change of changes.collections) {
    if (change.kind === "removed" || change.type === "view") {
      continue;
    }
    for (const index of change.indexes) {
      if (index.kind === "added") {
        index.rows = countRows(app.databases, change.name);
      }
    }
  }

  const currentByName = new Map(current.collections.map((c) => [c.name, c]));
  const changeByName = new Map(changes.collections.map((c) => [c.name, c]));

  // the views that the changes affect are dropped; the save creates them again
  const rebuild = viewsToRebuild(desired, changes);
  for (const name of rebuild) {
    if (currentByName.get(name)?.type === "view") {
      deleteView(app.databases, name);
    }
  }

  // 4 and 5: widen
  const deferred = widenNewCollections(app, desired, currentByName);
  widenExistingFields(app, desired, changeByName, "plain", new Set());
  widenExistingFields(app, desired, changeByName, "relation", deferred);

  // 5a: TypeScript migrations (S.5)
  applyTypeScriptMigrations();

  // 6: narrow, then the removed collections (the views first)
  narrow(app, desired, changeByName);
  for (const change of changes.collections) {
    if (change.kind === "removed" && change.type === "view") {
      removeCollection(app, change.name);
    }
  }
  for (const change of changes.collections) {
    if (change.kind === "removed" && change.type !== "view") {
      removeCollection(app, change.name);
    }
  }

  // 7: the views, each after the views its query reads
  for (const view of orderedViews(desired, rebuild)) {
    saveView(app, view);
  }

  // 8: the record check, of the collections whose fields changed
  const problems: Problem[] = [];
  for (const collection of desired.collections) {
    const change = changeByName.get(collection.name);
    if (collection.type === "view" || change === undefined || change.kind !== "changed") {
      continue;
    }
    const fields = checkedFields(change);
    if (fields.length > 0) {
      const model = findCollectionByNameOrId(app, collection.name);
      problems.push(...recordProblems(app, model, fields));
    }
  }
  if (problems.length > 0) {
    report.problems.push(...problems);
    throw new StopApply("records");
  }
}

// The renames of the file (S.5). None are declared yet.
function applyRenames(): void {
  // nothing to rename until S.5
}

// The TypeScript migrations of the file (S.5). None are declared yet.
function applyTypeScriptMigrations(): void {
  // nothing to run until S.5
}

// the ids of the stored collections, by name
function collectionIdsOf(app: App): CollectionIdOf {
  const ids = new Map(findAllCollections(app).map((c) => [c.name, c.id]));
  return (name) => {
    const id = ids.get(name);
    if (id === undefined) {
      throw new Error(`a relation points to the missing collection ${JSON.stringify(name)}`);
    }
    return id;
  };
}

// Records what the changes remove. Without --allow-data-loss each one is a
// problem, and the apply stops.
function collectLost(
  db: Databases,
  current: SchemaDescription,
  changes: SchemaChanges,
  report: ApplyReport,
): void {
  const lost: NonNullable<ApplyReport["lost"]> = [];
  for (const change of changes.collections) {
    const before = current.collections.find((c) => c.name === change.name);
    if (before === undefined || before.type === "view") {
      continue;
    }
    if (change.kind === "removed") {
      const rows = countRows(db, change.name);
      if (rows > 0) {
        lost.push({ collection: change.name, rows });
      }
      continue;
    }
    for (const field of lostFields(change)) {
      const rows = countValues(db, change.name, field.name);
      if (rows > 0) {
        lost.push({ collection: change.name, field: field.name, rows });
      }
    }
  }
  report.lost = lost;
  if (report.allowDataLoss) {
    return;
  }
  for (const item of lost) {
    const where = item.field === undefined ? item.collection : `${item.collection}.${item.field}`;
    const what = item.field === undefined ? "records" : "values";
    report.problems.push({
      where,
      message: `${item.rows} ${what} would be deleted`,
      next: "Pass --allow-data-loss to delete them.",
    });
  }
}

// The views to create again: the changed views, and every view that reads a
// changed collection or a view that is created again. A view's query names
// what it reads, so a name in it is taken as a dependency: that may
// over-approximate, and the extra views are created again too.
function viewsToRebuild(desired: SchemaDescription, changes: SchemaChanges): Set<string> {
  const changed = new Set(changes.collections.map((c) => c.name));
  const views = desired.collections.filter((c) => c.type === "view");
  const rebuild = new Set<string>();
  for (const view of views) {
    if (changed.has(view.name)) {
      rebuild.add(view.name);
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    const seeds = [...changed, ...rebuild];
    for (const view of views) {
      if (
        !rebuild.has(view.name) &&
        seeds.some((name) => mentions(view.query ?? "", name, view.name))
      ) {
        rebuild.add(view.name);
        grew = true;
      }
    }
  }
  return rebuild;
}

// whether a query names a collection (not as part of a longer name)
function mentions(query: string, name: string, self: string): boolean {
  if (name === self) {
    return false;
  }
  return new RegExp(`(^|[^A-Za-z0-9_])${name}($|[^A-Za-z0-9_])`, "i").test(query);
}

// the views to create, each after the views its query reads
function orderedViews(desired: SchemaDescription, rebuild: Set<string>): SchemaCollection[] {
  const pending = desired.collections.filter((c) => c.type === "view" && rebuild.has(c.name));
  const ordered: SchemaCollection[] = [];
  while (pending.length > 0) {
    const ready = pending.findIndex(
      (view) =>
        !pending.some(
          (other) => other !== view && mentions(view.query ?? "", other.name, view.name),
        ),
    );
    // a cycle of views is left to the save to refuse
    const [next] = pending.splice(ready < 0 ? 0 : ready, 1) as [SchemaCollection];
    ordered.push(next);
  }
  return ordered;
}

// 4: the new collections, each in one save with all its fields, as the
// dashboard saves a new collection (the table gets its columns at once). A
// collection that relates to another new one waits until that one exists.
// When the relations form a cycle, one collection goes first without its
// relation fields; those are added in step 5. Returns the names of the
// collections that went without them.
function widenNewCollections(
  app: App,
  desired: SchemaDescription,
  currentByName: Map<string, SchemaCollection>,
): Set<string> {
  const pending = desired.collections.filter(
    (collection) => collection.type !== "view" && !currentByName.has(collection.name),
  );
  const exists = new Set(currentByName.keys());
  const deferred = new Set<string>();
  const lookup: CollectionIdOf = (name) => collectionIdsOf(app)(name);
  while (pending.length > 0) {
    let index = pending.findIndex((collection) =>
      relationTargets(collection).every((target) => exists.has(target)),
    );
    const cycle = index < 0;
    if (cycle) {
      index = 0;
    }
    const [collection] = pending.splice(index, 1) as [SchemaCollection];
    const relations = collection.fields.filter((field) => field.type === "relation");
    const fields = collection.fields
      .filter((field) => !cycle || field.type !== "relation")
      .map((field) => fieldJSON(field, "", lookup));
    if (cycle && relations.length > 0) {
      deferred.add(collection.name);
    }
    const model = newCollection(collection.type, collection.name);
    model.unmarshalJSON(JSON.stringify(collectionJSON(collection, "", { fields })));
    saveAs(app, model, collection.name);
    exists.add(collection.name);
  }
  return deferred;
}

// the names of the collections that a collection's relation fields target
function relationTargets(collection: SchemaCollection): string[] {
  return collection.fields
    .filter((field) => field.type === "relation")
    .map((field) => String(field.options.collection));
}

// 4 and 5: the added fields of the existing collections, the plain ones
// first and then the relations (their targets exist by then)
function widenExistingFields(
  app: App,
  desired: SchemaDescription,
  changeByName: Map<string, CollectionChange>,
  pass: "plain" | "relation",
  deferred: Set<string>,
): void {
  const idOf = collectionIdsOf(app);
  for (const collection of desired.collections) {
    const change = changeByName.get(collection.name);
    // a new collection is created by widenNewCollections, and only its
    // relation fields a cycle deferred are added here (the relation pass)
    if (change === undefined || collection.type === "view") {
      continue;
    }
    const isDeferredNew = change.kind === "added" && deferred.has(collection.name);
    if (change.kind !== "changed" && !(pass === "relation" && isDeferredNew)) {
      continue;
    }
    const added = new Set(change.fields.filter((f) => f.kind === "added").map((f) => f.name));
    const fields = collection.fields.filter(
      (field) => added.has(field.name) && (field.type === "relation") === (pass === "relation"),
    );
    if (fields.length === 0) {
      continue;
    }
    // the stored fields stay as they are, with their ids; the new ones follow
    const model = findCollectionByNameOrId(app, collection.name);
    const stored = model.fields.marshalJSON().slice(1, -1);
    const list = [stored, ...fields.map((field) => JSON.stringify(fieldJSON(field, "", idOf)))];
    const text =
      `{"id":${JSON.stringify(model.id)},"name":${JSON.stringify(model.name)},` +
      `"type":${JSON.stringify(model.type)},"fields":[${list.filter((part) => part !== "").join(",")}]}`;
    model.unmarshalJSON(text);
    saveAs(app, model, collection.name);
  }
}

// 6: the new and the changed collections, in full: the fields in the file's
// order (the stored ids kept, the replaced fields with new ones), the indexes
// (by definition, with the stored names; the implied ones kept), the rules and
// the options
function narrow(
  app: App,
  desired: SchemaDescription,
  changeByName: Map<string, CollectionChange>,
): void {
  const idOf = collectionIdsOf(app);
  for (const collection of desired.collections) {
    if (collection.type === "view" || !changeByName.has(collection.name)) {
      continue;
    }
    const model = findCollectionByNameOrId(app, collection.name);
    const stored = new Map(
      model.fields
        .toArray()
        .map((field) => [field.getName(), { id: field.getId(), type: field.type() }]),
    );
    const fields = collection.fields.map((field) => {
      const before = stored.get(field.name);
      const id = before !== undefined && before.type === field.type ? before.id : "";
      return fieldJSON(field, id, idOf);
    });
    const indexes = [
      ...keepStoredIndexes(collection.indexes, model.indexes),
      ...impliedStatements(model.indexes, collection),
    ];
    const members = { ...settingsJSON(collection), fields, indexes };
    model.unmarshalJSON(JSON.stringify(collectionJSON(collection, model.id, members)));
    saveAs(app, model, collection.name);
  }
}

// 6: a removed collection; its records and views go with it
function removeCollection(app: App, name: string): void {
  let model: Collection;
  try {
    model = findCollectionByNameOrId(app, name);
  } catch (err) {
    throw new SaveFailed(name, err);
  }
  try {
    deleteCollection(app, model);
  } catch (err) {
    throw new SaveFailed(name, err);
  }
}

// 7: a view collection, saved with its query, rules and options; the save
// creates its SQL view again and keeps its id
function saveView(app: App, view: SchemaCollection): void {
  let model: Collection;
  try {
    model = findCollectionByNameOrId(app, view.name);
  } catch {
    model = newCollection("view", view.name);
  }
  const id = model.isNew() ? "" : model.id;
  model.unmarshalJSON(JSON.stringify(collectionJSON(view, id, settingsJSON(view))));
  saveAs(app, model, view.name);
}
