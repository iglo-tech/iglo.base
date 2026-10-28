// Upstream: tools/search/provider.go
//
// Exec is asynchronous: the count and the models queries run as dbx's
// RowAsync and AllAsync (on the read worker pool when the builder has one),
// at the same time, as upstream runs them in two goroutines.
//
// page and perPage are Go ints (GoInt: a number, or a bigint outside the
// safe range); the page offset is computed with Go's int64 wrap-around.
// Filter and sort field lengths are counted in UTF-8 bytes, as Go's len.

import type { Row } from "@/db/dbx/query";
import type { SelectQuery } from "@/db/dbx/select";
import type { StructModel } from "@/db/dbx/struct";
import { goQuote } from "@/fields/field";
import { parseQuery } from "@/server/request";
import {
  type FilterBuildOptions,
  type FilterData,
  filterBuildExprWithLimit,
} from "@/search/filter";
import type { FieldResolver } from "@/search/simple-field-resolver";
import {
  parseSortFromString,
  rowidSortKey,
  type SortField,
  sortFieldBuildExpr,
} from "@/search/sort";
import { aliasOrIdentifier } from "@/tools/dbutils/select";
import { columnify } from "@/tools/inflector/inflector";
import { type GoInt, goInt, textToBytes } from "@/tools/types/go-json";

// DefaultPerPage specifies the default number of returned search result items.
export const DefaultPerPage = 30;

// DefaultFilterExprLimit specifies the default filter expressions limit.
export const DefaultFilterExprLimit = 200;

// DefaultSortExprLimit specifies the default sort expressions limit.
export const DefaultSortExprLimit = 8;

// MaxPerPage specifies the max allowed search result items returned in a single page.
export const MaxPerPage = 1000;

// MaxFilterLength specifies the max allowed individual search filter parsable length.
export const MaxFilterLength = 3500;

// MaxSortFieldLength specifies the max allowed individual sort field parsable length.
export const MaxSortFieldLength = 255;

// Common search errors.
export const ErrEmptyQuery = new Error("search query is not set");
export const ErrSortExprLimit = new Error("max sort expressions limit reached");
export const ErrFilterExprLimit = new Error("max filter expressions limit reached");
export const ErrFilterLengthLimit = new Error("max filter length limit reached");
export const ErrSortFieldLengthLimit = new Error("max sort field length limit reached");

// URL search query params
export const PageQueryParam = "page";
export const PerPageQueryParam = "perPage";
export const SortQueryParam = "sort";
export const FilterQueryParam = "filter";
export const SkipTotalQueryParam = "skipTotal";

// Result defines the returned search result structure.
export interface Result<T> {
  items: T[];
  page: GoInt;
  perPage: number;
  totalItems: number;
  totalPages: number;
}

// NewProvider initializes and returns a new search provider.
//
// Example:
//
//	const baseQuery = db.select("*").from("user")
//	const fieldResolver = newSimpleFieldResolver("id", "name")
//
//	const result = await newProvider(fieldResolver, { clock })
//		.query(baseQuery)
//		.parseAndExec("page=2&filter=id>0&sort=-email")
export function newProvider(fieldResolver: FieldResolver, options: FilterBuildOptions): Provider {
  return new Provider(fieldResolver, options);
}

// Provider represents a single configured search provider instance.
export class Provider {
  private queryValue: SelectQuery | null = null;
  private countColValue = "id";
  private sortValue: SortField[] = [];
  private filterValue: FilterData[] = [];
  private pageValue: GoInt = 1;
  private perPageValue: GoInt = DefaultPerPage;
  private skipTotalValue = false;
  private maxFilterExprLimitValue = DefaultFilterExprLimit;
  private maxSortExprLimitValue = DefaultSortExprLimit;

  constructor(
    private readonly fieldResolver: FieldResolver,
    // the clock and the parse cache of the filters
    private readonly options: FilterBuildOptions,
  ) {}

  // MaxFilterExprLimit changes the default max allowed filter expressions.
  //
  // Note that currently the limit is applied individually for each separate filter.
  maxFilterExprLimit(max: number): this {
    this.maxFilterExprLimitValue = max;
    return this;
  }

  // MaxSortExprLimit changes the default max allowed sort expressions.
  maxSortExprLimit(max: number): this {
    this.maxSortExprLimitValue = max;
    return this;
  }

