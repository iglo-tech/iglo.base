// Upstream: apis/record_crud.go (bindRecordCrudApi, recordsList,
// randomizedThrottle, recordView, recordCreate, recordUpdate, recordDelete,
// recordDataFromRequest, extractUploadedFiles, hasAuthManageAccess)
//
// The OnRecordsListRequest, OnRecordViewRequest, OnRecordCreateRequest,
// OnRecordUpdateRequest and OnRecordDeleteRequest hooks are not ported (no
// extension surface): their default actions run directly. On the routes the
// records and the rule checks are read through the async resolvers, on the
// read worker pool; the saves and deletes go through
// src/records/record-save.ts. The rate limiter is "inlined" because the crud
// actions are also used in the batch APIs.
//
// The create, update and delete handlers are one implementation for the
// routes and the batch API (D28): each is a step (src/records/record-save.ts)
// that yields every read and write through a RecordIO. The routes run them
// with routeIO, on the read pool; src/batch runs them synchronously in its
// transaction, with txRecordIO. Upstream's responseWriteAfterTx and
// optFinalizer have no counterpart: a route is never in a transaction, so
// execAfterSuccessTx writes the response at once, and the batch runs its
// items in a loop instead of nesting them in optFinalizer (src/batch/batch.ts
// keeps what that nesting does to a later item's error). Realtime broadcasts
// (M5.1) follow the record save/delete after commit, outside these handlers.
//
// The timing throttle sleeps with the router option's sleep (Bun.sleep
// unless a test replaces it); its limiter windows read the app clock.

import type { App } from "@/app/app";
import { type RequestEvent, RequestInfoContextOAuth2, type RequestInfo } from "@/app/event-request";
import { findCachedCollectionByNameOrId } from "@/collections/collection-query";
import type { Collection } from "@/collections/collection-model";
import type { Params } from "@/db/dbx/query";
import { HashExp, isExpression } from "@/db/dbx/expression";
import type { SelectQuery } from "@/db/dbx/select";
import { FieldNamePassword } from "@/fields/field";
import { FieldTypeFile } from "@/fields/file";
import { PasswordFieldValue } from "@/fields/password";
import { dynamicCollectionBodyLimit } from "@/middlewares/body-limit";
import { DefaultRateLimitMiddlewareId } from "@/middlewares/middlewares";
import { checkCollectionRateLimit, checkRateLimit } from "@/middlewares/rate-limit";
import type { RateLimitRule } from "@/settings/settings-model";
import { type DataMap, newRecord, type Record } from "@/records/record-model";
import { recordQuery, recordsTarget, recordTarget } from "@/records/record-query";
import { expandRecordSync } from "@/records/record-query-expand";
import { deleteRecord, deleteRecordSync, driverValue, run, type Step } from "@/records/record-save";
import { RecordUpsert } from "@/records/record-upsert";
import {
  autoResolveRecordsFlagsSync,
  checkForSuperuserOnlyRuleFields,
  enrichRecord,
  enrichRecords,
  expandFetchSync,
  expandQueryParam,
  firstApiError,
  newRequestFieldResolver,
} from "@/apis/record-helpers";
import { filterBuildExpr } from "@/search/filter";
import { newProvider, type SearchResult } from "@/search/provider";
import { ErrMissingFile } from "@/server/event";
import type { RouterGroup } from "@/server/group";
import type { HandlerResult } from "@/server/handler";
import { setOwn } from "@/server/json-decode";
import { encodeValues } from "@/server/request";
import type { File } from "@/tools/filesystem/file";
import { columnify } from "@/tools/inflector/inflector";
import { toUniqueStringSlice } from "@/tools/list/list";
import { JSONRaw } from "@/tools/types/json-raw";
import { pseudorandomString, randomString } from "@/tools/security/random";

// a handler as a step: yields what RecordIO returns and gets it back resolved
export type HandlerStep = Generator<unknown, HandlerResult, unknown>;

