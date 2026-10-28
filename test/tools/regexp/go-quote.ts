// Upstream: Go go1.27.2 src/strconv/quote.go (Unquote of a double-quoted
// string), for the quoted strings of Go's regexp test data.
//
// The result is Go's bytes in the string form of src/tools/unicode/utf8.ts
// (an invalid UTF-8 byte is the lone surrogate U+DC80+n).

import { bytesToText } from "@/tools/types/go-json";

const encoder = new TextEncoder();

const simpleEscapes: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  "\\": 0x5c,
  "'": 0x27,
  '"': 0x22,
};

// unquote parses a Go double-quoted string literal; it throws on a
// malformed one.
export function unquote(q: string): string {
  if (q.length < 2 || q[0] !== '"' || q[q.length - 1] !== '"') {
    throw new Error(`invalid quoted string ${q}`);
  }
  const s = q.slice(1, -1);
  const bytes: number[] = [];
  const pushText = (t: string): void => {
    for (const b of encoder.encode(t)) {
      bytes.push(b);
    }
  };
  for (let i = 0; i < s.length;) {
    const c = s[i] as string;
    if (c === '"' || c === "\n") {
      throw new Error(`invalid quoted string ${q}`);
    }
    if (c !== "\\") {
      const cp = s.codePointAt(i) as number;
      const ch = String.fromCodePoint(cp);
      pushText(ch);
      i += ch.length;
      continue;
    }
    const e = s[i + 1] as string;
    i += 2;
    if (e in simpleEscapes) {
      if (e === "'") {
        throw new Error(`invalid quoted string ${q}`);
      }
      bytes.push(simpleEscapes[e] as number);
      continue;
    }
    switch (e) {
      case "x":
        bytes.push(hex(s.slice(i, i + 2), q));
        i += 2;
        break;
      case "u":
      case "U": {
        const n = e === "u" ? 4 : 8;
        const r = hex(s.slice(i, i + n), q);
        if (r > 0x10ffff || (r >= 0xd800 && r <= 0xdfff)) {
          throw new Error(`invalid quoted string ${q}`);
        }
        pushText(String.fromCodePoint(r));
        i += n;
        break;
      }
      default: {
        if (e >= "0" && e <= "7") {
          const v = Number.parseInt(s.slice(i - 1, i + 2), 8);
          if (!/^[0-7]{3}$/.test(s.slice(i - 1, i + 2)) || v > 255) {
            throw new Error(`invalid quoted string ${q}`);
          }
          bytes.push(v);
          i += 2;
          break;
        }
        throw new Error(`invalid quoted string ${q}`);
      }
    }
  }
  return bytesToText(Uint8Array.from(bytes));
}

function hex(s: string, q: string): number {
  if (!/^[0-9a-fA-F]+$/.test(s)) {
    throw new Error(`invalid quoted string ${q}`);
  }
  return Number.parseInt(s, 16);
}