  // Query sets the base query that will be used to fetch the search items.
  query(query: SelectQuery | null): this {
    this.queryValue = query;
    return this;
  }

  // SkipTotal changes the `skipTotal` field of the current search provider.
  skipTotal(skipTotal: boolean): this {
    this.skipTotalValue = skipTotal;
    return this;
  }

  // CountCol allows changing the default column (id) that is used
  // to generate the COUNT SQL query statement.
  //
  // This field is ignored if skipTotal is true.
  countCol(name: string): this {
    this.countColValue = name;
    return this;
  }

  // Page sets the `page` field of the current search provider.
  //
  // Normalization on the `page` value is done during `Exec()`.
  page(page: GoInt): this {
    this.pageValue = page;
    return this;
  }

  // PerPage sets the `perPage` field of the current search provider.
  //
  // Normalization on the `perPage` value is done during `Exec()`.
  perPage(perPage: GoInt): this {
    this.perPageValue = perPage;
    return this;
  }

  // Sort sets the `sort` field of the current search provider.
  sort(sort: SortField[]): this {
    this.sortValue = sort;
    return this;
  }

  // AddSort appends the provided SortField to the existing provider's sort field.
  addSort(field: SortField): this {
    this.sortValue = [...this.sortValue, field];
    return this;
  }

  // Filter sets the `filter` field of the current search provider.
  filter(filter: FilterData[]): this {
    this.filterValue = filter;
    return this;
  }

  // AddFilter appends the provided FilterData to the existing provider's filter field.
  addFilter(filter: FilterData): this {
    if (filter !== "") {
      this.filterValue = [...this.filterValue, filter];
    }
    return this;
  }

  // Parse parses the search query parameter from the provided query string
  // and assigns the found fields to the current search provider.
  //
  // The data from the "sort" and "filter" query parameters are appended
  // to the existing provider's `sort` and `filter` fields
  // (aka. using `AddSort` and `AddFilter`).
  parse(urlQuery: string): void {
    const { values: params, err } = parseQuery(urlQuery);
    if (err !== undefined) {
      throw err;
    }
    const get = (key: string): string => params.get(key)?.[0] ?? "";

    let raw = get(SkipTotalQueryParam);
    if (raw !== "") {
      this.skipTotal(parseBool(raw));
    }

    raw = get(PageQueryParam);
    if (raw !== "") {
      this.page(atoi(raw));
    }

    raw = get(PerPageQueryParam);
    if (raw !== "") {
      this.perPage(atoi(raw));
    }

    raw = get(SortQueryParam);
    if (raw !== "") {
      for (const sortField of parseSortFromString(raw)) {
        this.addSort(sortField);
      }
    }

    raw = get(FilterQueryParam);
    if (raw !== "") {
      this.addFilter(raw);
    }
  }

