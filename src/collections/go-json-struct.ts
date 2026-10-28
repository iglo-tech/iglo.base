// No single upstream file: the encoding/json/v2 rules for decoding into
// the Go structs of core/collection_model*.go and core/fields_list.go
// (Go 1.27 encoding/json/v2 arshal_default.go and arshal_methods.go).
//
// go-json's unmarshalStruct decodes flat structs with leaf members. The
// collection structs nest other structs and types with their own
// UnmarshalJSON (FieldsList, DateTime, OAuth2Config), which Go hands the
// member's raw bytes. unmarshalGoStruct gives each known member its raw
// JSON text, so a member decodes it as its Go type does:
//
//   - the input must be one valid JSON value (Go reads the whole value
//     before decoding it); syntax errors, duplicate names and invalid
//     UTF-8 throw before any member is applied (Go's streaming decoder
//     applies the members before the error; every caller discards the
//     value on error);
//   - null sets the struct to its zero value (onNull), any other non-object
//     is an error;
//   - member names match case-sensitively, unknown members are ignored,
//     and members are applied in order; a member that fails stops decoding
//     (json v2 errors are fatal), keeping the members before it;
//   - nested structs merge: members absent from the JSON keep their value.
//
// The leaf helpers decode one member as Go's string, bool, int, int64,
// *string and *bool do (null gives the zero value, a pointer becomes nil).

import {
  type GoType,
  JSONSemanticError,
  boolType,
  bytesToText,
  int64Type,
  intType,
  stringType,
  unmarshal,
  unmarshalStruct,
  type GoInt,
} from "@/tools/types/go-json";

export type MemberDecoders = Record<string, (raw: string) => void>;

// json.Unmarshal(data, &struct): decoders[name] gets each known member's
// raw JSON text.
export function unmarshalGoStruct(
  data: string | Uint8Array,
  decoders: MemberDecoders,
  onNull: () => void,
): void {
  const text = bytesToText(data);
  // syntax check (and the "cannot unmarshal JSON ... into Go struct" error)
  unmarshalStruct(text, {}, {}, () => {});

  const members = objectMembers(text);
  if (members === null) {
    onNull();
    return;
  }

  for (const [name, raw] of members) {
    const decode = Object.hasOwn(decoders, name) ? decoders[name] : undefined;
    decode?.(raw);
  }
}

// json.Unmarshal into a slice whose elements decode themselves: the raw
// text of each element of a JSON array, or null for JSON null (a nil
// slice). Any other value is an error.
export function arrayElements(data: string | Uint8Array): string[] | null {
  const text = bytesToText(data);
  checkSyntax(text);

  let i = skipWhitespace(text, 0);
  const c = text[i];
  if (c === "n") {
    return null;
  }
  if (c !== "[") {
    throw new JSONSemanticError(`cannot unmarshal JSON ${kindOf(c)} into Go slice`);
  }

  const items: string[] = [];
  i = skipWhitespace(text, i + 1);
  if (text[i] === "]") {
    return items;
  }
  for (;;) {
    i = skipWhitespace(text, i);
    const end = skipValue(text, i);
    items.push(text.slice(i, end));
    i = skipWhitespace(text, end);
    if (text[i] === "]") {
      return items;
    }
    i++; // ","
  }
}

// a Go string member
export function decodeString(raw: string): string {
  return unmarshal(raw, stringType) as string;
}

// a Go bool member
export function decodeBool(raw: string): boolean {
  return unmarshal(raw, boolType) as boolean;
}

// a Go int64 member
export function decodeInt64(raw: string): GoInt {
  return unmarshal(raw, int64Type) as GoInt;
}

// a Go int member
export function decodeInt(raw: string): GoInt {
  return unmarshal(raw, intType) as GoInt;
}

// a Go *string member: null is nil
export function decodeNullableString(raw: string): string | null {
  return isNull(raw) ? null : decodeString(raw);
}

// a Go *bool member: null is nil
export function decodeNullableBool(raw: string): boolean | null {
  return isNull(raw) ? null : decodeBool(raw);
}

// a member of any other GoType
export function decodeAs(raw: string, t: GoType): unknown {
  return unmarshal(raw, t);
}

function isNull(raw: string): boolean {
  return raw.trim() === "null";
}

// json.Unmarshal's syntax check of a whole value, without decoding it
function checkSyntax(text: string): void {
  try {
    unmarshalStruct(text, {}, {}, () => {});
  } catch (err) {
    if (err instanceof JSONSemanticError) {
      return; // valid JSON, not an object
    }
    throw err;
  }
}

function kindOf(c: string | undefined): string {
  switch (c) {
    case "{":
      return "object";
    case "[":
      return "array";
    case '"':
      return "string";
    case "t":
    case "f":
      return "boolean";
    default:
      return "number";
  }
}

// the members of a valid JSON object as [name, raw value] pairs, or null
// for JSON null
function objectMembers(text: string): [string, string][] | null {
  let i = skipWhitespace(text, 0);
  if (text[i] === "n") {
    return null;
  }

  const members: [string, string][] = [];
  i = skipWhitespace(text, i + 1); // "{"
  if (text[i] === "}") {
    return members;
  }
  for (;;) {
    i = skipWhitespace(text, i);
    const nameEnd = skipValue(text, i);
    const name = decodeString(text.slice(i, nameEnd));
    i = skipWhitespace(text, nameEnd) + 1; // ":"
    i = skipWhitespace(text, i);
    const end = skipValue(text, i);
    members.push([name, text.slice(i, end)]);
    i = skipWhitespace(text, end);
    if (text[i] === "}") {
      return members;
    }
    i++; // ","
  }
}

function skipWhitespace(s: string, i: number): number {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) {
      break;
    }
    i++;
  }
  return i;
}

// the end of the valid JSON value that starts at i
function skipValue(s: string, i: number): number {
  const c = s[i];
  if (c === '"') {
    return skipString(s, i);
  }
  if (c === "{" || c === "[") {
    let depth = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '"') {
        i = skipString(s, i);
        continue;
      }
      if (ch === "{" || ch === "[") {
        depth++;
      } else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) {
          return i + 1;
        }
      }
      i++;
    }
    return i;
  }
  // a literal or a number
  while (i < s.length && !",}] \t\n\r".includes(s[i] as string)) {
    i++;
  }
  return i;
}

function skipString(s: string, i: number): number {
  i++;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') {
      return i + 1;
    }
    i++;
  }
  return i;
}
