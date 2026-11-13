// Applying the schema file to the database (D40, S.3). Not an upstream file.
//
// The steps, in D40's order:
//
//	before the transaction (read only): compute the changes. When nothing
//	changes and no JavaScript migration is pending, stop: no backup and no
//	record check.
//
//	the dry run: the same transaction as `plan` (below), rolled back. When it
//	fails, the report is printed and the start fails with no backup, so a
//	restart loop makes no backups (D40, amended 2026-11-13).
//
//	the pre-schema backup; a failed backup stops the apply.
//
//	in one write transaction (auxiliary.db outside, data.db inside it, as up()
//	nests them; a rollback undoes both):
//	  1. the pending JavaScript migrations (D23), with `up`, as serve ran them
//	     before; they may change the structure first
//	  2. the declared renames of the pending TypeScript migrations (S.5): each
//	     is checked, then run as a save (fields keep their ids, a collection its
//	     id, so the values, records, files and relations stay); the rules and
//	     indexes that name a renamed field or collection are cleared first
//	  3. the changes against the file, again; the data-loss guard; the SQL
//	     views that the changes affect are dropped, and so are the removed
//	     views (a removed view may read a column or a view that goes)
//	  4. widen: new collections with their plain fields, and the new plain
//	     fields of the existing ones (a replaced field, same name with
//	     another type, waits for step 6, and the removed fields stay); a
//	     required field is added as optional, so a migration can fill it
//	  5. widen: the new relation fields, once every target exists
//	  5a. TypeScript migrations (S.5): up(tx), synchronous, in name order,
//	     each recorded as @schema/<file name> in this transaction
//	  6. narrow: the new and changed collections in full (fields, indexes,
//	     rules, options); then the removed views; then the removed collections,
//	     each after the collections that relate to it
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
  findCollectionReferences,
  reloadCachedCollections,
} from "@/collections/collection-query";
import { deleteCollection, saveCollection } from "@/collections/collection-save";
import type { Databases } from "@/db/base";
import { deleteView } from "@/db/table";
import { auxRunInTransaction, runInTransaction } from "@/db/tx";
import { parseIndex } from "@/tools/dbutils";
import { collectionJSON, fieldJSON, settingsJSON, type CollectionIdOf } from "@/schema/apply-json";
import { makePreSchemaBackup, prunePreSchemaBackups } from "@/schema/backup";
import {
  countBeyondMax,
  countRows,
  countValues,
  maxSelectOf,
  multiValueTypes,
  recordProblems,
} from "@/schema/check";
import { describeCollections } from "@/schema/describe";
import {
  checkedFields,
  distinctIndexes,
  diffSchemas,
  impliedStatements,
  keepStoredIndexes,
  lostFields,
  type CollectionChange,
  type SchemaChanges,
} from "@/schema/diff";
import { explicitIndexes } from "@/schema/implied";
import {
  formatReport,
  newReport,
  reportIsOK,
  type ApplyReport,
  type Problem,
} from "@/schema/report";
import { readSchema, type SchemaIssue } from "@/schema/read";
import {
  ruleKeys,
  type SchemaCollection,
  type SchemaDescription,
  type SchemaField,
  type SchemaObject,
} from "@/schema/types";
import { reloadSettings } from "@/settings/settings-query";
import {
  isMigrationApplied,
  saveAppliedMigration,
  up,
  type Migration,
} from "@/migrations/migrations-runner";
import { schemaMigrationRecord, type SchemaMigration } from "@/schema/migration-files";
import { newMigrationHelpers } from "@/schema/migration-tx";
import { declaredRenameSet, renameProblems, type DeclaredRenameSet } from "@/schema/renames";
import { Errors } from "@/validation/error";

