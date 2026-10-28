// Upstream: tools/search/filter.go
//
// FilterData is a plain string; its Go methods are filterBuildExpr and
// filterBuildExprWithLimit.
//
// No process-global state: upstream's macros read time.Now() and its parsed
// filters are kept in a package-level cache. Here the clock is passed in
// FilterBuildOptions, and so is the optional parse cache (ParsedFilterCache,
// which callers own). The cache only skips parsing again; the built
// expressions are the same with or without it.

import type { Clock } from "@/app/clock";
import { equalFold, toLower } from "@/collections/go-strings";
import type { DB } from "@/db/dbx/db";
import { and, enclose, type Expression, newExp, not } from "@/db/dbx/expression";
import { assignOwn, type Params, setOwn } from "@/db/dbx/query";
import { goQuote } from "@/fields/field";
import { type Expr, type ExprGroup, ErrEmpty, parse } from "@/search/fexpr/parser";
import {
  JoinOr,
  type SignOp,
  SignAnyEq,
  SignAnyGt,
  SignAnyGte,
  SignAnyLike,
  SignAnyLt,
  SignAnyLte,
  SignAnyNeq,
  SignAnyNlike,
  SignEq,
  SignGt,
  SignGte,
  SignLike,
  SignLt,
  SignLte,
  SignNeq,
  SignNlike,
  type Token,
  TokenFunction,
  TokenIdentifier,
  TokenNumber,
  TokenText,
} from "@/search/fexpr/scanner";
import { identifierMacros } from "@/search/identifier-macros";
import type { MultiMatchSubquery } from "@/search/multi-match-subquery";
import { DefaultFilterExprLimit, ErrFilterExprLimit } from "@/search/provider";
import {
  derefResult,
  type FieldResolver,
  NilPointerPanic,
  NullFallbackAuto,
  NullFallbackDisabled,
  NullFallbackEnforced,
  type NullFallbackPreference,
  type ResolverResult,
} from "@/search/simple-field-resolver";
import { TokenFunctions } from "@/search/token-functions";
import { pseudorandomString } from "@/tools/security/random";
import { toFloat64, toString, toStringE } from "@/tools/types/cast";
import { marshal } from "@/tools/types/go-json";
import { Store } from "@/tools/store/store";

// FilterData is a filter expression string following the `fexpr` package grammar.
//
// The filter string can also contain dbx placeholder parameters (eg. "title = {:name}"),
// that will be safely replaced and properly quoted inplace with the placeholderReplacements values.
//
// Example:
//
//	const filter: FilterData = "id = null || (name = 'test' && status = true) || (total >= {:min} && total <= {:max})"
//	const resolver = newSimpleFieldResolver("id", "name", "status")
//	const expr = filterBuildExpr(filter, resolver, { clock }, { min: 100, max: 200 })
export type FilterData = string;

// ParsedFilterCache holds previously parsed filter data expressions
// (upstream's package-level parsedFilterData store).
export class ParsedFilterCache {
  readonly store = new Store<string, ExprGroup[]>();
}

export interface FilterBuildOptions {
  // the clock the date macros (@now, @todayStart, ...) read
  clock: Clock;
  // an optional cache of parsed filters
  cache?: ParsedFilterCache | null;
}

// BuildExpr parses the current filter data and returns a new db WHERE expression.
//
// The filter string can also contain dbx placeholder parameters (eg. "title = {:name}"),
// that will be safely replaced and properly quoted inplace with the placeholderReplacements values.
//
// The parsed expressions are limited up to DefaultFilterExprLimit.
// Use [filterBuildExprWithLimit] if you want to set a custom limit.
export function filterBuildExpr(
  f: FilterData,
  fieldResolver: FieldResolver,
  options: FilterBuildOptions,
  ...placeholderReplacements: Params[]
): Expression {
  return filterBuildExprWithLimit(
    f,
    fieldResolver,
    DefaultFilterExprLimit,
    options,
    ...placeholderReplacements,
  );
}