// What a handler reads and writes (D28). A method's result is yielded, so it
// may be a promise on the routes and must not be one in a transaction.
export interface RecordIO {
  requestInfo(e: RequestEvent): RequestInfo | Error | Promise<RequestInfo | Error>;
  // FindUploadedFiles: throws ErrMissingFile when the key has no files
  uploadedFiles(e: RequestEvent, key: string): File[] | Promise<File[]>;
  row(q: SelectQuery): unknown[] | Promise<unknown[]>;
  record(q: SelectQuery): Record | Promise<Record>;
  submit(form: RecordUpsert): void | Promise<void>;
  deleteRecord(e: RequestEvent, record: Record): void | Promise<void>;
  enrich(e: RequestEvent, record: Record): Error | undefined | Promise<Error | undefined>;
}

// the routes: the reads go through the read pool
const routeIO: RecordIO = {
  requestInfo: (e) => e.requestInfo(),
  uploadedFiles: (e, key) => e.findUploadedFiles(key),
  row: (q) => q.rowAsync(),
  record: (q) => q.oneAsync<Record>(recordTarget),
  submit: (form) => form.submit(),
  deleteRecord: (e, record) => deleteRecord(e.app, record),
  enrich: (e, record) => enrichRecord(e, record),
};

// a batch item in its transaction: the reads stay on the transaction's
// connection, and what needs an await was prepared before the transaction
// opened
export function txRecordIO(
  requestInfo: RequestInfo | Error,
  uploadedFiles: ReadonlyMap<string, File[]>,
): RecordIO {
  return {
    requestInfo: () => requestInfo,
    uploadedFiles: (_e, key) => {
      const files = uploadedFiles.get(key);
      if (files === undefined || files.length === 0) {
        throw ErrMissingFile;
      }
      return files;
    },
    row: (q) => q.row(),
    record: (q) => q.one<Record>(recordTarget),
    submit: (form) => {
      form.submitSync();
    },
    deleteRecord: (e, record) => {
      deleteRecordSync(e.app, record);
    },
    enrich: (e, record) =>
      requestInfo instanceof Error ? requestInfo : enrichRecordSync(e, requestInfo, record),
  };
}

// enrichRecord with synchronous reads
function enrichRecordSync(e: RequestEvent, info: RequestInfo, record: Record): undefined {
  const param = Object.hasOwn(info.query, expandQueryParam) ? info.query[expandQueryParam] : "";
  const expands = param !== undefined && param !== "" ? param.split(",") : [];

  try {
    autoResolveRecordsFlagsSync(e.app, [record], info);
    if (expands.length > 0) {
      expandRecordSync(e.app, record, expands, expandFetchSync(e.app, info));
    }
  } catch {
    // only logged upstream because it is not critical
  }

  return undefined;
}

// a handler step as a route handler
function routeHandler(
  step: (e: RequestEvent, io: RecordIO) => HandlerStep,
): (e: RequestEvent) => Promise<HandlerResult> {
  return async (e) => {
    const result: { value?: HandlerResult } = {};
    await run(collectResult(step(e, routeIO), result));
    return result.value;
  };
}

// runs a handler step as a chain step that leaves its result in out
export function* collectResult(step: HandlerStep, out: { value?: HandlerResult }): Step {
  out.value = yield* step;
}

export interface RecordCrudOptions {
  // the randomized throttle's sleep (Bun.sleep by default)
  sleep?: (ms: number) => Promise<void>;
}

// bindRecordCrudApi registers the record crud api endpoints and
// the corresponding handlers.
//
// note: the rate limiter is "inlined" because some of the crud actions are also used in the batch APIs
export function bindRecordCrudApi(
  _app: App,
  rg: RouterGroup<RequestEvent>,
  options: RecordCrudOptions = {},
): void {
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));

  const subGroup = rg
    .group("/collections/{collection}/records")
    .unbind(DefaultRateLimitMiddlewareId);
  subGroup.GET("", (e) => recordsList(e, sleep));
  subGroup.GET("/{id}", recordView);
  subGroup.POST("", routeHandler(recordCreate)).bind(dynamicCollectionBodyLimit(""));
  subGroup.PATCH("/{id}", routeHandler(recordUpdate)).bind(dynamicCollectionBodyLimit(""));
  subGroup.DELETE("/{id}", routeHandler(recordDelete));
}