type Json = Record<string, unknown>;

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
  // the TypeScript migrations of the migrations directory, in name order
  schemaMigrations?: readonly SchemaMigration[];
  // called in the transaction after its last step, with the database as the
  // file leaves it (`schema types --schema` reads the collections here); a
  // plan rolls the transaction back after it
  inspect?: (app: App) => void;
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
// when the apply stops, and the database is unchanged then. The dry run and
// the backup come first: a failed dry run makes no backup.
export async function applySchema(
  app: App,
  text: string,
  options: ApplyOptions,
): Promise<ApplyReport> {
  const desired = parseSchemaFile(text);
  const pending = pendingMigrations(app, options);

  // read only: when nothing changes, there is nothing to back up or check
  const current = describeCollections(findAllCollections(app));
  const changes = diffSchemas(current, desired);
  if (changes.collections.length === 0 && pending.length === 0) {
    return newReport("apply", options.allowDataLoss);
  }

  // the dry run: the same transaction as `schema plan`, rolled back. A file
  // that would fail fails here, before any backup is made
  const dry = runTransaction(app, desired, options, "plan");
  // a migration that edits app.settings() changed the live object in memory,
  // and the dry run rolled back the stored row only: the apply starts from
  // the stored settings, so the migration runs once
  await reloadSettings(app);
  if (!reportIsOK(dry)) {
    dry.mode = "apply";
    throw new SchemaApplyError(dry);
  }

  const backup = await makePreSchemaBackup(app);
  try {
    const report = runTransaction(app, desired, options, "apply");
    report.backup = backup;
    if (!reportIsOK(report)) {
      throw new SchemaApplyError(report);
    }
    return report;
  } finally {
    // after every apply that made a backup, successful or not: at most three
    // pre-schema backups exist once the apply returns
    await prunePreSchemaBackups(app);
  }
}

// Plans the file: the report of the changes, the migrations and every
// problem, with the database unchanged. No backup is made.
export function planSchema(app: App, text: string, options: ApplyOptions): ApplyReport {
  const desired = parseSchemaFile(text);
  return runTransaction(app, desired, options, "plan");
}

// the names of the migrations that have not run yet, JavaScript ones first
function pendingMigrations(app: App, options: ApplyOptions): string[] {
  return [
    ...options.migrations
      .filter((m) => !isMigrationApplied(app.databases, m.file))
      .map((m) => m.file),
    ...pendingSchemaMigrations(app, options).map((m) => m.file),
  ];
}

