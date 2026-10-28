// Upstream: tools/types/json_map.go
//
// Go's JSONMap[T] is a map type with methods; here it is a plain object
// (members set as own properties, so "__proto__" is an ordinary key) and
// the methods are functions. T is named at runtime by a GoType for Scan. A
// nil map is undefined. Get and Set exist upstream for the goja (JSVM)
// integration; they are kept for the ported tests and callers.

import {
  type GoType,
  anyType,
  bytesToText,
  marshal,
  setOwn,
  unmarshalMapInto,
} from "@/tools/types/go-json";

export type JSONMap<T> = Record<string, T>;

// Get retrieves a single value (undefined when missing).
export function jsonMapGet<T>(m: JSONMap<T> | undefined, key: string): T | undefined {
  return m !== undefined && Object.hasOwn(m, key) ? m[key] : undefined;
}

// Set sets a single value.
export function jsonMapSet<T>(m: JSONMap<T>, key: string, value: T): void {
  setOwn(m, key, value);
}

// MarshalJSON: json v2 with Deterministic (sorted keys) and
// AllowInvalidUTF8, forced to get the same output in mixed json v1 and v2
// configurations.
export function jsonMapMarshalJSON(m: JSONMap<unknown> | undefined): string {
  return marshal(m ?? {}, { allowInvalidUTF8: true });
}

// String returns the string representation of the map ("" when it cannot be
// marshaled).
export function jsonMapString(m: JSONMap<unknown> | undefined): string {
  try {
    return jsonMapMarshalJSON(m);
  } catch {
    return "";
  }
}

// Value implements the db driver Valuer.
export function jsonMapValue(m: JSONMap<unknown> | undefined): string {
  return jsonMapMarshalJSON(m);
}

// Scan decodes a string or bytes value (empty means "{}", nil is empty)
// into `into` (merged, as Go's json v2 does with an existing map) or into a
// new map, and returns it. Anything else, invalid JSON or a value that is
// not an elem fails. Go's streaming decoding has then already changed the
// map, so upstream resets it to empty: on a throw `into` is emptied in
// place (Go assigns a new empty map; no ported caller keeps another
// reference to the old one).
export function scanJSONMap<T = unknown>(
  value: unknown,
  elem: GoType = anyType,
  into: JSONMap<T> = {},
): JSONMap<T> {
  let data: string;
  if (value === null || value === undefined) {
    data = "";
  } else if (value instanceof Uint8Array || typeof value === "string") {
    data = bytesToText(value);
  } else {
    throw new Error(`failed to unmarshal JSONMap[T] value: ${JSON.stringify(String(value))}`);
  }
  if (data.length === 0) {
    data = "{}";
  }
  try {
    return (unmarshalMapInto(data, elem, into) as JSONMap<T> | undefined) ?? {};
  } catch (err) {
    for (const key of Object.keys(into)) {
      delete into[key];
    }
    throw err;
  }
}
