// Upstream: encoding/json (v2) Unmarshal into the anonymous structs of
// tools/auth/*.go, and the rawUser map (`map[string]any`) each provider keeps
//
// A member the struct names with the wrong JSON type is an error (every
// error is fatal in json v2); a null is the zero value; a member the struct
// does not name is ignored. A nested struct is an `any` member, read with
// decodeNested, and a nested array of structs with decodeNestedList.
//
// rawUser keeps the document as upstream decodes it: go-json's `any`
// values, marshaled back in upstream's form (AuthUser.toMeta).

import {
  type GoInt,
  type GoType,
  anyType,
  mapOf,
  unmarshal,
  unmarshalStruct,
} from "@/tools/types/go-json";

type Fields<T> = { [K in keyof T]-?: GoType };

// the zero value of a Go type, as the struct starts with
function zeroOf(t: GoType): unknown {
  switch (t.kind) {
    case "string":
      return "";
    case "bool":
      return false;
    case "int":
    case "int64":
    case "float64":
      return 0;
    default:
      return undefined;
  }
}

function zeros<T>(fields: Fields<T>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(fields)) {
    out[name] = zeroOf(fields[name as keyof T]);
  }
  return out;
}

// json.Unmarshal of data into a new map[string]any: a null leaves the nil map
export function decodeRawUser(data: Uint8Array): { [key: string]: unknown } | null {
  return (unmarshal(data, mapOf(anyType)) as { [key: string]: unknown } | undefined) ?? null;
}

// json.Unmarshal of data into the Go struct T (fields by JSON name)
export function decodeFields<T>(data: Uint8Array, fields: Fields<T>): T {
  const out = zeros(fields);
  const setters: Record<string, (value: unknown) => void> = {};
  for (const name of Object.keys(fields)) {
    setters[name] = (value) => {
      out[name] = value;
    };
  }
  unmarshalStruct(data, setters, fields as Record<string, GoType>, () => {});
  return out as T;
}

// one JSON value of a Go type, as a member of a nested struct already
// decoded as `any`
function valueOf(value: unknown, t: GoType): unknown {
  switch (t.kind) {
    case "any":
      return value;
    case "string":
      if (value === null || value === undefined) {
        return "";
      }
      if (typeof value !== "string") {
        throw new Error("json: cannot unmarshal into Go struct field of type string");
      }
      return value;
    case "bool":
      if (value === null || value === undefined) {
        return false;
      }
      if (typeof value !== "boolean") {
        throw new Error("json: cannot unmarshal into Go struct field of type bool");
      }
      return value;
    case "int":
    case "int64":
    case "float64":
      if (value === null || value === undefined) {
        return 0;
      }
      if (typeof value !== "number") {
        throw new Error("json: cannot unmarshal into Go struct field of a number type");
      }
      return value as GoInt;
    default:
      throw new Error("json: unsupported nested member type");
  }
}

// a nested struct: the JSON object decoded as `any`, null for the zero value
export function decodeNested<T>(value: unknown, fields: Fields<T>): T {
  const out = zeros(fields);
  if (value === null || value === undefined) {
    return out as T;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("json: cannot unmarshal into Go struct");
  }
  const members = value as Record<string, unknown>;
  for (const name of Object.keys(fields)) {
    if (Object.hasOwn(members, name)) {
      out[name] = valueOf(members[name], fields[name as keyof T]);
    }
  }
  return out as T;
}

// a nested array of structs (a JSON array decoded as `any`, null for nil)
export function decodeNestedList<T>(value: unknown, fields: Fields<T>): T[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("json: cannot unmarshal into Go slice");
  }
  return value.map((item) => decodeNested(item, fields));
}
