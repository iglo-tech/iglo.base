// Upstream: Go's encoding/json/v2 decoding rules as used by
// tools/router (Event.BindBody with jsontext.Decoder and
// MatchCaseInsensitiveNames, UnmarshalRequestData's @jsonPayload with
// json.Unmarshal).
//
// A small strict parser: like jsontext it rejects duplicate object names
// and invalid UTF-8 escapes, and decodeFirstValue reads only the first JSON
// value of the input, as a jsontext.Decoder does.

// a JSON number, kept as its literal so integer targets can be checked
export class JsonNumber {
  constructor(readonly literal: string) {}
}

export type JsonValue =
  | null
  | boolean
  | string
  | JsonNumber
  | JsonValue[]
  | { kind: "object"; members: [string, JsonValue][] };

export class JsonSyntaxError extends Error {
  constructor(message: string) {
    super(`jsontext: ${message}`);
    this.name = "JsonSyntaxError";
  }
}

// io.EOF / io.ErrUnexpectedEOF for an input without a complete value
export class JsonEOFError extends Error {
  constructor(unexpected: boolean) {
    super(unexpected ? "unexpected EOF" : "EOF");
    this.name = "JsonEOFError";
  }
}

const whitespace = new Set([" ", "\t", "\n", "\r"]);

class Parser {
  i = 0;
  constructor(readonly s: string) {}

  skipWhitespace(): void {
    while (this.i < this.s.length && whitespace.has(this.s[this.i] as string)) {
      this.i++;
    }
  }

