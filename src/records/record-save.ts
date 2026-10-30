// Upstream: core/record_model.go (callFieldInterceptors, onRecordValidate,
// onRecordSaveExecute, onRecordDeleteExecute, cascadeRecordDelete,
// deleteRefRecords and the order registerRecordHooks gives them), with
// core/db.go's Validate, Save, SaveNoValidate and Delete (create, update,
// delete) for a record, and the record checks of registerSuperuserHooks
// (core/record_model_superusers.go)
//
// There is no hook system (D5): upstream's hook chain for a record is
// called directly, in the order the hooks' priorities give it (lower
// first; equal priorities in registration order: record, superusers,
// external auths, MFAs, OTPs, auth origins). Each "next" below is the rest
// of the chain:
//
//	validateRecord (app.Validate)
//	  interceptors "validate"                 OnRecordValidate, record (99)
//	    onRecordValidate: every field's ValidateValue
//	    the system collections' ref checks    (99, record-auth-refs.ts)
//
//	saveRecord / saveRecordNoValidate (app.Save / app.SaveNoValidate)
//	  create:
//	    interceptors "create"                 OnRecordCreate, record (-99)
//	      validateRecord                      only saveRecord
//	      superusers: verified, then the installer delete (-99)
//	        interceptors "createExecute"      OnRecordCreateExecute, record (99)
//	          onRecordSaveExecute: cross-collection id check, then the
//	          insert, unique errors normalized
//	  update:
//	    interceptors "update"                 OnRecordUpdate, record (-99)
//	      MFAs, then auth origins cleanup     (99, after the rest)
//	        validateRecord                    only saveRecord
//	        superusers: verified (-99)
//	          interceptors "updateExecute"    OnRecordUpdateExecute, record (99)
//	            onRecordSaveExecute: token key refresh, cross-collection id
//	            check, then
//	              external auths on verified upgrade (99, a transaction)
//	                OTPs cleanup on token key change (99, after the update)
//	                  the update; unique errors normalized
//	  on error: a new record is new again, then interceptors
//	  "afterCreateFailure" / "afterUpdateError"; on success interceptors
//	  "afterCreate" / "afterUpdate" (when in a transaction: once it ends)
//
//	deleteRecord (app.Delete)
//	  interceptors "delete"                   OnRecordDelete, record (-99)
//	    view records cannot be deleted
//	    superusers: the last one stays (-99, a transaction)
//	      the primary key check
//	      interceptors "deleteExecute"        OnRecordDeleteExecute, record (99)
//	        onRecordDeleteExecute: a transaction with
//	          the system collections' ref deletes (99, after the row)
//	            the row delete
//	          then cascadeRecordDelete
//	  then interceptors "afterDeleteError" / "afterDelete", as for saves
//
// Interceptors: a field's Intercept may be async (none is now: the file
// field's storage calls are synchronous), so the chain is written as generators that yield what may be a promise.
// run() drives a chain synchronously until something actually returns a
// promise and goes on asynchronously from there; runSync() is for the
// parts inside a write transaction, which must stay synchronous (D8): it
// throws if an interceptor turns async there. The exported functions
// return a promise; the *Sync variants are for callers inside a
// transaction.
//
// Deep cascades: upstream deletes a cascaded record from inside its
// parent's delete (Go's stack grows as needed). Here a step yields
// call(step) where the chain recurses (a cascaded or ref delete), and
// run() keeps the called steps on its own stack, so the JS call stack does
// not grow per related record. On that path nothing else nests: a
// RunInTransaction inside a transaction is the same transaction
// (inTransaction runs it inline), and the "delete" and "deleteExecute"
// interceptors are called in their order before the action runs instead
// of around it. Every field passes these two actions through to
// actionFunc unchanged, as upstream's fields do (their Intercept default
// case), so the action and its errors are the same.
//
// Upstream's `e.App` is the app argument: a hook that opens a transaction
// passes the transaction's app to the rest of the chain, as upstream sets
// e.App to txApp. The superusers save hook finds the installer with the
// app it was registered on (never a transaction app): committed data only
// (record-model-superusers.ts).
//
// Values are written as Go's driver binds them: Record.dbExport() returns
// upstream's typed values, and recordRow converts each to its driver value
// (DateTime, GeoPoint and JSONArray to text, JSONRaw to text or NULL, with
// JSONRaw text that is not valid UTF-8 bound as its bytes and cast to
// TEXT, as Go's driver stores a string holding those bytes). Booleans and
// numbers are bound as they are: bun:sqlite binds booleans as INTEGER 0/1
// as Go's driver does, and the NUMERIC column affinity gives a number the
// storage class Go's float64 gets.
//
// After a successful delete (after the transaction, when there is one),
// the record's storage directory is deleted in the background
// (deleteRecordFiles: upstream's OnModelAfterDeleteSuccess files handler).
//
// The realtime handlers (bindRealtimeEvents, src/realtime/realtime-events.ts)
// run as the action of the after success interceptors, once the outer
// transaction has committed: the create and update broadcasts (their rule
// checks read the state the commit left) and the delete broadcast of
// the messages the delete dry cache prepared right before the row delete
// (OnModelDelete, after the "delete" interceptors and the superusers check).
//
// Not ported: the hook events, tags and the model events around the
// record events (D5).

