// Upstream: Go 1.27 encoding/json/v2 and encoding/json (v1 on top of v2,
// GOEXPERIMENT=jsonv2), internal/jsonwire (AppendQuote, AppendFloat,
// ReformatString), jsontext (Encoder.WriteValue reformatting), the
// arshalers for any, string, int, float64, slices, maps and structs.
//
// The subset of Go's JSON behavior the tools/types values, store and
// golang-jwt rely on, so their bytes match upstream's:
//
//   - marshal: map keys sorted by their UTF-8 bytes (json.Deterministic),
//     Go's string escaping and float text (ES6 number text, except -0),
//     the output of marshalJSON() methods compacted and validated as
//     jsontext does with Encoder.WriteValue;
//   - unmarshal: strict v2 decoding (duplicate names and invalid UTF-8 are
//     errors, numbers out of float64 range fail), or v1 decoding with
//     `legacy` (duplicates allowed, the last replaces earlier ones whatever
//     their type; invalid UTF-8 becomes U+FFFD),
//     as golang-jwt's json.Unmarshal does.
//
// JS has no Go types, so the decoder takes a GoType that names the Go
// destination type, and values map to JS this way: float64 is number, int
// and int64 are GoInt (a number inside Number.MAX_SAFE_INTEGER, the exact
// bigint outside it, as src/db reads integers), Go int64/uint64 values that
// must stay exact are bigint, string is string,
// []T is an array, map[string]T and struct-less `any` objects are plain
// objects. A JS string can only hold invalid UTF-8 as a lone surrogate:
// decodeUTF8Bytes maps each invalid byte to one, so a lone surrogate is
// treated as one invalid byte everywhere here.
//
// Not ported: indentation and the other jsontext/json options, which no
// ported caller uses.

import { decodeUTF8Bytes } from "@/server/json-decode";

// Values with their own JSON form, as Go's json.Marshaler. The returned
// text must be one valid JSON value; it is compacted and checked when it is
// part of a larger value, as Go's jsontext.Encoder.WriteValue does.
export interface JSONMarshaler {
  marshalJSON(): string;
}

export function isJSONMarshaler(value: unknown): value is JSONMarshaler {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { marshalJSON?: unknown }).marshalJSON === "function"
  );
}

// Values that decode their own JSON form, as Go's json.Unmarshaler: they
// get the text of one valid JSON value and throw on failure.
export interface JSONUnmarshaler {
  unmarshalJSON(b: string): void;
}

export function isJSONUnmarshaler(value: unknown): value is JSONUnmarshaler {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { unmarshalJSON?: unknown }).unmarshalJSON === "function"
  );
}

export class JSONSyntaxError extends Error {
  constructor(message: string) {
    super(`jsontext: ${message}`);
    this.name = "JSONSyntaxError";
  }
}

export class JSONSemanticError extends Error {
  constructor(message: string) {
    super(`json: ${message}`);
    this.name = "JSONSemanticError";
  }
}

// json.Marshal returns the bytes written before an error together with the
// error. A throw from marshal carries them here: delimiters (`,` and `:`)
// are written with the token that follows, so a value that fails leaves no
// delimiter behind it.
export function marshalPartial(err: unknown): string {
  return err instanceof Error ? ((err as { partial?: string }).partial ?? "") : "";
}

function withPartial(err: unknown, prefix: string, delim: string): unknown {
  if (err instanceof Error) {
    const child = (err as { partial?: string }).partial ?? "";
    (err as { partial?: string }).partial = child === "" ? prefix : prefix + delim + child;
  }
  return err;
}

// jsontext's maxNestingDepth
const maxNestingDepth = 10000;

export interface MarshalOptions {
  // encoding/json (v1) defaults: EscapeForHTML, EscapeForJS,
  // AllowInvalidUTF8, AllowDuplicateNames and PreserveRawStrings
  legacy?: boolean;
  // jsontext.AllowInvalidUTF8(true)
  allowInvalidUTF8?: boolean;
  // jsontext.AllowDuplicateNames(true): duplicate object member names
  // (in a marshaler's output, or names equal after invalid UTF-8 is
  // replaced) are written as they are instead of failing
  allowDuplicateNames?: boolean;
}

interface EncodeFlags {
  escapeForHTML: boolean;
  escapeForJS: boolean;
  allowInvalidUTF8: boolean;
  allowDuplicateNames: boolean;
  preserveRawStrings: boolean;
}

