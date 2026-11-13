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
//	  2. the declared renames of the pending TypeScript migrations (S.5): the
//	     stored rules and indexes are cleared first (none can name an old name
//	     then), and the files run in name order, each checked against the names
//	     the earlier ones left, then run as saves (fields keep their ids, a
//	     collection its id, so the values, records, files and relations stay)
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
import type { Field } from "@/fields/field";
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
import { explicitIndexes, isImpliedIndex } from "@/schema/implied";
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
import { fileProblems } from "@/schema/renames";
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
  const renamesRan = applyRenames(app, pendingSchema, desired, report);

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
  const rebuild = viewsToRebuild(desired, changes, renamesRan);
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

// 2: the declared renames (S.5), from the pending TypeScript migrations. Runs
// only when a pending file declares a rename. First every stored rule of the
// non-view, non-system collections is cleared (superuser-only), and every index
// except the implied auth ones is dropped: a stored reference can name a
// renamed name in a form this step does not list (a relation path, a back
// relation, an alias, an expression or a partial index), and the save of any
// collection validates its rules and indexes. Step 6 sets them from the file.
// Then the files run in name order, each against the names the earlier ones
// left (a chain across files works). Returns whether a rename ran; then every
// view is created again (steps 3 and 7), since a view's query or rules may name
// an old name.
function applyRenames(
  app: App,
  files: readonly SchemaMigration[],
  desired: SchemaDescription,
  report: ApplyReport,
): boolean {
  const declaring = files.filter(
    (file) =>
      Object.keys(file.renames).length > 0 || Object.keys(file.renameCollections).length > 0,
  );
  if (declaring.length === 0) {
    return false;
  }
  clearStoredReferences(app);
  const applied: AppliedRename[] = [];
  for (const file of declaring) {
    // the file's problems are checked against the names as they are now, and
    // a refused file stops the apply before its renames run
    const problems = fileProblems(describeCollections(findAllCollections(app)), file);
    if (problems.length > 0) {
      report.problems.push(...problems);
      throw new StopApply("renames");
    }
    renameFile(app, file, report, applied);
  }
  // every rename must end in a name the file has (a chain's intermediate name
  // is not in the file, so this is checked at the end)
  const problems = appliedProblems(app, desired, applied);
  if (problems.length > 0) {
    report.problems.push(...problems);
    throw new StopApply("renames");
  }
  return true;
}

// a rename that ran: the collection and field keep their ids, so the end check
// finds them by id, whatever their names became
interface AppliedRename {
  file: string;
  collectionId: string;
  // undefined for a collection rename
  fieldId?: string;
  to: string;
  where: string;
}

// the renames of one file, run as one save per collection they touch. The
// file's keys are the names before its own renames, and fileProblems has
// checked them; the rate-limit rules are read before the saves relabel them,
// for the report, as the plan shows the rules a collection rename changes.
function renameFile(
  app: App,
  file: SchemaMigration,
  report: ApplyReport,
  applied: AppliedRename[],
): void {
  const models = findAllCollections(app);
  const byName = new Map(models.map((model) => [model.name, model]));
  const plans = new Map<string, { model: Collection; fields: Map<string, string>; to?: string }>();
  const planOf = (model: Collection) => {
    const plan = plans.get(model.id) ?? { model, fields: new Map<string, string>() };
    plans.set(model.id, plan);
    return plan;
  };
  const rules = app.settings.settings.RateLimits.Rules ?? [];

  for (const [collectionName, pairs] of Object.entries(file.renames)) {
    const model = byName.get(collectionName) as Collection;
    for (const [from, to] of Object.entries(pairs)) {
      const field = model.fields.toArray().find((f) => f.getName() === from) as Field;
      planOf(model).fields.set(from, to);
      applied.push({
        file: file.file,
        collectionId: model.id,
        fieldId: field.getId(),
        to,
        where: `${collectionName}.${from}`,
      });
      report.renames.push({
        kind: "field",
        collection: collectionName,
        from,
        to,
        file: file.file,
        rateLimits: [],
      });
    }
  }
  for (const [from, to] of Object.entries(file.renameCollections)) {
    const model = byName.get(from) as Collection;
    planOf(model).to = to;
    applied.push({ file: file.file, collectionId: model.id, to, where: from });
    report.renames.push({
      kind: "collection",
      from,
      to,
      file: file.file,
      rateLimits: rules
        .filter((rule) => rule.Label.startsWith(from + ":"))
        .map((rule) => ({ from: rule.Label, to: to + rule.Label.slice(from.length) })),
    });
  }

  for (const { model, fields, to } of plans.values()) {
    const json = JSON.parse(model.marshalJSON()) as Json;
    if (fields.size > 0) {
      json.fields = (json.fields as Json[]).map((field) => {
        const renamed = fields.get(String(field.name));
        return renamed === undefined ? field : { ...field, name: renamed };
      });
    }
    const before = model.name;
    if (to !== undefined) {
      json.name = to;
      // the implied indexes name the table: they are built again for the new one
      json.indexes = (json.indexes as string[]).map((statement) => retabled(statement, to));
    }
    model.unmarshalJSON(JSON.stringify(json));
    saveAs(app, model, to ?? before);
  }
}