import {
  fieldApp,
  findAllCollections,
  findCachedCollectionReferences,
  runInAppTransaction,
} from "@/collections/collection-query";
import { type Collection, CollectionTypeAuth } from "@/collections/collection-model";
import { withDriverErrors } from "@/collections/driver-error";
import { joinErrors, wrapError } from "@/collections/view";
import { type DBExporter, deleteModel, saveNoValidate } from "@/db/db";
import { Errors as JoinedErrors } from "@/db/dbx/db";
import { exists, HashExp, newExp, not } from "@/db/dbx/expression";
import { type Params, setOwn } from "@/db/dbx/query";
import { isNoRowsError } from "@/db/dbx/rows";
import type { Model } from "@/db/model";
import {
  type Field,
  FieldNamePassword,
  type InterceptorApp,
  InterceptorActionAfterCreate,
  InterceptorActionAfterCreateError,
  InterceptorActionAfterDelete,
  InterceptorActionAfterDeleteError,
  InterceptorActionAfterUpdate,
  InterceptorActionAfterUpdateError,
  InterceptorActionCreate,
  InterceptorActionCreateExecute,
  InterceptorActionDelete,
  InterceptorActionDeleteExecute,
  InterceptorActionUpdate,
  InterceptorActionUpdateExecute,
  InterceptorActionValidate,
  isMultiValuer,
  isRecordInterceptor,
} from "@/fields/field";
import { RelationField } from "@/fields/relation";
import { Tx } from "@/db/dbx/tx";
import {
  authOriginsOnUpdate,
  externalAuthsOnUpdateExecute,
  mfasOnUpdate,
  otpsOnUpdateExecute,
  refsOnDeleteExecute,
  validateRefs,
} from "@/records/record-auth-refs";
import type { Record } from "@/records/record-model";
import {
  superusersOnCreateExecute,
  superusersOnDelete,
  superusersOnUpdateExecute,
} from "@/records/record-model-superusers";
import { findRecordById, type RecordsApp } from "@/records/record-query";
import {
  realtimeRecordAfterCreate,
  realtimeRecordAfterDelete,
  realtimeRecordAfterDeleteError,
  realtimeRecordAfterUpdate,
  realtimeRecordDelete,
} from "@/realtime/realtime-events";
import { jsonEach } from "@/tools/dbutils/json";
import { columnify } from "@/tools/inflector/inflector";
import { DateTime } from "@/tools/types/datetime";
import { GeoPoint } from "@/tools/types/geo-point";
import { jsonArrayValue } from "@/tools/types/json-array";
import { JSONRaw } from "@/tools/types/json-raw";
import { Errors, NewError } from "@/validation/error";
import { NormalizeUniqueIndexError } from "@/validators/db";