function encodeFlags(opts: MarshalOptions): EncodeFlags {
  const legacy = opts.legacy === true;
  return {
    escapeForHTML: legacy,
    escapeForJS: legacy,
    allowInvalidUTF8: legacy || opts.allowInvalidUTF8 === true,
    allowDuplicateNames: legacy || opts.allowDuplicateNames === true,
    preserveRawStrings: legacy,
  };
}

// json.Marshal with json.Deterministic(true) (Go's v1 Marshal is
// deterministic too). Throws on values Go cannot encode (NaN, ±Inf,
// functions, symbols, invalid UTF-8 without allowInvalidUTF8).
export function marshal(value: unknown, opts: MarshalOptions = {}): string {
  return encodeValue(value, encodeFlags(opts), 0);
}

function encodeValue(value: unknown, flags: EncodeFlags, depth: number): string {
  if (depth > maxNestingDepth) {
    throw new JSONSyntaxError("exceeded max depth");
  }
  switch (typeof value) {
    case "undefined":
      return "null";
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return formatFloat(value);
    case "bigint":
      return value.toString();
    case "string":
      return quote(value, flags);
    case "function":
    case "symbol":
      throw new JSONSemanticError(`cannot marshal ${typeof value}`);
  }
  if (value === null) {
    return "null";
  }
  if (isJSONMarshaler(value)) {
    return reformatValue(value.marshalJSON(), flags, depth);
  }
  if (Array.isArray(value)) {
    let out = "[";
    for (let i = 0; i < value.length; i++) {
      try {
        const item = encodeValue(value[i], flags, depth + 1);
        out += (i > 0 ? "," : "") + item;
      } catch (err) {
        throw withPartial(err, out, i > 0 ? "," : "");
      }
    }
    return out + "]";
  }
  if (value instanceof Uint8Array) {
    // []byte is a base64 (StdEncoding) string
    return quote(value.toBase64(), flags);
  }
  if (value instanceof Date) {
    // time.Time is RFC 3339 with nanoseconds, trailing zeros trimmed
    return quote(formatRFC3339Nano(value), flags);
  }
  const entries =
    value instanceof Map
      ? [...(value as Map<unknown, unknown>).entries()].map(([k, v]): [string, unknown] => [
          String(k),
          v,
        ])
      : Object.entries(value as object);
  return encodeObject(entries, flags, depth);
}

function encodeObject(entries: [string, unknown][], flags: EncodeFlags, depth: number): string {
  // names are compared as Go strings (UTF-8 bytes); invalid UTF-8 is
  // replaced first, which may make two names equal
  const members = entries.map(([name, value]): [string, string, unknown] => [
    quote(name, flags),
    name.toWellFormed(),
    value,
  ]);
  members.sort((a, b) => compareUTF8(a[1], b[1]));
  let out = "{";
  for (let i = 0; i < members.length; i++) {
    const [quoted, name, value] = members[i] as [string, string, unknown];
    if (
      !flags.allowDuplicateNames &&
      i > 0 &&
      (members[i - 1] as [string, string, unknown])[1] === name
    ) {
      throw withPartial(new JSONSyntaxError(`duplicate object member name ${quoted}`), out, "");
    }
    // the name is written before its value is encoded
    out += (i > 0 ? "," : "") + quoted;
    try {
      out += ":" + encodeValue(value, flags, depth + 1);
    } catch (err) {
      throw withPartial(err, out, ":");
    }
  }
  return out + "}";
}

// compares two strings by their UTF-8 bytes (= by code points), as Go's
// slices.Sort on strings does
export function compareUTF8(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(i) as number;
    if (ca !== cb) {
      return ca < cb ? -1 : 1;
    }
    if (ca > 0xffff) {
      i++;
    }
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

// jsonwire.AppendFloat for float64: ES6 number text, except that -0 stays
// "-0". NaN and ±Inf are not valid JSON.
export function formatFloat(n: number): string {
  if (!Number.isFinite(n)) {
    throw new JSONSemanticError(`unsupported value: ${n}`);
  }
  if (Object.is(n, -0)) {
    return "-0";
  }
  return String(n);
}

// jsonwire.AppendQuote. Invalid UTF-8 (a lone surrogate) becomes U+FFFD and
// is an error unless allowInvalidUTF8.
export function quote(
  s: string,
  flags: Pick<EncodeFlags, "escapeForHTML" | "escapeForJS" | "allowInvalidUTF8">,
): string {
  if (!s.isWellFormed()) {
    if (!flags.allowInvalidUTF8) {
      throw new JSONSyntaxError("invalid UTF-8");
    }
    s = s.toWellFormed();
  }
  let out = '"';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let esc: string | undefined;
    if (c < 0x20 || c === 0x22 || c === 0x5c) {
      esc = escapeASCII(c);
    } else if ((c === 0x3c || c === 0x3e || c === 0x26) && flags.escapeForHTML) {
      esc = escapeUTF16(c);
    } else if ((c === 0x2028 || c === 0x2029) && flags.escapeForJS) {
      esc = escapeUTF16(c);
    }
    if (esc !== undefined) {
      out += s.slice(last, i) + esc;
      last = i + 1;
    }
  }
  return out + s.slice(last) + '"';
}

