// A strict JSON parser that keeps the source text of every value, and Go's
// jsontext reformatting that tests/api.go applies to a response body before
// its substring checks (Go 1.27 encoding/json/jsontext Encoder.WriteValue
// with default options, internal/jsonwire AppendQuote).
//
// JSON.parse is not used for values: it loses number text and key order.

export type JsonNode =
  | { kind: "null" | "true" | "false" | "number"; raw: string }
  | { kind: "string"; raw: string; value: string }
  | { kind: "array"; raw: string; items: JsonNode[] }
  | { kind: "object"; raw: string; entries: [name: string, value: JsonNode][] };

export class JsonSyntaxError extends Error {}

// Parses one JSON value with optional surrounding whitespace.
export function parseJson(text: string): JsonNode {
  const parser = new Parser(text);
  parser.skipWhitespace();
  const node = parser.value();
  parser.skipWhitespace();
  if (parser.pos !== text.length) {
    parser.fail("after top-level value");
  }
  return node;
}

const numberPattern = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
// a string literal: no raw control characters, only valid escapes
// oxlint-disable-next-line no-control-regex
const stringPattern = /"(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/y;

class Parser {
  pos = 0;

  constructor(private readonly text: string) {}

  fail(what: string): never {
    throw new JsonSyntaxError(`invalid JSON ${what} at offset ${this.pos}`);
  }

  skipWhitespace(): void {
    while (this.pos < this.text.length && " \t\n\r".includes(this.text[this.pos] ?? "")) {
      this.pos++;
    }
  }

  value(): JsonNode {
    const start = this.pos;
    const c = this.text[this.pos];
    if (c === "{") {
      return this.object(start);
    }
    if (c === "[") {
      return this.array(start);
    }
    if (c === '"') {
      const raw = this.match(stringPattern, "string");
      return { kind: "string", raw, value: JSON.parse(raw) as string };
    }
    for (const literal of ["null", "true", "false"] as const) {
      if (this.text.startsWith(literal, this.pos)) {
        this.pos += literal.length;
        return { kind: literal, raw: literal };
      }
    }
    return { kind: "number", raw: this.match(numberPattern, "value") };
  }

  private match(pattern: RegExp, what: string): string {
    pattern.lastIndex = this.pos;
    const m = pattern.exec(this.text);
    if (!m) {
      this.fail(what);
    }
    this.pos += m[0].length;
    return m[0];
  }

  private expect(c: string): void {
    if (this.text[this.pos] !== c) {
      this.fail(`character, expected ${JSON.stringify(c)}`);
    }
    this.pos++;
  }

  private object(start: number): JsonNode {
    const entries: [string, JsonNode][] = [];
    this.pos++;
    this.skipWhitespace();
    if (this.text[this.pos] !== "}") {
      for (;;) {
        this.skipWhitespace();
        const name = this.match(stringPattern, "object name");
        this.skipWhitespace();
        this.expect(":");
        this.skipWhitespace();
        entries.push([JSON.parse(name) as string, this.value()]);
        this.skipWhitespace();
        if (this.text[this.pos] !== ",") {
          break;
        }
        this.pos++;
      }
    }
    this.expect("}");
    return { kind: "object", raw: this.text.slice(start, this.pos), entries };
  }

  private array(start: number): JsonNode {
    const items: JsonNode[] = [];
    this.pos++;
    this.skipWhitespace();
    if (this.text[this.pos] !== "]") {
      for (;;) {
        this.skipWhitespace();
        items.push(this.value());
        this.skipWhitespace();
        if (this.text[this.pos] !== ",") {
          break;
        }
        this.pos++;
      }
    }
    this.expect("]");
    return { kind: "array", raw: this.text.slice(start, this.pos), items };
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// The body text tests/api.go runs ExpectedContent and NotExpectedContent
// against: a valid JSON body reformatted as Go's jsontext does (no
// whitespace, strings in their shortest escaping, numbers verbatim, a
// trailing newline), otherwise the body unchanged. Invalid UTF-8 and
// duplicate object names are errors for jsontext, so such a body stays
// unchanged too.
export function goNormalizedBody(body: Uint8Array): Uint8Array {
  let node: JsonNode;
  try {
    node = parseJson(utf8.decode(body));
  } catch {
    return body;
  }
  const out: string[] = [];
  if (!appendGo(node, out)) {
    return body;
  }
  out.push("\n");
  return new TextEncoder().encode(out.join(""));
}

// false on a duplicate object name
function appendGo(node: JsonNode, out: string[]): boolean {
  switch (node.kind) {
    case "string":
      out.push(goQuote(node.value));
      return true;
    case "array":
      out.push("[");
      for (const [i, item] of node.items.entries()) {
        if (i > 0) {
          out.push(",");
        }
        if (!appendGo(item, out)) {
          return false;
        }
      }
      out.push("]");
      return true;
    case "object": {
      const names = new Set<string>();
      out.push("{");
      for (const [i, [name, value]] of node.entries.entries()) {
        if (names.has(name)) {
          return false;
        }
        names.add(name);
        out.push(i > 0 ? "," : "", goQuote(name), ":");
        if (!appendGo(value, out)) {
          return false;
        }
      }
      out.push("}");
      return true;
    }
    default:
      out.push(node.raw);
      return true;
  }
}

// jsonwire.AppendQuote without EscapeForHTML and EscapeForJS: only `"`,
// `\` and control characters are escaped. Lone surrogates, which Go
// decodes to U+FFFD, become U+FFFD.
function goQuote(value: string): string {
  let out = '"';
  for (const ch of value.toWellFormed()) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"' || ch === "\\") {
      out += `\\${ch}`;
    } else if (code < 0x20) {
      out += shortEscapes[ch] ?? `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  return `${out}"`;
}

const shortEscapes: Record<string, string> = {
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};
