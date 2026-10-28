// Upstream: core/record_field_resolver.go
//
// Go's (result, error) returns are the result, and the error is thrown.
//
// No process-global state: the filters the resolver builds itself (a
// collection's list rule in UpdateQuery, the :changed alias) read the date
// macros from the app's clock; the optional parse cache is the resolver's
// (filterCache), where upstream uses its package-level one.
//
// Param values follow Go's driver bindings: a JS number from the request
// info (JSON numbers, a number field's ParseFloat, an auth record's number
// field) is a Go float64 and is bound as Float64 (REAL); a bigint is an
// int64; the :each data is bound as a []byte (a BLOB).
//
// Not ported: preferGroupBy and the commented-out GROUP BY branch of
// updateQueryWithDeduplicateConstraint (unused upstream), and the debug
// log of resolveStaticRequestField's graceful fallback (application code
// logs only errors).

import type { RequestInfo } from "@/app/event-request";
import type { Collection } from "@/collections/collection-model";
import { Float64, type Params, setOwn } from "@/db/dbx/query";
import type { SelectQuery } from "@/db/dbx/select";
import { goQuote } from "@/fields/field";
import { FieldTypeNumber } from "@/fields/number";
import { Record } from "@/records/record-model";
import { getCollectionByModelOrIdentifier, type RecordsApp } from "@/records/record-query";
import { parseAndRun } from "@/resolver/record-field-resolver-runner";
import { type FilterBuildOptions, filterBuildExpr, type ParsedFilterCache } from "@/search/filter";
import type { Join } from "@/search/multi-match-subquery";
import type { FieldResolver, ResolverResult } from "@/search/simple-field-resolver";
import { parseGoFloat } from "@/server/unmarshal-request-data";
import { pseudorandomString } from "@/tools/security/random";
import { toStringE } from "@/tools/types/cast";
import { anyType, marshal, unmarshal } from "@/tools/types/go-json";
import { JSONRaw } from "@/tools/types/json-raw";
import type { Expression } from "@/db/dbx/expression";

// filter modifiers
export const eachModifier = "each";
export const issetModifier = "isset";
export const lengthModifier = "length";
export const lowerModifier = "lower";
export const changedModifier = "changed";

export interface RuleJoin {
  collection: Collection;
  tableAlias: string;
}

// NewRecordFieldResolver creates and initializes a new `RecordFieldResolver`.
export function newRecordFieldResolver(
  app: RecordsApp,
  baseCollection: Collection,
  requestInfo: RequestInfo | null,
  allowHiddenFields: boolean,
): RecordFieldResolver {
  return new RecordFieldResolver(app, baseCollection, requestInfo, allowHiddenFields);
}

// RecordFieldResolver defines a custom search resolver struct for
// managing Record model search fields.
//
// Usually used together with `search.Provider`.
// Example:
//
//	const resolver = newRecordFieldResolver(app, myCollection, requestInfo, true)
//	const provider = newProvider(resolver, { clock: app.clock })
//	...
//
// The members are the package-internal state the runner
// (record-field-resolver-runner.ts) reads and changes, as Go's unexported
// struct fields; callers use the methods.
export class RecordFieldResolver implements FieldResolver {
  app: RecordsApp;
  baseCollection: Collection;
  requestInfo: RequestInfo | null;
  staticRequestInfo: { [key: string]: unknown };
  allowedFields: string[];
  joins: Join[];
  allowHiddenFields: boolean;
  // ---
  listRuleJoins: RuleJoin[] = [];
  joinAliasSuffix = ""; // used for uniqueness in the flatten collection list rule join
  baseCollectionAlias = "";
  // the optional parse cache of the filters the resolver builds itself
  filterCache: ParsedFilterCache | null = null;

  constructor(
    app: RecordsApp,
    baseCollection: Collection,
    requestInfo: RequestInfo | null,
    allowHiddenFields: boolean,
  ) {
    this.app = app;
    this.baseCollection = baseCollection;
    this.requestInfo = requestInfo;
    // note: it is not based only on the requestInfo.auth since it could be used by a non-request internal method
    this.allowHiddenFields = allowHiddenFields;
    this.joins = [];
    this.allowedFields = [
      String.raw`^\w+[\w\.\:]*$`,
      String.raw`^\@request\.context$`,
      String.raw`^\@request\.method$`,
      String.raw`^\@request\.auth\.[\w\.\:]*\w+$`,
      String.raw`^\@request\.body\.[\w\.\:]*\w+$`,
      String.raw`^\@request\.query\.[\w\.\:]*\w+$`,
      String.raw`^\@request\.headers\.[\w\.\:]*\w+$`,
      String.raw`^\@collection\.\w+(\:\w+)?\.[\w\.\:]*\w+$`,
    ];

    this.staticRequestInfo = {};
    if (requestInfo !== null) {
      this.staticRequestInfo["context"] = requestInfo.context;
      this.staticRequestInfo["method"] = requestInfo.method;
      this.staticRequestInfo["query"] = requestInfo.query;
      this.staticRequestInfo["headers"] = requestInfo.headers;
      this.staticRequestInfo["body"] = requestInfo.body;
      this.staticRequestInfo["auth"] = null;
      const auth = requestAuthRecord(requestInfo);
      if (auth !== null) {
        const authClone = auth.clone();
        this.staticRequestInfo["auth"] = authClone
          .unhide(...authClone.collection().fields.fieldNames())
          .ignoreEmailVisibility(true)
          .publicExport();
      }
    }
  }

