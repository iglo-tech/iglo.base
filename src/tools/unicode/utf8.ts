// Upstream: Go go1.27.2 src/unicode/utf8/utf8.go (DecodeRuneInString,
// RuneError, RuneSelf, ValidRune) and the string(rune) conversion of the Go
// spec.
//
// Go strings are bytes; here they are JS strings in which an invalid UTF-8
// byte 0x80+n is the lone surrogate U+DC80+n (bytesToText in
// src/tools/types/go-json.ts). A string is first made into that form with
// goString, so no other lone surrogate is left.

import { bytesToText, textToBytes } from "@/tools/types/go-json";

export const RuneError = 0xfffd; // the "error" Rune or "Unicode replacement character"
export const RuneSelf = 0x80; // characters below RuneSelf are represented as themselves in a single byte.
export const MaxRune = 0x10ffff; // Maximum valid Unicode code point.

const surrogate = /[\ud800-\udfff]/;

// goString normalizes a JS string or bytes to the Go string form above:
// bytes are decoded with invalid bytes as lone surrogates, and a lone
// surrogate outside U+DC80..U+DCFF (which a Go string cannot hold) becomes
// U+FFFD, as textToBytes does.
export function goString(s: string | Uint8Array): string {
  if (typeof s !== "string") {
    return bytesToText(s);
  }
  return surrogate.test(s) ? bytesToText(textToBytes(s)) : s;
}

// DecodeRuneInString unpacks the first UTF-8 encoding in s and returns the
// rune and its width in UTF-16 code units. An invalid byte gives
// (RuneError, 1) and the empty string (RuneError, 0), as in Go.
export function DecodeRuneInString(s: string): [rune: number, size: number] {
  if (s === "") {
    return [RuneError, 0];
  }
  const c = s.codePointAt(0) as number;
  if (c >= 0xdc80 && c <= 0xdcff) {
    return [RuneError, 1];
  }
  return [c, c > 0xffff ? 2 : 1];
}

// ValidRune reports whether r can be legally encoded as UTF-8. Code points
// that are out of range or a surrogate half are illegal.
export function ValidRune(r: number): boolean {
  return (r >= 0 && r < 0xd800) || (r > 0xdfff && r <= MaxRune);
}

// string(rune): the UTF-8 of r, or of U+FFFD when r is not a valid rune.
export function runeString(r: number): string {
  return String.fromCodePoint(ValidRune(r) ? r : RuneError);
}

// string([]rune): each rune as runeString.
export function runesString(runes: readonly number[]): string {
  let out = "";
  for (const r of runes) {
    out += runeString(r);
  }
  return out;
}
