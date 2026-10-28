// Upstream: github.com/spf13/cast v1.10.0, the parts the record getters
// use: number.go (ToInt64E and ToIntE through toNumberE, parseInt,
// trimDecimal) and map.go (ToStringMapE through toMapE).
//
// Go's static types become JS runtime types as in src/tools/types/cast.ts:
// number is float64, bigint is a Go integer, a plain object or a Map is a
// map[string]any. Go's int is int64 on the 64-bit platforms upstream ships
// for, so ToInt and ToInt64 are the same here. The results are GoInt (a
// number inside the safe integer range, the exact bigint outside it).
//
// These belong next to ToFloat64E in src/tools/types/cast.ts; they are
// kept here because that module belongs to another task.

import { type GoInt, anyType, goInt, mapOf, unmarshal } from "@/tools/types/go-json";

const two63 = 2 ** 63;

// float64 → int64 as the upstream binary for this CPU converts it (see
// src/fields/number.ts): in-range values are truncated; on amd64 NaN and
// out-of-range values give -2^63, on arm64 they saturate and NaN gives 0.
const saturatingConversion = process.arch === "arm64";

function int64OfFloat64(v: number): bigint {
  if (v >= -two63 && v < two63) {
    return BigInt(Math.trunc(v));
  }
  if (!saturatingConversion) {
    return -(2n ** 63n);
  }
  if (Number.isNaN(v)) {
    return 0n;
  }
  return v > 0 ? 2n ** 63n - 1n : -(2n ** 63n);
}

// trimDecimal: a decimal number's integer part ("123.5" -> "123",
// "-.5" -> "-0"); other strings as they are
function trimDecimal(s: string): string {
  if (!s.includes(".")) {
    return s;
  }
  const m = /^([-+]?\d*)(\.\d*)?$/.exec(s);
  if (m === null) {
    return s;
  }
  let int = m[1] as string;
  switch (int) {
    case "-":
    case "+":
      int += "0";
      break;
    case "":
      int = "0";
      break;
  }
  return int;
}

// strconv.ParseInt(s, 0, 64); null on a syntax or range error
function parseInt64(s: string): bigint | null {
  let body = s;
  let negative = false;
  if (body.startsWith("+") || body.startsWith("-")) {
    negative = body[0] === "-";
    body = body.slice(1);
  }
  // base prefix, underscores only between digits or after the prefix
  const m =
    /^(?:0[xX]((?:_?[0-9a-fA-F])+)|0[oO]((?:_?[0-7])+)|0[bB]((?:_?[01])+)|(0(?:_?[0-7])*)|([1-9](?:_?[0-9])*))$/.exec(
      body,
    );
  if (m === null) {
    return null;
  }
  const [, hex, oct, bin, legacyOct, dec] = m;
  let value: bigint;
  if (hex !== undefined) {
    value = BigInt(`0x${hex.replaceAll("_", "")}`);
  } else if (oct !== undefined) {
    value = BigInt(`0o${oct.replaceAll("_", "")}`);
  } else if (bin !== undefined) {
    value = BigInt(`0b${bin.replaceAll("_", "")}`);
  } else if (legacyOct !== undefined) {
    value = BigInt(`0o${legacyOct.replaceAll("_", "") || "0"}`);
  } else {
    value = BigInt((dec as string).replaceAll("_", ""));
  }
  const signed = negative ? -value : value;
  if (signed > 2n ** 63n - 1n || signed < -(2n ** 63n)) {
    return null;
  }
  return signed;
}

// ToInt64 (ToInt64E without the error: 0 instead). Go integers wrap to
// int64, floats are truncated, booleans are 1 or 0, nil is 0, strings are
// parsed with trimDecimal and strconv.ParseInt (base prefixes allowed);
// anything else is 0.
export function toInt64(i: unknown): GoInt {
  switch (typeof i) {
    case "bigint":
      return goInt(BigInt.asIntN(64, i));
    case "number":
      return goInt(int64OfFloat64(i));
    case "boolean":
      return i ? 1 : 0;
    case "undefined":
      return 0;
    case "string": {
      if (i === "") {
        return 0;
      }
      const v = parseInt64(trimDecimal(i));
      return v === null ? 0 : goInt(v);
    }
  }
  return 0;
}

// ToInt: ToInt64 (Go's int is 64 bits wide)
export function toInt(i: unknown): GoInt {
  return toInt64(i);
}

// a Go map[string]any: a plain object or a Map with string keys
function isGoMap(i: unknown): i is { [key: string]: unknown } | Map<string, unknown> {
  if (i instanceof Map) {
    return true;
  }
  if (typeof i !== "object" || i === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(i) as unknown;
  return proto === Object.prototype || proto === null;
}

// ToStringMap (ToStringMapE without the error): a shallow copy of a
// map[string]any, a JSON object string decoded with encoding/json (v1),
// anything else (or a failed decoding) an empty map.
export function toStringMap(i: unknown): Map<string, unknown> {
  if (isGoMap(i)) {
    return new Map(i instanceof Map ? i : Object.entries(i));
  }
  if (typeof i === "string") {
    try {
      const decoded = unmarshal(i, mapOf(anyType), { legacy: true });
      if (typeof decoded === "object" && decoded !== null) {
        return new Map(Object.entries(decoded));
      }
    } catch {
      // the error is ignored by ToStringMap
    }
  }
  return new Map();
}