  // AllowedFields returns a copy of the resolver's allowed fields.
  getAllowedFields(): string[] {
    return [...this.allowedFields];
  }

  // SetAllowedFields replaces the resolver's allowed fields with the new ones.
  setAllowedFields(newAllowedFields: readonly string[]): void {
    this.allowedFields = [...newAllowedFields];
  }

  // AllowHiddenFields returns whether the current resolver allows filtering hidden fields.
  getAllowHiddenFields(): boolean {
    return this.allowHiddenFields;
  }

  // SetAllowHiddenFields enables or disables hidden fields filtering.
  setAllowHiddenFields(allowHiddenFields: boolean): void {
    this.allowHiddenFields = allowHiddenFields;
  }

  // the options of the filters the resolver builds itself
  filterOptions(): FilterBuildOptions {
    return { clock: this.app.clock, cache: this.filterCache };
  }

  // @todo think of a better a way how to call it automatically after BuildExpr
  //
  // UpdateQuery implements `search.FieldResolver` interface.
  //
  // Conditionally updates the provided search query based on the
  // resolved fields (eg. dynamically joining relations).
  updateQuery(query: SelectQuery): void {
    if (this.joins.length > 0) {
      this.updateQueryWithDeduplicateConstraint(query);

      for (const join of this.joins) {
        query.leftJoin(join.tableName + " " + join.tableAlias, join.on ?? null);
      }
    }

    // note: for now the joins are not applied for multi-match conditions to avoid excessive checks
    if (this.listRuleJoins.length > 0) {
      for (const join of this.listRuleJoins) {
        this.updateQueryWithCollectionListRule(join.collection, join.tableAlias, query);
      }
    }
  }

  private updateQueryWithCollectionListRule(
    c: Collection | null,
    tableAlias: string,
    query: SelectQuery,
  ): void {
    if (this.allowHiddenFields || c === null || c.listRule === null || c.listRule === "") {
      return;
    }

    // a shallow copy (Go's cloneR := *r)
    const cloneR = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as RecordFieldResolver,
      this,
    );
    cloneR.joins = [];
    cloneR.baseCollection = c;
    cloneR.baseCollectionAlias = tableAlias;
    cloneR.allowHiddenFields = true;
    cloneR.joinAliasSuffix = pseudorandomString(8);

    // The extra "id='' || (\nRULE\n)" concatenated part on its own
    // doesn't make much sense because all records are required to have an id,
    // but it is necessary to properly resolve client-side filters when
    // referencing missing relations (the "\n" is for leading and trailing comments).
    //
    // Consider the client-side filter: "a.name != '' || b.name != ''",
    // where both "a" and "b" ref collections have non-empty ListRule.
    // Without the empty check the query will always evaluate to FALSE
    // when one of the "a" or "b" relation fields are empty,
    // even if for example "a.name != ''" is true.
    let expr: Expression;
    try {
      expr = filterBuildExpr("id='' || (\n" + c.listRule + "\n)", cloneR, this.filterOptions());
    } catch (err) {
      throw wrapResolverError(
        `failed to build ${goQuote(c.name)} ListRule join subquery filter expression`,
        err,
      );
    }

    // Bind the extra rule expression at the top query level for performance and security reasons
    // (it is more strict and minimizes the risk of data disclosure from a side-channel attack).
    query.andWhere(expr);