function escapeASCII(c: number): string {
  switch (c) {
    case 0x22:
      return '\\"';
    case 0x5c:
      return "\\\\";
    case 0x08:
      return "\\b";
    case 0x0c:
      return "\\f";
    case 0x0a:
      return "\\n";
    case 0x0d:
      return "\\r";
    case 0x09:
      return "\\t";
    default:
      return escapeUTF16(c);
  }
}

function escapeUTF16(c: number): string {
  return "\\u" + c.toString(16).padStart(4, "0");
}

function formatRFC3339Nano(d: Date): string {
  const ms = d.getTime();
  if (!Number.isFinite(ms)) {
    throw new JSONSemanticError("invalid time");
  }
  const year = d.getUTCFullYear();
  if (year < 0 || year > 9999) {
    throw new JSONSemanticError("year outside of range [0,9999]");
  }
  const iso = d.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ for years 0..9999
  const frac = iso.slice(20, 23).replace(/0+$/, "");
  return iso.slice(0, 19) + (frac === "" ? "" : "." + frac) + "Z";
}

// Encoder.WriteValue: raw is checked and compacted; strings are copied as
// they are when canonical (or under preserveRawStrings), else re-quoted;
// numbers are copied as they are.
function reformatValue(raw: string, flags: EncodeFlags, depth: number): string {
  const r = new Reformatter(raw, flags);
  r.skipWhitespace();
  const out = r.value(depth);
  r.skipWhitespace();
  if (r.i < raw.length) {
    throw new JSONSyntaxError(
      `invalid character ${JSON.stringify(raw[r.i])} after top-level value`,
    );
  }
  return out;
}

class Reformatter {
  i = 0;
  constructor(
    readonly s: string,
    readonly flags: EncodeFlags,
  ) {}

  skipWhitespace(): void {
    while (this.i < this.s.length && isWhitespace(this.s.charCodeAt(this.i))) {
      this.i++;
    }
  }

  value(depth: number): string {
    if (this.i >= this.s.length) {
      throw new JSONSyntaxError("unexpected EOF");
    }
    const c = this.s[this.i] as string;
    switch (c) {
      case "{":
        return this.object(depth + 1);
      case "[":
        return this.array(depth + 1);
      case '"':
        return this.string()[0];
      case "n":
        return this.literal("null");
      case "t":
        return this.literal("true");
      case "f":
        return this.literal("false");
    }
    const n = consumeNumber(this.s, this.i);
    this.i += n;
    return this.s.slice(this.i - n, this.i);
  }

  literal(text: string): string {
    if (!this.s.startsWith(text, this.i)) {
      throw new JSONSyntaxError(`invalid literal at offset ${this.i}`);
    }
    this.i += text.length;
    return text;
  }

  // returns the reformatted string and its unquoted value
  string(): [string, string] {
    const start = this.i;
    const [value, end, canonical] = scanString(this.s, start, !this.flags.allowInvalidUTF8);
    this.i = end;
    const rawText = this.s.slice(start, end);
    const anyEscape = this.flags.escapeForHTML || this.flags.escapeForJS;
    if (!anyEscape && (canonical || this.flags.preserveRawStrings)) {
      return [rawText, value];
    }
    if (this.flags.preserveRawStrings) {
      // pre-escaped sequences stay; only the HTML and JS escapes are added
      let out = "";
      for (const ch of rawText) {
        const c = ch.charCodeAt(0);
        if ((c === 0x3c || c === 0x3e || c === 0x26) && this.flags.escapeForHTML) {
          out += escapeUTF16(c);
        } else if ((c === 0x2028 || c === 0x2029) && this.flags.escapeForJS) {
          out += escapeUTF16(c);
        } else {
          out += ch;
        }
      }
      return [out, value];
    }
    return [quote(value, { ...this.flags, allowInvalidUTF8: true }), value];
  }