// -------------------------------------------------------------------
// the chain runner

// a part of the chain: yields values that may be promises and gets them
// back resolved
export type Step = Generator<unknown, void, unknown>;

// a step's continuation; app is the chain's current app
export type Next = (app: RecordsApp) => Step;

// yielded by a step to run another step as `yield*` would, without
// growing the JS call stack (run keeps it on its own stack)
class Call {
  constructor(readonly step: Step) {}
}

export function call(step: Step): Call {
  return new Call(step);
}

// a step's state in run: the steps called and not yet returned (the
// last one runs), and what the running one gets back next
interface RunState {
  readonly stack: Step[];
  input: unknown;
  failed: boolean;
}

// run drives a step synchronously until it yields a promise, and
// asynchronously from there.
export function run(step: Step): void | Promise<void> {
  const state: RunState = { stack: [step], input: undefined, failed: false };
  for (;;) {
    const pending = advance(state);
    if (pending === null) {
      return;
    }
    if (pending instanceof Promise) {
      return runAsync(state, pending);
    }
  }
}

async function runAsync(state: RunState, pending: Promise<unknown>): Promise<void> {
  for (;;) {
    try {
      state.input = await pending;
      state.failed = false;
    } catch (err) {
      state.input = err;
      state.failed = true;
    }
    for (;;) {
      const next = advance(state);
      if (next === null) {
        return;
      }
      if (next instanceof Promise) {
        pending = next;
        break;
      }
    }
  }
}

// advance resumes the running step once. Returns null when the first step
// returned, a promise the step yielded, or undefined to go on. Throws the
// first step's error.
function advance(state: RunState): Promise<unknown> | null | undefined {
  const stack = state.stack;
  const step = stack[stack.length - 1] as Step;
  let res: IteratorResult<unknown, void>;
  try {
    res = state.failed ? step.throw(state.input) : step.next(state.input);
  } catch (err) {
    stack.pop();
    if (stack.length === 0) {
      throw err;
    }
    // the calling step gets the error
    state.input = err;
    state.failed = true;
    return undefined;
  }

  state.input = undefined;
  state.failed = false;

  if (res.done === true) {
    stack.pop();
    return stack.length === 0 ? null : undefined;
  }
  if (res.value instanceof Call) {
    stack.push(res.value.step);
    return undefined;
  }
  if (res.value instanceof Promise) {
    return res.value;
  }
  state.input = res.value;
  return undefined;
}

// runSync runs a step inside a write transaction, where the chain must
// stay synchronous.
export function runSync(step: Step): void {
  const result = run(step);
  if (result instanceof Promise) {
    // the promise still settles; its outcome no longer matters
    result.catch(() => {});
    throw new Error("record interceptors must be synchronous inside a transaction");
  }
}

// -------------------------------------------------------------------
// the entry points

// app.Validate(record): runs the record validators (the fields' and the
// system collections' ones) with the "validate" interceptors. Throws the
// validation Errors.
export async function validateRecord(app: RecordsApp, record: Record): Promise<void> {
  await run(validateStep(app, record));
}

// app.Save(record): validates and creates or updates the record.
export async function saveRecord(app: RecordsApp, record: Record): Promise<void> {
  await run(saveStep(app, record, true));
}

// app.SaveNoValidate(record): creates or updates the record without the
// record validators.
export async function saveRecordNoValidate(app: RecordsApp, record: Record): Promise<void> {
  await run(saveStep(app, record, false));
}

// app.Delete(record): deletes the record and cascades to its references.
export async function deleteRecord(app: RecordsApp, record: Record): Promise<void> {
  await run(deleteStep(app, record));
}

// validateRecord inside a transaction
export function validateRecordSync(app: RecordsApp, record: Record): void {
  runSync(validateStep(app, record));
}

// saveRecord inside a transaction
export function saveRecordSync(app: RecordsApp, record: Record): void {
  runSync(saveStep(app, record, true));
}