    if (cloneR.joins.length > 0) {
      this.updateQueryWithDeduplicateConstraint(query);

      for (const j of cloneR.joins) {
        query.leftJoin(j.tableName + " " + j.tableAlias, j.on ?? null);
      }
    }
  }

  private updateQueryWithDeduplicateConstraint(query: SelectQuery): void {
    query.distinct(true);

    // @todo Research better options for generic rows deduplication.
    //
    // (upstream keeps a disabled GROUP BY variant here because it prevents
    // proper utilization of ORDER BY indexes)
  }

  // Resolve implements `search.FieldResolver` interface.
  //
  // Example of some resolvable fieldName formats:
  //
  //	id
  //	someSelect.each
  //	project.screen.status
  //	screen.project_via_prototype.name
  //	@request.context
  //	@request.method
  //	@request.query.filter
  //	@request.headers.x_token
  //	@request.auth.someRelation.name
  //	@request.body.someRelation.name
  //	@request.body.someField
  //	@request.body.someSelect:each
  //	@request.body.someField:isset
  //	@collection.product.name
  resolve(fieldName: string): ResolverResult {
    return parseAndRun(fieldName, this);
  }

  resolveStaticRequestField(...path: string[]): ResolverResult {
    if (path.length === 0) {
      throw new Error("at least one path key should be provided");
    }

    const [lastProp, modifier] = splitModifier(path[path.length - 1] as string);

    path[path.length - 1] = lastProp;

    // extract value
    let resultVal: unknown;
    let extractErr: unknown = null;
    try {
      resultVal = extractNestedVal(this.staticRequestInfo, ...path);
    } catch (err) {
      // (upstream logs it at the debug level)
      extractErr = err;
      resultVal = null;
    }

    if (modifier === issetModifier) {
      if (extractErr !== null) {
        return { identifier: "FALSE" };
      }
      return { identifier: "TRUE" };
    }

    // note: we are ignoring the error because requestInfo is dynamic
    // and some of the lookup keys may not be defined for the request

    if (resultVal === null || resultVal === undefined) {
      // no further processing is needed...
      resultVal = null;
    } else if (typeof resultVal === "string") {
      // check if it is a number field and explicitly try to cast to
      // float in case of a numeric string value was used
      // (this usually the case when the data is from a multipart/form-data request)
      const field = this.baseCollection.fields.getByName(path[path.length - 1] as string);
      if (field !== null && field.type() === FieldTypeNumber) {
        try {
          resultVal = parseGoFloat(resultVal, 64);
        } catch {
          // not a number
        }
      }
      // otherwise - no further processing is needed...
    } else if (
      typeof resultVal === "boolean" ||
      typeof resultVal === "number" ||
      typeof resultVal === "bigint"
    ) {
      // no further processing is needed...
    } else {
      // non-plain value
      // try casting to string (in case for example fmt.Stringer is implemented)
      let val = "";
      try {
        val = toStringE(resultVal);
      } catch {
        // if that doesn't work, try encoding it
        try {
          val = marshal(resultVal);
        } catch {
          // Go keeps the empty string
        }
      }

      resultVal = val;
    }

    // unsupported modifier
    // @todo consider deprecating with the introduction of filter functions
    if (modifier !== "" && modifier !== lowerModifier) {
      throw new Error(`invalid modifier sequence ${lastProp}:${modifier}`);
    }

    // no need to wrap as placeholder if we already know that it is null
    if (resultVal === null) {
      return { identifier: "NULL" };
    }

    const placeholder = "f" + pseudorandomString(10);

    const params: Params = {};
    setOwn(params, placeholder, paramValue(resultVal));

    // @todo consider deprecating with the introduction of filter functions
    if (modifier === lowerModifier) {
      return { identifier: "LOWER({:" + placeholder + "})", params };
    }

    return { identifier: "{:" + placeholder + "}", params };
  }

  // loadCollection throws when the collection is not found
  loadCollection(collectionNameOrId: string): Collection {
    if (
      collectionNameOrId === this.baseCollection.name ||
      collectionNameOrId === this.baseCollection.id
    ) {
      return this.baseCollection;
    }

    return getCollectionByModelOrIdentifier(this.app, collectionNameOrId);
  }

  registerJoin(tableName: string, tableAlias: string, on: Expression | null): void {
    const newJoin: Join = { tableName, tableAlias, on };

    // (see updateQueryWithCollectionListRule)
    if (!this.allowHiddenFields) {
      let c: Collection | null = null;
      try {
        c = this.loadCollection(tableName);
      } catch {
        // ignore non-collections since the table name could be an expression (e.g. json) or some other subquery
      }

      if (c !== null) {
        // treat all fields as if they are hidden
        if (c.listRule === null) {
          throw new Error(
            `${goQuote(c.name)} fields can be accessed only when allowHiddenFields is enabled or by superusers`,
          );
        }

        this.registerRuleJoin(c, newJoin.tableAlias);
      }
    }

    // replace existing join
    for (const [i, j] of this.joins.entries()) {
      if (j.tableAlias === newJoin.tableAlias) {
        this.joins[i] = newJoin;
        return;
      }
    }

    // register new join
    this.joins.push(newJoin);
  }

  private registerRuleJoin(collection: Collection, tableAlias: string): void {
    // replace existing
    for (const j of this.listRuleJoins) {
      if (j.tableAlias === tableAlias) {
        j.collection = collection;
        return;
      }
    }

    // register new
    this.listRuleJoins.push({ collection, tableAlias });
  }
}

