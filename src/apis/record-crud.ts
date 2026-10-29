// Upstream: apis/record_crud.go (bindRecordCrudApi, recordsList,
// randomizedThrottle, recordView)
//
// The list and view routes. Create, update and delete (and
// hasAuthManageAccess, which only they use) are M3.1; they are bound in
// the same group after these two, in upstream's order. The
// OnRecordsListRequest and OnRecordViewRequest hooks are not ported (no
// extension surface): their default actions run directly. The records are
// read through the async resolvers, on the read worker pool. Not here yet:
// checkCollectionRateLimit (the settings rate limit rules, M4.8), so the
// `<collection>:list` and `<collection>:view` rules are not applied.
//
// The timing throttle sleeps with the router option's sleep (Bun.sleep
// unless a test replaces it); its limiter windows read the app clock.

import type { App } from "@/app/app";
import type { RequestEvent } from "@/app/event-request";
import { findCachedCollectionByNameOrId } from "@/collections/collection-query";
import type { Collection } from "@/collections/collection-model";
import { HashExp } from "@/db/dbx/expression";
import type { SelectQuery } from "@/db/dbx/select";
import { DefaultRateLimitMiddlewareId } from "@/middlewares/middlewares";
import { checkRateLimit, type RateLimitRule } from "@/middlewares/rate-limit";
import type { Record } from "@/records/record-model";
import { recordQuery, recordsTarget, recordTarget } from "@/records/record-query";
import {
  checkForSuperuserOnlyRuleFields,
  enrichRecord,
  enrichRecords,
  firstApiError,
  newRequestFieldResolver,
} from "@/apis/record-helpers";
import { filterBuildExpr } from "@/search/filter";
import { newProvider, type SearchResult } from "@/search/provider";
import type { RouterGroup } from "@/server/group";
import type { HandlerResult } from "@/server/handler";
import { encodeValues } from "@/server/request";

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
  // POST "", PATCH "/{id}" and DELETE "/{id}" are bound here by M3.1
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

  // checkCollectionRateLimit(e, collection, "list") lands with M4.8

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
  label: "",
  audience: "",
  maxRequests: 3,
  duration: 3,
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

  // checkCollectionRateLimit(e, collection, "view") lands with M4.8

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