  array(depth: number): string {
    if (depth > maxNestingDepth) {
      throw new JSONSyntaxError("exceeded max depth");
    }
    this.i++;
    const items: string[] = [];
    this.skipWhitespace();
    if (this.s[this.i] === "]") {
      this.i++;
      return "[]";
    }
    for (;;) {
      this.skipWhitespace();
      items.push(this.value(depth));
      this.skipWhitespace();
      const c = this.s[this.i++];
      if (c === "]") {
        return "[" + items.join(",") + "]";
      }
      if (c !== ",") {
        throw new JSONSyntaxError("invalid character after array element");
      }
    }
  }

  object(depth: number): string {
    if (depth > maxNestingDepth) {
      throw new JSONSyntaxError("exceeded max depth");
    }
    this.i++;
    const members: string[] = [];
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.s[this.i] === "}") {
      this.i++;
      return "{}";
    }
    for (;;) {
      this.skipWhitespace();
      if (this.s[this.i] !== '"') {
        throw new JSONSyntaxError("invalid character at start of object name");
      }
      const [name, unquoted] = this.string();
      const key = unquoted.toWellFormed();
      if (!this.flags.allowDuplicateNames && seen.has(key)) {
        throw new JSONSyntaxError(`duplicate object member name ${name}`);
      }
      seen.add(key);
      this.skipWhitespace();
      if (this.s[this.i++] !== ":") {
        throw new JSONSyntaxError("invalid character after object name");
      }
      this.skipWhitespace();
      members.push(name + ":" + this.value(depth));
      this.skipWhitespace();
      const c = this.s[this.i++];
      if (c === "}") {
        return "{" + members.join(",") + "}";
      }
      if (c !== ",") {
        throw new JSONSyntaxError("invalid character after object value");
      }
    }
  }
}

function isWhitespace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

// jsonwire.ConsumeNumber: the length of the JSON number at s[i:]. The
// whole token is checked before it is returned: a fraction or exponent
// without digits (`50.`, `50e`, `50e+`, `1.e5`) and a lone `-` are errors,
// so no prefix of them is applied. Anything else ends the number (`01` is
// `0`, `1.5.` is `1.5`), as in Go; the caller fails on what follows.
function consumeNumber(s: string, i: number): number {
  const m = /-?(?:0|[1-9][0-9]*)(\.[0-9]*)?([eE][+-]?[0-9]*)?/y;
  m.lastIndex = i;
  const match = m.exec(s);
  if (!match || match[0] === "" || match[0] === "-") {
    throw new JSONSyntaxError(`invalid character at offset ${i} at start of value`);
  }
  const [token, fraction, exponent] = match;
  if (fraction === "." || (exponent !== undefined && !/[0-9]$/.test(exponent))) {
    const end = i + token.length;
    throw new JSONSyntaxError(
      end >= s.length ? "unexpected EOF" : `invalid character in number at offset ${end}`,
    );
  }
  return token.length;
}

// jsonwire.ConsumeString and AppendUnquote: the unquoted value, the end
// offset and whether the input is canonical (RFC 8785). With validateUTF8
// invalid UTF-8 and lone surrogate escapes are errors; without it they
// become U+FFFD.
function scanString(s: string, start: number, validateUTF8: boolean): [string, number, boolean] {
  let i = start + 1;
  let out = "";
  let canonical = true;
  let last = i;
  for (;;) {
    if (i >= s.length) {
      throw new JSONSyntaxError("unexpected EOF");
    }
    const c = s.charCodeAt(i);
    if (c === 0x22) {
      out += s.slice(last, i);
      return [out, i + 1, canonical];
    }
    if (c < 0x20) {
      throw new JSONSyntaxError(`invalid character in string at offset ${i}`);
    }
    if (c >= 0xd800 && c <= 0xdfff) {
      const pair =
        c <= 0xdbff &&
        i + 1 < s.length &&
        s.charCodeAt(i + 1) >= 0xdc00 &&
        s.charCodeAt(i + 1) <= 0xdfff;
      if (pair) {
        i += 2;
        continue;
      }
      // a lone surrogate stands for one invalid UTF-8 byte
      if (validateUTF8) {
        throw new JSONSyntaxError("invalid UTF-8 within string");
      }
      canonical = false;
      out += s.slice(last, i) + "\ufffd";
      i++;
      last = i;
      continue;
    }
    if (c !== 0x5c) {
      i++;
      continue;
    }
    out += s.slice(last, i);
    const e = s[i + 1];
    switch (e) {
      case "/":
        canonical = false;
        out += "/";
        i += 2;
        break;
      case '"':
        out += '"';
        i += 2;
        break;
      case "\\":
        out += "\\";
        i += 2;
        break;
      case "b":
        out += "\b";
        i += 2;
        break;
      case "f":
        out += "\f";
        i += 2;
        break;
      case "n":
        out += "\n";
        i += 2;
        break;
      case "r":
        out += "\r";
        i += 2;
        break;
      case "t":
        out += "\t";
        i += 2;
        break;
      case "u": {
        const hex = s.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new JSONSyntaxError(`invalid escape sequence in string at offset ${i}`);
        }
        const v1 = Number.parseInt(hex, 16);
        if (
          v1 >= 0x20 ||
          v1 === 0x08 ||
          v1 === 0x0c ||
          v1 === 0x0a ||
          v1 === 0x0d ||
          v1 === 0x09 ||
          /[A-F]/.test(hex)
        ) {
          canonical = false;
        }
        i += 6;
        if (v1 < 0xd800 || v1 > 0xdfff) {
          out += String.fromCharCode(v1);
          break;
        }
        // a surrogate must be a high half followed by an escaped low half
        const hex2 = s.slice(i + 2, i + 6);
        const v2 =
          s[i] === "\\" && s[i + 1] === "u" && /^[0-9a-fA-F]{4}$/.test(hex2)
            ? Number.parseInt(hex2, 16)
            : -1;
        if (v1 <= 0xdbff && v2 >= 0xdc00 && v2 <= 0xdfff) {
          out += String.fromCharCode(v1, v2);
          i += 6;
          break;
        }
        if (validateUTF8) {
          throw new JSONSyntaxError(`invalid escape sequence in string at offset ${i - 6}`);
        }
        out += "\ufffd";
        break;
      }
      default:
        throw new JSONSyntaxError(`invalid escape sequence in string at offset ${i}`);
    }
    last = i;
  }
}

