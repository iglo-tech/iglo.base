// Upstream: ozzo-validation v4.4.1 util.go
//
// Go's reflect kinds are JS types here:
//   - nil (a nil pointer, interface, slice or map) is null or undefined;
//     rules that tell a typed nil from Go's untyped nil (Each, Map) treat
//     it as a typed nil slice or map, the values upstream passes;
//   - string is a JS string, []byte a Uint8Array;
//   - Go integers are integral numbers and bigints; float64 is a
//     non-integral number or a Float64 (see error.ts), and ToFloat takes
//     any number;
//   - slices and arrays are JS arrays, maps are plain objects (Go's
//     map[string]any) or Maps;
//   - any other object (a class instance) is a struct;
//   - DateTime stands for both types.DateTime and time.Time: Indirect keeps
//     it, IsEmpty is true for the zero DateTime (as for a zero time.Time and
//     for types.DateTime, whose driver.Valuer value is then ""), and
//     EnsureString gives its String() (types.DateTime's Valuer value).
//   - JSONRaw and GeoPoint are driver.Valuer values, as in Go: Indirect
//     replaces them with their Value() (nil for an empty JSONRaw).
//     types.JSONArray and types.JSONMap have no TS type of their own (they
//     are arrays and plain objects), so a non-nil empty one is empty here,
//     while Go's Indirect would see its Value() "[]" or "{}".

import { Float64 } from "@/validation/error";
import { DateTime } from "@/tools/types/datetime";
import { GeoPoint } from "@/tools/types/geo-point";
import { bytesToText } from "@/tools/types/go-json";
import { JSONRaw } from "@/tools/types/json-raw";

// EnsureString ensures the given value is a string. If the value is a byte
// slice, it will be typecast into a string. An error is returned otherwise.
export function EnsureString(value: unknown): [string, Error | null] {
  if (typeof value === "string") {
    return [value, null];
  }
  if (value instanceof Uint8Array) {
    return [bytesToText(value), null];
  }
  if (value instanceof DateTime) {
    return [value.string(), null];
  }
  return ["", new Error("must be either a string or byte slice")];
}

// StringOrBytes typecasts a value into a string or byte slice. Boolean
// flags are returned to indicate if the typecasting succeeds or not.
export function StringOrBytes(
  value: unknown,
): [isString: boolean, str: string, isBytes: boolean, bs: Uint8Array | null] {
  if (typeof value === "string") {
    return [true, value, false, null];
  }
  if (value instanceof Uint8Array) {
    return [false, "", true, value];
  }
  return [false, "", false, null];
}

// LengthOfValue returns the length of a value that is a string, slice, map,
// or array. An error is returned for all other types. The length of a
// string is the length of its UTF-8 bytes, as Go's len.
export function LengthOfValue(value: unknown): [number, Error | null] {
  if (typeof value === "string") {
    return [byteLength(value), null];
  }
  if (value instanceof Uint8Array || Array.isArray(value)) {
    return [value.length, null];
  }
  if (value instanceof Map) {
    return [value.size, null];
  }
  if (isMap(value)) {
    return [Object.keys(value).length, null];
  }
  return [0, new Error(`cannot get the length of ${kindOf(value)}`)];
}

// ToInt converts the given value to an int64. An error is returned for all
// incompatible types.
export function ToInt(value: unknown): [bigint, Error | null] {
  if (typeof value === "bigint") {
    return [value, null];
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return [BigInt(value), null];
  }
  return [0n, new Error(`cannot convert ${kindOf(value)} to int64`)];
}

// ToUint converts the given value to an uint64. JS has no unsigned type:
// a non-negative integer converts.
export function ToUint(value: unknown): [bigint, Error | null] {
  const [n, err] = ToInt(value);
  if (err === null && n >= 0n) {
    return [n, null];
  }
  return [0n, new Error(`cannot convert ${kindOf(value)} to uint64`)];
}

// ToFloat converts the given value to a float64. An error is returned for
// all incompatible types. Any JS number converts (a Float64 threshold says
// the value is a float64).
export function ToFloat(value: unknown): [number, Error | null] {
  if (value instanceof Float64) {
    return [value.value, null];
  }
  if (typeof value === "number") {
    return [value, null];
  }
  return [0, new Error(`cannot convert ${kindOf(value)} to float64`)];
}

// IsEmpty checks if a value is empty or not.
// A value is considered empty if
// - integer, float: zero
// - bool: false
// - string, array: len() == 0
// - slice, map: nil or len() == 0
// - interface, pointer: nil or the referenced value is empty
export function IsEmpty(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  switch (typeof value) {
    case "string":
      return value.length === 0;
    case "boolean":
      return !value;
    case "number":
      return value === 0;
    case "bigint":
      return value === 0n;
    default:
      break;
  }
  if (value instanceof Float64) {
    return value.value === 0;
  }
  if (value instanceof Uint8Array || Array.isArray(value)) {
    return value.length === 0;
  }
  if (value instanceof Map) {
    return value.size === 0;
  }
  if (value instanceof DateTime) {
    return value.isZero();
  }
  if (value instanceof JSONRaw) {
    return value.bytes().length === 0;
  }
  if (isMap(value)) {
    return Object.keys(value).length === 0;
  }
  return false;
}

// Indirect returns the value that the given interface or pointer references
// to. If the value implements driver.Valuer, it will deal with the value
// returned by the Value() method instead. A boolean value is also returned
// to indicate if the value is nil or not (only applicable to interface,
// pointer, map, and slice). If the value is neither an interface nor a
// pointer, it will be returned back.
export function Indirect(value: unknown): [unknown, boolean] {
  if (value === null || value === undefined) {
    return [null, true];
  }
  if (value instanceof JSONRaw) {
    return value.bytes().length === 0 ? [null, true] : Indirect(value.string());
  }
  if (value instanceof GeoPoint) {
    return Indirect(value.value());
  }
  return [value, false];
}

// a plain object: a Go map
export function isMap(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

// the Go reflect.Kind name of a value, for error messages
export function kindOf(value: unknown): string {
  if (value === null || value === undefined) {
    return "invalid";
  }
  switch (typeof value) {
    case "string":
      return "string";
    case "boolean":
      return "bool";
    case "number":
      return Number.isInteger(value) ? "int" : "float64";
    case "bigint":
      return "int64";
    case "function":
      return "func";
    default:
      break;
  }
  if (value instanceof Float64) {
    return "float64";
  }
  if (value instanceof Uint8Array || Array.isArray(value)) {
    return "slice";
  }
  if (value instanceof Map || isMap(value)) {
    return "map";
  }
  return "struct";
}

// len of the UTF-8 bytes of s (a lone surrogate U+DC80..U+DCFF is one
// invalid byte, see bytesToText in src/tools/types/go-json.ts; any other
// lone surrogate is U+FFFD, three bytes)
export function byteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      n += 1;
    } else if (c < 0x800) {
      n += 2;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else {
        n += 3;
      }
    } else if (c >= 0xdc80 && c <= 0xdcff) {
      n += 1;
    } else {
      n += 3;
    }
  }
  return n;
}

// utf8.RuneCountInString: code points, an invalid byte (lone surrogate)
// counting as one
export function runeCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
      }
    }
    n++;
  }
  return n;
}
