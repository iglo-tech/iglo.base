// Upstream: tools/types/json_array.go
//
// Go's JSONArray[T] is a slice type with methods; here it is a plain array
// and the methods are functions. T is named at runtime by a GoType for Scan
// (anyType for JSONArray[any], stringType for JSONArray[string], ...). A
// nil slice is undefined.

import {
  type GoType,
  anyType,
  bytesToText,
  marshal,
  sliceOf,
  unmarshal,
} from "@/tools/types/go-json";

export type JSONArray<T> = T[];

// MarshalJSON: json v2 with Deterministic and AllowInvalidUTF8, forced to
// get the same output in mixed json v1 and v2 configurations.
export function jsonArrayMarshalJSON(m: readonly unknown[] | undefined): string {
  return marshal(m ?? [], { allowInvalidUTF8: true });
}

// String returns the string representation of the array ("" when it cannot
// be marshaled).
export function jsonArrayString(m: readonly unknown[] | undefined): string {
  try {
    return jsonArrayMarshalJSON(m);
  } catch {
    return "";
  }
}

// Value implements the db driver Valuer.
export function jsonArrayValue(m: readonly unknown[] | undefined): string {
  return jsonArrayMarshalJSON(m);
}

// Scan decodes a string or bytes value (empty means "[]", nil is empty) into
// a new array of elem. Anything else, invalid JSON or an element that is not
// an elem fails; Go then resets the array to empty, so on a throw the caller
// keeps an empty array.
export function scanJSONArray<T = unknown>(value: unknown, elem: GoType = anyType): JSONArray<T> {
  let data: string;
  if (value === null || value === undefined) {
    data = "";
  } else if (value instanceof Uint8Array || typeof value === "string") {
    data = bytesToText(value);
  } else {
    throw new Error(`failed to unmarshal JSONArray value: ${JSON.stringify(String(value))}`);
  }
  if (data.length === 0) {
    data = "[]";
  }
  return (unmarshal(data, sliceOf(elem)) as T[] | undefined) ?? [];
}
