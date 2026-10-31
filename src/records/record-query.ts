// Upstream: core/record_query.go (RecordQuery, resolveRecordOneHook,
// resolveRecordAllHook, getCollectionByModelOrIdentifier, FindRecordById,
// FindRecordsByIds, FindAllRecords, FindFirstRecordByData, CountRecords,
// FindAuthRecordByToken, FindAuthRecordByEmail)
//
// Upstream's methods are on BaseApp. Here they are functions of the narrow
// RecordsApp below (the CollectionsApp of src/collections: the databases,
// the store with the collections cache and the clock). The token checks
// read the app clock where golang-jwt reads time.Now().
//
// Go's (value, error) results are the value, and the error is thrown; a
// record that is not found throws src/db's NoRowsError (sql.ErrNoRows).
// Go's optional `...func(q *dbx.SelectQuery) error` filters are functions
// that change the query and throw instead of returning an error.
//
// RecordQuery hydrates Records where Go's One()/All() get a *Record or a
// *[]*Record: query.one<Record>(recordTarget) returns a Record and
// query.all<Record>(recordsTarget) returns Records (Go fills the given
// target; here the resolver returns them). Other targets scan as dbx
// does. Rows are read with withExactIntegers(), as dbx's NullStringMap
// scan needs.
//
// The synchronous resolvers and the async ones (on the read pool) both
// run through execLockRetry with the app's query timeout.
//
// Not here: FindRecordsByFilter, FindFirstRecordByFilter and
// CanAccessRecord (record-query-filter.ts).
// Not ported: the RecordProxy
// branches of the One/All hooks (custom Go structs that embed a Record; a
// library API) and the non-pointer *[]Record slice (Go only).

import {
  type CollectionsApp,
  findCachedCollectionByNameOrId,
} from "@/collections/collection-query";
import { Collection } from "@/collections/collection-model";
import { equalFold } from "@/collections/go-strings";
import { driverError, withDriverErrors } from "@/collections/driver-error";
import { wrapError } from "@/collections/view";
import { type Expression, HashExp, inExp, newExp } from "@/db/dbx/expression";
import type { Row } from "@/db/dbx/query";
import type { SelectQuery } from "@/db/dbx/select";
import type { StructModel } from "@/db/dbx/struct";
import { defaultMaxLockRetries, execLockRetry, execLockRetryAsync } from "@/db/retry";
import { FieldNameEmail, goQuote } from "@/fields/field";
import {
  type Record,
  newRecordFromNullStringMap,
  newRecordsFromNullStringMaps,
  nullStringMapFromRow,
} from "@/records/record-model";
import {
  TokenClaimCollectionId,
  TokenClaimId,
  TokenClaimType,
  TokenTypeAuth,
  TokenTypeEmailChange,
  TokenTypeFile,
  TokenTypePasswordReset,
  TokenTypeVerification,
} from "@/records/record-tokens";
import { findSingleColumnUniqueIndex } from "@/tools/dbutils/index";
import { columnify } from "@/tools/inflector/inflector";
import { existInSlice, toInterfaceSlice } from "@/tools/list/list";
import { parseJWT, parseUnverifiedJWT } from "@/tools/security/jwt";

// The app members the record queries use (core/app.go).
export type RecordsApp = CollectionsApp;

// a collection model, or a collection id or name (Go's any argument)
export type CollectionModelOrIdentifier = Collection | string;

// Go's optional query filter: changes the query, throws to fail the find
export type RecordQueryFilter = ((q: SelectQuery) => void) | null | undefined;

// a StructModel that is never scanned: the targets below are only markers
// for RecordQuery's hooks
function markerModel(): StructModel {
  return { tableName: notScanned, dbColumns: notScanned, dbScan: notScanned };
}

// Scanning into a record target on a query RecordQuery did not build.
export class NotRecordQueryError extends Error {
  constructor() {
    super("the record target is only for queries built by RecordQuery");
  }
}

function notScanned(): never {
  throw new NotRecordQueryError();
}

// One()'s target for a Record (Go: &core.Record{})
export const recordTarget: StructModel = Object.freeze(markerModel());

// All()'s target for Records (Go: &[]*core.Record{})
export function recordsTarget(): StructModel {
  return markerModel();
}

