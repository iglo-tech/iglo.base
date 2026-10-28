// Upstream: core/record_query.go (FindRecordsByFilter,
// FindFirstRecordByFilter, CanAccessRecord)
//
// Upstream's methods are on BaseApp; here they are functions of the
// RecordsApp of record-query.ts. Go's (value, error) results are the
// value, and the error is thrown; FindFirstRecordByFilter throws src/db's
// NoRowsError (sql.ErrNoRows) when nothing matches.
//
// Each function has a synchronous form, which keeps upstream's name, and
// an async one (…Async), which reads through dbx's async resolvers: on
// the read worker pool outside a transaction, on the transaction's
// connection inside one. Callers outside write transactions use the async
// forms; a synchronous transaction callback uses the synchronous ones.

import type { RequestInfo } from "@/app/event-request";
import { HashExp } from "@/db/dbx/expression";
import type { Params } from "@/db/dbx/query";
import { isNoRowsError, NoRowsError } from "@/db/dbx/rows";
import type { SelectQuery } from "@/db/dbx/select";
import type { Record } from "@/records/record-model";
import {
  type CollectionModelOrIdentifier,
  getCollectionByModelOrIdentifier,
  type RecordsApp,
  recordQuery,
  recordsTarget,
} from "@/records/record-query";
import { newRecordFieldResolver, wrapResolverError } from "@/resolver/record-field-resolver";
import { filterBuildExpr } from "@/search/filter";
import { parseSortFromString, sortFieldBuildExpr } from "@/search/sort";

// FindRecordsByFilter returns limit number of records matching the
// provided string filter.
//
// NB! Use the last "params" argument to bind untrusted user variables!
//
// The filter argument is optional and can be empty string to target
// all available records.
//
// The sort argument is optional and can be empty string OR the same format
// used in the web APIs, ex. "-created,title".
//
// If the limit argument is <= 0, no limit is applied to the query and
// all matching records are returned.
//
// Returns an empty slice if no records are found.
//
// Example:
//
//	findRecordsByFilter(
//		app,
//		"posts",
//		"title ~ {:title} && visible = {:visible}",
//		"-created",
//		10,
//		0,
//		{ title: "lorem ipsum", visible: true },
//	)
export function findRecordsByFilter(
  app: RecordsApp,
  collectionModelOrIdentifier: CollectionModelOrIdentifier,
  filter: string,
  sort: string,
  limit: number,
  offset: number,
  ...params: Params[]
): Record[] {
  return recordsByFilterQuery(
    app,
    collectionModelOrIdentifier,
    filter,
    sort,
    limit,
    offset,
    params,
  ).all<Record>(recordsTarget);
}

// FindRecordsByFilter, read through dbx's async resolvers.
export function findRecordsByFilterAsync(
  app: RecordsApp,
  collectionModelOrIdentifier: CollectionModelOrIdentifier,
  filter: string,
  sort: string,
  limit: number,
  offset: number,
  ...params: Params[]
): Promise<Record[]> {
  let q: SelectQuery;
  try {
    q = recordsByFilterQuery(app, collectionModelOrIdentifier, filter, sort, limit, offset, params);
  } catch (err) {
    return Promise.reject(err);
  }
  return q.allAsync<Record>(recordsTarget);
}

function recordsByFilterQuery(
  app: RecordsApp,
  collectionModelOrIdentifier: CollectionModelOrIdentifier,
  filter: string,
  sort: string,
  limit: number,
  offset: number,
  params: Params[],
): SelectQuery {
  const collection = getCollectionByModelOrIdentifier(app, collectionModelOrIdentifier);

  const q = recordQuery(app, collection);

  // build a fields resolver and attach the generated conditions to the query
  // ---
  const resolver = newRecordFieldResolver(
    app,
    collection, // the base collection
    null, // no request data
    true, // allow searching hidden/protected fields like "email"
  );

  if (filter !== "") {
    let expr;
    try {
      expr = filterBuildExpr(filter, resolver, resolver.filterOptions(), ...params);
    } catch (err) {
      throw wrapResolverError("invalid filter expression", err);
    }
    q.andWhere(expr);
  }

  if (sort !== "") {
    for (const sortField of parseSortFromString(sort)) {
      const expr = sortFieldBuildExpr(sortField, resolver);
      if (expr !== "") {
        q.andOrderBy(expr);
      }
    }
  }

  resolver.updateQuery(q); // attaches any adhoc joins and aliases
  // ---

  if (offset > 0) {
    q.offset(offset);
  }

  if (limit > 0) {
    q.limit(limit);
  }

  return q;
}