  // Exec executes the search provider and returns the found models (rows,
  // or the models the factory creates, as dbx's All).
  async exec<T = Row>(factory?: () => StructModel): Promise<Result<T>> {
    if (this.queryValue === null) {
      throw ErrEmptyQuery;
    }

    // clone the provider's query
    const modelsQuery = this.queryValue.clone();

    // build filters
    for (const f of this.filterValue) {
      if (byteLength(f) > MaxFilterLength) {
        throw ErrFilterLengthLimit;
      }
      const expr = filterBuildExprWithLimit(
        f,
        this.fieldResolver,
        this.maxFilterExprLimitValue,
        this.options,
      );
      modelsQuery.andWhere(expr);
    }

    // apply sorting
    if (this.sortValue.length > this.maxSortExprLimitValue) {
      throw ErrSortExprLimit;
    }
    for (const sortField of this.sortValue) {
      if (byteLength(sortField.name) > MaxSortFieldLength) {
        throw ErrSortFieldLengthLimit;
      }
      let expr = sortFieldBuildExpr(sortField, this.fieldResolver);
      if (expr !== "") {
        // ensure that _rowid_ expressions are always prefixed with the first FROM table
        if (sortField.name === rowidSortKey && !expr.includes(".")) {
          const queryInfo = modelsQuery.info();
          if (queryInfo.from.length > 0) {
            expr = "[[" + columnify(queryInfo.from[0] as string) + "]]." + expr;
          }
        }

        modelsQuery.andOrderBy(expr);
      }
    }

    // apply field resolver query modifications (if any)
    this.fieldResolver.updateQuery(modelsQuery);

    // normalize page
    if (this.pageValue <= 0) {
      this.pageValue = 1;
    }

    // normalize perPage
    if (this.perPageValue <= 0) {
      this.perPageValue = DefaultPerPage;
    } else if (this.perPageValue > MaxPerPage) {
      this.perPageValue = MaxPerPage;
    }

    const page = this.pageValue;
    const perPage = Number(this.perPageValue);

    // negative value to differentiate from the zero default
    let totalCount = -1;
    let totalPages = -1;

    // prepare a count query from the base one
    const countQuery = modelsQuery.clone();
    const countExec = async (): Promise<void> => {
      const queryInfo = countQuery.info();
      let countCol = this.countColValue;

      if (queryInfo.from.length > 0) {
        const firstFrom = aliasOrIdentifier(queryInfo.from[0] as string);
        countCol = firstFrom + "." + countCol;
      }

      // @todo while currently there is no such use case, evaluate if
      // wrapping as a subquery would be more suitable for the cases
      // when there is "Group By" different from the default deduplication one
      // added by RecordFieldResolver.UpdateQuery
      const row = await countQuery
        .distinct(false)
        .select("COUNT(DISTINCT [[" + countCol + "]])")
        .groupBy(/* reset */)
        .orderBy(/* reset */)
        .rowAsync();
      totalCount = Number(row[0]);

      totalPages = Math.ceil(totalCount / perPage);
    };

    // apply pagination to the original query and fetch the models
    let items: T[] = [];
    const modelsExec = async (): Promise<void> => {
      modelsQuery.limit(perPage);
      // int64(s.perPage * (s.page - 1)), with Go's int64 wrap-around (a
      // negative offset means no offset). dbx's offset is a JS number, so an
      // offset past 2^53 - 1 rows is given as 2^53 - 1: both are far past
      // any table, so the page is empty either way.
      const offset = BigInt.asIntN(64, BigInt(perPage) * (BigInt(page) - 1n));
      modelsQuery.offset(Number(offset > maxSafeOffset ? maxSafeOffset : offset));

      items = await modelsQuery.allAsync<T>(factory);
    };

    if (!this.skipTotalValue) {
      // execute the 2 queries concurrently
      await Promise.all([countExec(), modelsExec()]);
    } else {
      await modelsExec();
    }

    return {
      items,
      page,
      perPage,
      totalItems: totalCount,
      totalPages,
    };
  }

  // ParseAndExec is a short convenient method to trigger both
  // `Parse()` and `Exec()` in a single call.
  async parseAndExec<T = Row>(urlQuery: string, factory?: () => StructModel): Promise<Result<T>> {
    this.parse(urlQuery);

    return this.exec<T>(factory);
  }
}

// len(s) of a Go string
function byteLength(s: string): number {
  return textToBytes(s).length;
}

// strconv.NumError's text
function numError(fn: string, num: string, err: string): Error {
  return new Error(`strconv.${fn}: parsing ${goQuote(num)}: ${err}`);
}

// strconv.ParseBool
function parseBool(str: string): boolean {
  switch (str) {
    case "1":
    case "t":
    case "T":
    case "true":
    case "TRUE":
    case "True":
      return true;
    case "0":
    case "f":
    case "F":
    case "false":
    case "FALSE":
    case "False":
      return false;
  }
  throw numError("ParseBool", str, "invalid syntax");
}

const maxUint64 = 2n ** 64n - 1n;
const maxSafeOffset = BigInt(Number.MAX_SAFE_INTEGER);

// strconv.Atoi (int is 64 bits): an optional sign and decimal digits;
// the first problem met while reading the digits decides the error.
function atoi(s0: string): GoInt {
  let s = s0;
  let neg = false;
  if (s[0] === "+" || s[0] === "-") {
    neg = s[0] === "-";
    s = s.slice(1);
  }
  if (s === "") {
    throw numError("Atoi", s0, "invalid syntax");
  }

  let n = 0n;
  for (const c of s) {
    if (c < "0" || c > "9") {
      throw numError("Atoi", s0, "invalid syntax");
    }
    n = n * 10n + BigInt(c.charCodeAt(0) - 0x30);
    if (n > maxUint64) {
      throw numError("Atoi", s0, "value out of range");
    }
  }

  const cutoff = 2n ** 63n;
  if ((!neg && n >= cutoff) || (neg && n > cutoff)) {
    throw numError("Atoi", s0, "value out of range");
  }

  return goInt(neg ? -n : n);
}
