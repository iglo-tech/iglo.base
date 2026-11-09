// JSON value helpers for the schema file (D40). Not an upstream file.

import type { SchemaObject, SchemaValue } from "@/schema/types";

export function isPlainObject(value: unknown): value is SchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Deep equality of JSON values; key order does not matter.
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => jsonEqual(item, b[i]))
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
    );
  }
  return false;
}

// Object keys that JavaScript orders first, whatever the insertion order
// (integer-like names). Schema names never are: the reader refuses them.
export function isIntegerLike(name: string): boolean {
  return /^\d+$/.test(name);
}

// A copy of the object whose keys come first in the given order, then the
// others in code unit order. Only the keys that exist are written.
export function withKeyOrder(value: SchemaObject, preferred: readonly string[]): SchemaObject {
  const out: SchemaObject = {};
  for (const key of preferred) {
    if (Object.hasOwn(value, key)) {
      out[key] = value[key] as SchemaValue;
    }
  }
  for (const key of Object.keys(value).toSorted()) {
    if (!Object.hasOwn(out, key)) {
      out[key] = value[key] as SchemaValue;
    }
  }
  return out;
}