// RecordQuery returns a new Record select query from a collection model, id or name.
//
// In case a collection id or name is provided and that collection doesn't
// actually exists, the generated query will be created with a cancelled context
// and will fail once an executor (Row(), One(), All(), etc.) is called.
export function recordQuery(app: RecordsApp, collectionModelOrIdentifier: unknown): SelectQuery {
  let tableName = "";

  let collection: Collection | null = null;
  let collectionErr: unknown = null;
  try {
    collection = getCollectionByModelOrIdentifier(app, collectionModelOrIdentifier);
    tableName = collection.name;
  } catch (err) {
    collectionErr = err;
  }
  if (tableName === "") {
    // update with some fake table name for easier debugging
    tableName = "@@__invalidCollectionModelOrIdentifier";
  }

  const db = app.databases.concurrentDB();
  const query = db.select(db.quoteSimpleColumnName(tableName) + ".*").from(tableName);

  // in case of an error attach a new context and cancel it immediately with the error
  if (collectionErr !== null) {
    query.withCancelCause(collectionErr);
  }

  return query.withBuildHook((q) => {
    const databases = app.databases;
    const now = (): number => databases.now();
    const retry = execLockRetry(
      databases.queryTimeout(),
      defaultMaxLockRetries,
      (ms) => databases.sleep(ms),
      now,
    );
    const retryAsync = execLockRetryAsync(
      databases.queryTimeout(),
      defaultMaxLockRetries,
      (ms) => databases.asyncSleep(ms),
      now,
    );
    q.withExactIntegers()
      .withExecHook((built, op) => retry(built, () => withDriverErrors(op)))
      .withAsyncExecHook((built, op) =>
        retryAsync(built, async () => {
          try {
            await op();
          } catch (err) {
            throw driverError(err);
          }
        }),
      )
      .withOneHook((_q, a, op) => {
        if (a === recordTarget) {
          return resolveRecordOneHook(collection as Collection, op);
        }
        return op(a);
      })
      .withAllHook((_q, sliceA, op) => {
        if (sliceA === recordsTarget) {
          return resolveRecordAllHook(collection as Collection, op);
        }
        return op(sliceA);
      });
  });
}

function resolveRecordOneHook(collection: Collection, op: (dst: unknown) => unknown): Record {
  const data = op(undefined) as Row;
  return newRecordFromNullStringMap(collection, nullStringMapFromRow(data));
}

function resolveRecordAllHook(collection: Collection, op: (dst: unknown) => unknown[]): Record[] {
  const data = op(undefined) as Row[];
  return newRecordsFromNullStringMaps(collection, data.map(nullStringMapFromRow));
}

export function getCollectionByModelOrIdentifier(
  app: RecordsApp,
  collectionModelOrIdentifier: unknown,
): Collection {
  if (collectionModelOrIdentifier instanceof Collection) {
    return collectionModelOrIdentifier;
  }
  if (typeof collectionModelOrIdentifier === "string") {
    return findCachedCollectionByNameOrId(app, collectionModelOrIdentifier);
  }
  throw new Error("unknown collection identifier - must be collection model, id or name");
}

// -------------------------------------------------------------------

// FindRecordById finds the Record model by its id.
export function findRecordById(
  app: RecordsApp,
  collectionModelOrIdentifier: CollectionModelOrIdentifier,
  recordId: string,
  ...optFilters: RecordQueryFilter[]
): Record {
  const collection = getCollectionByModelOrIdentifier(app, collectionModelOrIdentifier);

  const query = recordQuery(app, collection).andWhere(
    new HashExp({ [collection.name + ".id"]: recordId }),
  );

  // apply filter funcs (if any)
  for (const filter of optFilters) {
    if (filter === null || filter === undefined) {
      continue;
    }
    filter(query);
  }

  return query.limit(1).one<Record>(recordTarget);
}

// FindRecordsByIds finds all records by the specified ids.
// If no records are found, returns an empty slice.
export function findRecordsByIds(
  app: RecordsApp,
  collectionModelOrIdentifier: CollectionModelOrIdentifier,
  recordIds: readonly string[],
  ...optFilters: RecordQueryFilter[]
): Record[] {
  const collection = getCollectionByModelOrIdentifier(app, collectionModelOrIdentifier);

  const query = recordQuery(app, collection).andWhere(
    inExp(collection.name + ".id", ...toInterfaceSlice(recordIds)),
  );

  for (const filter of optFilters) {
    if (filter === null || filter === undefined) {
      continue;
    }
    filter(query);
  }

  return query.all<Record>(recordsTarget);
}

// FindAllRecords finds all records matching specified db expressions.
//
// Returns all collection records if no expression is provided.
//
// Returns an empty slice if no records are found.
//
// Example:
//
//	// no extra expressions
//	findAllRecords(app, "example")
//
//	// with extra expressions
//	const expr1 = new HashExp({ email: "test@example.com" })
//	const expr2 = newExp("LOWER(username) = {:username}", { username: "test" })
//	findAllRecords(app, "example", expr1, expr2)
export function findAllRecords(
  app: RecordsApp,
  collectionModelOrIdentifier: CollectionModelOrIdentifier,
  ...exprs: (Expression | null | undefined)[]
): Record[] {
  const query = recordQuery(app, collectionModelOrIdentifier);

  for (const expr of exprs) {
    if (expr !== null && expr !== undefined) {
      // add only the non-nil expressions
      query.andWhere(expr);
    }
  }

  return query.all<Record>(recordsTarget);
}