// ---------------------------------------------------------------------
// Decoding

// a JSON number, kept as its literal so each Go type can parse it
class NumberNode {
  constructor(readonly literal: string) {}
}

class ObjectNode {
  constructor(readonly members: [string, Node][]) {}
}

type Node = null | boolean | string | NumberNode | Node[] | ObjectNode;

export interface UnmarshalOptions {
  // encoding/json (v1) semantics: duplicate names allowed (last wins),
  // invalid UTF-8 replaced with U+FFFD
  legacy?: boolean;
  // jsontext.AllowInvalidUTF8(true): invalid UTF-8 and lone surrogate
  // escapes become U+FFFD instead of failing (duplicate names still fail)
  allowInvalidUTF8?: boolean;
  // jsontext.AllowDuplicateNames(true): a repeated object member name is
  // decoded again into the same destination (v2 merge semantics) instead
  // of failing
  allowDuplicateNames?: boolean;
}

// The Go destination types the ported code unmarshals into.
export type GoType =
  | { kind: "any" }
  | { kind: "string" }
  | { kind: "int" }
  | { kind: "int64" }
  | { kind: "float64" }
  | { kind: "bool" }
  | { kind: "slice"; elem: GoType }
  | { kind: "map"; elem: GoType };

export const anyType: GoType = { kind: "any" };
export const stringType: GoType = { kind: "string" };
export const intType: GoType = { kind: "int" };
export const int64Type: GoType = { kind: "int64" };
export const float64Type: GoType = { kind: "float64" };
export const boolType: GoType = { kind: "bool" };

export function sliceOf(elem: GoType): GoType {
  return { kind: "slice", elem };
}

export function mapOf(elem: GoType): GoType {
  return { kind: "map", elem };
}

// Converts Go bytes to text: invalid UTF-8 bytes become lone surrogates.
export function bytesToText(data: string | Uint8Array): string {
  return typeof data === "string" ? data : decodeUTF8Bytes(data);
}

// The inverse of bytesToText: the lone surrogate U+DC80+n (an invalid byte
// from decodeUTF8Bytes) becomes the byte 0x80+n, the rest is UTF-8 (other
// lone surrogates, which bytesToText never yields, become U+FFFD).
export function textToBytes(text: string): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
      }
      continue;
    }
    if (c >= 0xdc80 && c <= 0xdcff) {
      parts.push(encoder.encode(text.slice(start, i)), Uint8Array.of(c - 0xdc00));
      start = i + 1;
    }
  }
  parts.push(encoder.encode(text.slice(start)));
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

class Parser {
  i = 0;
  constructor(
    readonly s: string,
    readonly legacy: boolean,
    readonly allowInvalidUTF8 = false,
    readonly allowDuplicateNames = false,
  ) {}

  skipWhitespace(): void {
    while (this.i < this.s.length && isWhitespace(this.s.charCodeAt(this.i))) {
      this.i++;
    }
  }