  value(): JsonValue {
    this.skipWhitespace();
    if (this.i >= this.s.length) {
      throw new JsonEOFError(true);
    }
    const c = this.s[this.i];
    switch (c) {
      case "{":
        return this.object();
      case "[":
        return this.array();
      case '"':
        return this.string();
      case "t":
        return this.literal("true", true);
      case "f":
        return this.literal("false", false);
      case "n":
        return this.literal("null", null);
      default:
        if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) {
          return this.number();
        }
        throw new JsonSyntaxError(`invalid character ${JSON.stringify(c)} at start of value`);
    }
  }

  literal<T>(text: string, value: T): T {
    const got = this.s.slice(this.i, this.i + text.length);
    if (got !== text) {
      if (text.startsWith(got) && this.i + got.length >= this.s.length) {
        throw new JsonEOFError(true);
      }
      throw new JsonSyntaxError(`invalid literal at offset ${this.i}`);
    }
    this.i += text.length;
    return value;
  }

  number(): JsonNumber {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      this.s.slice(this.i),
    );
    if (!match || match[0] === "-") {
      throw new JsonSyntaxError(`invalid number at offset ${this.i}`);
    }
    this.i += match[0].length;
    const next = this.s[this.i];
    if (next !== undefined && /[0-9.eE+-]/.test(next)) {
      throw new JsonSyntaxError(`invalid number at offset ${this.i}`);
    }
    return new JsonNumber(match[0]);
  }

  string(): string {
    const start = this.i;
    this.i++; // opening quote
    let out = "";
    for (;;) {
      if (this.i >= this.s.length) {
        throw new JsonEOFError(true);
      }
      const c = this.s[this.i] as string;
      if (c === '"') {
        this.i++;
        return out;
      }
      if (c < " ") {
        throw new JsonSyntaxError(`invalid control character in string at offset ${this.i}`);
      }
      if (c !== "\\") {
        out += c;
        this.i++;
        continue;
      }
      const e = this.s[this.i + 1];
      if (e === undefined) {
        throw new JsonEOFError(true);
      }
      const simple: Record<string, string> = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      if (e in simple) {
        out += simple[e];
        this.i += 2;
        continue;
      }
      if (e !== "u") {
        throw new JsonSyntaxError(`invalid escape sequence in string at offset ${this.i}`);
      }
      const code = this.hex4(this.i + 2);
      this.i += 6;
      if (code >= 0xd800 && code <= 0xdbff) {
        // a high surrogate must be followed by an escaped low surrogate;
        // an input that ends within a possible one is truncated
        // (jsonwire's hasEscapedUTF16Prefix)
        const next = this.s.slice(this.i, this.i + 6);
        if (/^\\u[dD][c-fC-F][0-9a-fA-F]{2}$/.test(next)) {
          out += String.fromCharCode(code, Number.parseInt(next.slice(2), 16));
          this.i += 6;
          continue;
        }
        if (next.length < 6 && isLowSurrogateEscapePrefix(next)) {
          throw new JsonEOFError(true);
        }
        throw new JsonSyntaxError(`invalid surrogate pair in string at offset ${start}`);
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        // a low surrogate cannot start a pair, but an input that ends
        // within a possible escape after it is truncated all the same
        const next = this.s.slice(this.i, this.i + 6);
        if (next.length < 6 && isLowSurrogateEscapePrefix(next)) {
          throw new JsonEOFError(true);
        }
        throw new JsonSyntaxError(`invalid surrogate pair in string at offset ${start}`);
      }
      out += String.fromCharCode(code);
    }
  }

  hex4(at: number): number {
    const hex = this.s.slice(at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      if (at + hex.length >= this.s.length && /^[0-9a-fA-F]*$/.test(hex)) {
        throw new JsonEOFError(true);
      }
      throw new JsonSyntaxError(`invalid escape sequence in string at offset ${at - 2}`);
    }
    return Number.parseInt(hex, 16);
  }

  array(): JsonValue[] {
    this.i++; // [
    const out: JsonValue[] = [];
    this.skipWhitespace();
    if (this.s[this.i] === "]") {
      this.i++;
      return out;
    }
    for (;;) {
      out.push(this.value());
      this.skipWhitespace();
      const c = this.s[this.i];
      if (c === undefined) {
        throw new JsonEOFError(true);
      }
      this.i++;
      if (c === "]") {
        return out;
      }
      if (c !== ",") {
        throw new JsonSyntaxError(`invalid character ${JSON.stringify(c)} after array element`);
      }
    }
  }

  object(): JsonValue {
    this.i++; // {
    const members: [string, JsonValue][] = [];
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.s[this.i] === "}") {
      this.i++;
      return { kind: "object", members };
    }
    for (;;) {
      this.skipWhitespace();
      const c = this.s[this.i];
      if (c === undefined) {
        throw new JsonEOFError(true);
      }
      if (c !== '"') {
        throw new JsonSyntaxError(`invalid character ${JSON.stringify(c)} at start of name`);
      }
      const name = this.string();
      if (seen.has(name)) {
        throw new JsonSyntaxError(`duplicate object member name ${JSON.stringify(name)}`);
      }
      seen.add(name);
      this.skipWhitespace();
      const colon = this.s[this.i];
      if (colon === undefined) {
        throw new JsonEOFError(true);
      }
      if (colon !== ":") {
        throw new JsonSyntaxError(`invalid character ${JSON.stringify(colon)} after object name`);
      }
      this.i++;
      members.push([name, this.value()]);
      this.skipWhitespace();
      const sep = this.s[this.i];
      if (sep === undefined) {
        throw new JsonEOFError(true);
      }
      this.i++;
      if (sep === "}") {
        return { kind: "object", members };
      }
      if (sep !== ",") {
        throw new JsonSyntaxError(`invalid character ${JSON.stringify(sep)} after object value`);
      }
    }
  }
}

// whether s is a prefix of an escaped low surrogate (\uDC00 to \uDFFF)
function isLowSurrogateEscapePrefix(s: string): boolean {
  return /^(?:\\(?:u(?:[dD](?:[c-fC-F][0-9a-fA-F]{0,2})?)?)?)?$/.test(s);
}

// Decodes the first JSON value of text and ignores what follows it, as a
// single jsontext.Decoder read does. An input with only whitespace fails
// with EOF. text comes from decodeUTF8Bytes: only the consumed value must
// be valid UTF-8, so invalid bytes after it are ignored.
export function decodeFirstValue(text: string): JsonValue {
  const p = new Parser(text);
  p.skipWhitespace();
  if (p.i >= text.length) {
    throw new JsonEOFError(false);
  }
  const value = p.value();
  if (hasInvalidUTF8(text.slice(0, p.i))) {
    throw new JsonSyntaxError("invalid UTF-8 within string");
  }
  return value;
}