// FindFirstRecordByData returns the first found record matching
// the provided key-value pair.
export function findFirstRecordByData(
  app: RecordsApp,
  collectionModelOrIdentifier: CollectionModelOrIdentifier,
  key: string,
  value: unknown,
): Record {
  const collection = getCollectionByModelOrIdentifier(app, collectionModelOrIdentifier);

  const field = collection.fields.getByName(key);
  if (field === null) {
    throw new Error("invalid or missing field " + key);
  }

  return recordQuery(app, collection)
    .andWhere(new HashExp({ [columnify(key)]: value }))
    .limit(1)
    .one<Record>(recordTarget);
}

// CountRecords returns the total number of records in a collection.
export function countRecords(
  app: RecordsApp,
  collectionModelOrIdentifier: CollectionModelOrIdentifier,
  ...exprs: (Expression | null | undefined)[]
): number {
  const q = recordQuery(app, collectionModelOrIdentifier).select("count(*)");

  for (const expr of exprs) {
    if (expr !== null && expr !== undefined) {
      // add only the non-nil expressions
      q.andWhere(expr);
    }
  }

  const [total] = q.row();

  return Number(total as bigint);
}

// FindAuthRecordByToken finds the auth record associated with the provided JWT
// (auth, file, verifyEmail, changeEmail, passwordReset types).
//
// Optionally specify a list of validTypes to check tokens only from those types.
//
// Throws if the token is invalid, expired or not associated to an auth collection record.
export function findAuthRecordByToken(
  app: RecordsApp,
  token: string,
  ...validTypes: string[]
): Record {
  if (token === "") {
    throw new Error("missing token");
  }

  const unverifiedClaims = parseUnverifiedJWT(token, app.clock);

  // check required claims
  const id = stringClaim(unverifiedClaims, TokenClaimId);
  const collectionId = stringClaim(unverifiedClaims, TokenClaimCollectionId);
  const tokenType = stringClaim(unverifiedClaims, TokenClaimType);
  if (id === "" || collectionId === "" || tokenType === "") {
    throw new Error("missing or invalid token claims");
  }

  // check types (if explicitly set)
  if (validTypes.length > 0 && !existInSlice(tokenType, validTypes)) {
    throw new Error(
      `invalid token type ${goQuote(tokenType)}, expects ${goQuote(validTypes.join(","))}`,
    );
  }

  const record = findRecordById(app, collectionId, id);

  if (!record.collection().isAuth()) {
    throw new Error("the token is not associated to an auth collection record");
  }

  let baseTokenKey: string;
  switch (tokenType) {
    case TokenTypeAuth:
      baseTokenKey = record.collection().authToken.secret;
      break;
    case TokenTypeFile:
      baseTokenKey = record.collection().fileToken.secret;
      break;
    case TokenTypeVerification:
      baseTokenKey = record.collection().verificationToken.secret;
      break;
    case TokenTypePasswordReset:
      baseTokenKey = record.collection().passwordResetToken.secret;
      break;
    case TokenTypeEmailChange:
      baseTokenKey = record.collection().emailChangeToken.secret;
      break;
    default:
      throw new Error("unknown token type " + tokenType);
  }

  const secret = record.tokenKey() + baseTokenKey;

  // verify token signature
  parseJWT(token, secret, app.clock);

  return record;
}

// claims[key].(string): the claim if it is a string, else ""
function stringClaim(claims: { [key: string]: unknown }, key: string): string {
  const v = Object.hasOwn(claims, key) ? claims[key] : undefined;
  return typeof v === "string" ? v : "";
}

// FindAuthRecordByEmail finds the auth record associated with the provided email.
//
// The email check would be case-insensitive if the related collection
// email unique index has COLLATE NOCASE specified for the email column.
//
// Throws if it is not an auth collection or the record is not found.
export function findAuthRecordByEmail(
  app: RecordsApp,
  collectionModelOrIdentifier: CollectionModelOrIdentifier,
  email: string,
): Record {
  let collection: Collection;
  try {
    collection = getCollectionByModelOrIdentifier(app, collectionModelOrIdentifier);
  } catch (err) {
    throw wrapError("failed to fetch auth collection", err);
  }

  if (!collection.isAuth()) {
    throw new Error(`${goQuote(collection.name)} is not an auth collection`);
  }

  let expr: Expression;

  const [index, ok] = findSingleColumnUniqueIndex(collection.indexes, FieldNameEmail);
  if (ok && equalFold(index.columns[0]?.collate ?? "", "nocase")) {
    // case-insensitive search
    expr = newExp("[[" + FieldNameEmail + "]] = {:email} COLLATE NOCASE", { email });
  } else {
    expr = new HashExp({ [FieldNameEmail]: email });
  }

  return recordQuery(app, collection).andWhere(expr).limit(1).one<Record>(recordTarget);
}
