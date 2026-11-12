// iglo.base's own parser for the schema file (D40). Not an upstream file.
//
// JSON.parse keeps neither the order of an object's keys (it moves
// integer-like keys first) nor duplicate keys (it keeps the last one), and
// the schema file relies on both: a field's position is its place in the
// file, and a duplicated name is an error. This parser keeps every member
// in the order it is written, duplicates included, so the reader can report
// them with their path. Numbers are read with the same grammar as JSON.parse
// and checked for finiteness only; the reader checks their range.

export type JSONNode =
  | { kind: "object"; members: { key: string; value: JSONNode }[] }
  | { kind: "array"; items: JSONNode[] }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" };

// A syntax error, with the line and column (both from 1) of the character
// where the text stopped being JSON.
export class JSONSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`line ${line}, column ${column}: ${message}`);
  }
}

// The members of a JSON object as a plain record (first occurrence wins
// for a duplicated key; use the members to see every one).
export function objectValue(node: JSONNode): Map<string, JSONNode> {
  const map = new Map<string, JSONNode>();
  if (node.kind === "object") {
    for (const member of node.members) {
      if (!map.has(member.key)) {
        map.set(member.key, member.value);
      }
    }
  }
  return map;
}

const whitespace = new Set([" ", "\t", "\n", "\r"]);

class Parser {
  private pos = 0;

  constructor(private readonly text: string) {}

  parseDocument(): JSONNode {
    this.skipWhitespace();
    const node = this.parseValue();
    this.skipWhitespace();
    if (this.pos < this.text.length) {
      throw this.error("unexpected text after the JSON value");
    }
    return node;
  }

  private error(message: string, at = this.pos): JSONSyntaxError {
    let line = 1;
    let column = 1;
    for (let i = 0; i < at && i < this.text.length; i++) {
      if (this.text[i] === "\n") {
        line++;
        column = 1;
      } else {
        column++;
      }
    }
    return new JSONSyntaxError(message, line, column);
  }

  private skipWhitespace(): void {
    while (this.pos < this.text.length && whitespace.has(this.text[this.pos] ?? "")) {
      this.pos++;
    }
  }

  private parseValue(): JSONNode {
    const ch = this.text[this.pos];
    switch (ch) {
      case "{":
        return this.parseObject();
      case "[":
        return this.parseArray();
      case '"':
        return { kind: "string", value: this.parseString() };
      case "t":
        return this.parseLiteral("true", { kind: "boolean", value: true });
      case "f":
        return this.parseLiteral("false", { kind: "boolean", value: false });
      case "n":
        return this.parseLiteral("null", { kind: "null" });
      case undefined:
        throw this.error("unexpected end of the file");
      default:
        if (ch === "-" || (ch !== undefined && ch >= "0" && ch <= "9")) {
          return this.parseNumber();
        }
        throw this.error(`unexpected character ${JSON.stringify(ch)}`);
    }
  }

  private parseLiteral(word: string, node: JSONNode): JSONNode {
    if (this.text.startsWith(word, this.pos)) {
      this.pos += word.length;
      return node;
    }
    throw this.error(`invalid literal, expected ${word}`);
  }

  private parseNumber(): JSONNode {
    const numberPattern = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
    numberPattern.lastIndex = this.pos;
    const match = numberPattern.exec(this.text);
    if (!match) {
      throw this.error("invalid number");
    }
    const raw = match[0];
    this.pos += raw.length;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw this.error("number out of range", this.pos - raw.length);
    }
    return { kind: "number", value };
  }

  private parseString(): string {
    const start = this.pos;
    this.pos++; // opening quote
    let out = "";
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined) {
        throw this.error("unterminated string", start);
      }
      if (ch === '"') {
        this.pos++;
        return out;
      }
      if (ch.charCodeAt(0) < 0x20) {
        throw this.error("control character in a string");
      }
      if (ch !== "\\") {
        out += ch;
        this.pos++;
        continue;
      }
      const escape = this.text[this.pos + 1];
      this.pos += 2;
      switch (escape) {
        case '"':
        case "\\":
        case "/":
          out += escape;
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const hex = this.text.slice(this.pos, this.pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw this.error("invalid \\u escape", this.pos - 2);
          }
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.pos += 4;
          break;
        }
        default:
          throw this.error("invalid escape in a string", this.pos - 1);
      }
    }
  }

  private parseObject(): JSONNode {
    this.pos++; // {
    const members: { key: string; value: JSONNode }[] = [];
    this.skipWhitespace();
    if (this.text[this.pos] === "}") {
      this.pos++;
      return { kind: "object", members };
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.pos] !== '"') {
        throw this.error("expected a string key in the object");
      }
      const key = this.parseString();
      this.skipWhitespace();
      if (this.text[this.pos] !== ":") {
        throw this.error("expected ':' after the key");
      }
      this.pos++;
      this.skipWhitespace();
      members.push({ key, value: this.parseValue() });
      this.skipWhitespace();
      const sep = this.text[this.pos];
      if (sep === ",") {
        this.pos++;
        continue;
      }
      if (sep === "}") {
        this.pos++;
        return { kind: "object", members };
      }
      throw this.error("expected ',' or '}' in the object");
    }
  }

  private parseArray(): JSONNode {
    this.pos++; // [
    const items: JSONNode[] = [];
    this.skipWhitespace();
    if (this.text[this.pos] === "]") {
      this.pos++;
      return { kind: "array", items };
    }
    for (;;) {
      this.skipWhitespace();
      items.push(this.parseValue());
      this.skipWhitespace();
      const sep = this.text[this.pos];
      if (sep === ",") {
        this.pos++;
        continue;
      }
      if (sep === "]") {
        this.pos++;
        return { kind: "array", items };
      }
      throw this.error("expected ',' or ']' in the array");
    }
  }
}

// Parses the text of a JSON document, keeping the order and every duplicate
// of its object members. A leading byte order mark is skipped.
export function parseJSONTree(text: string): JSONNode {
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  return new Parser(body).parseDocument();
}