// the TypeScript migrations that have not run yet, in name order
function pendingSchemaMigrations(app: App, options: ApplyOptions): SchemaMigration[] {
  return (options.schemaMigrations ?? []).filter(
    (m) => !isMigrationApplied(app.databases, schemaMigrationRecord(m.file)),
  );
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
    // the auxiliary transaction is the outer one, the nesting up() uses, so
    // the migrations' writes to both databases, and their after-commit work
    // (file deletes), end with this transaction: a plan or a failed apply
    // rolls them back together
    auxRunInTransaction(app.databases, (auxDatabases) => {
      runInTransaction(auxDatabases, (txDatabases) => {
        const txApp = txDatabases === app.databases ? app : { ...app, databases: txDatabases };
        applyInTransaction(txApp, desired, options, report);
        options.inspect?.(txApp);
        if (mode === "plan") {
          throw new RollBack("plan");
        }
      });
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

  // 2. the declared renames (S.5), from the pending TypeScript migrations
  const pendingSchema = pendingSchemaMigrations(app, options);
  const renames = declaredRenameSet(pendingSchema);
  const renamedNames =
    renames.fields.length === 0 && renames.collections.length === 0
      ? new Set<string>()
      : applyRenames(app, describeCollections(findAllCollections(app)), desired, renames, report);

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
  collectLost(app.databases, current, desired, changes, report);
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

  // the removed views are dropped first: their query may read a column or a
  // view that this transaction drops, and SQLite checks every view on an ALTER
  for (const change of changes.collections) {
    if (change.kind === "removed" && change.type === "view") {
      deleteView(app.databases, change.name);
    }
  }
  // the views that the changes affect are dropped; the save creates them again
  const rebuild = viewsToRebuild(desired, changes, renamedNames);
  for (const name of rebuild) {
    if (currentByName.get(name)?.type === "view") {
      deleteView(app.databases, name);
    }
  }

  // 4 and 5: widen
  const deferred = widenNewCollections(app, desired, currentByName);
  widenExistingFields(app, desired, changeByName, "plain", new Set());
  widenExistingFields(app, desired, changeByName, "relation", deferred);

  // 5a: TypeScript migrations (S.5), each recorded in this transaction
  runSchemaMigrations(app, pendingSchema, report);

  // 6: narrow, then the removed views, then the removed collections in
  // dependency order
  narrow(app, desired, changeByName);
  for (const change of changes.collections) {
    if (change.kind === "removed" && change.type === "view") {
      removeCollection(app, change.name);
    }
  }
  removeCollections(
    app,
    changes.collections
      .filter((change) => change.kind === "removed" && change.type !== "view")
      .map((change) => change.name),
  );

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

// 2: the declared renames (S.5). Each one is checked against the database and
// the file first; a refused rename is a problem and stops the apply. Then each
// collection that a rename touches is saved once, through the save path (so the
// table and its columns are renamed, and the rate-limit rules of a renamed
// collection are relabelled, as the dashboard does). A field keeps its id, a
// collection its id; its records, files and relations stay. Before the save,
// the indexes that name a renamed field are dropped, the indexes of a renamed
// collection name the new table, and the rules that name a renamed field or
// collection are cleared (superusers only): the file sets them again in step 6.
// Returns the names, after the renames, of the collections a rename touched.
function applyRenames(
  app: App,
  current: SchemaDescription,
  desired: SchemaDescription,
  renames: DeclaredRenameSet,
  report: ApplyReport,
): Set<string> {
  const touched = new Set<string>();
  if (renames.fields.length === 0 && renames.collections.length === 0) {
    return touched;
  }
  const problems = renameProblems(current, desired, renames);
  if (problems.length > 0) {
    report.problems.push(...problems);
    throw new StopApply("renames");
  }

  const newNameOf = new Map(renames.collections.map((rename) => [rename.from, rename.to]));
  const fieldsOf = new Map<string, Map<string, string>>();
  for (const rename of renames.fields) {
    const fields = fieldsOf.get(rename.collection) ?? new Map<string, string>();
    fields.set(rename.from, rename.to);
    fieldsOf.set(rename.collection, fields);
  }

  // what the report shows: the renames, and the rate-limit rules a collection rename relabels
  const rules = app.settings.settings.RateLimits.Rules ?? [];
  for (const rename of renames.collections) {
    const rateLimits = rules
      .filter((rule) => rule.Label.startsWith(rename.from + ":"))
      .map((rule) => ({ from: rule.Label, to: rename.to + rule.Label.slice(rename.from.length) }));
    report.renames.push({
      kind: "collection",
      from: rename.from,
      to: rename.to,
      file: rename.file,
      rateLimits,
    });
  }
  for (const rename of renames.fields) {
    report.renames.push({
      kind: "field",
      collection: rename.collection,
      from: rename.from,
      to: rename.to,
      file: rename.file,
      rateLimits: [],
    });
  }

  for (const model of findAllCollections(app)) {
    // a view's fields come from its query and its SQL view is made again in
    // step 7; a view's rules are set from the file there too
    if (model.type === "view") {
      continue;
    }
    const ownFields = fieldsOf.get(model.name) ?? new Map<string, string>();
    const newName = newNameOf.get(model.name);
    const oldFields = [...ownFields.keys()];
    const json = JSON.parse(model.marshalJSON()) as Json;
    let changed = false;

    if (oldFields.length > 0) {
      json.fields = (json.fields as Json[]).map((field) => {
        const to = ownFields.get(String(field.name));
        if (to === undefined) {
          return field;
        }
        changed = true;
        return { ...field, name: to };
      });
      json.indexes = (json.indexes as string[]).filter(
        (statement) => !indexNamesAny(statement, oldFields),
      );
    }
    if (newName !== undefined) {
      changed = true;
      json.name = newName;
      json.indexes = (json.indexes as string[]).map((statement) => retabled(statement, newName));
    }
    for (const key of Object.keys(ruleKeyOfAPI)) {
      const rule = json[key];
      if (typeof rule === "string" && ruleNamesRenamed(rule, oldFields, renames)) {
        json[key] = null;
        changed = true;
      }
    }
    if (!changed) {
      continue;
    }
    const name = newName ?? model.name;
    model.unmarshalJSON(JSON.stringify(json));
    saveAs(app, model, name);
    touched.add(name);
  }
  return touched;
}

// the rule keys of the API's collection JSON (listRule, ...)
const ruleKeyOfAPI: Readonly<Record<string, string>> = Object.freeze({
  listRule: "list",
  viewRule: "view",
  createRule: "create",
  updateRule: "update",
  deleteRule: "delete",
  authRule: "auth",
  manageRule: "manage",
});

// whether an index statement names one of the columns
function indexNamesAny(statement: string, columns: readonly string[]): boolean {
  const index = parseIndex(statement);
  return index.columns.some((column) => columns.includes(column.name.replace(/[`"[\]]/g, "")));
}

// the statement with the table name the collection has now (a renamed
// collection's indexes name the new table; the statement is built again)
function retabled(statement: string, table: string): string {
  const index = parseIndex(statement);
  if (!index.isValid()) {
    return statement;
  }
  index.tableName = table;
  return index.build();
}

// whether a rule names a field of its collection that a rename changes, or a
// collection or field that a rename changes through `@collection.<name>`
function ruleNamesRenamed(
  rule: string,
  oldFields: readonly string[],
  renames: DeclaredRenameSet,
): boolean {
  if (oldFields.some((field) => namedIn(rule, field, ""))) {
    return true;
  }
  if (renames.collections.some((rename) => namedIn(rule, rename.from, "@collection."))) {
    return true;
  }
  return renames.fields.some((rename) =>
    namedIn(rule, `${rename.collection}.${rename.from}`, "@collection."),
  );
}

// whether text names `name` as a whole identifier, after `prefix` (a bare name
// is not preceded by `@` or `.`, so another collection's field does not count)
function namedIn(text: string, name: string, prefix: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (prefix !== "") {
    return new RegExp(`${prefix.replace(".", "\\.")}${escaped}(?![A-Za-z0-9_])`).test(text);
  }
  return new RegExp(`(^|[^A-Za-z0-9_@.])${escaped}(?![A-Za-z0-9_])`).test(text);
}

// 5a: the TypeScript migrations of the file (S.5), in name order. Each one's
// up(tx) runs synchronously in the apply transaction; a throw or a promise
// fails the apply, naming the file. Each run is recorded as @schema/<file>.
function runSchemaMigrations(
  app: App,
  pending: readonly SchemaMigration[],
  report: ApplyReport,
): void {
  for (const migration of pending) {
    if (migration.up !== null) {
      let result: unknown;
      try {
        result = migration.up(newMigrationHelpers(app));
      } catch (err) {
        throw new Error(`migration ${migration.file} failed: ${messageOf(err)}`, { cause: err });
      }
      if (isThenable(result)) {
        // the promise is only observed here, so its rejection is not unhandled
        result.then(undefined, () => {});
        throw new Error(
          `migration ${migration.file} returned a promise: up(tx) must be synchronous, and async work (mail, S3, OAuth2, fetch) cannot run inside the apply transaction`,
        );
      }
    }
    saveAppliedMigration(app.databases, app.clock, schemaMigrationRecord(migration.file));
    report.migrations.push(migration.file);
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
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
// problem, and the apply stops. A removed or replaced field loses its non-empty
// values. A select, file or relation that becomes single-valued loses the
// extra values of the rows that hold more: the table sync keeps one value.
// Any other lowered maxSelect deletes nothing (the table sync keeps the rows),
// so the record check reports the rows that hold more, and the apply stops.
function collectLost(
  db: Databases,
  current: SchemaDescription,
  desired: SchemaDescription,
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
      const old = before.fields.find((f) => f.name === field.name);
      const rows = old === undefined ? 0 : countValues(db, change.name, old);
      if (rows > 0) {
        lost.push({ collection: change.name, field: field.name, rows });
      }
    }
    const after = desired.collections.find((c) => c.name === change.name);
    for (const field of change.fields) {
      if (field.kind !== "changed" || !field.details.includes("maxSelect")) {
        continue;
      }
      const old = before.fields.find((f) => f.name === field.name);
      const now = after?.fields.find((f) => f.name === field.name);
      if (old === undefined || now === undefined || !multiValueTypes.has(old.type)) {
        continue;
      }
      if (old.type !== now.type || maxSelectOf(now) !== 1 || maxSelectOf(old) === 1) {
        continue;
      }
      const rows = countBeyondMax(db, change.name, field.name, 1);
      if (rows > 0) {
        lost.push({ collection: change.name, field: field.name, rows, becomesSingle: true });
      }
    }
  }
  report.lost = lost;
  if (report.allowDataLoss) {
    return;
  }
  for (const item of lost) {
    const where = item.field === undefined ? item.collection : `${item.collection}.${item.field}`;
    if (item.becomesSingle === true) {
      report.problems.push({
        where,
        message: `${item.rows} records hold more than one value, so their extra values would be deleted`,
        next: "Pass --allow-data-loss to delete them.",
      });
      continue;
    }
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
function viewsToRebuild(
  desired: SchemaDescription,
  changes: SchemaChanges,
  renamed: ReadonlySet<string>,
): Set<string> {
  // a renamed collection (or one with a renamed field) is a change for the
  // views that read it, though the file and the database agree after the renames
  const changed = new Set([...changes.collections.map((c) => c.name), ...renamed]);
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
      .map((field) => plainFieldJSON(field, "", lookup));
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

// a field as widen adds it: not required yet. The file's narrow step (6)
// makes it required, after the TypeScript migrations (5a) have filled it, so a
// save in a migration does not need the value of a field it does not touch
function plainFieldJSON(field: SchemaField, id: string, lookup: CollectionIdOf): SchemaObject {
  const json = fieldJSON(field, id, lookup);
  if (json.required === true) {
    json.required = false;
  }
  return json;
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
    const list = [
      stored,
      ...fields.map((field) => JSON.stringify(plainFieldJSON(field, "", idOf))),
    ];
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
    // the explicit indexes by definition (an implied one the file lists is
    // the stored implied index, kept once); then the stored implied ones
    const indexes = distinctIndexes([
      ...keepStoredIndexes(explicitIndexes(collection.indexes, collection), model.indexes),
      ...impliedStatements(model.indexes, collection),
    ]);
    const members = { ...settingsJSON(collection), fields, indexes };
    model.unmarshalJSON(JSON.stringify(collectionJSON(collection, model.id, members)));
    saveAs(app, model, collection.name);
  }
}

// the stored collection of a name, or a SaveFailed that names it
function storedModel(app: App, name: string): Collection {
  try {
    return findCollectionByNameOrId(app, name);
  } catch (err) {
    throw new SaveFailed(name, err);
  }
}

// 6: a removed collection; its records and views go with it
function removeCollection(app: App, name: string): void {
  const model = storedModel(app, name);
  try {
    deleteCollection(app, model);
  } catch (err) {
    throw new SaveFailed(name, err);
  }
}

// 6: the removed collections, in dependency order. The save refuses a
// collection that another collection still relates to, so a collection goes
// once nothing relates to it. A cycle of relations is cut first: one
// collection is saved without its relation fields into the removed set, and
// then the cycle is gone. A collection that is referenced by a collection the
// apply keeps is no cycle of ours: the save refuses it and names the reference.
function removeCollections(app: App, names: readonly string[]): void {
  const pending = [...names];
  while (pending.length > 0) {
    const models = pending.map((name) => storedModel(app, name));
    const free = models.findIndex((model) => {
      try {
        return findCollectionReferences(app, model, model.id).size === 0;
      } catch (err) {
        throw new SaveFailed(model.name, err);
      }
    });
    if (free >= 0) {
      removeCollection(app, pending[free] as string);
      pending.splice(free, 1);
      continue;
    }
    const ids = new Set(models.map((model) => model.id));
    const referrer = models.find((model) =>
      storedFields(model).some((field) => isRelationInto(field, ids)),
    );
    if (referrer === undefined) {
      // nothing of the set relates to it: the save refuses it with the name of
      // the reference it has (a collection the apply keeps)
      removeCollection(app, pending[0] as string);
      pending.shift();
      continue;
    }
    cutRelationsInto(app, referrer, ids);
  }
}

// the stored fields of a collection, as the API's JSON
function storedFields(model: Collection): Json[] {
  return JSON.parse(model.fields.marshalJSON()) as Json[];
}

// whether a field is a relation into a set of collections (by id)
function isRelationInto(field: Json, ids: ReadonlySet<string>): boolean {
  return field.type === "relation" && ids.has(String(field.collectionId));
}

// saves a removed collection without its relation fields into the set: the
// collection goes after it, and its records were counted by the guard already.
// Its rules and indexes may use the cut fields, and the save checks them against
// the fields it keeps, so they are cleared too (null rules, no indexes): the
// collection is deleted in the same transaction, right after.
function cutRelationsInto(app: App, model: Collection, ids: ReadonlySet<string>): void {
  const fields = storedFields(model).filter((field) => !isRelationInto(field, ids));
  const rules = Object.fromEntries(Object.keys(ruleKeys).map((key) => [key, null]));
  model.unmarshalJSON(
    JSON.stringify({
      id: model.id,
      name: model.name,
      type: model.type,
      fields,
      indexes: [],
      ...rules,
    }),
  );
  saveAs(app, model, model.name);
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
