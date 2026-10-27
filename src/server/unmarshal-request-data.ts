// Upstream: tools/router/unmarshal_request_data.go, plus the Go reflection
// and strconv rules it relies on, and json/v2's rules for unmarshaling into
// structs (used by @jsonPayload here and by Event.bindBody).
//
// Go binds into typed structs through reflection. TypeScript has no runtime
// types, so a struct is described by a StructType: its fields in declaration
// order, with their Go names (also the property set on the destination
// object), types and tags. An embedded struct is stored under its type name,
// as Go lays it out. Integers are stored as numbers (int64 and uint64
// values beyond 2^53 lose precision).

import {
  decodeValue,
  isJsonObject,
  JsonNumber,
  JsonSyntaxError,
  setOwn,
  toAny,
  type JsonValue,
} from "@/server/json-decode";

export type Kind =
  | "bool"
  | "string"
  | "int"
  | "int8"
  | "int16"
  | "int32"
  | "int64"
  | "uint"
  | "uint8"
  | "uint16"
  | "uint32"
  | "uint64"
  | "float32"
  | "float64"
  | "any";

// encoding.TextUnmarshaler: unmarshalText returns the parsed value or throws.
export interface TextType {
  kind: "text";
  unmarshalText(text: string): unknown;
}

export interface StructType {
  kind: "struct";
  fields: StructField[];
}

export interface SliceType {
  kind: "slice";
  elem: FieldType;
}

export interface PointerType {
  kind: "pointer";
  elem: FieldType;
}

export type FieldType = Kind | TextType | StructType | SliceType | PointerType;

export interface StructField {
  // the Go field name; also the property set on the destination object
  name: string;
  type: FieldType;
  // struct tags, e.g. { form: "title", json: "title" }
  tags?: Record<string, string>;
  // an embedded (anonymous) field
  embedded?: boolean;
}

export const structOf = (fields: StructField[]): StructType => ({ kind: "struct", fields });
export const sliceOf = (elem: FieldType): SliceType => ({ kind: "slice", elem });
export const pointerTo = (elem: FieldType): PointerType => ({ kind: "pointer", elem });
export const textOf = (unmarshalText: (text: string) => unknown): TextType => ({
  kind: "text",
  unmarshalText,
});

// JSONPayloadKey is the key for the special UnmarshalRequestData case
// used for reading serialized json payload without normalization.
export const JSONPayloadKey = "@jsonPayload";

export type RequestData = Map<string, string[]> | Record<string, string[]>;

// MapRef is a *map[string]any destination: unmarshaling a JSON null into it
// sets the map to nil (null), as json/v2 does.
export interface MapRef {
  map: Record<string, unknown> | null;
}

function getValues(data: RequestData, key: string): string[] | undefined {
  return data instanceof Map ? data.get(key) : Object.hasOwn(data, key) ? data[key] : undefined;
}

function entries(data: RequestData): [string, string[]][] {
  return data instanceof Map ? [...data] : Object.entries(data);
}

// UnmarshalRequestData unmarshals url.Values type of data (query,
// multipart/form-data, etc.) into dst.
//
// Without a struct type, dst is a map[string]any: each data value is
// inferred and converted to its bool, numeric, or string equivalent value
// (see inferValue).
//
// With a struct type, the fields are matched by their structTagKey tag
// (defaults to "form") or, without it, by the Go field name. Dot-notation
// targets nested struct fields; structPrefix is prepended to every key.
// The special "@jsonPayload" key holds serialized JSON that is unmarshaled
// into dst without normalization.
export function unmarshalRequestData(data: RequestData | undefined, dst: MapRef): void;
export function unmarshalRequestData(
  data: RequestData | undefined,
  dst: Record<string, unknown>,
  type: StructType,
  structTagKey?: string,
  structPrefix?: string,
): void;
export function unmarshalRequestData(
  data: RequestData | undefined,
  dst: MapRef | Record<string, unknown>,
  type?: StructType,
  structTagKey = "",
  structPrefix = "",
): void {
  if (!data || entries(data).length === 0) {
    return; // nothing to unmarshal
  }

  if (!type) {
    const ref = dst as MapRef;
    ref.map ??= {};
    for (const [k, v] of entries(data)) {
      if (k === JSONPayloadKey) {
        continue; // unmarshaled separately
      }
      if (v.length === 1) {
        setOwn(ref.map, k, inferValue(v[0] as string));
      } else {
        setOwn(ref.map, k, v.map(inferValue));
      }
    }
  } else {
    // set a default tag key
    unmarshalInStructValue(
      data,
      dst as Record<string, unknown>,
      type,
      structTagKey || "form",
      structPrefix,
    );
  }

  // @jsonPayload
  //
  // Special case to scan serialized json string without
  // normalization alongside the other data values
  for (const payload of getValues(data, JSONPayloadKey) ?? []) {
    if (type) {
      unmarshalJSON(decodeValue(payload), dst as Record<string, unknown>, type, false);
    } else {
      unmarshalJSON(decodeValue(payload), dst as MapRef, undefined, false);
    }
  }
}

