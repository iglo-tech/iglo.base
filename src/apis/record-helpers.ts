// Upstream: apis/record_helpers.go (EnrichRecord, EnrichRecords,
// defaultEnrichRecords, expandFetch, autoResolveRecordsFlags,
// checkForSuperuserOnlyRuleFields, firstApiError, execAfterSuccessTx)
//
// The OnRecordEnrich hook chain (triggerRecordEnrichHooks) is not ported
// (no extension surface): the default enrich runs directly, in upstream's
// order. The record reads are async and go through the read worker pool.
// Upstream logs a failed default enrich or expand as a warning in its
// `_logs` (M5); here those failures are dropped, as upstream drops them
// from the response. RecordAuthResponse, MFA and the auth alert are M4.

import type { App } from "@/app/app";
import { type RequestEvent, RequestInfo, RequestInfoContextExpand } from "@/app/event-request";
import type { Collection } from "@/collections/collection-model";
import { inExp } from "@/db/dbx/expression";
import type { SelectQuery } from "@/db/dbx/select";
import type { Record } from "@/records/record-model";
import { recordQuery, recordsTarget } from "@/records/record-query";
import { type ExpandFetchFunc, expandRecords } from "@/records/record-query-expand";
import { newRecordFieldResolver } from "@/resolver/record-field-resolver";
import { ApiError, errorsAs, newForbiddenError, newInternalServerError } from "@/server/error";
import { filterBuildExpr, ParsedFilterCache } from "@/search/filter";
import { FilterQueryParam, SortQueryParam } from "@/search/provider";

export const expandQueryParam = "expand";
export const fieldsQueryParam = "fields";

// the app store key of the parsed filters cache that the request handlers
// share (upstream's package-level cache in tools/search)
const parsedFilterCacheStoreKey = "@igloParsedFilterCache";

// The parsed filters cache of the app (created on first use).
export function parsedFilterCache(app: App): ParsedFilterCache {
  return app.store.getOrSet(
    parsedFilterCacheStoreKey,
    () => new ParsedFilterCache(),
  ) as ParsedFilterCache;
}

// core.NewRecordFieldResolver with the app's parsed filters cache
export function newRequestFieldResolver(
  app: App,
  collection: Collection,
  requestInfo: RequestInfo | null,
  allowHiddenFields: boolean,
): ReturnType<typeof newRecordFieldResolver> {
  const resolver = newRecordFieldResolver(app, collection, requestInfo, allowHiddenFields);
  resolver.filterCache = parsedFilterCache(app);
  return resolver;
}

// EnrichRecord parses the request context and enrich the provided record:
//   - expands relations (if defaultExpands and/or ?expand query param is set)
//   - ensures that the emails of the auth record and its expanded auth relations
//     are visible only for the current logged superuser, record owner or record with manage access
export function enrichRecord(
  e: RequestEvent,
  record: Record,
  ...defaultExpands: string[]
): Promise<Error | undefined> {
  return enrichRecords(e, [record], ...defaultExpands);
}

// EnrichRecords parses the request context and enriches the provided records:
//   - expands relations (if defaultExpands and/or ?expand query param is set)
//   - ensures that the emails of the auth records and their expanded auth relations
//     are visible only for the current logged superuser, record owner or record with manage access
//
// Note: Expects all records to be from the same collection!
export async function enrichRecords(
  e: RequestEvent,
  records: Record[],
  ...defaultExpands: string[]
): Promise<Error | undefined> {
  if (records.length === 0) {
    return undefined;
  }

  const info = await e.requestInfo();
  if (info instanceof Error) {
    return info;
  }

  let expands = defaultExpands;
  const param = Object.hasOwn(info.query, expandQueryParam) ? info.query[expandQueryParam] : "";
  if (param !== undefined && param !== "") {
    expands = [...expands, ...param.split(",")];
  }

  try {
    await defaultEnrichRecords(e.app, info, records, ...expands);
  } catch {
    // only logged upstream because it is not critical
  }

  return undefined;
}

async function defaultEnrichRecords(
  app: App,
  requestInfo: RequestInfo,
  records: Record[],
  ...expands: string[]
): Promise<void> {
  try {
    await autoResolveRecordsFlags(app, records, requestInfo);
  } catch (err) {
    throw new Error(`failed to resolve records flags: ${errorMessage(err)}`, { cause: err });
  }

  if (expands.length > 0) {
    const expandErrs = await expandRecords(app, records, expands, expandFetch(app, requestInfo));
    if (expandErrs.size > 0) {
      const errs = [...expandErrs].map(
        ([key, err]) => new Error(`failed to expand ${JSON.stringify(key)}: ${err.message}`),
      );
      throw new Error(`failed to expand records: ${errs.map((err) => err.message).join("\n")}`);
    }
  }
}