async function recordsList(
  e: RequestEvent,
  sleep: (ms: number) => Promise<void>,
): Promise<HandlerResult> {
  let collection: Collection;
  try {
    collection = findCachedCollectionByNameOrId(e.app, e.request.pathValue("collection"));
  } catch (err) {
    return e.notFoundError("Missing collection context.", err);
  }

  const rateLimitErr = checkCollectionRateLimit(e, collection, "list");
  if (rateLimitErr !== undefined) {
    return rateLimitErr;
  }

  const requestInfo = await e.requestInfo();
  if (requestInfo instanceof Error) {
    return firstApiError(requestInfo, e.badRequestError("", requestInfo));
  }

  if (collection.listRule === null && !requestInfo.hasSuperuserAuth()) {
    return e.forbiddenError("Only superusers can perform this action.", null);
  }

  // forbid users and guests to query special filter/sort fields
  const ruleFieldsErr = checkForSuperuserOnlyRuleFields(requestInfo);
  if (ruleFieldsErr) {
    return ruleFieldsErr;
  }

  const query = recordQuery(e.app, collection);

  const fieldsResolver = newRequestFieldResolver(e.app, collection, requestInfo, true);

  if (
    !requestInfo.hasSuperuserAuth() &&
    collection.listRule !== null &&
    collection.listRule !== ""
  ) {
    try {
      const expr = filterBuildExpr(
        collection.listRule,
        fieldsResolver,
        fieldsResolver.filterOptions(),
      );
      query.andWhere(expr);
    } catch (err) {
      return asError(err);
    }

    // will be applied by the search provider right before executing the query
    // fieldsResolver.UpdateQuery(query)
  }

  // hidden fields are searchable only by superusers
  fieldsResolver.setAllowHiddenFields(requestInfo.hasSuperuserAuth());

  const searchProvider = newProvider(fieldsResolver, fieldsResolver.filterOptions()).query(query);

  // use rowid when available to minimize the need of a covering index with the "id" field
  if (!collection.isView()) {
    searchProvider.countCol("_rowid_");
  }

  let result: SearchResult<Record>;
  try {
    result = await searchProvider.parseAndExec<Record>(
      encodeValues(e.request.query()),
      recordsTarget,
    );
  } catch (err) {
    return firstApiError(err, e.badRequestError("", err));
  }

  const enrichErr = await enrichRecords(e, result.items);
  if (enrichErr) {
    return firstApiError(enrichErr, e.internalServerError("Failed to enrich records", enrichErr));
  }

  // Add a randomized throttle in case of too many empty search filter attempts.
  //
  // This is just for extra precaution since security researches raised concern regarding the possibility of eventual
  // timing attacks because the List API rule acts also as filter and executes in a single run with the client-side filters.
  // This is by design and it is an accepted trade off between performance, usability and correctness.
  //
  // While technically the below doesn't fully guarantee protection against filter timing attacks, in practice combined with the network latency it makes them even less feasible.
  // A properly configured rate limiter or individual fields Hidden checks are better suited if you are really concerned about eventual information disclosure by side-channel attacks.
  //
  // In all cases it doesn't really matter that much because it doesn't affect the builtin PocketBase security sensitive fields (e.g. password and tokenKey) since they
  // are not client-side filterable and in the few places where they need to be compared against an external value, a constant time check is used.
  if (
    !e.hasSuperuserAuth() &&
    collection.listRule !== null &&
    collection.listRule !== "" &&
    (Object.hasOwn(requestInfo.query, "filter") ? requestInfo.query["filter"] : "") !== "" &&
    result.items.length === 0 &&
    checkRateLimit(e, "@pb_list_timing_check_" + collection.id, listTimingRateLimitRule) !==
      undefined
  ) {
    await randomizedThrottle(500, sleep);
  }

  // execAfterSuccessTx: the handler never runs in a transaction here
  return e.json(200, result);
}