// BuildExpr parses the current filter data and returns a new db WHERE expression.
//
// The filter string can also contain dbx placeholder parameters (eg. "title = {:name}"),
// that will be safely replaced and properly quoted inplace with the placeholderReplacements values.
export function filterBuildExprWithLimit(
  f: FilterData,
  fieldResolver: FieldResolver,
  maxExpressions: number,
  options: FilterBuildOptions,
  ...placeholderReplacements: Params[]
): Expression {
  let raw = f;

  // replace the placeholder params in the raw string filter
  if (placeholderReplacements.length > 0) {
    const replacements: [string, string][] = [];

    for (const p of placeholderReplacements) {
      for (const [key, value] of Object.entries(p)) {
        replacements.push(["{:" + key + "}", placeholderReplacement(key, value)]);
      }
    }

    raw = replaceAll(raw, replacements);
  }

  const cacheKey = raw + "/" + String(maxExpressions);
  const state: BuildState = { maxExpressions, clock: options.clock };

  const cache = options.cache ?? null;
  const [cached, ok] = cache?.store.getOk(cacheKey) ?? [undefined, false];
  if (ok) {
    return buildParsedFilterExpr(cached as ExprGroup[], fieldResolver, state);
  }

  // depending on the users demand we may allow empty expressions
  // (aka. expressions consisting only of whitespaces or comments)
  // but for now disallow them as it seems unnecessary
  const data = parse(raw);

  // store in cache
  // (the limit size is arbitrary and it is there to prevent the cache growing too big)
  cache?.store.setIfLessThanLimit(cacheKey, data, 500);

  return buildParsedFilterExpr(data, fieldResolver, state);
}