// isExported: a Go identifier starting with an upper case letter
function isExported(name: string): boolean {
  const first = String.fromCodePoint(name.codePointAt(0) ?? 0);
  return /\p{Lu}/u.test(first);
}

function stripPointers(t: FieldType): FieldType {
  while (typeof t === "object" && t.kind === "pointer") {
    t = t.elem;
  }
  return t;
}

// the Go zero value of t, as allocated by reflect.New
function zeroValue(t: FieldType): unknown {
  if (typeof t === "string") {
    switch (t) {
      case "string":
        return "";
      case "bool":
        return false;
      case "any":
        return null;
      default:
        return 0;
    }
  }
  switch (t.kind) {
    case "struct":
      return {};
    case "text":
      return null;
    default:
      return null; // nil slice or pointer
  }
}

// unmarshalInStructValue unmarshals data into the provided struct fields.
function unmarshalInStructValue(
  data: RequestData,
  dst: Record<string, unknown>,
  type: StructType,
  structTagKey: string,
  structPrefix: string,
): void {
  for (const field of type.fields) {
    const tag = field.tags?.[structTagKey] ?? "";

    if (tag === "-" || (!field.embedded && !isExported(field.name))) {
      continue; // disabled or unexported non-anonymous struct field
    }

    let ft = field.type;
    // dereference: a nil pointer field is allocated
    if (typeof ft === "object" && ft.kind === "pointer") {
      ft = ft.elem;
      if (dst[field.name] === undefined || dst[field.name] === null) {
        setOwn(dst, field.name, zeroValue(stripPointers(ft)));
      }
    }

    const isSlice = typeof ft === "object" && ft.kind === "slice";
    if (typeof ft === "object" && ft.kind === "slice") {
      ft = stripPointers(ft.elem);
    } else {
      ft = stripPointers(ft);
    }

    let name = tag;
    if (name === "" && !field.embedded) {
      name = field.name;
    }
    if (name !== "" && structPrefix !== "") {
      name = `${structPrefix}.${name}`;
    }

    // encoding.TextUnmarshaler field
    if (typeof ft === "object" && ft.kind === "text") {
      const values = getValues(data, name);
      if (!values || values.length === 0) {
        continue; // no value to load
      }
      const text = ft;
      if (isSlice) {
        setOwn(
          dst,
          field.name,
          values.map((v) => text.unmarshalText(v)),
        );
      } else {
        setOwn(dst, field.name, text.unmarshalText(values[0] as string));
      }
      continue;
    }

    // "regular" field
    if (typeof ft === "string") {
      const values = getValues(data, name);
      if (!values || values.length === 0) {
        continue; // no value to load
      }
      const kind = ft;
      if (isSlice) {
        setOwn(
          dst,
          field.name,
          values.map((v) => regularValue(kind, v)),
        );
      } else {
        setOwn(dst, field.name, regularValue(kind, values[0] as string));
      }
      continue;
    }

    if (ft.kind !== "struct") {
      throw new Error(`unknown value type ${ft.kind}`);
    }

    // structs (embedded or nested)
    if (isSlice) {
      // populating slice of structs is not supported at the moment
      // because the filling rules are ambiguous
      continue;
    }

    // note: upstream reassigns structPrefix here, so the fields declared
    // after a nested struct are looked up with that struct's prefix
    if (tag !== "") {
      structPrefix = tag;
    } else {
      structPrefix = name; // name is empty for anonymous structs -> no prefix
    }

    unmarshalInStructValue(data, structValue(dst, field.name), ft, structTagKey, structPrefix);
  }
}

// the (embedded or nested) struct object stored in dst[name], allocated if missing
export function structValue(dst: Record<string, unknown>, name: string): Record<string, unknown> {
  const current = dst[name];
  if (typeof current === "object" && current !== null) {
    return current as Record<string, unknown>;
  }
  const value: Record<string, unknown> = {};
  setOwn(dst, name, value);
  return value;
}

