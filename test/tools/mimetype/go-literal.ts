// Go string literals in the ported gabriel-vasile/mimetype tests.
//
// g`...` takes the body of a Go interpreted ("...") string literal as raw
// template text, escapes included, and returns its bytes: \xNN is the byte
// NN and other characters are UTF-8, as in Go. `raw` is a Go raw (`...`)
// string literal: plain UTF-8.

import { textToBytes } from "@/tools/types/go-json";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "@test/support/reference-tools";
import { unquote } from "@test/tools/regexp/go-quote";

export function g(s: TemplateStringsArray): Uint8Array {
  return textToBytes(unquote(`"${s.raw[0] ?? ""}"`));
}

export function raw(s: string): Uint8Array {
  return textToBytes(s);
}

// []byte(s) of a Go string built byte by byte (each char code below 0x100).
export function bin(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export const fixturesDir = join(repoRoot, "test/fixtures/mimetype");

// fromDisk in mimetype_test.go: a file from mimetype's testdata.
export function disk(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(fixturesDir, name)));
}