// saveRecordNoValidate inside a transaction
export function saveRecordNoValidateSync(app: RecordsApp, record: Record): void {
  runSync(saveStep(app, record, false));
}

// deleteRecord inside a transaction
export function deleteRecordSync(app: RecordsApp, record: Record): void {
  runSync(deleteStep(app, record));
}

// -------------------------------------------------------------------
// interceptors

// the app the interceptors get: FieldApp with the filesystem, the record
// lookup, the transaction state and the logger of app
function interceptorApp(app: RecordsApp): InterceptorApp {
  return {
    ...fieldApp(app),
    newFilesystem: () => app.filesystem.newFilesystem(),
    findRecordById: (collection, recordId) =>
      findRecordById(app, collection as Collection, recordId),
    isTransactional: () => app.databases.isTransactional(),
    logger: app.logger,
  };
}

export function* callFieldInterceptors(
  app: RecordsApp,
  record: Record,
  actionName: string,
  actionFunc: () => Step,
): Step {
  const fa = interceptorApp(app);

  // the cascade path: the interceptors pass the action through, so it runs
  // after them (see the top of the file)
  if (actionName === InterceptorActionDelete || actionName === InterceptorActionDeleteExecute) {
    let proceed = false;
    let fn: () => void | Promise<void> = () => {
      proceed = true;
    };
    for (const field of record.collection().fields) {
      if (isRecordInterceptor(field)) {
        const oldfn = fn;
        fn = () => field.intercept(fa, record, actionName, oldfn);
      }
    }

    const result = fn();
    if (result instanceof Promise) {
      yield result;
    }

    if (proceed) {
      yield* actionFunc();
    }
    return;
  }

  // the firing order of the fields doesn't matter
  let fn: () => void | Promise<void> = () => run(actionFunc());
  for (const field of record.collection().fields) {
    if (isRecordInterceptor(field)) {
      const oldfn = fn;
      fn = () => field.intercept(fa, record, actionName, oldfn);
    }
  }

  // a synchronous result needs no round trip through the runner
  const result = fn();
  if (result instanceof Promise) {
    yield result;
  }
}

// a synchronous part of the chain, run when the chain reaches it
export function* syncStep(fn: () => void): Step {
  fn();
  yield* [];
}

function noop(): Step {
  return syncStep(() => {});
}

// RunInTransaction for a step: inside a transaction it is the same
// transaction (src/db/tx.ts), so the step runs inline.
export function* inTransaction(app: RecordsApp, fn: Next): Step {
  if (app.databases.nonconcurrentDB() instanceof Tx) {
    yield* fn(app);
    return;
  }

  runInAppTransaction(app, (txApp) => {
    runSync(fn(txApp));
  });
}

// -------------------------------------------------------------------
// validate

export function* validateStep(app: RecordsApp, record: Record): Step {
  // OnRecordValidate
  yield* callFieldInterceptors(app, record, InterceptorActionValidate, () =>
    syncStep(() => onRecordValidate(app, record)),
  );
}

function onRecordValidate(app: RecordsApp, record: Record): void {
  const errs = new Errors();

  const fa = interceptorApp(app);
  for (const f of record.collection().fields) {
    const err = f.validateValue(fa, record);
    if (err !== null) {
      errs.errors[f.getName()] = err;
    }
  }

  if (errs.size > 0) {
    throw errs;
  }

  // the next OnRecordValidate handlers
  validateRefs(app, record);
}

// -------------------------------------------------------------------
// save

export function* saveStep(app: RecordsApp, record: Record, withValidations: boolean): Step {
  if (record.isNew()) {
    yield* createStep(app, record, withValidations);
    return;
  }

  yield* updateStep(app, record, withValidations);
}

