// Upstream: tools/list/list.go
//
// ExistInSliceWithRegex keeps upstream's cache of compiled patterns in a
// module-level store: it only holds patterns from the internal callers'
// constant lists (bounded at 500 entries as upstream), never request data.
//
// Go's `comparable` equality is === here (the callers use strings and
// numbers).

import { Store } from "@/tools/store/store";
import { toStringSlice } from "@/tools/types/cast";
import { GeoPoint } from "@/tools/types/geo-point";
import { isJSONMarshaler, stringType, unmarshalSlicePartial } from "@/tools/types/go-json";

const cachedPatterns = new Store<string, RegExp>();

// SubtractSlice returns a new array with only the base elements that don't
// exist in subtract.
export function subtractSlice<T>(base: readonly T[], subtract: readonly T[]): T[] {
  return base.filter((b) => !existInSlice(b, subtract));
}

// ExistInSlice checks whether an element exists in a list.
export function existInSlice<T>(item: T, list: readonly T[]): boolean {
  for (const v of list) {
    if (v === item) {
      return true;
    }
  }
  return false;
}

// ExistInSliceWithRegex checks whether str exists in list either by direct
// match or by a regular expression (eg. `^\w+$`). Only list items starting
// with '^' and ending with '$' are treated as regular expressions; an
// invalid one is skipped.
//
// The list comes from internal callers only, and its patterns are JS
// RegExp syntax (no flags) of upstream's Go RE2 patterns. The patterns
// upstream passes (`^\w+[\w\.\:]*$`, `^\@request\.body\.[\w\.\:]*\w+$` and
// the like) mean the same in both: \w is ASCII [0-9A-Za-z_] in both, and
// identity escapes such as \@ are valid without the u flag. Unlike RE2, a
// JS `.` does not match \r, \u2028 or \u2029; none of those patterns uses
// `.` unescaped.
export function existInSliceWithRegex(str: string, list: readonly string[]): boolean {
  for (const field of list) {
    const isRegex = field.startsWith("^") && field.endsWith("$");
    if (!isRegex) {
      // check for direct match
      if (str === field) {
        return true;
      }
      continue;
    }

    // check for regex match
    let pattern = cachedPatterns.get(field);
    if (pattern === undefined) {
      try {
        pattern = new RegExp(field);
      } catch {
        continue;
      }
      // the limit is arbitrary, to keep the cache from growing too big
      cachedPatterns.setIfLessThanLimit(field, pattern, 500);
    }

    if (pattern.test(str)) {
      return true;
    }
  }
  return false;
}

// ToInterfaceSlice converts a typed array to an array of unknown values (a
// shallow copy; JS needs no conversion).
export function toInterfaceSlice<T>(list: readonly T[]): unknown[] {
  return [...list];
}

type Comparable = string | number | boolean | bigint;

function isZero(v: Comparable): boolean {
  return v === "" || v === 0 || v === false || v === 0n;
}

// NonzeroUniques returns only the nonzero unique values from a list. The
// elements are one basic Go type (string, int, float64, bool); its zero
// value ("", 0, false) is dropped. NaN is never equal to itself, so every
// NaN is kept, as in Go.
export function nonzeroUniques<T extends Comparable>(list: readonly T[]): T[] {
  const result: T[] = [];
  const exist = new Set<T>();
  for (const val of list) {
    if (isZero(val)) {
      continue;
    }
    if (typeof val === "number" && Number.isNaN(val)) {
      result.push(val);
      continue;
    }
    if (exist.has(val)) {
      continue;
    }
    exist.add(val);
    result.push(val);
  }
  return result;
}

// ToUniqueStringSlice casts value to an array of non-zero unique strings:
// a string holding a JSON array of strings is decoded (any other string,
// or one whose decoding fails, is a single element), a JSON marshaler's
// output is decoded, anything else goes through cast.ToStringSlice.
//
// Upstream's JSONArray values take the json.Marshaler branch. Here a
// JSONArray is a plain array and takes the cast branch, which gives the
// same strings for the string elements callers store in them.
export function toUniqueStringSlice(value: unknown): string[] {
  let result: string[] = [];
  if (value === null || value === undefined) {
    // nothing to cast
  } else if (typeof value === "string") {
    if (value !== "") {
      // check if it is a json encoded array of strings
      if (value.includes("[")) {
        const [decoded, err] = unmarshalSlicePartial(value, stringType);
        result = (decoded as string[] | undefined) ?? [];
        if (err !== undefined) {
          // not a json array, just add the string as single array element
          result.push(value);
        }
      } else {
        result = [value];
      }
    }
  } else if (Array.isArray(value)) {
    result = toStringSlice(value);
  } else if (isJSONMarshaler(value) && !(value instanceof GeoPoint)) {
    // upstream's GeoPoint is not a json.Marshaler (its marshalJSON here is
    // only the encoding adapter), so it takes the cast branch below
    result =
      (unmarshalSlicePartial(value.marshalJSON(), stringType)[0] as string[] | undefined) ?? [];
  } else {
    result = toStringSlice(value);
  }
  return nonzeroUniques(result);
}

// ToChunks splits list into chunks of chunkSize (zero or negative is
// normalized to 1).
export function toChunks<T>(list: readonly T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) {
    chunkSize = 1;
  }
  const chunks: T[][] = [];
  for (let i = 0; i < list.length; i += chunkSize) {
    chunks.push(list.slice(i, i + chunkSize));
  }
  return chunks;
}