// FindFirstRecordByFilter returns the first available record matching the provided filter (if any).
//
// NB! Use the last params argument to bind untrusted user variables!
//
// Throws NoRowsError (sql.ErrNoRows) if no record is found.
//
// Example:
//
//	findFirstRecordByFilter(app, "posts", "")
//	findFirstRecordByFilter(app, "posts", "slug={:slug} && status='public'", { slug: "test" })
export function findFirstRecordByFilter(
  app: RecordsApp,
  collectionModelOrIdentifier: CollectionModelOrIdentifier,
  filter: string,
  ...params: Params[]
): Record {
  const result = findRecordsByFilter(app, collectionModelOrIdentifier, filter, "", 1, 0, ...params);

  return firstRecord(result);
}

// FindFirstRecordByFilter, read through dbx's async resolvers.
export async function findFirstRecordByFilterAsync(
  app: RecordsApp,
  collectionModelOrIdentifier: CollectionModelOrIdentifier,
  filter: string,
  ...params: Params[]
): Promise<Record> {
  const result = await findRecordsByFilterAsync(
    app,
    collectionModelOrIdentifier,
    filter,
    "",
    1,
    0,
    ...params,
  );

  return firstRecord(result);
}

function firstRecord(result: Record[]): Record {
  if (result.length === 0) {
    throw new NoRowsError();
  }

  return result[0] as Record;
}

// CanAccessRecord checks if a record is allowed to be accessed by the
// specified requestInfo and accessRule.
//
// Rule and db checks are ignored in case requestInfo.auth is a superuser.
//
// The returned error indicate that something unexpected happened during
// the check (eg. invalid rule or db query error).
//
// The method always return false on invalid rule or db query error.
//
// Example:
//
//	const requestInfo = await e.requestInfo()
//	const record = findRecordById(app, "example", "RECORD_ID")
//	const rule = types.Pointer("@request.auth.id != '' || status = 'public'")
//	// ... or use one of the record collection's rule, eg. record.collection().viewRule
//
//	if (canAccessRecord(app, record, requestInfo, rule)) { ... }
export function canAccessRecord(
  app: RecordsApp,
  record: Record,
  requestInfo: RequestInfo,
  accessRule: string | null,
): boolean {
  const query = accessQuery(app, record, requestInfo, accessRule);
  if (typeof query === "boolean") {
    return query;
  }

  let exists: unknown = 0;
  try {
    [exists] = query.row();
  } catch (err) {
    if (!isNoRowsCause(err)) {
      throw err;
    }
  }

  return Number(exists) > 0;
}

// CanAccessRecord, read through dbx's async resolvers.
export async function canAccessRecordAsync(
  app: RecordsApp,
  record: Record,
  requestInfo: RequestInfo,
  accessRule: string | null,
): Promise<boolean> {
  const query = accessQuery(app, record, requestInfo, accessRule);
  if (typeof query === "boolean") {
    return query;
  }

  let exists: unknown = 0;
  try {
    [exists] = await query.rowAsync();
  } catch (err) {
    if (!isNoRowsCause(err)) {
      throw err;
    }
  }

  return Number(exists) > 0;
}

// the access query of CanAccessRecord, or its result when no query is needed
function accessQuery(
  app: RecordsApp,
  record: Record,
  requestInfo: RequestInfo,
  accessRule: string | null,
): SelectQuery | boolean {
  // superusers can access everything
  if (requestInfo.hasSuperuserAuth()) {
    return true;
  }

  // only superusers can access this record
  if (accessRule === null) {
    return false;
  }

  // empty public rule, aka. everyone can access
  if (accessRule === "") {
    return true;
  }

  const query = recordQuery(app, record.collection())
    .select("(1)")
    .andWhere(new HashExp({ [record.collection().name + ".id"]: record.id }));

  // parse and apply the access rule filter
  const resolver = newRecordFieldResolver(app, record.collection(), requestInfo, true);
  const expr = filterBuildExpr(accessRule, resolver, resolver.filterOptions());

  resolver.updateQuery(query);

  return query.andWhere(expr).limit(1);
}

// errors.Is(err, sql.ErrNoRows): the error or one of its causes
function isNoRowsCause(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (isNoRowsError(e)) {
      return true;
    }
  }
  return false;
}
