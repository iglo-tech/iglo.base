// Upstream: tools/search/token_functions.go
//
// Upstream's TokenFunctions is an exported, writable map; here it is a
// read-only map (no extension surface, AGENTS.md).

import { type Params, setOwn } from "@/db/dbx/query";
import {
  type Token,
  TokenIdentifier,
  TokenNumber,
  TokenText,
  type TokenType,
} from "@/search/fexpr/scanner";
import { mergeParams } from "@/search/filter";
import {
  derefResult,
  NilPointerPanic,
  NullFallbackDisabled,
  NullFallbackEnforced,
  type ResolverResult,
} from "@/search/simple-field-resolver";

// the resolver of a function argument token; null is Go's nil result with
// a nil error
export type ArgTokenResolverFunc = (token: Token) => ResolverResult | null;

export type TokenFunction = (
  argTokenResolverFunc: ArgTokenResolverFunc,
  ...args: Token[]
) => ResolverResult;

// a resolver call whose error is wrapped with the given message prefix
// (fmt.Errorf("...: %w", err))
function resolveArg(
  argTokenResolverFunc: ArgTokenResolverFunc,
  arg: Token,
  message: string,
): ResolverResult | null {
  try {
    return argTokenResolverFunc(arg);
  } catch (err) {
    if (err instanceof NilPointerPanic) {
      throw err;
    }
    throw new Error(`${message}: ${errorText(err)}`, { cause: err });
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const TokenFunctions: ReadonlyMap<string, TokenFunction> = new Map<string, TokenFunction>([
  // geoDistance(lonA, latA, lonB, latB) calculates the Haversine
  // distance between 2 points in kilometres (https://www.movable-type.co.uk/scripts/latlong.html).
  //
  // The accepted arguments at the moment could be either a plain number or a column identifier (including NULL).
  // If the column identifier cannot be resolved and converted to a numeric value, it resolves to NULL.
  //
  // Similar to the built-in SQLite functions, geoDistance doesn't apply
  // a "match-all" constraints in case there are multiple relation fields arguments.
  // Or in other words, if a collection has "orgs" multiple relation field pointing to "orgs" collection that has "office" as "geoPoint" field,
  // then the filter: `geoDistance(orgs.office.lon, orgs.office.lat, 1, 2) < 200`
  // will evaluate to true if for at-least-one of the "orgs.office" records the function result in a value satisfying the condition (aka. "result < 200").
  [
    "geoDistance",
    (argTokenResolverFunc, ...args) => {
      if (args.length !== 4) {
        throw new Error(`[geoDistance] expected 4 arguments, got ${args.length}`);
      }

      const resolvedArgs: (ResolverResult | null)[] = [];
      for (const [i, arg] of args.entries()) {
        if (arg.type !== TokenIdentifier && arg.type !== TokenNumber) {
          throw new Error(`[geoDistance] argument ${i} must be an identifier or number`);
        }
        resolvedArgs.push(
          resolveArg(argTokenResolverFunc, arg, `[geoDistance] failed to resolve argument ${i}`),
        );
      }

      const [a0, a1, a2, a3] = resolvedArgs.map(derefResult) as [
        ResolverResult,
        ResolverResult,
        ResolverResult,
        ResolverResult,
      ];
      const lonA = a0.identifier;
      const latA = a1.identifier;
      const lonB = a2.identifier;
      const latB = a3.identifier;

      return {
        nullFallback: NullFallbackDisabled,
        // the clamping is to prevent floating point rounding errors for values like
        // "1.0002" that could occur for example when comparing identical points
        // (see the NULL note for arccosine in https://sqlite.org/lang_mathfunc.html#overview)
        identifier: `(6371 * acos(min(1, max(-1, cos(radians(${latA})) * cos(radians(${latB})) * cos(radians(${lonB}) - radians(${lonA})) + sin(radians(${latA})) * sin(radians(${latB}))))))`,
        params: mergeParams(a0.params, a1.params, a2.params, a3.params),
      };
    },
  ],

  // strftime(format, [timeValue, modifier1, modifier2, ...]) returns
  // a date string formatted according to the specified format argument.
  //
  // It is similar to the builtin SQLite strftime function (https://sqlite.org/lang_datefunc.html)
  // with the main difference that NULL results will be normalized for
  // consistency with the non-nullable PocketBase "text" and "date" fields.
  //
  // The function accepts 1, 2 or 3+ arguments.
  //
  // (1) The first (format) argument must be always a formatting string
  // with valid substitutions as listed in https://sqlite.org/lang_datefunc.html.
  //
  // (2) The second (time-value) argument is optional and must be either a date string, number or collection field identifier
  // that matches one of the formats listed in https://sqlite.org/lang_datefunc.html#time_values.
  //
  // (3+) The remaining (modifiers) optional arguments are expected to be
  // string literals matching the listed modifiers in https://sqlite.org/lang_datefunc.html#modifiers.
  //
  // A multi-match constraint will be also applied in case the time-value
  // is an identifier as a result of a multi-value relation field.
  [
    "strftime",
    (argTokenResolverFunc, ...args) => {
      const totalArgs = args.length;

      if (totalArgs < 1) {
        throw new Error(`[strftime] expected at least 1 arguments, got ${args.length}`);
      }

      // limit the number of arguments to prevent abuse
      if (totalArgs > 10) {
        throw new Error(`[strftime] too many arguments (max allowed 10, got ${totalArgs})`);
      }

      // format arg
      // -----------------------------------------------------------
      const formatArg = args[0] as Token;
      if (formatArg.type !== TokenText) {
        throw new Error("[strftime] expects the first argument to be a format string");
      }

      const formatArgResult = derefResult(
        resolveArg(argTokenResolverFunc, formatArg, "[strftime] failed to resolve format argument"),
      );

      // no further arguments
      if (totalArgs === 1) {
        formatArgResult.nullFallback = NullFallbackEnforced;
        formatArgResult.identifier = "strftime(" + formatArgResult.identifier + ")";
        return formatArgResult;
      }

      // time-value arg
      // -----------------------------------------------------------
      const allowedTimeValueTokens: TokenType[] = [TokenText, TokenIdentifier, TokenNumber];
      const timeValueArg = args[1] as Token;
      if (!allowedTimeValueTokens.includes(timeValueArg.type)) {
        throw new Error("[strftime] expects the second argument to be of a valid time-value type");
      }

      const timeValueArgResult = resolveArg(
        argTokenResolverFunc,
        timeValueArg,
        "[strftime] failed to resolve time-value argument",
      );

      // modifiers args
      // -----------------------------------------------------------
      const resolvedModifierArgs: (ResolverResult | null)[] = [];
      for (const [i, arg] of args.slice(2).entries()) {
        if (arg.type !== TokenText) {
          throw new Error(`[strftime] invalid modifier argument ${i} - can be only string`);
        }

        resolvedModifierArgs.push(
          resolveArg(
            argTokenResolverFunc,
            arg,
            `[strftime] failed to resolve modifier argument ${i}`,
          ),
        );
      }

      // generating new ResolverResult
      // -----------------------------------------------------------
      const result: ResolverResult = {
        identifier: "",
        nullFallback: NullFallbackEnforced,
        params: {},
      };
      const resultParams = result.params as Params;

      const identifiers: string[] = [];

      identifiers.push(formatArgResult.identifier);
      concatUniqueParams(resultParams, formatArgResult.params);

      const timeValue = derefResult(timeValueArgResult);
      identifiers.push(timeValue.identifier);
      concatUniqueParams(resultParams, timeValue.params);

      for (const m of resolvedModifierArgs) {
        const modifier = derefResult(m);
        identifiers.push(modifier.identifier);
        concatUniqueParams(resultParams, modifier.params);
      }

      result.identifier = "strftime(" + identifiers.join(",") + ")";

      const subQuery = timeValue.multiMatchSubQuery;
      if (subQuery !== undefined && subQuery !== null) {
        // replace the regular time-value identifier with the multi-match one
        identifiers[1] = subQuery.valueIdentifier;
        result.multiMatchSubQuery = subQuery;
        subQuery.valueIdentifier = "strftime(" + identifiers.join(",") + ")";

        concatUniqueParams(subQuery.params, resultParams);
      }

      return result;
    },
  ],
]);

function concatUniqueParams(destParams: Params, newParams: Params | null | undefined): void {
  for (const [k, v] of Object.entries(newParams ?? {})) {
    if (Object.hasOwn(destParams, k) && v !== destParams[k]) {
      throw new Error(`conflicting param key ${k}`);
    }

    setOwn(destParams, k, v);
  }
}