  value(depth: number): Node {
    this.skipWhitespace();
    if (this.i >= this.s.length) {
      throw new JSONSyntaxError("unexpected EOF");
    }
    switch (this.s[this.i]) {
      case "{":
        return this.object(depth + 1);
      case "[":
        return this.array(depth + 1);
      case '"':
        return this.string();
      case "n":
        return this.literal("null", null);
      case "t":
        return this.literal("true", true);
      case "f":
        return this.literal("false", false);
    }
    const n = consumeNumber(this.s, this.i);
    this.i += n;
    return new NumberNode(this.s.slice(this.i - n, this.i));
  }

  literal<T>(text: string, value: T): T {
    if (!this.s.startsWith(text, this.i)) {
      throw new JSONSyntaxError(`invalid literal at offset ${this.i}`);
    }
    this.i += text.length;
    return value;
  }

  string(): string {
    const [value, end] = scanString(this.s, this.i, !this.legacy && !this.allowInvalidUTF8);
    this.i = end;
    return value;
  }

  // onElement is called for each element as soon as it is read (see
  // object)
  array(depth: number, onElement?: (value: Node) => void): Node[] {
    if (depth > maxNestingDepth) {
      throw new JSONSyntaxError("exceeded max depth");
    }
    this.i++;
    const items: Node[] = [];
    this.skipWhitespace();
    if (this.s[this.i] === "]") {
      this.i++;
      return items;
    }
    for (;;) {
      const item = this.value(depth);
      items.push(item);
      onElement?.(item);
      this.skipWhitespace();
      const c = this.s[this.i++];
      if (c === "]") {
        return items;
      }
      if (c !== ",") {
        throw new JSONSyntaxError(
          c === undefined ? "unexpected EOF" : "invalid character after array element",
        );
      }
    }
  }

  // onMember is called for each member as soon as it is read, so a caller
  // can apply members before a later syntax error, as Go's streaming
  // decoder does
  object(depth: number, onMember?: (name: string, value: Node) => void): ObjectNode {
    if (depth > maxNestingDepth) {
      throw new JSONSyntaxError("exceeded max depth");
    }
    this.i++;
    const members: [string, Node][] = [];
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.s[this.i] === "}") {
      this.i++;
      return new ObjectNode(members);
    }
    for (;;) {
      this.skipWhitespace();
      if (this.i >= this.s.length) {
        throw new JSONSyntaxError("unexpected EOF");
      }
      if (this.s[this.i] !== '"') {
        throw new JSONSyntaxError("invalid character at start of object name");
      }
      const name = this.string();
      if (!this.legacy && !this.allowDuplicateNames) {
        if (seen.has(name)) {
          throw new JSONSyntaxError(`duplicate object member name ${JSON.stringify(name)}`);
        }
        seen.add(name);
      }
      this.skipWhitespace();
      const colon = this.s[this.i++];
      if (colon !== ":") {
        throw new JSONSyntaxError(
          colon === undefined ? "unexpected EOF" : "invalid character after object name",
        );
      }
      const value = this.value(depth);
      members.push([name, value]);
      onMember?.(name, value);
      this.skipWhitespace();
      const c = this.s[this.i++];
      if (c === "}") {
        return new ObjectNode(members);
      }
      if (c !== ",") {
        throw new JSONSyntaxError(
          c === undefined ? "unexpected EOF" : "invalid character after object value",
        );
      }
    }
  }

  end(): void {
    this.skipWhitespace();
    if (this.i < this.s.length) {
      throw new JSONSyntaxError(
        `invalid character ${JSON.stringify(this.s[this.i])} after top-level value`,
      );
    }
  }
}

function parse(data: string | Uint8Array, opts: UnmarshalOptions): Node {
  const p = new Parser(
    bytesToText(data),
    opts.legacy === true,
    opts.allowInvalidUTF8 === true,
    opts.allowDuplicateNames === true,
  );
  const node = p.value(0);
  p.end();
  return node;
}

// json.Unmarshal into a new value of the Go type t. Throws on syntax
// errors and on values that do not fit t.
export function unmarshal(
  data: string | Uint8Array,
  t: GoType,
  opts: UnmarshalOptions = {},
): unknown {
  return convert(parse(data, opts), t, undefined, opts.legacy === true);
}

// json.Unmarshal into an existing map[string]T (merge semantics: existing
// members are kept, decoded members replace or merge into them). A JSON
// null leaves a nil map, returned as undefined.
export function unmarshalMapInto(
  data: string | Uint8Array,
  elem: GoType,
  existing: Record<string, unknown>,
  opts: UnmarshalOptions = {},
): Record<string, unknown> | undefined {
  const node = parse(data, opts);
  if (node === null) {
    return undefined;
  }
  return convertObject(node, elem, existing, "map", opts.legacy === true);
}