// setRegularReflectedValue: value cast to kind.
function regularValue(kind: Kind, value: string): unknown {
  switch (kind) {
    case "string":
      return value;
    case "bool":
      return parseBool(value === "" ? "f" : value);
    case "int":
    case "int8":
    case "int16":
    case "int32":
    case "int64":
      // reflect.Value.SetInt truncates to the field's size
      return Number(BigInt.asIntN(intBits(kind), parseInt64(value === "" ? "0" : value)));
    case "uint":
    case "uint8":
    case "uint16":
    case "uint32":
    case "uint64":
      return Number(BigInt.asUintN(intBits(kind), parseUint64(value === "" ? "0" : value)));
    case "float32":
      return Math.fround(parseFloat64(value === "" ? "0" : value));
    case "float64":
      return parseFloat64(value === "" ? "0" : value);
    case "any":
      return inferValue(value);
  }
}

function intBits(kind: Kind): number {
  switch (kind) {
    case "int8":
    case "uint8":
      return 8;
    case "int16":
    case "uint16":
      return 16;
    case "int32":
    case "uint32":
      return 32;
    default:
      return 64;
  }
}

// strconv.NumError
export class NumError extends Error {
  constructor(func: string, input: string, reason: "invalid syntax" | "value out of range") {
    super(`strconv.${func}: parsing ${JSON.stringify(input)}: ${reason}`);
    this.name = "NumError";
  }
}

// strconv.ParseBool
function parseBool(str: string): boolean {
  switch (str) {
    case "1":
    case "t":
    case "T":
    case "true":
    case "TRUE":
    case "True":
      return true;
    case "0":
    case "f":
    case "F":
    case "false":
    case "FALSE":
    case "False":
      return false;
  }
  throw new NumError("ParseBool", str, "invalid syntax");
}

// strconv.ParseUint(s, 0, 64) without the sign; undefined on bad syntax
function parseUnsigned(s: string): bigint | undefined {
  // base prefix, underscores only between digits or after the prefix
  const match =
    /^(?:0[xX]((?:_?[0-9a-fA-F])+)|0[oO]((?:_?[0-7])+)|0[bB]((?:_?[01])+)|(0(?:_?[0-7])*)|([1-9](?:_?[0-9])*))$/.exec(
      s,
    );
  if (!match) {
    return undefined;
  }
  const [, hex, oct, bin, legacyOct, dec] = match;
  if (hex !== undefined) {
    return BigInt(`0x${hex.replaceAll("_", "")}`);
  }
  if (oct !== undefined) {
    return BigInt(`0o${oct.replaceAll("_", "")}`);
  }
  if (bin !== undefined) {
    return BigInt(`0b${bin.replaceAll("_", "")}`);
  }
  if (legacyOct !== undefined) {
    return BigInt(`0o${legacyOct.replaceAll("_", "") || "0"}`);
  }
  return BigInt((dec as string).replaceAll("_", ""));
}

// strconv.ParseInt(s, 0, 64)
function parseInt64(s: string): bigint {
  let body = s;
  let negative = false;
  if (body.startsWith("+") || body.startsWith("-")) {
    negative = body[0] === "-";
    body = body.slice(1);
  }
  const value = parseUnsigned(body);
  if (value === undefined) {
    throw new NumError("ParseInt", s, "invalid syntax");
  }
  const signed = negative ? -value : value;
  if (signed > 2n ** 63n - 1n || signed < -(2n ** 63n)) {
    throw new NumError("ParseInt", s, "value out of range");
  }
  return signed;
}

// strconv.ParseUint(s, 0, 64)
function parseUint64(s: string): bigint {
  const value = parseUnsigned(s);
  if (value === undefined) {
    throw new NumError("ParseUint", s, "invalid syntax");
  }
  if (value > 2n ** 64n - 1n) {
    throw new NumError("ParseUint", s, "value out of range");
  }
  return value;
}

