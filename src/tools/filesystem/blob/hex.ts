// Upstream: tools/filesystem/blob/hex.go (copied there from gocloud.dev/blob,
// Apache License 2.0, Copyright 2019 The Go Cloud Development Kit Authors)
//
// Runes are Unicode code points (a Go []rune of the string): an invalid
// byte of a Go string (a lone surrogate U+DC80+n, see
// src/tools/types/go-json.ts) is U+FFFD, as Go's []rune(s) gives.

// HexEscape returns s, with all runes for which shouldEscape returns true
// escaped to "__0xXXX__", where XXX is the hex representation of the rune
// value. For example, " " would escape to "__0x20__".
//
// Non-UTF-8 strings will have their non-UTF-8 characters escaped to
// unicode.ReplacementChar; the original value is lost.
//
// Note: shouldEscape takes the whole string as a slice of runes and an
// index. Passing it a single byte or a single rune doesn't provide enough
// context for some escape decisions; for example, the caller might want to
// escape the second "/" in "//" but not the first one.
export function HexEscape(s: string, shouldEscape: (s: number[], i: number) => boolean): string {
  // Do a first pass to see which runes (if any) need escaping.
  const runes = toRunes(s);
  const toEscape = new Set<number>();
  for (let i = 0; i < runes.length; i++) {
    if (shouldEscape(runes, i)) {
      toEscape.add(i);
    }
  }
  if (toEscape.size === 0) {
    return s;
  }

  let escaped = "";
  for (let i = 0; i < runes.length; i++) {
    const r = runes[i] as number;
    if (toEscape.has(i)) {
      // We were asked to escape this rune (fmt's "%#x": "0x" and lower-case hex).
      escaped += `__0x${r.toString(16)}__`;
    } else {
      escaped += String.fromCodePoint(r);
    }
  }

  return escaped;
}

// unescape tries to unescape starting at r[i].
// It returns a boolean indicating whether the unescaping was successful,
// and (if true) the unescaped rune and the last index of r that was used
// during unescaping.
function unescape(r: number[], i: number): [boolean, number, number] {
  const underscore = 0x5f;
  // Look for "__0x".
  if (r[i] !== underscore) {
    return [false, 0, 0];
  }
  i++;
  if (i >= r.length || r[i] !== underscore) {
    return [false, 0, 0];
  }
  i++;
  if (i >= r.length || r[i] !== 0x30) {
    return [false, 0, 0];
  }
  i++;
  if (i >= r.length || r[i] !== 0x78) {
    return [false, 0, 0];
  }
  i++;

  // Capture the digits until the next "_" (if any).
  const hexdigits: number[] = [];
  for (; i < r.length && r[i] !== underscore; i++) {
    hexdigits.push(r[i] as number);
  }

  // Look for the trailing "__".
  if (i >= r.length || r[i] !== underscore) {
    return [false, 0, 0];
  }
  i++;
  if (i >= r.length || r[i] !== underscore) {
    return [false, 0, 0];
  }

  // Parse the hex digits into an int32.
  const retval = parseInt32Hex(String.fromCodePoint(...hexdigits));
  if (retval === null) {
    return [false, 0, 0];
  }

  return [true, retval, i];
}

// strconv.ParseInt(s, 16, 32): an optional sign, hex digits (with "_"
// separators only after a base prefix, which base 16 does not allow), and
// the int32 range
function parseInt32Hex(s: string): number | null {
  let digits = s;
  let neg = false;
  if (digits.startsWith("+") || digits.startsWith("-")) {
    neg = digits[0] === "-";
    digits = digits.slice(1);
  }
  if (digits === "" || !/^[0-9a-fA-F]+$/.test(digits)) {
    return null;
  }
  const v = BigInt("0x" + digits) * (neg ? -1n : 1n);
  if (v < -(2n ** 31n) || v > 2n ** 31n - 1n) {
    return null;
  }
  return Number(v);
}

// HexUnescape reverses HexEscape.
export function HexUnescape(s: string): string {
  let unescaped: number[] | null = null;

  const runes = toRunes(s);
  for (let i = 0; i < runes.length; i++) {
    const [ok, newR, newI] = unescape(runes, i);
    if (ok) {
      // We unescaped some runes starting at i, resulting in the
      // unescaped rune newR. The last rune used was newI.
      if (unescaped === null) {
        // This is the first rune we've encountered that needed
        // unescaping. Copy any previous runes.
        unescaped = runes.slice(0, i);
      }
      unescaped.push(newR);
      i = newI;
    } else if (unescaped !== null) {
      unescaped.push(runes[i] as number);
    }
  }

  if (unescaped === null) {
    return s;
  }

  return runesToString(unescaped);
}

// []rune(s): invalid bytes and lone surrogates become U+FFFD
function toRunes(s: string): number[] {
  const runes: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    runes.push(c >= 0xd800 && c <= 0xdfff ? 0xfffd : c);
  }
  return runes;
}

// string(runes): a rune outside the valid range (a negative, a surrogate or
// a too large value) becomes U+FFFD
function runesToString(runes: number[]): string {
  let out = "";
  for (const r of runes) {
    out += String.fromCodePoint(r < 0 || r > 0x10ffff || (r >= 0xd800 && r <= 0xdfff) ? 0xfffd : r);
  }
  return out;
}