// the auth Record of a RequestInfo (null for none)
export function requestAuthRecord(requestInfo: RequestInfo | null): Record | null {
  return requestInfo?.auth ?? null;
}

// a request info value as Go's driver binds it: a JS number is a float64
export function paramValue(v: unknown): unknown {
  return typeof v === "number" ? new Float64(v) : v;
}

// the own member of a map (Go's m[key], with the zero value nil)
export function ownValue(m: { [key: string]: unknown } | null | undefined, key: string): unknown {
  if (m === null || m === undefined || !Object.hasOwn(m, key)) {
    return null;
  }
  return m[key];
}

// a fmt.Errorf("...: %w", err) wrap
export function wrapResolverError(prefix: string, err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  // a Go panic is not an error result
  if (e.name === "NilPointerPanic") {
    return e;
  }
  return new Error(`${prefix}: ${e.message}`, { cause: e });
}

interface MapExtractor {
  asMap(): { [key: string]: unknown };
}

function isMapExtractor(v: unknown): v is MapExtractor {
  return (
    typeof v === "object" && v !== null && typeof (v as { asMap?: unknown }).asMap === "function"
  );
}

function isPlainMap(v: unknown): v is { [key: string]: unknown } {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

export function extractNestedVal(rawData: unknown, ...keys: string[]): unknown {
  if (keys.length === 0) {
    throw new Error("at least one key should be provided");
  }

  // maps
  if (isPlainMap(rawData)) {
    return mapVal(rawData, keys);
  }
  if (rawData instanceof JSONRaw) {
    let raw: unknown;
    try {
      raw = unmarshal(rawData.bytes(), anyType);
    } catch (err) {
      throw wrapResolverError(
        "failed to unmarshal raw JSON in order extract nested value from",
        err,
      );
    }
    return extractNestedVal(raw, ...keys);
  }
  if (isMapExtractor(rawData)) {
    return mapVal(rawData.asMap(), keys);
  }

  // slices
  if (Array.isArray(rawData)) {
    return arrVal(rawData, keys);
  }
  if (rawData instanceof Uint8Array) {
    return arrVal(Array.from(rawData), keys);
  }

  throw new Error(`expected map or array, got ${String(rawData)}`);
}

function mapVal(m: { [key: string]: unknown }, keys: string[]): unknown {
  const key = keys[0] as string;
  if (!Object.hasOwn(m, key)) {
    throw new Error(`invalid key path - missing key ${goQuote(key)}`);
  }
  let result = m[key];
  if (result === undefined) {
    result = null;
  }

  // end key reached
  if (keys.length === 1) {
    return result;
  }

  return extractNestedVal(result, ...keys.slice(1));
}

function arrVal(m: readonly unknown[], keys: string[]): unknown {
  const key = keys[0] as string;
  const idx = goAtoi(key);
  if (idx === null || idx < 0 || idx >= m.length) {
    throw new Error(`invalid key path - invalid or missing array index ${goQuote(key)}`);
  }

  let result = m[idx];
  if (result === undefined) {
    result = null;
  }

  // end key reached
  if (keys.length === 1) {
    return result;
  }

  return extractNestedVal(result, ...keys.slice(1));
}

// strconv.Atoi: an optional sign and decimal digits within the int64
// range (null when it fails)
export function goAtoi(s: string): number | null {
  if (!/^[+-]?[0-9]+$/.test(s)) {
    return null;
  }
  const n = BigInt(s);
  if (n < -(2n ** 63n) || n >= 2n ** 63n) {
    return null;
  }
  return Number(n);
}

// splitModifier returns the name and the modifier of a "name:modifier"
// prop; a prop with no or several ":" is returned as it is.
export function splitModifier(combined: string): [string, string] {
  const parts = combined.split(":");

  if (parts.length !== 2) {
    return [combined, ""];
  }

  // validate modifier
  switch (parts[1]) {
    case issetModifier:
    case eachModifier:
    case lengthModifier:
    case lowerModifier:
    case changedModifier:
      return [parts[0] as string, parts[1]];
  }

  throw new Error(`unknown modifier in ${goQuote(combined)}`);
}