function* createStep(app: RecordsApp, record: Record, withValidations: boolean): Step {
  try {
    // OnRecordCreate
    yield* callFieldInterceptors(app, record, InterceptorActionCreate, function* () {
      // run validations (if any)
      if (withValidations) {
        yield* validateStep(app, record);
      }

      // db write: OnRecordCreateExecute
      yield* superusersOnCreateExecute(app, record, (execApp) =>
        callFieldInterceptors(execApp, record, InterceptorActionCreateExecute, () =>
          onRecordSaveExecute(execApp, record, (writeApp) => dbWrite(writeApp, record)),
        ),
      );
    });
  } catch (saveErr) {
    record.markAsNew(); // reset "new" state

    yield* afterError(app, record, InterceptorActionAfterCreateError, saveErr);
  }

  yield* afterSuccess(app, record, InterceptorActionAfterCreate, InterceptorActionAfterCreateError);
}

function* updateStep(app: RecordsApp, record: Record, withValidations: boolean): Step {
  try {
    // OnRecordUpdate
    yield* callFieldInterceptors(app, record, InterceptorActionUpdate, () =>
      mfasOnUpdate(app, record, (mfaApp) =>
        authOriginsOnUpdate(mfaApp, record, function* (updateApp) {
          // run validations (if any)
          if (withValidations) {
            yield* validateStep(updateApp, record);
          }

          // db write: OnRecordUpdateExecute
          yield* superusersOnUpdateExecute(updateApp, record, (execApp) =>
            callFieldInterceptors(execApp, record, InterceptorActionUpdateExecute, () =>
              onRecordSaveExecute(execApp, record, (authsApp) =>
                externalAuthsOnUpdateExecute(authsApp, record, (otpApp) =>
                  otpsOnUpdateExecute(otpApp, record, (writeApp) => dbWrite(writeApp, record)),
                ),
              ),
            ),
          );
        }),
      ),
    );
  } catch (saveErr) {
    yield* afterError(app, record, InterceptorActionAfterUpdateError, saveErr);
  }

  yield* afterSuccess(app, record, InterceptorActionAfterUpdate, InterceptorActionAfterUpdateError);
}

// the after error interceptors, then the save or delete error (joined with
// the interceptors' error, if any)
function* afterError(
  app: RecordsApp,
  record: Record,
  errorAction: string,
  actionErr: unknown,
): Generator<unknown, never, unknown> {
  try {
    yield* callFieldInterceptors(app, record, errorAction, noop);
  } catch (hookErr) {
    throw joinErrors([actionErr, hookErr]);
  }
  throw actionErr;
}

// the after success interceptors; in a transaction they run once it ends
// (the error interceptors when it fails)
function* afterSuccess(
  app: RecordsApp,
  record: Record,
  successAction: string,
  errorAction: string,
): Step {
  const txInfo = app.databases.txInfo();
  if (txInfo === null) {
    yield* callFieldInterceptors(
      app,
      record,
      successAction,
      realtimeStep(app, record, successAction),
    );
    if (successAction === InterceptorActionAfterDelete) {
      // a promise while every delete worker is busy
      const waiting = deleteRecordFiles(app, record);
      if (waiting instanceof Promise) {
        yield waiting;
      }
    }
    return;
  }

  // execute later after the transaction has completed
  txInfo.onComplete((txErr) => {
    const parentApp: RecordsApp = { ...app, databases: txInfo.parent };

    let result: void | Promise<void>;
    if (txErr !== null) {
      if (errorAction === InterceptorActionAfterCreateError) {
        record.markAsNew(); // reset "new" state
      }
      if (errorAction === InterceptorActionAfterDeleteError) {
        realtimeRecordAfterDeleteError(parentApp, record);
      }
      result = run(callFieldInterceptors(parentApp, record, errorAction, noop));
    } else {
      result = run(
        callFieldInterceptors(
          parentApp,
          record,
          successAction,
          realtimeStep(parentApp, record, successAction),
        ),
      );
      if (successAction === InterceptorActionAfterDelete) {
        // the delete does not wait for a busy worker pool here
        void deleteRecordFiles(parentApp, record);
      }
    }

    // an async interceptor ends after the transaction call returned
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        app.logger.error(`Record ${successAction} interceptors failed after the transaction`, err);
      });
    }
  });
}

