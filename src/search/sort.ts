// Upstream: tools/search/sort.go
//
// SortField.BuildExpr is sortFieldBuildExpr.

import { equalFold, trimSpace } from "@/collections/go-strings";
import { goQuote } from "@/fields/field";
import type { FieldResolver, ResolverResult } from "@/search/simple-field-resolver";

export const randomSortKey = "@random";
export const rowidSortKey = "@rowid";

// sort field directions
export const SortAsc = "ASC";
export const SortDesc = "DESC";

// SortField defines a single search sort field.
export interface SortField {
  name: string;
  direction: string;
}

// BuildExpr resolves the sort field into a valid db sort expression.
export function sortFieldBuildExpr(s: SortField, fieldResolver: FieldResolver): string {
  // special case for random sort
  if (s.name === randomSortKey) {
    return "RANDOM()";
  }

  // special case for the builtin SQLite rowid column
  if (s.name === rowidSortKey) {
    return `[[_rowid_]] ${s.direction}`;
  }

  let result: ResolverResult | undefined;
  try {
    result = fieldResolver.resolve(s.name);
  } catch {
    result = undefined;
  }

  // invalidate empty fields and non-column identifiers
  if (
    result === undefined ||
    Object.keys(result.params ?? {}).length > 0 ||
    result.identifier === "" ||
    equalFold(result.identifier, "null")
  ) {
    throw new Error(`invalid sort field ${goQuote(s.name)}`);
  }

  return `${result.identifier} ${s.direction}`;
}

// ParseSortFromString parses the provided string expression
// into a slice of SortFields.
//
// Example:
//
//	const fields = parseSortFromString("-name,+created")
export function parseSortFromString(str: string): SortField[] {
  const fields: SortField[] = [];

  for (let field of str.split(",")) {
    // trim whitespaces
    field = trimSpace(field);
    if (field.startsWith("-")) {
      fields.push({ name: field.slice(1), direction: SortDesc });
    } else {
      fields.push({ name: field.startsWith("+") ? field.slice(1) : field, direction: SortAsc });
    }
  }

  return fields;
}