// expandFetch is the records fetch function that is used to expand related records.
export function expandFetch(app: App, originalRequestInfo: RequestInfo): ExpandFetchFunc {
  // shallow clone the provided request info to set an "expand" context
  const requestInfoPtr = Object.assign(new RequestInfo(), originalRequestInfo);
  requestInfoPtr.context = RequestInfoContextExpand;

  return async (relCollection, relIds) => {
    // FindRecordsByIds with the view rule filter
    const q = recordQuery(app, relCollection).andWhere(
      inExp(relCollection.name + ".id", ...relIds),
    );
    applyViewRule(app, relCollection, requestInfoPtr, q);
    const records = await q.allAsync<Record>(recordsTarget);

    try {
      await autoResolveRecordsFlags(app, records, requestInfoPtr);
    } catch {
      // non-critical error (logged upstream)
    }

    return records;
  };
}

function applyViewRule(
  app: App,
  relCollection: Collection,
  requestInfo: RequestInfo,
  q: SelectQuery,
): void {
  if (requestInfo.auth !== undefined && requestInfo.auth.isSuperuser()) {
    return; // superusers can access everything
  }

  if (relCollection.viewRule === null) {
    throw new Error(
      `only superusers can view collection ${JSON.stringify(relCollection.name)} records`,
    );
  }

  if (relCollection.viewRule !== "") {
    const resolver = newRequestFieldResolver(app, relCollection, requestInfo, true);

    const expr = filterBuildExpr(relCollection.viewRule, resolver, resolver.filterOptions());

    q.andWhere(expr);

    resolver.updateQuery(q);
  }
}

// autoResolveRecordsFlags resolves various visibility flags of the provided records.
//
// Currently it enables:
// - export of hidden fields if the current auth model is a superuser
// - email export ignoring the emailVisibity checks if the current auth model is superuser, owner or a "manager".
//
// Note: Expects all records to be from the same collection!
export async function autoResolveRecordsFlags(
  app: App,
  records: Record[],
  requestInfo: RequestInfo,
): Promise<void> {
  if (records.length === 0) {
    return; // nothing to resolve
  }

  const first = records[0] as Record;

  if (requestInfo.hasSuperuserAuth()) {
    const hiddenFields = first.collection().fields.fieldNames();
    for (const rec of records) {
      rec.unhide(...hiddenFields);
      rec.ignoreEmailVisibility(true);
    }
  }

  // additional emailVisibility checks
  // ---------------------------------------------------------------
  if (!first.collection().isAuth()) {
    return; // not auth collection records
  }

  const collection = first.collection();

  const mappedRecords = new Map<string, Record>();
  const recordIds: string[] = [];
  for (const rec of records) {
    mappedRecords.set(rec.id, rec);
    recordIds.push(rec.id);
  }

  if (requestInfo.auth !== undefined) {
    mappedRecords.get(requestInfo.auth.id)?.ignoreEmailVisibility(true);
  }

  if (collection.manageRule === null || collection.manageRule === "") {
    return; // no manage rule to check
  }

  // fetch the ids of the managed records
  // ---
  const db = app.databases.concurrentDB();
  const query = recordQuery(app, collection)
    .select(db.quoteSimpleColumnName(collection.name) + ".id")
    .andWhere(inExp(db.quoteSimpleColumnName(collection.name) + ".id", ...recordIds));

  const resolver = newRequestFieldResolver(app, collection, requestInfo, true);
  const expr = filterBuildExpr(collection.manageRule, resolver, resolver.filterOptions());

  query.andWhere(expr);

  resolver.updateQuery(query);

  const managedIds = await query.columnAsync<unknown>();
  // ---

  // ignore the email visibility check for the managed records
  for (const id of managedIds) {
    mappedRecords.get(String(id))?.ignoreEmailVisibility(true);
  }
}

const ruleQueryParams = [FilterQueryParam, SortQueryParam];
const superuserOnlyRuleFields = ["@collection.", "@request."];

// checkForSuperuserOnlyRuleFields loosely checks and returns an error if
// the provided RequestInfo contains rule fields that only the superuser can use.
export function checkForSuperuserOnlyRuleFields(requestInfo: RequestInfo): ApiError | undefined {
  if (Object.keys(requestInfo.query).length === 0 || requestInfo.hasSuperuserAuth()) {
    return undefined; // superuser or nothing to check
  }

  for (const param of ruleQueryParams) {
    const v = Object.hasOwn(requestInfo.query, param) ? requestInfo.query[param] : undefined;
    if (v === undefined || v === "") {
      continue;
    }

    for (const field of superuserOnlyRuleFields) {
      if (v.includes(field)) {
        return newForbiddenError("Only superusers can filter by " + field, null);
      }
    }
  }

  return undefined;
}

// firstApiError returns the first ApiError from the errors list
// (this is used usually to prevent unnecessary wraping and to allow bubling ApiError from nested hooks)
//
// If no ApiError is found, returns a default "Internal server" error.
export function firstApiError(...errs: unknown[]): ApiError {
  for (const err of errs) {
    if (err === null || err === undefined) {
      continue;
    }

    // quick assert to avoid the reflection checks
    if (err instanceof ApiError) {
      return err;
    }

    // nested/wrapped errors
    const apiErr = errorsAs(err, ApiError);
    if (apiErr) {
      return apiErr;
    }
  }

  return newInternalServerError(
    "",
    new AggregateError(errs.filter((err) => err !== null && err !== undefined)),
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