// json.Unmarshal into a Go struct whose fields are named in setters
// (case-sensitive names, unknown members ignored). Members are applied in
// order while reading, so a later error keeps earlier members, as Go's
// streaming decoder does. A member of the wrong type stops decoding (json
// v2 treats every error as fatal); with `legacy` (v1) it is skipped and
// reported after the rest are applied. A JSON null calls onNull (the
// struct's zero value).
export function unmarshalStruct(
  data: string | Uint8Array,
  setters: Record<string, (value: unknown) => void>,
  fieldTypes: Record<string, GoType>,
  onNull: () => void,
  opts: UnmarshalOptions = {},
): void {
  const p = new Parser(bytesToText(data), opts.legacy === true);
  p.skipWhitespace();
  let firstError: unknown;
  const c = p.s[p.i];
  if (c === "{") {
    p.object(1, (name, value) => {
      const set = Object.hasOwn(setters, name) ? setters[name] : undefined;
      const t = Object.hasOwn(fieldTypes, name) ? fieldTypes[name] : undefined;
      if (set === undefined || t === undefined) {
        return;
      }
      try {
        set(convert(value, t, undefined, p.legacy));
      } catch (err) {
        if (!p.legacy) {
          throw err;
        }
        firstError ??= err;
      }
    });
    p.end();
  } else {
    const node = p.value(0);
    p.end();
    if (node !== null) {
      throw new JSONSemanticError(`cannot unmarshal JSON ${kindOf(node)} into Go struct`);
    }
    onNull();
  }
  if (firstError !== undefined) {
    throw firstError;
  }
}

// json.Unmarshal into a nil []T, returning what Go leaves in the slice
// together with the error: elements are decoded as they are read, and an
// error keeps the elements before it. An element of the wrong type is left
// as T's zero value and stops decoding (json v2: every error is fatal); with
// `legacy` (v1) the remaining elements are still decoded. A JSON null or a
// non-array leaves the slice nil (undefined).
export function unmarshalSlicePartial(
  data: string | Uint8Array,
  elem: GoType,
  opts: UnmarshalOptions = {},
): [unknown[] | undefined, unknown] {
  const p = new Parser(bytesToText(data), opts.legacy === true);
  let result: unknown[] | undefined;
  let firstError: unknown;
  try {
    p.skipWhitespace();
    if (p.s[p.i] === "[") {
      result = [];
      const out = result;
      p.array(1, (node) => {
        try {
          out.push(convert(node, elem, undefined, p.legacy));
        } catch (err) {
          out.push(convert(null, elem, undefined, p.legacy));
          if (!p.legacy) {
            throw err;
          }
          firstError ??= err;
        }
      });
    } else {
      const node = p.value(0);
      if (node !== null) {
        firstError ??= mismatch(node, "slice");
      }
    }
    p.end();
  } catch (err) {
    firstError ??= err;
  }
  return [result, firstError];
}

function kindOf(node: Node): string {
  if (node === null) {
    return "null";
  }
  if (typeof node === "boolean") {
    return "boolean";
  }
  if (typeof node === "string") {
    return "string";
  }
  if (node instanceof NumberNode) {
    return "number";
  }
  if (Array.isArray(node)) {
    return "array";
  }
  return "object";
}

function mismatch(node: Node, goType: string): JSONSemanticError {
  return new JSONSemanticError(`cannot unmarshal JSON ${kindOf(node)} into Go ${goType}`);
}

// existing is the current Go value of the destination, used by `any`
// (whose dynamic type is kept when set) and maps (merged into); v1 map
// entries are always decoded from zero. legacy: v1 semantics, where a
// member of the wrong type does not stop decoding.
function convert(node: Node, t: GoType, existing: unknown, legacy: boolean): unknown {
  switch (t.kind) {
    case "any":
      return convertAny(node, existing, legacy);
    case "string":
      if (node === null) {
        return "";
      }
      if (typeof node !== "string") {
        throw mismatch(node, "string");
      }
      return node;
    case "bool":
      if (node === null) {
        return false;
      }
      if (typeof node !== "boolean") {
        throw mismatch(node, "bool");
      }
      return node;
    case "float64":
      if (node === null) {
        return 0;
      }
      if (!(node instanceof NumberNode)) {
        throw mismatch(node, "float64");
      }
      return parseFloat64(node.literal);
    case "int":
    case "int64":
      if (node === null) {
        return 0;
      }
      if (!(node instanceof NumberNode)) {
        throw mismatch(node, t.kind);
      }
      return parseInt64(node.literal, t.kind);
    case "slice": {
      if (node === null) {
        return undefined; // nil slice
      }
      if (!Array.isArray(node)) {
        throw mismatch(node, "slice");
      }
      // elements are zeroed before decoding (no merge into old elements)
      return node.map((item) => convert(item, t.elem, undefined, legacy));
    }
    case "map": {
      if (node === null) {
        return undefined; // nil map
      }
      const target =
        typeof existing === "object" && existing !== null && !Array.isArray(existing)
          ? (existing as Record<string, unknown>)
          : {};
      return convertObject(node, t.elem, target, "map", legacy);
    }
  }
}