// one placeholder value as filter text: nil as null, booleans and numbers
// as cast.ToString gives them, anything else as a quoted string (cast's
// string or, if cast fails, the deterministic JSON)
function placeholderReplacement(key: string, value: unknown): string {
  switch (typeof value) {
    case "undefined":
      return "null";
    case "boolean":
    case "number":
    case "bigint":
      return toString(value);
  }
  if (value === null) {
    return "null";
  }

  let casted: string;
  if (value instanceof Date) {
    // time.Time is a fmt.Stringer (a Date is a UTC time.Time here)
    casted = timeString(value);
  } else {
    try {
      casted = toStringE(value);
    } catch {
      // try to json serialize as fallback
      try {
        casted = marshal(value);
      } catch (err) {
        throw new Error(
          `failed to serialize param ${goQuote(key)}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }
  }

  return goQuote(casted);
}

// time.Time.String() of a UTC time ("2006-01-02 15:04:05.999999999 -0700 MST")
function timeString(d: Date): string {
  const iso = d.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ (years 0..9999)
  const frac = iso.slice(20, 23).replace(/0+$/, "");
  return (
    iso.slice(0, 10) + " " + iso.slice(11, 19) + (frac === "" ? "" : "." + frac) + " +0000 UTC"
  );
}

// strings.NewReplacer(oldnew...).Replace(s): at each position the first
// pair (in argument order) whose old string matches is replaced, matches do
// not overlap, and text that matches nothing is copied.
function replaceAll(s: string, oldnew: readonly [string, string][]): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const match = oldnew.find(([old]) => old !== "" && s.startsWith(old, i));
    if (match !== undefined) {
      out += match[1];
      i += match[0].length;
      continue;
    }
    out += s[i] as string;
    i++;
  }
  return out;
}

interface BuildState {
  // the remaining expressions (upstream's *int)
  maxExpressions: number;
  clock: Clock;
}

function buildParsedFilterExpr(
  data: readonly ExprGroup[],
  fieldResolver: FieldResolver,
  state: BuildState,
): Expression {
  if (data.length === 0) {
    throw ErrEmpty;
  }

  const result = new ConcatExpr(" ");

  for (const group of data) {
    let expr: Expression;

    const item = group.item;
    if (Array.isArray(item)) {
      expr = buildParsedFilterExpr(item, fieldResolver, state);
    } else if ("op" in item) {
      if (state.maxExpressions <= 0) {
        throw ErrFilterExprLimit;
      }

      state.maxExpressions--;

      expr = resolveTokenizedExpr(item, fieldResolver, state);
    } else {
      expr = buildParsedFilterExpr([item], fieldResolver, state);
    }

    if (result.parts.length > 0) {
      let op: string;
      if (group.join === JoinOr) {
        op = "OR";
      } else {
        op = "AND";
      }
      result.parts.push(new OpExpr(op));
    }

    result.parts.push(expr);
  }

  return result;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolveTokenizedExpr(
  expr: Expr,
  fieldResolver: FieldResolver,
  state: BuildState,
): Expression {
  const [lResult, lErr] = tryResolveToken(expr.left, fieldResolver, state);
  if (lErr !== undefined || derefResult(lResult).identifier === "") {
    throw new Error(
      `invalid left operand ${goQuote(expr.left.literal)} - ${lErr === undefined ? "<nil>" : errorText(lErr)}`,
    );
  }

  const [rResult, rErr] = tryResolveToken(expr.right, fieldResolver, state);
  if (rErr !== undefined || derefResult(rResult).identifier === "") {
    throw new Error(
      `invalid right operand ${goQuote(expr.right.literal)} - ${rErr === undefined ? "<nil>" : errorText(rErr)}`,
    );
  }

  return buildResolversExpr(lResult as ResolverResult, expr.op, rResult as ResolverResult);
}

function tryResolveToken(
  token: Token,
  fieldResolver: FieldResolver,
  state: BuildState,
): [ResolverResult | null, unknown] {
  try {
    return [resolveToken(token, fieldResolver, state), undefined];
  } catch (err) {
    if (err instanceof NilPointerPanic) {
      throw err;
    }
    return [null, err];
  }
}

function paramsLen(params: Params | null | undefined): number {
  return params === null || params === undefined ? 0 : Object.keys(params).length;
}

function buildResolversExpr(left: ResolverResult, op: SignOp, right: ResolverResult): Expression {
  let expr: Expression | null = null;

  switch (op) {
    case SignEq:
    case SignAnyEq:
      expr = resolveEqualExpr(true, left, right);
      break;
    case SignNeq:
    case SignAnyNeq:
      expr = resolveEqualExpr(false, left, right);
      break;
    case SignLike:
    case SignAnyLike:
      // the right side is a column and therefor wrap it with "%" for contains like behavior
      if (paramsLen(right.params) === 0) {
        expr = newExp(
          `${left.identifier} LIKE ('%' || ${right.identifier} || '%') ESCAPE '\\'`,
          left.params ?? undefined,
        );
      } else {
        expr = newExp(
          `${left.identifier} LIKE ${right.identifier} ESCAPE '\\'`,
          mergeParams(left.params, wrapLikeParams(right.params)),
        );
      }
      break;
    case SignNlike:
    case SignAnyNlike:
      // the right side is a column and therefor wrap it with "%" for not-contains like behavior
      if (paramsLen(right.params) === 0) {
        expr = newExp(
          `${left.identifier} NOT LIKE ('%' || ${right.identifier} || '%') ESCAPE '\\'`,
          left.params ?? undefined,
        );
      } else {
        expr = newExp(
          `${left.identifier} NOT LIKE ${right.identifier} ESCAPE '\\'`,
          mergeParams(left.params, wrapLikeParams(right.params)),
        );
      }
      break;
    case SignLt:
    case SignAnyLt:
      expr = newExp(
        `${left.identifier} < ${right.identifier}`,
        mergeParams(left.params, right.params),
      );
      break;
    case SignLte:
    case SignAnyLte:
      expr = newExp(
        `${left.identifier} <= ${right.identifier}`,
        mergeParams(left.params, right.params),
      );
      break;
    case SignGt:
    case SignAnyGt:
      expr = newExp(
        `${left.identifier} > ${right.identifier}`,
        mergeParams(left.params, right.params),
      );
      break;
    case SignGte:
    case SignAnyGte:
      expr = newExp(
        `${left.identifier} >= ${right.identifier}`,
        mergeParams(left.params, right.params),
      );
      break;
  }

  if (expr === null) {
    throw new Error(`unknown expression operator ${goQuote(op)}`);
  }

  // multi-match expressions
  if (!isAnyMatchOp(op)) {
    const leftSubQuery = left.multiMatchSubQuery ?? null;
    const rightSubQuery = right.multiMatchSubQuery ?? null;
    if (leftSubQuery !== null && rightSubQuery !== null) {
      const mm = new ManyVsManyExpr(left, right, op);

      expr = enclose(and(expr, mm));
    } else if (leftSubQuery !== null) {
      const mm = new ManyVsOneExpr(right, leftSubQuery, op, false, left.nullFallback ?? 0);

      expr = enclose(and(expr, mm));
    } else if (rightSubQuery !== null) {
      const mm = new ManyVsOneExpr(left, rightSubQuery, op, true, right.nullFallback ?? 0);

      expr = enclose(and(expr, mm));
    }
  }

  if (left.afterBuild !== undefined && left.afterBuild !== null) {
    expr = left.afterBuild(expr);
  }

  if (right.afterBuild !== undefined && right.afterBuild !== null) {
    expr = right.afterBuild(expr);
  }

  return expr;
}

const normalizedIdentifiers: readonly [string, string][] = [
  // if `null` field is missing, treat `null` identifier as NULL token
  ["null", "NULL"],
  // if `true` field is missing, treat `true` identifier as TRUE token
  ["true", "1"],
  // if `false` field is missing, treat `false` identifier as FALSE token
  ["false", "0"],
];

// resolveToken returns null where upstream returns a nil result with a nil
// error (a resolver that resolved an identifier to "" without an error).
function resolveToken(
  token: Token,
  fieldResolver: FieldResolver,
  state: BuildState,
): ResolverResult | null {
  switch (token.type) {
    case TokenIdentifier: {
      // check for macros
      // ---
      const macroFunc = identifierMacros.get(token.literal);
      if (macroFunc !== undefined) {
        const placeholder = "t" + pseudorandomString(8);

        const macroValue = macroFunc(state.clock.now());

        return {
          identifier: "{:" + placeholder + "}",
          params: paramsOf(placeholder, macroValue),
        };
      }

      // custom resolver
      // ---
      let result: ResolverResult | null = null;
      let err: unknown;
      try {
        result = fieldResolver.resolve(token.literal);
      } catch (e) {
        err = e;
      }
      if (err !== undefined || result === null || result.identifier === "") {
        for (const [k, v] of normalizedIdentifiers) {
          if (equalFold(k, token.literal)) {
            return { identifier: v };
          }
        }
        if (err !== undefined) {
          throw err;
        }
        return null;
      }

      return result;
    }
    case TokenText: {
      const placeholder = "t" + pseudorandomString(8);

      return {
        identifier: "{:" + placeholder + "}",
        params: paramsOf(placeholder, token.literal),
      };
    }
    case TokenNumber: {
      const placeholder = "t" + pseudorandomString(8);

      return {
        identifier: "{:" + placeholder + "}",
        params: paramsOf(placeholder, toFloat64(token.literal)),
      };
    }
    case TokenFunction: {
      const fn = TokenFunctions.get(token.literal);
      if (fn === undefined) {
        throw new Error(`unknown function ${goQuote(token.literal)}`);
      }

      const args = token.meta ?? [];
      return fn((argToken) => resolveToken(argToken, fieldResolver, state), ...args);
    }
  }

  throw new Error(`unsupported token type ${goQuote(token.type)}`);
}

function paramsOf(key: string, value: unknown): Params {
  const params: Params = {};
  setOwn(params, key, value);
  return params;
}

// Resolves = and != expressions in an attempt to minimize the COALESCE
// usage and to gracefully handle null vs empty string normalizations.
//
// The expression `a = "" OR a is null` tends to perform better than
// `COALESCE(a, "") = ""` since the direct match can be accomplished
// with a seek while the COALESCE will induce a table scan.
function resolveEqualExpr(equal: boolean, left: ResolverResult, right: ResolverResult): Expression {
  let equalOp = "=";
  let nullEqualOp = "IS";
  let concatOp = "OR";
  let nullExpr = "IS NULL";
  if (!equal) {
    // always use `IS NOT` instead of `!=` because direct non-equal comparisons
    // to nullable column values that are actually NULL yields to NULL instead of TRUE, eg.:
    // `'example' != nullableColumn` -> NULL even if nullableColumn row value is NULL
    equalOp = "IS NOT";
    nullEqualOp = equalOp;
    concatOp = "AND";
    nullExpr = "IS NOT NULL";
  }

  const leftFallback = left.nullFallback ?? NullFallbackAuto;
  const rightFallback = right.nullFallback ?? NullFallbackAuto;

  // no coalesce fallback (eg. compare to a json field)
  // a IS b
  // a IS NOT b
  if (leftFallback === NullFallbackDisabled || rightFallback === NullFallbackDisabled) {
    return newExp(
      `${left.identifier} ${nullEqualOp} ${right.identifier}`,
      mergeParams(left.params, right.params),
    );
  }

  const isLeftEmpty =
    isEmptyIdentifier(left) ||
    (leftFallback === NullFallbackAuto && paramsLen(left.params) === 1 && hasEmptyParamValue(left));

  const isRightEmpty =
    isEmptyIdentifier(right) ||
    (rightFallback === NullFallbackAuto &&
      paramsLen(right.params) === 1 &&
      hasEmptyParamValue(right));

  // both operands are empty
  if (isLeftEmpty && isRightEmpty) {
    return newExp(`'' ${equalOp} ''`, mergeParams(left.params, right.params));
  }

  // direct compare since at least one of the operands is known to be non-empty
  // eg. a = 'example'
  if (isKnownNonEmptyIdentifier(left) || isKnownNonEmptyIdentifier(right)) {
    let leftIdentifier = left.identifier;
    if (isLeftEmpty) {
      leftIdentifier = "''";
    }
    let rightIdentifier = right.identifier;
    if (isRightEmpty) {
      rightIdentifier = "''";
    }
    return newExp(
      `${leftIdentifier} ${equalOp} ${rightIdentifier}`,
      mergeParams(left.params, right.params),
    );
  }

  // "" = b OR b IS NULL
  // "" IS NOT b AND b IS NOT NULL
  if (isLeftEmpty) {
    return newExp(
      `('' ${equalOp} ${right.identifier} ${concatOp} ${right.identifier} ${nullExpr})`,
      mergeParams(left.params, right.params),
    );
  }

  // a = "" OR a IS NULL
  // a IS NOT "" AND a IS NOT NULL
  if (isRightEmpty) {
    return newExp(
      `(${left.identifier} ${equalOp} '' ${concatOp} ${left.identifier} ${nullExpr})`,
      mergeParams(left.params, right.params),
    );
  }

  // fallback to a COALESCE comparison
  return newExp(
    `COALESCE(${left.identifier}, '') ${equalOp} COALESCE(${right.identifier}, '')`,
    mergeParams(left.params, right.params),
  );
}

function hasEmptyParamValue(result: ResolverResult): boolean {
  for (const p of Object.values(result.params ?? {})) {
    if (p === null || p === undefined || p === "") {
      return true;
    }
  }

  return false;
}

function isKnownNonEmptyIdentifier(result: ResolverResult): boolean {
  if (result.nullFallback === NullFallbackEnforced) {
    return false;
  }

  switch (toLower(result.identifier)) {
    case "1":
    case "0":
    case "false":
    case "true":
      return true;
  }

  return paramsLen(result.params) > 0 && !hasEmptyParamValue(result) && !isEmptyIdentifier(result);
}

function isEmptyIdentifier(result: ResolverResult): boolean {
  switch (toLower(result.identifier)) {
    case "":
    case "null":
    case "''":
    case '""':
    case "``":
      return true;
    default:
      return false;
  }
}

function isAnyMatchOp(op: SignOp): boolean {
  switch (op) {
    case SignAnyEq:
    case SignAnyNeq:
    case SignAnyLike:
    case SignAnyNlike:
    case SignAnyLt:
    case SignAnyLte:
    case SignAnyGt:
    case SignAnyGte:
      return true;
  }

  return false;
}

// mergeParams returns new dbx.Params where each provided params item
// is merged in the order they are specified.
export function mergeParams(...params: (Params | null | undefined)[]): Params {
  const result: Params = {};

  for (const p of params) {
    if (p !== null && p !== undefined) {
      assignOwn(result, p);
    }
  }

  return result;
}

// @todo consider adding support for custom single character wildcard
//
// wrapLikeParams wraps each provided param value string with `%`
// if the param doesn't contain an explicit wildcard (`%`) character already.
function wrapLikeParams(params: Params | null | undefined): Params {
  const result: Params = {};

  for (const [k, v] of Object.entries(params ?? {})) {
    let vStr = toString(v);
    if (!containsUnescapedChar(vStr, "%")) {
      // note: this is done to minimize the breaking changes and to preserve the original autoescape behavior
      vStr = escapeUnescapedChars(vStr, "\\", "%", "_");
      vStr = "%" + vStr + "%";
    }
    setOwn(result, k, vStr);
  }

  return result;
}

// []rune(str): the code points, with each invalid UTF-8 byte (a lone
// surrogate) as U+FFFD
function runes(str: string): string[] {
  return Array.from(str, (ch) => (ch.length === 1 && /[\ud800-\udfff]/.test(ch) ? "�" : ch));
}

function escapeUnescapedChars(str: string, ...escapeChars: string[]): string {
  const rs = runes(str);
  const total = rs.length;
  const result: string[] = [];

  let match = false;

  for (let i = total - 1; i >= 0; i--) {
    if (match) {
      // check if already escaped
      if (rs[i] !== "\\") {
        result.push("\\");
      }
      match = false;
    } else {
      for (const ec of escapeChars) {
        if (rs[i] === ec) {
          match = true;
          break;
        }
      }
    }

    result.push(rs[i] as string);

    // in case the matching char is at the beginning
    if (i === 0 && match) {
      result.push("\\");
    }
  }

  // reverse
  return result.toReversed().join("");
}

function containsUnescapedChar(str: string, ch: string): boolean {
  let prev = "";

  for (const c of runes(str)) {
    if (c === ch && prev !== "\\") {
      return true;
    }

    if (c === "\\" && prev === "\\") {
      prev = ""; // reset escape sequence
    } else {
      prev = c;
    }
  }

  return false;
}

// -------------------------------------------------------------------

// opExpr defines an expression that contains a raw sql operator string.
class OpExpr implements Expression {
  constructor(private readonly op: string) {}

  // Build converts the expression into a SQL fragment.
  //
  // Implements [dbx.Expression] interface.
  build(_db: DB, _params: Params): string {
    return this.op;
  }
}

// -------------------------------------------------------------------

// concatExpr defines an expression that concatenates multiple
// other expressions with a specified separator.
class ConcatExpr implements Expression {
  readonly parts: Expression[] = [];

  constructor(private readonly separator: string) {}

  // Build converts the expression into a SQL fragment.
  //
  // Implements [dbx.Expression] interface.
  build(db: DB, params: Params): string {
    if (this.parts.length === 0) {
      return "";
    }

    const stringParts: string[] = [];

    for (const p of this.parts) {
      const sql = p.build(db, params);
      if (sql !== "") {
        stringParts.push(sql);
      }
    }

    // skip extra parenthesis for single concat expression
    // (only ASCII letters upper-case to "AND" and "OR", in Go and in JS)
    if (
      stringParts.length === 1 &&
      // check for already concatenated raw/plain expressions
      !(stringParts[0] as string).toUpperCase().includes(" AND ") &&
      !(stringParts[0] as string).toUpperCase().includes(" OR ")
    ) {
      return stringParts[0] as string;
    }

    return "(" + stringParts.join(this.separator) + ")";
  }
}

// -------------------------------------------------------------------

// manyVsManyExpr constructs a multi-match many<->many db where expression.
//
// Expects leftSubQuery and rightSubQuery to return a subquery with a
// single "multiMatchValue" column.
class ManyVsManyExpr implements Expression {
  constructor(
    private readonly left: ResolverResult,
    private readonly right: ResolverResult,
    private readonly op: SignOp,
  ) {}

  // Build converts the expression into a SQL fragment.
  //
  // Implements [dbx.Expression] interface.
  build(db: DB, params: Params): string {
    const leftSubQuery = this.left.multiMatchSubQuery ?? null;
    const rightSubQuery = this.right.multiMatchSubQuery ?? null;
    if (leftSubQuery === null || rightSubQuery === null) {
      return "0=1";
    }

    const lAlias = "__ml" + pseudorandomString(8);
    const rAlias = "__mr" + pseudorandomString(8);

    let whereExpr: Expression;
    try {
      whereExpr = buildResolversExpr(
        {
          nullFallback: this.left.nullFallback ?? NullFallbackAuto,
          identifier: "[[" + lAlias + ".multiMatchValue]]",
        },
        this.op,
        {
          nullFallback: this.right.nullFallback ?? NullFallbackAuto,
          identifier: "[[" + rAlias + ".multiMatchValue]]",
          // note: the AfterBuild needs to be handled only once and it
          // doesn't matter whether it is applied on the left or right subquery operand
          afterBuild: not, // inverse for the not-exist expression
        },
      );
    } catch {
      return "0=1";
    }

    const lSQL = leftSubQuery.build(db, params);
    const rSQL = rightSubQuery.build(db, params);
    return `NOT EXISTS (SELECT 1 FROM (${lSQL}) {{${lAlias}}} LEFT JOIN (${rSQL}) {{${rAlias}}} WHERE ${whereExpr.build(db, params)})`;
  }
}

// -------------------------------------------------------------------

// manyVsOneExpr constructs a multi-match many<->one db where expression.
//
// Expects subQuery to return a subquery with a single "multiMatchValue" column.
//
// You can set inverse=false to reverse the condition sides (aka. one<->many).
class ManyVsOneExpr implements Expression {
  constructor(
    private readonly otherOperand: ResolverResult,
    private readonly subQuery: MultiMatchSubquery | null,
    private readonly op: SignOp,
    private readonly inverse: boolean,
    private readonly nullFallback: NullFallbackPreference,
  ) {}

  // Build converts the expression into a SQL fragment.
  //
  // Implements [dbx.Expression] interface.
  build(db: DB, params: Params): string {
    if (this.subQuery === null) {
      return "0=1";
    }

    const alias = "__sm" + pseudorandomString(8);

    const r1: ResolverResult = {
      nullFallback: this.nullFallback,
      identifier: "[[" + alias + ".multiMatchValue]]",
      afterBuild: not, // inverse for the not-exist expression
    };

    const r2: ResolverResult = {
      identifier: this.otherOperand.identifier,
      params: this.otherOperand.params ?? null,
    };

    let whereExpr: Expression;
    try {
      if (this.inverse) {
        whereExpr = buildResolversExpr(r2, this.op, r1);
      } else {
        whereExpr = buildResolversExpr(r1, this.op, r2);
      }
    } catch {
      return "0=1";
    }

    const subQuerySQL = this.subQuery.build(db, params);
    return `NOT EXISTS (SELECT 1 FROM (${subQuerySQL}) {{${alias}}} WHERE ${whereExpr.build(db, params)})`;
  }
}