const listTimingRateLimitRule: RateLimitRule = {
  Label: "",
  Audience: "",
  MaxRequests: 3,
  Duration: 3,
};

// randomizedThrottle sleeps a random [0, softMax) number of milliseconds
// (crypto random, as upstream).
export function randomizedThrottle(
  softMax: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const timeout = (buf[0] as number) % softMax;

  return sleep(timeout);
}

async function recordView(e: RequestEvent): Promise<HandlerResult> {
  let collection: Collection;
  try {
    collection = findCachedCollectionByNameOrId(e.app, e.request.pathValue("collection"));
  } catch (err) {
    return e.notFoundError("Missing collection context.", err);
  }

  const rateLimitErr = checkCollectionRateLimit(e, collection, "view");
  if (rateLimitErr !== undefined) {
    return rateLimitErr;
  }

  const recordId = e.request.pathValue("id");
  if (recordId === "") {
    return e.notFoundError("", null);
  }

  const requestInfo = await e.requestInfo();
  if (requestInfo instanceof Error) {
    return firstApiError(requestInfo, e.badRequestError("", requestInfo));
  }

  if (collection.viewRule === null && !requestInfo.hasSuperuserAuth()) {
    return e.forbiddenError("Only superusers can perform this action.", null);
  }

  const ruleFunc = (q: SelectQuery): void => {
    if (
      !requestInfo.hasSuperuserAuth() &&
      collection.viewRule !== null &&
      collection.viewRule !== ""
    ) {
      const resolver = newRequestFieldResolver(e.app, collection, requestInfo, true);

      const expr = filterBuildExpr(collection.viewRule, resolver, resolver.filterOptions());

      q.andWhere(expr);

      resolver.updateQuery(q);
    }
  };

  // FindRecordById with the rule filter, read through the read pool
  let record: Record;
  try {
    const q = recordQuery(e.app, collection).andWhere(
      new HashExp({ [collection.name + ".id"]: recordId }),
    );
    ruleFunc(q);
    record = await q.limit(1).oneAsync<Record>(recordTarget);
  } catch (fetchErr) {
    // upstream passes the (nil) RequestInfo error first: always a 404
    return firstApiError(undefined, e.notFoundError("", fetchErr));
  }

  const enrichErr = await enrichRecord(e, record);
  if (enrichErr) {
    return firstApiError(enrichErr, e.internalServerError("Failed to enrich record", enrichErr));
  }

  // execAfterSuccessTx: the handler never runs in a transaction here
  return e.json(200, record);
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export function* recordCreate(e: RequestEvent, io: RecordIO): HandlerStep {
  let collection: Collection;
  try {
    collection = findCachedCollectionByNameOrId(e.app, e.request.pathValue("collection"));
  } catch (err) {
    return e.notFoundError("Missing collection context.", err);
  }

  if (collection.isView()) {
    return e.badRequestError("Unsupported collection type.", null);
  }

  const rateLimitErr = checkCollectionRateLimit(e, collection, "create");
  if (rateLimitErr !== undefined) {
    return rateLimitErr;
  }

  const requestInfo = (yield io.requestInfo(e)) as RequestInfo | Error;
  if (requestInfo instanceof Error) {
    return firstApiError(requestInfo, e.badRequestError("", requestInfo));
  }

  const hasSuperuserAuth = requestInfo.hasSuperuserAuth();
  if (!hasSuperuserAuth && collection.createRule === null) {
    return e.forbiddenError("Only superusers can perform this action.", null);
  }

  const record = newRecord(collection);

  let data: DataMap | null;
  try {
    data = yield* recordDataFromRequest(e, record, io);
  } catch (err) {
    return firstApiError(err, e.badRequestError("Failed to read the submitted data.", err));
  }

  // set a random password for the OAuth2 ignoring its plain password validators
  let skipPlainPasswordRecordValidators = false;
  if (requestInfo.context === RequestInfoContextOAuth2) {
    data ??= {};
    if (!Object.hasOwn(data, FieldNamePassword)) {
      data[FieldNamePassword] = randomString(30);
      data[FieldNamePassword + "Confirm"] = data[FieldNamePassword];
      skipPlainPasswordRecordValidators = true;
    }
  }

  // replace modifiers fields so that the resolved value is always
  // available when accessing requestInfo.Body
  requestInfo.body = data;

  const form = new RecordUpsert(e.app, record);
  if (hasSuperuserAuth) {
    form.grantSuperuserAccess();
  }
  form.load(data);

  if (skipPlainPasswordRecordValidators) {
    // unset the plain value to skip the plain password field validators
    const raw = record.getRaw(FieldNamePassword);
    if (raw instanceof PasswordFieldValue) {
      raw.plain = "";
    }
  }

  // check the request and record data against the create and manage rules
  if (!hasSuperuserAuth && collection.createRule !== null) {
    const dummyRecord = record.clone();

    const dummyRandomPart = "__pb_create__" + pseudorandomString(6);

    // set an id if it doesn't have already
    // (the value doesn't matter; it is used only to minimize the breaking changes with earlier versions)
    if (dummyRecord.id === "") {
      dummyRecord.id = "__temp_id__" + dummyRandomPart;
    }

    // unset the verified field to prevent manage API rule misuse in case the rule relies on it
    dummyRecord.setVerified(false);

    // export the dummy record data into db params
    let dummyExport: Params;
    try {
      dummyExport = dummyRecord.dbExport();
    } catch (err) {
      return e.badRequestError(
        "Failed to create record",
        new Error(`dummy DBExport error: ${errorMessage(err)}`, { cause: err }),
      );
    }

    const dummyParams: Params = {};
    const selects: string[] = [];
    for (let [k, v] of Object.entries(dummyExport)) {
      // bound as Go's driver binds the typed values
      const value = driverValue(k, v);
      k = columnify(k); // columnify is just as extra measure in case of custom fields
      const param = "__pb_create__" + k;
      if (isExpression(value) && v instanceof JSONRaw) {
        // JSON text that is not valid UTF-8: a Go string with its bytes
        setOwn(dummyParams, param, v.value());
        selects.push("CAST({:" + param + "} AS TEXT) AS [[" + k + "]]");
        continue;
      }
      setOwn(dummyParams, param, value);
      selects.push("{:" + param + "} AS [[" + k + "]]");
    }

    // shallow clone the current collection
    const dummyCollection = Object.assign(
      Object.create(Object.getPrototypeOf(collection) as object) as Collection,
      collection,
    );
    dummyCollection.id += dummyRandomPart;
    dummyCollection.name += columnify(dummyRandomPart);

    const withFrom = `WITH {{${dummyCollection.name}}} as (SELECT ${selects.join(",")})`;

    // check non-empty create rule
    if (dummyCollection.createRule !== "") {
      const ruleQuery = e.app.databases
        .concurrentDB()
        .select("(1)")
        .preFragment(withFrom)
        .from(dummyCollection.name)
        .andBind(dummyParams);

      const resolver = newRequestFieldResolver(e.app, dummyCollection, requestInfo, true);

      try {
        const expr = filterBuildExpr(
          dummyCollection.createRule as string,
          resolver,
          resolver.filterOptions(),
        );
        ruleQuery.andWhere(expr);
      } catch (err) {
        return e.badRequestError(
          "Failed to create record",
          new Error(`create rule build expression failure: ${errorMessage(err)}`, {
            cause: err,
          }),
        );
      }

      try {
        resolver.updateQuery(ruleQuery);
      } catch (err) {
        return e.badRequestError(
          "Failed to create record",
          new Error(`create rule update query failure: ${errorMessage(err)}`, { cause: err }),
        );
      }

      let exists = 0;
      let ruleErr: unknown = null;
      try {
        const row = (yield io.row(ruleQuery.limit(1))) as unknown[];
        exists = Number(row[0] ?? 0);
      } catch (err) {
        ruleErr = err;
      }
      if (ruleErr !== null || exists === 0) {
        return e.badRequestError(
          "Failed to create record",
          new Error(`create rule failure: ${ruleErr === null ? "<nil>" : errorMessage(ruleErr)}`, {
            cause: ruleErr,
          }),
        );
      }
    }

    // check for manage rule access
    const manageRuleQuery = e.app.databases
      .concurrentDB()
      .select("(1)")
      .preFragment(withFrom)
      .from(dummyCollection.name)
      .andBind(dummyParams);
    if (
      !form.hasManageAccess() &&
      (yield* hasAuthManageAccess(e.app, requestInfo, dummyCollection, manageRuleQuery, io))
    ) {
      form.grantManagerAccess();
    }
  }

  // the default OnRecordCreateRequest action
  form.setApp(e.app);
  form.setRecord(record);

  try {
    yield io.submit(form);
  } catch (err) {
    return firstApiError(err, e.badRequestError("Failed to create record", err));
  }

  const enrichErr = (yield io.enrich(e, record)) as Error | undefined;
  if (enrichErr) {
    return firstApiError(enrichErr, e.internalServerError("Failed to enrich record", enrichErr));
  }

  // execAfterSuccessTx: the response is written at once (see the top of the file)
  return e.json(200, record);
}

export function* recordUpdate(e: RequestEvent, io: RecordIO): HandlerStep {
  let collection: Collection;
  try {
    collection = findCachedCollectionByNameOrId(e.app, e.request.pathValue("collection"));
  } catch (err) {
    return e.notFoundError("Missing collection context.", err);
  }

  if (collection.isView()) {
    return e.badRequestError("Unsupported collection type.", null);
  }

  const rateLimitErr = checkCollectionRateLimit(e, collection, "update");
  if (rateLimitErr !== undefined) {
    return rateLimitErr;
  }

  const recordId = e.request.pathValue("id");
  if (recordId === "") {
    return e.notFoundError("", null);
  }

  const requestInfo = (yield io.requestInfo(e)) as RequestInfo | Error;
  if (requestInfo instanceof Error) {
    return firstApiError(requestInfo, e.badRequestError("", requestInfo));
  }

  const hasSuperuserAuth = requestInfo.hasSuperuserAuth();

  if (!hasSuperuserAuth && collection.updateRule === null) {
    return firstApiError(
      undefined,
      e.forbiddenError("Only superusers can perform this action.", null),
    );
  }

  // eager fetch the record so that the modifiers field values can be resolved
  let record: Record;
  try {
    record = (yield findRecordByIdIO(e.app, collection, recordId, null, io)) as Record;
  } catch (err) {
    return firstApiError(err, e.notFoundError("", err));
  }

  let data: DataMap | null;
  try {
    data = yield* recordDataFromRequest(e, record, io);
  } catch (err) {
    return firstApiError(err, e.badRequestError("Failed to read the submitted data.", err));
  }

  // replace modifiers fields so that the resolved value is always
  // available when accessing requestInfo.Body
  requestInfo.body = data;

  const ruleFunc = (q: SelectQuery): void => {
    if (!hasSuperuserAuth && collection.updateRule !== null && collection.updateRule !== "") {
      const resolver = newRequestFieldResolver(e.app, collection, requestInfo, true);

      const expr = filterBuildExpr(collection.updateRule, resolver, resolver.filterOptions());

      q.andWhere(expr);

      resolver.updateQuery(q);
    }
  };

  // refetch with access checks
  try {
    record = (yield findRecordByIdIO(e.app, collection, recordId, ruleFunc, io)) as Record;
  } catch (err) {
    return firstApiError(err, e.notFoundError("", err));
  }

  const form = new RecordUpsert(e.app, record);
  if (hasSuperuserAuth) {
    form.grantSuperuserAccess();
  }
  form.load(data);

  const manageRuleQuery = e.app.databases
    .concurrentDB()
    .select("(1)")
    .from(collection.name)
    .andWhere(new HashExp({ [collection.name + ".id"]: record.id }));
  if (
    !form.hasManageAccess() &&
    (yield* hasAuthManageAccess(e.app, requestInfo, collection, manageRuleQuery, io))
  ) {
    form.grantManagerAccess();
  }

  // the default OnRecordUpdateRequest action
  form.setApp(e.app);
  form.setRecord(record);

  try {
    yield io.submit(form);
  } catch (err) {
    return firstApiError(err, e.badRequestError("Failed to update record.", err));
  }

  const enrichErr = (yield io.enrich(e, record)) as Error | undefined;
  if (enrichErr) {
    return firstApiError(enrichErr, e.internalServerError("Failed to enrich record", enrichErr));
  }

  // execAfterSuccessTx: the response is written at once (see the top of the file)
  return e.json(200, record);
}

export function* recordDelete(e: RequestEvent, io: RecordIO): HandlerStep {
  let collection: Collection;
  try {
    collection = findCachedCollectionByNameOrId(e.app, e.request.pathValue("collection"));
  } catch (err) {
    return e.notFoundError("Missing collection context.", err);
  }

  if (collection.isView()) {
    return e.badRequestError("Unsupported collection type.", null);
  }

  const rateLimitErr = checkCollectionRateLimit(e, collection, "delete");
  if (rateLimitErr !== undefined) {
    return rateLimitErr;
  }

  const recordId = e.request.pathValue("id");
  if (recordId === "") {
    return e.notFoundError("", null);
  }

  const requestInfo = (yield io.requestInfo(e)) as RequestInfo | Error;
  if (requestInfo instanceof Error) {
    return firstApiError(requestInfo, e.badRequestError("", requestInfo));
  }

  if (!requestInfo.hasSuperuserAuth() && collection.deleteRule === null) {
    return e.forbiddenError("Only superusers can perform this action.", null);
  }

  const ruleFunc = (q: SelectQuery): void => {
    if (
      !requestInfo.hasSuperuserAuth() &&
      collection.deleteRule !== null &&
      collection.deleteRule !== ""
    ) {
      const resolver = newRequestFieldResolver(e.app, collection, requestInfo, true);

      const expr = filterBuildExpr(collection.deleteRule, resolver, resolver.filterOptions());

      q.andWhere(expr);

      resolver.updateQuery(q);
    }
  };

  let record: Record;
  try {
    record = (yield findRecordByIdIO(e.app, collection, recordId, ruleFunc, io)) as Record;
  } catch (err) {
    return e.notFoundError("", err);
  }

  // the default OnRecordDeleteRequest action
  try {
    yield io.deleteRecord(e, record);
  } catch (err) {
    return firstApiError(
      err,
      e.badRequestError(
        "Failed to delete record. Make sure that the record is not part of a required relation reference.",
        err,
      ),
    );
  }

  // execAfterSuccessTx: the response is written at once (see the top of the file)
  return e.noContent(204);
}

// FindRecordById with an optional filter
function findRecordByIdIO(
  app: App,
  collection: Collection,
  recordId: string,
  filter: ((q: SelectQuery) => void) | null,
  io: RecordIO,
): Record | Promise<Record> {
  const q = recordQuery(app, collection).andWhere(
    new HashExp({ [collection.name + ".id"]: recordId }),
  );
  filter?.(q);
  return io.record(q.limit(1));
}

// -------------------------------------------------------------------

function* recordDataFromRequest(
  e: RequestEvent,
  record: Record,
  io: RecordIO,
): Generator<unknown, DataMap | null, unknown> {
  const info = (yield io.requestInfo(e)) as RequestInfo | Error;
  if (info instanceof Error) {
    throw info;
  }

  // resolve regular fields
  let result = info.body === null ? null : record.replaceModifiers(info.body);

  // resolve uploaded files
  const uploadedFiles = yield* extractUploadedFiles(e, record.collection(), "", io);
  if (uploadedFiles !== null && uploadedFiles.size > 0) {
    result ??= {};

    for (const [k, files] of uploadedFiles) {
      const uploaded: unknown[] = [];

      // if not remove/prepend/append -> merge with the submitted
      // info.Body values to prevent accidental old files deletion
      const bodyValue = info.body !== null && Object.hasOwn(info.body, k) ? info.body[k] : null;
      if (
        bodyValue !== null &&
        bodyValue !== undefined &&
        !k.startsWith("+") &&
        !k.endsWith("+") &&
        !k.endsWith("-")
      ) {
        const existing = toUniqueStringSlice(bodyValue);
        for (const name of existing) {
          uploaded.push(name);
        }
      }

      for (const file of files) {
        uploaded.push(file);
      }

      setOwn(result, k, uploaded);
    }

    result = record.replaceModifiers(result);
  }

  const isAuth = record.collection().isAuth();

  // unset hidden fields for non-superusers
  if (!info.hasSuperuserAuth() && result !== null) {
    for (const f of record.collection().fields) {
      if (f.getHidden()) {
        // exception for the auth collection "password" field
        if (isAuth && f.getName() === FieldNamePassword) {
          continue;
        }

        delete result[f.getName()];
      }
    }
  }

  return result;
}

function* extractUploadedFiles(
  re: RequestEvent,
  collection: Collection,
  prefix: string,
  io: RecordIO,
): Generator<unknown, Map<string, File[]> | null, unknown> {
  const contentType = re.request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    return null; // not multipart/form-data request
  }

  const result = new Map<string, File[]>();

  for (const field of collection.fields) {
    if (field.type() !== FieldTypeFile) {
      continue;
    }

    const baseKey = field.getName();

    const keys = [
      baseKey,
      // prepend and append modifiers
      "+" + baseKey,
      baseKey + "+",
    ];

    for (let k of keys) {
      if (prefix !== "") {
        k = prefix + "." + k;
      }
      let files: File[] = [];
      try {
        files = (yield io.uploadedFiles(re, k)) as File[];
      } catch (err) {
        if (err !== ErrMissingFile) {
          throw err;
        }
      }
      if (files.length > 0) {
        result.set(k, files);
      }
    }
  }

  return result;
}

// hasAuthManageAccess checks whether the client is allowed to have
// [RecordUpsert] auth management permissions
// (e.g. allowing to change system auth fields without oldPassword).
function* hasAuthManageAccess(
  app: App,
  requestInfo: RequestInfo | null,
  collection: Collection,
  query: SelectQuery,
  io: RecordIO,
): Generator<unknown, boolean, unknown> {
  if (!collection.isAuth()) {
    return false;
  }

  const manageRule = collection.manageRule;

  if (manageRule === null || manageRule === "") {
    return false; // only for superusers (manageRule can't be empty)
  }

  if (requestInfo === null || requestInfo.auth === undefined) {
    return false; // no auth record
  }

  const resolver = newRequestFieldResolver(app, collection, requestInfo, true);

  try {
    const expr = filterBuildExpr(manageRule, resolver, resolver.filterOptions());
    query.andWhere(expr);
  } catch (err) {
    app.logger.error(`Manage rule build expression error (collectionId ${collection.id})`, err);
    return false;
  }

  try {
    resolver.updateQuery(query);
  } catch {
    return false;
  }

  try {
    const row = (yield io.row(query.limit(1))) as unknown[];
    return Number(row[0] ?? 0) > 0;
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