function convertObject(
  node: Node,
  elem: GoType,
  target: Record<string, unknown>,
  goType: string,
  legacy: boolean,
): Record<string, unknown> {
  if (!(node instanceof ObjectNode)) {
    throw mismatch(node, goType);
  }
  let firstError: unknown;
  for (const [name, value] of node.members) {
    if (legacy) {
      // v1 (MergeWithLegacySemantics) zeroes an existing map entry before
      // decoding into it, so a duplicate name replaces the earlier value
      // whatever its type
      try {
        setOwn(target, name, convert(value, elem, undefined, legacy));
      } catch (err) {
        // v1: a semantic error does not stop the remaining members
        firstError ??= err;
      }
      continue;
    }
    const old = Object.hasOwn(target, name) ? target[name] : undefined;
    setOwn(target, name, convert(value, elem, old, legacy));
  }
  if (firstError !== undefined) {
    throw firstError;
  }
  return target;
}

// an interface value: a null clears it; a non-nil value keeps its dynamic
// type (a float64 stays a float64, a map is merged into, a slice is
// replaced); a nil one gets the natural type of the JSON value
function convertAny(node: Node, existing: unknown, legacy: boolean): unknown {
  if (node === null) {
    return null;
  }
  if (existing !== undefined && existing !== null) {
    switch (typeof existing) {
      case "number":
        return convert(node, float64Type, undefined, legacy);
      case "string":
        return convert(node, stringType, undefined, legacy);
      case "boolean":
        return convert(node, boolType, undefined, legacy);
    }
    if (Array.isArray(existing)) {
      return convert(node, sliceOf(anyType), undefined, legacy);
    }
    if (typeof existing === "object") {
      return convertObject(
        node,
        anyType,
        existing as Record<string, unknown>,
        "map[string]any",
        legacy,
      );
    }
  }
  if (node instanceof NumberNode) {
    return parseFloat64(node.literal);
  }
  if (Array.isArray(node)) {
    return node.map((item) => convertAny(item, undefined, legacy));
  }
  if (node instanceof ObjectNode) {
    return convertObject(node, anyType, {}, "map[string]any", legacy);
  }
  return node;
}

// strconv.ParseFloat(64): overflow is an error, underflow rounds to 0
function parseFloat64(literal: string): number {
  const n = Number(literal);
  if (!Number.isFinite(n)) {
    throw new JSONSemanticError(
      `cannot unmarshal JSON number ${literal} into Go float64: value out of range`,
    );
  }
  return n;
}

// A Go int or int64 (int is 64 bits on the platforms upstream builds for):
// a number inside Number.MAX_SAFE_INTEGER, the exact bigint outside it.
// JS comparisons between numbers and bigints are exact, so GoInt values
// compare with < and > directly; arithmetic needs the helpers below.
export type GoInt = number | bigint;

// a number for a safe integer, the bigint otherwise
export function goInt(v: bigint): GoInt {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
}

// Go's built-in max for integers
export function maxGoInt(a: GoInt, b: GoInt): GoInt {
  return a >= b ? a : b;
}

// the int arshaler: only integer digits (no fraction or exponent), in the
// int64 range
function parseInt64(literal: string, goType: string): GoInt {
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(literal)) {
    throw new JSONSemanticError(
      `cannot unmarshal JSON number ${literal} into Go ${goType}: invalid syntax`,
    );
  }
  const v = BigInt(literal);
  if (v < -(1n << 63n) || v >= 1n << 63n) {
    throw new JSONSemanticError(
      `cannot unmarshal JSON number ${literal} into Go ${goType}: value out of range`,
    );
  }
  return goInt(v);
}

// Sets an own enumerable property, also for names like "__proto__".
export function setOwn(target: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(target, name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
