// Upstream: tools/search/simple_field_resolver.go

import type { Expression } from "@/db/dbx/expression";
import type { Params } from "@/db/dbx/query";
import type { SelectQuery } from "@/db/dbx/select";
import type { MultiMatchSubquery } from "@/search/multi-match-subquery";
import { columnify } from "@/tools/inflector/inflector";
import { existInSliceWithRegex } from "@/tools/list/list";
import { goQuote } from "@/fields/field";

export type NullFallbackPreference = 0 | 1 | 2;

export const NullFallbackAuto: NullFallbackPreference = 0;
export const NullFallbackDisabled: NullFallbackPreference = 1;
export const NullFallbackEnforced: NullFallbackPreference = 2;

// ResolverResult defines a single FieldResolver.Resolve() successfully parsed result.
//
// The optional members are Go's zero values when left out.
export interface ResolverResult {
  // Identifier is the plain SQL identifier/column that will be used
  // in the final db expression as left or right operand.
  identifier: string;

  // NullFallback specify the preference for how NULL or empty values
  // should be resolved (default to "auto").
  //
  // Set to NullFallbackDisabled to prevent any COALESCE or NULL fallbacks.
  // Set to NullFallbackEnforced to prefer COALESCE or NULL fallbacks when needed.
  nullFallback?: NullFallbackPreference;

  // Params is a map with db placeholder->value pairs that will be added
  // to the query when building both resolved operands/sides in a single expression.
  params?: Params | null;

  // MultiMatchSubQuery is an optional sub query expression that will be added
  // in addition to the combined ResolverResult expression during build.
  multiMatchSubQuery?: MultiMatchSubquery | null;

  // AfterBuild is an optional function that will be called after building
  // and combining the result of both resolved operands/sides in a single expression.
  afterBuild?: ((expr: Expression) => Expression) | null;
}

// NilPointerPanic is Go's runtime panic for a nil pointer dereference. It
// is not an error result: callers that turn errors into other errors let it
// pass, as a Go panic passes through them.
export class NilPointerPanic extends TypeError {
  constructor() {
    super("runtime error: invalid memory address or nil pointer dereference");
    this.name = "NilPointerPanic";
  }
}

// derefResult reads a *ResolverResult that may be nil: Go panics where
// upstream reads a field of a nil result (a resolver that returned no
// result and no error).
export function derefResult(result: ResolverResult | null): ResolverResult {
  if (result === null) {
    throw new NilPointerPanic();
  }
  return result;
}

// FieldResolver defines an interface for managing search fields.
//
// Go's error results are thrown.
export interface FieldResolver {
  // UpdateQuery allows to updated the provided db query based on the
  // resolved search fields (eg. adding joins aliases, etc.).
  //
  // Called internally by `search.Provider` before executing the search request.
  updateQuery(query: SelectQuery): void;

  // Resolve parses the provided field and returns a properly
  // formatted db identifier (eg. NULL, quoted column, placeholder parameter, etc.).
  resolve(field: string): ResolverResult;
}

// NewSimpleFieldResolver creates a new `SimpleFieldResolver` with the
// provided `allowedFields`.
//
// Each `allowedFields` could be a plain string (eg. "name")
// or a regexp pattern (eg. `^\w+[\w\.]*$`).
export function newSimpleFieldResolver(...allowedFields: string[]): SimpleFieldResolver {
  return new SimpleFieldResolver(allowedFields);
}

// SimpleFieldResolver defines a generic search resolver that allows
// only its listed fields to be resolved and take part in a search query.
//
// If `allowedFields` are empty no fields filtering is applied.
export class SimpleFieldResolver implements FieldResolver {
  constructor(private readonly allowedFields: readonly string[]) {}

  // UpdateQuery implements `search.UpdateQuery` interface.
  updateQuery(_query: SelectQuery | null): void {
    // nothing to update...
  }

  // Resolve implements `search.Resolve` interface.
  //
  // Returns error if `field` is not in `r.allowedFields`.
  resolve(field: string): ResolverResult {
    if (!existInSliceWithRegex(field, this.allowedFields)) {
      throw new Error(`failed to resolve field ${goQuote(field)}`);
    }

    const parts = field.split(".");

    // single regular field
    if (parts.length === 1) {
      return {
        identifier: "[[" + columnify(parts[0] as string) + "]]",
      };
    }

    // treat as json path
    let jsonPath = "$";
    for (const part of parts.slice(1)) {
      if (isAtoi(part)) {
        jsonPath += "[" + columnify(part) + "]";
      } else {
        jsonPath += "." + columnify(part);
      }
    }

    return {
      nullFallback: NullFallbackDisabled,
      identifier: `JSON_EXTRACT([[${columnify(parts[0] as string)}]], '${jsonPath}')`,
    };
  }
}

// whether strconv.Atoi accepts s: an optional sign and decimal digits
// within the int64 range
function isAtoi(s: string): boolean {
  if (!/^[+-]?[0-9]+$/.test(s)) {
    return false;
  }
  const n = BigInt(s);
  return n >= -(2n ** 63n) && n < 2n ** 63n;
}