// the realtime handlers as the action of the after success interceptors:
// upstream's OnModelAfter*Success handlers (-99, bound after the record
// event proxy) run when the record interceptors call e.Next(). They run
// synchronously, so the broadcast's checks read the state the write left.
function realtimeStep(app: RecordsApp, record: Record, successAction: string): () => Step {
  return () => syncStep(() => realtimeAfterSuccess(app, record, successAction));
}

// the realtime handlers of a successful save or delete
// (OnModelAfterCreateSuccess, OnModelAfterUpdateSuccess,
// OnModelAfterDeleteSuccess); they never fail the save
function realtimeAfterSuccess(app: RecordsApp, record: Record, successAction: string): void {
  try {
    if (successAction === InterceptorActionAfterCreate) {
      realtimeRecordAfterCreate(app, record);
    } else if (successAction === InterceptorActionAfterUpdate) {
      realtimeRecordAfterUpdate(app, record);
    } else if (successAction === InterceptorActionAfterDelete) {
      realtimeRecordAfterDelete(app, record);
    }
  } catch (err) {
    app.logger.error("Failed to broadcast the record change", err);
  }
}

// the storage cleanup after a record delete (registerBaseHooks'
// "__pbFilesManagerDelete__", src/app/filesystem.ts): the record's files
// directory, when its collection has a file field
function deleteRecordFiles(app: RecordsApp, record: Record): void | Promise<void> {
  return app.filesystem.deleteModelFiles({
    baseFilesPath: () => record.baseFilesPath(),
    fieldTypes: () => [...record.collection().fields].map((f) => f.type()),
  });
}

function* onRecordSaveExecute(app: RecordsApp, record: Record, next: Next): Step {
  const collection = record.collection();

  if (collection.isAuth()) {
    if (!record.isNew()) {
      const lastSavedRecord = findRecordById(app, collection, record.id);

      // ensure that the token key is regenerated on password change or email change
      if (
        lastSavedRecord.tokenKey() === record.tokenKey() &&
        (lastSavedRecord.get(FieldNamePassword) !== record.get(FieldNamePassword) ||
          lastSavedRecord.email() !== record.email())
      ) {
        record.refreshTokenKey();
      }
    }

    // loosely cross-check that the auth record id is unique across all auth collections
    // to minimize impact of mistakes in API rules when multiple auth collections are used
    let authCollections: Collection[];
    try {
      authCollections = withDriverErrors(() => findAllCollections(app, CollectionTypeAuth));
    } catch (err) {
      throw wrapError("unable to fetch the auth collections for cross-id unique check", err);
    }
    for (const c of authCollections) {
      if (collection.id === c.id) {
        continue; // skip current collection (sqlite will do the check for us)
      }
      let found: Record | null = null;
      try {
        found = findRecordById(app, c, record.id);
      } catch {
        // not found (or failed): no duplicate
      }
      if (found !== null) {
        throw new Errors({
          id: NewError("validation_invalid_auth_id", "Invalid or duplicated auth record id."),
        });
      }
    }
  }

  try {
    yield* next(app);
  } catch (err) {
    throw NormalizeUniqueIndexError(toError(err), collection.name, collection.fields.fieldNames());
  }
}

// the model's db write (core/db.go create/update)
function dbWrite(app: RecordsApp, record: Record): Step {
  return syncStep(() => {
    withDriverErrors(() => saveNoValidate(app.databases, recordRow(record)));
  });
}

// -------------------------------------------------------------------
// delete