// strconv.ParseFloat(s, 64): decimal and hexadecimal Go float literals,
// "inf", "infinity" and "nan" (case-insensitive) with an optional sign.
function parseFloat64(s: string): number {
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(s);
  if (special) {
    if ((special[2] as string).toLowerCase() === "nan") {
      return Number.NaN;
    }
    return special[1] === "-" ? -Infinity : Infinity;
  }
  const decimal =
    /^[+-]?(?:[0-9](?:_?[0-9])*(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/;
  const hex =
    /^([+-]?)0[xX]((?:_?[0-9a-fA-F])*)(?:\.((?:[0-9a-fA-F](?:_?[0-9a-fA-F])*)?))?[pP]([+-]?[0-9](?:_?[0-9])*)$/;
  if (decimal.test(s)) {
    const value = Number(s.replaceAll("_", ""));
    if (!Number.isFinite(value)) {
      throw new NumError("ParseFloat", s, "value out of range");
    }
    return value;
  }
  const h = hex.exec(s);
  if (h && (h[2] !== "" || (h[3] ?? "") !== "")) {
    const intPart = (h[2] as string).replaceAll("_", "");
    const fracPart = (h[3] ?? "").replaceAll("_", "");
    const mantissa = BigInt(`0x${intPart || "0"}${fracPart}`);
    const exponent = Number((h[4] as string).replaceAll("_", "")) - 4 * fracPart.length;
    const value = Number(mantissa) * 2 ** exponent;
    if (!Number.isFinite(value)) {
      throw new NumError("ParseFloat", s, "value out of range");
    }
    return h[1] === "-" ? -value : value;
  }
  throw new NumError("ParseFloat", s, "invalid syntax");
}

const inferNumberCharsRegex = /^[-.\d]+$/;

// In order to support more seamlessly both json and multipart/form-data requests,
// the following normalization rules are applied for plain multipart string values:
//   - "true" is converted to the json "true"
//   - "false" is converted to the json "false"
//   - numeric strings are converted to json number ONLY if the resulted
//     minimal number string representation is the same as the provided raw string
//     (aka. scientific notations, "Infinity", "0.0", "0001", etc. are kept as string)
//   - any other string (empty string too) is left as it is
export function inferValue(raw: string): unknown {
  switch (raw) {
    case "":
      return raw;
    case "true":
      return true;
    case "false":
      return false;
    default: {
      // try to convert to number
      //
      // note: expects the provided raw string to match exactly with the
      // minimal string representation of the parsed float
      const first = raw[0] as string;
      if ((first === "-" || (first >= "0" && first <= "9")) && inferNumberCharsRegex.test(raw)) {
        let v: number | undefined;
        try {
          v = parseFloat64(raw);
        } catch {
          v = undefined;
        }
        if (v !== undefined && formatFloat(v) === raw) {
          return v;
        }
      }
      return raw;
    }
  }
}

// strconv.FormatFloat(v, 'f', -1, 64): the shortest decimal that round
// trips, without an exponent
function formatFloat(v: number): string {
  if (Object.is(v, -0)) {
    return "-0";
  }
  const s = String(v);
  if (!/e/i.test(s)) {
    return s;
  }
  // expand the exponent form that String() uses for very large/small values
  const [mantissa, expPart] = s.split(/e/i) as [string, string];
  const exp = Number(expPart);
  const negative = mantissa.startsWith("-");
  const digits = mantissa.replace("-", "").replace(".", "");
  const pointPos =
    (mantissa.replace("-", "").indexOf(".") + 1 || mantissa.replace("-", "").length + 1) - 1;
  const newPoint = pointPos + exp;
  let out: string;
  if (newPoint <= 0) {
    out = `0.${"0".repeat(-newPoint)}${digits}`;
  } else if (newPoint >= digits.length) {
    out = digits + "0".repeat(newPoint - digits.length);
  } else {
    out = `${digits.slice(0, newPoint)}.${digits.slice(newPoint)}`;
  }
  return negative ? `-${out}` : out;
}

// ---------------------------------------------------------------------------
// json/v2 unmarshaling into a map[string]any or a struct

class JsonSemanticError extends Error {
  constructor(message: string) {
    super(`json: ${message}`);
    this.name = "JsonSemanticError";
  }
}

function jsonKind(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "string") {
    return "string";
  }
  if (value instanceof JsonNumber) {
    return "number";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return "object";
}

function cannot(value: JsonValue, goType: string): JsonSemanticError {
  return new JsonSemanticError(`cannot unmarshal JSON ${jsonKind(value)} into Go ${goType}`);
}

// json/v2 foldName: ASCII letters upper-cased, dashes and underscores
// dropped, other characters folded to the smallest of their case variants
// (an approximation of unicode.SimpleFold's orbit).
function foldName(name: string): string {
  let out = "";
  for (const c of name) {
    if (c === "-" || c === "_") {
      continue;
    }
    if (c < "\u0080") {
      out += c >= "a" && c <= "z" ? c.toUpperCase() : c;
      continue;
    }
    let folded = c;
    for (const variant of [c.toLowerCase(), c.toUpperCase()]) {
      if (
        [...variant].length === 1 &&
        (variant.codePointAt(0) as number) < (folded.codePointAt(0) as number)
      ) {
        folded = variant;
      }
    }
    out += folded;
  }
  return out;
}

interface JsonField {
  jsonName: string;
  field: StructField;
  // the `case:ignore` / `case:strict` tag option
  casing: "" | "ignore" | "strict";
  // the object that holds the field's property (an inlined embedded struct
  // is stored under its type name)
  holder: (dst: Record<string, unknown>) => Record<string, unknown>;
}

// the JSON-visible fields of a struct, embedded structs inlined
function jsonFields(type: StructType): JsonField[] {
  const out: JsonField[] = [];
  for (const field of type.fields) {
    const tag = field.tags?.json ?? "";
    const [tagName = "", ...options] = tag.split(",");
    if (tag === "-") {
      continue;
    }
    const base = stripPointers(field.type);
    if (field.embedded && tagName === "" && typeof base === "object" && base.kind === "struct") {
      // inlined: the embedded fields are JSON members of the parent object
      for (const inner of jsonFields(base)) {
        out.push({
          ...inner,
          holder: (dst) => inner.holder(structValue(dst, field.name)),
        });
      }
      continue;
    }
    if (!isExported(field.name)) {
      continue;
    }
    const casing = options.includes("case:ignore")
      ? "ignore"
      : options.includes("case:strict")
        ? "strict"
        : "";
    out.push({ jsonName: tagName || field.name, field, casing, holder: (dst) => dst });
  }
  return out;
}

// the fields' Go zero values, as reflect.Value.SetZero leaves a struct
function resetStruct(dst: Record<string, unknown>, type: StructType): void {
  for (const field of type.fields) {
    setOwn(dst, field.name, zeroValue(field.type));
  }
}

// Unmarshals a decoded JSON value into dst: a *map[string]any (MapRef)
// without a struct type, or the struct's fields. Object members are merged
// into the existing map or struct values; a JSON null sets the map to nil
// or the struct to its zero value. caseInsensitive is
// json.MatchCaseInsensitiveNames.
export function unmarshalJSON(
  value: JsonValue,
  dst: MapRef,
  type: undefined,
  caseInsensitive: boolean,
): void;
export function unmarshalJSON(
  value: JsonValue,
  dst: Record<string, unknown>,
  type: StructType,
  caseInsensitive: boolean,
): void;
export function unmarshalJSON(
  value: JsonValue,
  dst: MapRef | Record<string, unknown>,
  type: StructType | undefined,
  caseInsensitive: boolean,
): void {
  if (!type) {
    const ref = dst as MapRef;
    ref.map = unmarshalMap(value, ref.map);
    return;
  }
  unmarshalStruct(value, dst as Record<string, unknown>, type, caseInsensitive);
}

function unmarshalStruct(
  value: JsonValue,
  dst: Record<string, unknown>,
  type: StructType,
  caseInsensitive: boolean,
): void {
  if (value === null) {
    resetStruct(dst, type);
    return;
  }
  if (!isJsonObject(value)) {
    throw cannot(value, "struct");
  }
  const fields = jsonFields(type);
  const seen = new Set<JsonField>();
  for (const [name, member] of value.members) {
    let f = fields.find((candidate) => candidate.jsonName === name);
    if (!f) {
      const folded = foldName(name);
      const matches = fields.filter(
        (candidate) =>
          foldName(candidate.jsonName) === folded &&
          (candidate.casing === "ignore" || (caseInsensitive && candidate.casing !== "strict")),
      );
      if (matches.length > 1) {
        throw new JsonSemanticError("cannot unmarshal into Go struct: ambiguous name");
      }
      f = matches[0];
    }
    if (!f) {
      continue; // unknown members are ignored
    }
    // two members (e.g. "n" and "N") must not set the same field
    if (seen.has(f)) {
      throw new JsonSyntaxError(`duplicate object member name ${JSON.stringify(name)}`);
    }
    seen.add(f);
    const holder = f.holder(dst);
    setOwn(
      holder,
      f.field.name,
      jsonFieldValue(member, f.field.type, holder[f.field.name], caseInsensitive),
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// json/v2 into a map[string]any: null gives a nil map, an object's members
// are unmarshaled into the existing entries (see unmarshalAny).
function unmarshalMap(
  value: JsonValue,
  current: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (value === null) {
    return null;
  }
  if (!isJsonObject(value)) {
    throw cannot(value, "map[string]any");
  }
  const target = current ?? {};
  for (const [name, member] of value.members) {
    const existing = Object.hasOwn(target, name) ? target[name] : undefined;
    setOwn(target, name, unmarshalAny(member, existing));
  }
  return target;
}

// json/v2 into an `any` that may already hold a value: null resets it;
// otherwise a held value keeps its Go type (bool, string, float64, []any,
// map[string]any) and the JSON value must fit it. Maps are merged, slices
// are replaced. An empty `any` gets a fresh value.
function unmarshalAny(value: JsonValue, current: unknown): unknown {
  if (value === null) {
    return null;
  }
  if (current === null || current === undefined) {
    return toAny(value);
  }
  if (typeof current === "boolean") {
    if (typeof value !== "boolean") {
      throw cannot(value, "bool");
    }
    return value;
  }
  if (typeof current === "string") {
    if (typeof value !== "string") {
      throw cannot(value, "string");
    }
    return value;
  }
  if (typeof current === "number") {
    if (!(value instanceof JsonNumber)) {
      throw cannot(value, "float64");
    }
    return toAny(value);
  }
  if (Array.isArray(current)) {
    if (!Array.isArray(value)) {
      throw cannot(value, "[]any");
    }
    return toAny(value);
  }
  if (isPlainObject(current)) {
    return unmarshalMap(value, current);
  }
  return toAny(value);
}

const intRanges: Record<string, [bigint, bigint]> = {
  int: [-(2n ** 63n), 2n ** 63n - 1n],
  int8: [-128n, 127n],
  int16: [-32768n, 32767n],
  int32: [-(2n ** 31n), 2n ** 31n - 1n],
  int64: [-(2n ** 63n), 2n ** 63n - 1n],
  uint: [0n, 2n ** 64n - 1n],
  uint8: [0n, 255n],
  uint16: [0n, 65535n],
  uint32: [0n, 2n ** 32n - 1n],
  uint64: [0n, 2n ** 64n - 1n],
};

function jsonFieldValue(
  value: JsonValue,
  type: FieldType,
  current: unknown,
  caseInsensitive: boolean,
): unknown {
  if (value === null) {
    // null resets the value to its zero value
    return typeof type === "object" && type.kind === "struct" ? {} : zeroValue(type);
  }
  if (typeof type === "string") {
    switch (type) {
      case "any":
        return unmarshalAny(value, current);
      case "string":
        if (typeof value !== "string") {
          throw cannot(value, type);
        }
        return value;
      case "bool":
        if (typeof value !== "boolean") {
          throw cannot(value, type);
        }
        return value;
      case "float32":
      case "float64": {
        if (!(value instanceof JsonNumber)) {
          throw cannot(value, type);
        }
        const n = Number(value.literal);
        if (!Number.isFinite(n) || (type === "float32" && Math.abs(n) > 3.4028234663852886e38)) {
          throw cannot(value, type);
        }
        return type === "float32" ? Math.fround(n) : n;
      }
      default: {
        if (!(value instanceof JsonNumber) || !/^-?[0-9]+$/.test(value.literal)) {
          throw cannot(value, type);
        }
        const n = BigInt(value.literal);
        const [min, max] = intRanges[type] as [bigint, bigint];
        if (n < min || n > max) {
          throw cannot(value, type);
        }
        return Number(n);
      }
    }
  }
  switch (type.kind) {
    case "pointer":
      return jsonFieldValue(value, type.elem, current, caseInsensitive);
    case "text":
      if (typeof value !== "string") {
        throw cannot(value, "encoding.TextUnmarshaler");
      }
      return type.unmarshalText(value);
    case "slice":
      if (!Array.isArray(value)) {
        throw cannot(value, "slice");
      }
      return value.map((item) => jsonFieldValue(item, type.elem, undefined, caseInsensitive));
    case "struct": {
      const target =
        typeof current === "object" && current !== null ? (current as Record<string, unknown>) : {};
      unmarshalStruct(value, target, type, caseInsensitive);
      return target;
    }
  }
}