// the rules and indexes that the renames clear (step 2): the rules of every
// collection that is not a view or a system collection, and every index but
// the implied ones (tokenKey and email of an auth collection, which upstream
// adds on each save). A rule that is already null is not changed.
function clearStoredReferences(app: App): void {
  for (const model of findAllCollections(app)) {
    if (model.system || model.type === "view") {
      continue;
    }
    const json = JSON.parse(model.marshalJSON()) as Json;
    let changed = false;
    for (const key of Object.keys(ruleKeyOfAPI)) {
      if (json[key] !== undefined && json[key] !== null) {
        json[key] = null;
        changed = true;
      }
    }
    const indexes = json.indexes as string[];
    const kept = indexes.filter((statement) => isImpliedIndex(statement, model));
    if (kept.length !== indexes.length) {
      json.indexes = kept;
      changed = true;
    }
    if (changed) {
      model.unmarshalJSON(JSON.stringify(json));
      saveAs(app, model, model.name);
    }
  }
}

// the end check of the renames: each one ends in a collection or field that
// the file has, by the name it has now (found by id)
function appliedProblems(
  app: App,
  desired: SchemaDescription,
  applied: readonly AppliedRename[],
): Problem[] {
  const problems: Problem[] = [];
  const byId = new Map(findAllCollections(app).map((model) => [model.id, model]));
  for (const rename of applied) {
    const model = byId.get(rename.collectionId);
    if (model === undefined) {
      continue;
    }
    const target = desired.collections.find((collection) => collection.name === model.name);
    const note = `(declared in ${rename.file})`;
    if (rename.fieldId === undefined) {
      if (target === undefined) {
        problems.push({
          where: rename.where,
          message: `renameCollections: the schema file has no collection ${JSON.stringify(model.name)} ${note}`,
          next: "Name the collection in the file as the rename does.",
        });
      }
      continue;
    }
    const field = model.fields.toArray().find((f) => f.getId() === rename.fieldId);
    const name = field?.getName() ?? rename.to;
    if (target === undefined || !target.fields.some((f) => f.name === name)) {
      problems.push({
        where: rename.where,
        message: `renames: the schema file has no field ${JSON.stringify(name)} in ${model.name} ${note}`,
        next: "Name the field in the file as the rename does.",
      });
    }
  }
  return problems;
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
// over-approximate, and the extra views are created again too. After a rename
// every view is created again: a view's rules are not in its query, so a rule
// that names an old name is not found here, and the renames clear the rules of
// the collections only (step 2).
function viewsToRebuild(
  desired: SchemaDescription,
  changes: SchemaChanges,
  renamesRan: boolean,
): Set<string> {
  const views = desired.collections.filter((c) => c.type === "view");
  if (renamesRan) {
    return new Set(views.map((view) => view.name));
  }
  const changed = new Set(changes.collections.map((c) => c.name));
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