export function* deleteStep(app: RecordsApp, record: Record): Step {
  try {
    // OnRecordDelete
    yield* callFieldInterceptors(app, record, InterceptorActionDelete, function* () {
      if (record.collection().isView()) {
        throw new Error("view records cannot be deleted");
      }

      yield* superusersOnDelete(app, record, function* (deleteApp) {
        // OnModelDelete: the realtime dry cache
        realtimeRecordDelete(deleteApp, record);

        const pk = record.lastSavedPK();
        if (pk === "") {
          throw new Error(
            "the model can be deleted only if it is existing and has a non-empty primary key",
          );
        }

        // db write: OnRecordDeleteExecute
        yield* callFieldInterceptors(deleteApp, record, InterceptorActionDeleteExecute, () =>
          onRecordDeleteExecute(deleteApp, record, (txApp) =>
            refsOnDeleteExecute(txApp, record, (rowApp) => dbDelete(rowApp, record)),
          ),
        );
      });
    });
  } catch (deleteErr) {
    realtimeRecordAfterDeleteError(app, record);
    yield* afterError(app, record, InterceptorActionAfterDeleteError, deleteErr);
  }

  yield* afterSuccess(app, record, InterceptorActionAfterDelete, InterceptorActionAfterDeleteError);
}

function dbDelete(app: RecordsApp, record: Record): Step {
  return syncStep(() => {
    withDriverErrors(() => deleteModel(app.databases, recordRow(record)));
  });
}

function* onRecordDeleteExecute(app: RecordsApp, record: Record, next: Next): Step {
  // fetch rel references (if any)
  //
  // note: the select is outside of the transaction to minimize
  // SQLITE_BUSY errors when mixing read&write in a single transaction
  const refs = withDriverErrors(() => findCachedCollectionReferences(app, record.collection()));

  yield* inTransaction(app, function* (txApp) {
    // delete the record before the relation references to ensure that there
    // will be no "A<->B" relations to prevent deadlock when calling DeleteRecord recursively
    yield* next(txApp);

    yield* cascadeRecordDelete(txApp, record, refs);
  });
}