// Decodes bytes as Go reads them: a leading BOM is kept, and each byte that
// utf8.DecodeRune rejects (RuneError of size 1) becomes the lone surrogate
// U+DC00+byte. Valid UTF-8 never yields a lone surrogate, so decoders can
// reject invalid UTF-8 only where Go checks it (hasInvalidUTF8).
export function decodeUTF8Bytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    // fall through to the byte-by-byte decoder
  }
  let out = "";
  let chunk: number[] = [];
  for (let i = 0; i < bytes.length;) {
    const [r, size] = decodeRune(bytes, i);
    chunk.push(r);
    i += size;
    if (chunk.length >= 4096) {
      out += String.fromCodePoint(...chunk);
      chunk = [];
    }
  }
  return out + String.fromCodePoint(...chunk);
}

// utf8.DecodeRune at bytes[i]; an invalid byte gives [0xdc00 + byte, 1]
function decodeRune(bytes: Uint8Array, i: number): [number, number] {
  const b0 = bytes[i] as number;
  if (b0 < 0x80) {
    return [b0, 1];
  }
  const invalid: [number, number] = [0xdc00 + b0, 1];
  // utf8 first and acceptRanges: sequence size and the second byte's range
  let size: number;
  let lo = 0x80;
  let hi = 0xbf;
  if (b0 >= 0xc2 && b0 <= 0xdf) {
    size = 2;
  } else if (b0 >= 0xe0 && b0 <= 0xef) {
    size = 3;
    if (b0 === 0xe0) {
      lo = 0xa0;
    } else if (b0 === 0xed) {
      hi = 0x9f;
    }
  } else if (b0 >= 0xf0 && b0 <= 0xf4) {
    size = 4;
    if (b0 === 0xf0) {
      lo = 0x90;
    } else if (b0 === 0xf4) {
      hi = 0x8f;
    }
  } else {
    return invalid;
  }
  if (i + size > bytes.length) {
    return invalid;
  }
  const b1 = bytes[i + 1] as number;
  if (b1 < lo || b1 > hi) {
    return invalid;
  }
  let r = b0 & (0xff >> (size + 1));
  r = (r << 6) | (b1 & 0x3f);
  for (let k = 2; k < size; k++) {
    const b = bytes[i + k] as number;
    if (b < 0x80 || b > 0xbf) {
      return invalid;
    }
    r = (r << 6) | (b & 0x3f);
  }
  return [r, size];
}

// whether text from decodeUTF8Bytes held invalid UTF-8 (a lone surrogate)
export function hasInvalidUTF8(text: string): boolean {
  return /[\ud800-\udfff]/u.test(text);
}

// Decodes text that must hold exactly one JSON value (json.Unmarshal).
export function decodeValue(text: string): JsonValue {
  const p = new Parser(text);
  p.skipWhitespace();
  if (p.i >= text.length) {
    throw new JsonEOFError(false);
  }
  const value = p.value();
  p.skipWhitespace();
  if (p.i < text.length) {
    throw new JsonSyntaxError(
      `invalid character ${JSON.stringify(text[p.i])} after top-level value`,
    );
  }
  return value;
}

export function isJsonObject(
  value: JsonValue,
): value is { kind: "object"; members: [string, JsonValue][] } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof JsonNumber)
  );
}

// The value as unmarshaled into a Go `any`: objects become plain objects,
// numbers float64.
export function toAny(value: JsonValue): unknown {
  if (value instanceof JsonNumber) {
    const n = Number(value.literal);
    if (!Number.isFinite(n)) {
      // out of float64 range: json/v2 fails instead of storing ±Inf
      throw new Error("json: cannot unmarshal JSON number into Go float64");
    }
    return n;
  }
  if (Array.isArray(value)) {
    return value.map(toAny);
  }
  if (isJsonObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [name, member] of value.members) {
      setOwn(out, name, toAny(member));
    }
    return out;
  }
  return value;
}

// Sets an own enumerable property, also for names like "__proto__".
export function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}