// cascadeRecordDelete triggers cascade deletion for the provided references.
//
// NB! This method is expected to be called from inside of a transaction.
function* cascadeRecordDelete(
  app: RecordsApp,
  mainRecord: Record,
  refs: Map<Collection, Field[]>,
): Step {
  // Sort the refs keys to ensure that the cascade events firing order is always the same.
  // This is not necessary for the operation to function correctly but it helps having deterministic output during testing.
  const sortedRefKeys = [...refs.keys()].toSorted((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );

  for (const refCollection of sortedRefKeys) {
    const fields = refs.get(refCollection);

    if (fields === undefined || refCollection.isView()) {
      continue; // skip missing or view collections
    }

    const refTableName = columnify(refCollection.name);

    for (const field of fields) {
      const prefixedFieldName = refTableName + "." + columnify(field.getName());

      // fetch only the related ids because they will be queried anyway right
      // before delete to ensure that we are working with fresh record data
      const db = app.databases.db();
      const query = db.select(refTableName + ".id").from(refTableName);

      if (!isMultiValuer(field) || !field.isMultiple()) {
        query.andWhere(new HashExp({ [prefixedFieldName]: mainRecord.id }));
      } else {
        query.andWhere(
          exists(
            newExp(
              `SELECT 1 FROM ${jsonEach(prefixedFieldName)} {{__je__}} WHERE [[__je__.value]]={:jevalue}`,
              { jevalue: mainRecord.id },
            ),
          ),
        );
      }

      if (refCollection.id === mainRecord.collection().id) {
        query.andWhere(not(new HashExp({ [refTableName + ".id"]: mainRecord.id })));
      }

      // trigger cascade for each batchSize rel items until there is none
      const batchSize = 8000;
      for (;;) {
        const refIds = withDriverErrors(() => query.limit(batchSize).column<unknown>()).map(String);

        const total = refIds.length;
        if (total === 0) {
          break;
        }

        yield* deleteRefRecords(app, mainRecord, refCollection, refIds, field);

        if (total < batchSize) {
          break; // no more items
        }
      }
    }
  }
}

// deleteRefRecords checks if related records has to be deleted (if `CascadeDelete` is set)
// OR
// just unset the record id from any relation field values (if they are not required).
//
// NB! This method is expected to be called from inside of a transaction.
function* deleteRefRecords(
  app: RecordsApp,
  mainRecord: Record,
  refCollection: Collection,
  refIds: readonly string[],
  field: Field,
): Step {
  if (!(field instanceof RelationField)) {
    throw new Error("only RelationField is supported at the moment, got " + field.type());
  }
  const relField = field;

  for (const refId of refIds) {
    let refRecord: Record;
    try {
      refRecord = findRecordById(app, refCollection, refId);
    } catch (err) {
      if (isNoRows(err)) {
        continue; // already deleted
      }
      throw err;
    }

    const ids = refRecord.getStringSlice(relField.name);

    // unset the record id
    for (let i = ids.length - 1; i >= 0; i--) {
      if (ids[i] === mainRecord.id) {
        ids.splice(i, 1);
        break;
      }
    }

    // cascade delete the reference
    // (only if there are no other active references in case of multiple select)
    if (relField.cascadeDelete && ids.length === 0) {
      yield call(deleteStep(app, refRecord));
      // no further actions are needed (the reference is deleted)
      continue;
    }

    if (relField.required && ids.length === 0) {
      throw new Error(
        `the record cannot be deleted because it is part of a required reference in record ${refRecord.id} (${refRecord.collection().name} collection)`,
      );
    }

    // save the reference changes
    // (without validation because it is possible that another relation field to have a reference to a previous deleted record)
    refRecord.set(relField.name, ids);
    yield* saveStep(app, refRecord, false);
  }
}

// -------------------------------------------------------------------
// TruncateCollection's delete loop (core/collection_query.go), called by
// truncateCollection in src/collections inside its transaction

// deletes the given records; a record that is already gone is skipped
export function deleteTruncatedRecords(app: RecordsApp, records: readonly Record[]): void {
  for (const record of records) {
    try {
      deleteRecordSync(app, record);
    } catch (err) {
      if (!isNoRows(err)) {
        throw err;
      }
    }
  }
}

// -------------------------------------------------------------------
// helpers

// errors.Is(err, sql.ErrNoRows): the error, its causes or joined errors
export function isNoRows(err: unknown): boolean {
  if (isNoRowsError(err)) {
    return true;
  }
  if (err instanceof AggregateError || err instanceof JoinedErrors) {
    return err.errors.some(isNoRows);
  }
  if (err instanceof Error && err.cause !== undefined) {
    return isNoRows(err.cause);
  }
  return false;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// The record as src/db writes it: its dbExport() with each value converted
// to what Go's driver binds.
function recordRow(record: Record): Model & DBExporter {
  return {
    tableName: () => record.tableName(),
    pk: () => record.pk(),
    lastSavedPK: () => record.lastSavedPK(),
    isNew: () => record.isNew(),
    markAsNew: () => record.markAsNew(),
    markAsNotNew: () => record.markAsNotNew(),
    dbExport: () => driverValues(record.dbExport()),
  };
}

function driverValues(data: Params): Params {
  const result: Params = {};
  for (const [key, value] of Object.entries(data)) {
    setOwn(result, key, driverValue(key, value));
  }
  return result;
}

// the driver.Valuer of upstream's typed values; anything else is bound as
// it is. Exported for the record create rule check (src/apis/record-crud.ts),
// which binds a record's dbExport() as query parameters.
export function driverValue(key: string, value: unknown): unknown {
  if (value instanceof DateTime || value instanceof GeoPoint) {
    return value.value();
  }
  if (value instanceof JSONRaw) {
    const v = value.value();
    if (v instanceof Uint8Array) {
      // a Go string with bytes that are not valid UTF-8, stored as TEXT
      return newExp(`CAST({:${jsonTextParam(key)}} AS TEXT)`, { [jsonTextParam(key)]: v });
    }
    return v;
  }
  if (Array.isArray(value)) {
    return jsonArrayValue(value);
  }
  return value;
}

// a placeholder name per column that the builder's own p0, p1, ... cannot
// take
function jsonTextParam(column: string): string {
  return "pbJSONText_" + Buffer.from(column).toString("hex");
}
