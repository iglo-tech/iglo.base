// Upstream: Go go1.27.2 src/strings/strings.go (ToLower, EqualFold,
// TrimSpace, Trim), src/unicode/letter.go (ToLower) and
// src/unicode/graphic.go (IsSpace)
//
// The collection validator and queries lower names with Go's
// strings.ToLower and compare them with strings.EqualFold. JS's
// toLowerCase follows SpecialCasing.txt (U+0130 lowers to "i" + U+0307,
// a final sigma to U+03C2) and the engine's Unicode version, so it gives
// other results than Go for some names, which changes validation errors
// (checkForVia runs before the name pattern check). These use Go's case
// tables from src/tools/unicode/tables.ts (Unicode 17.0.0, go1.27.2).
//
// src/tools/unicode/letter.ts decodes the same table but exports only
// SimpleFold; unicode.ToLower belongs there (reported for the lead).

import { CaseRanges as caseRangesText } from "@/tools/unicode/tables";
import { SimpleFold } from "@/tools/unicode/letter";

const MaxRune = 0x10ffff;
const MaxASCII = 0x7f;
const RuneError = 0xfffd;
const LowerCase = 1;
const UpperLower = MaxRune + 1;

// lo, hi and the UpperCase, LowerCase and TitleCase deltas
type CaseRange = [lo: number, hi: number, upper: number, lower: number, title: number];

let caseRanges: CaseRange[] | undefined;

function decodeCaseRanges(): CaseRange[] {
  return caseRangesText.split(",").map((item) => {
    const [lo = "", hi = "", ...deltas] = item.split(" ");
    const d = deltas.map((delta) => (delta === "UL" ? UpperLower : Number(delta)));
    return [Number.parseInt(lo, 16), Number.parseInt(hi, 16), d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
  });
}

// unicode.to(LowerCase, r, CaseRanges)
function toLowerCase(r: number): number {
  caseRanges ??= decodeCaseRanges();
  // binary search over ranges
  let lo = 0;
  let hi = caseRanges.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    const cr = caseRanges[m] as CaseRange;
    if (cr[0] <= r && r <= cr[1]) {
      const delta = cr[2 + LowerCase] as number;
      if (delta > MaxRune) {
        // In an Upper-Lower sequence, which always starts with an UpperCase
        // letter, the characters at even offsets from the beginning of the
        // sequence are upper case; the ones at odd offsets are lower.
        return cr[0] + (((r - cr[0]) & ~1) | (LowerCase & 1));
      }
      return r + delta;
    }
    if (r < cr[0]) {
      hi = m;
    } else {
      lo = m + 1;
    }
  }
  return r;
}

// unicode.ToLower maps the rune to lower case.
export function toLowerRune(r: number): number {
  if (r <= MaxASCII) {
    if (r >= 0x41 && r <= 0x5a) {
      r += 32;
    }
    return r;
  }
  return toLowerCase(r);
}

// strings.ToLower returns s with all Unicode letters mapped to their lower
// case. An invalid UTF-8 byte (a lone surrogate here) becomes U+FFFD, as
// strings.Map writes it.
export function toLower(s: string): string {
  let isASCII = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > MaxASCII) {
      isASCII = false;
      break;
    }
  }
  if (isASCII) {
    return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  }

  let out = "";
  for (const ch of s) {
    const r = ch.codePointAt(0) as number;
    if (r >= 0xd800 && r <= 0xdfff) {
      out += String.fromCodePoint(RuneError);
      continue;
    }
    out += String.fromCodePoint(toLowerRune(r));
  }
  return out;
}

// strings.EqualFold reports whether s and t are equal under simple Unicode
// case-folding.
export function equalFold(s: string, t: string): boolean {
  const a = [...s];
  const b = [...t];
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    const r = (a[i] as string).codePointAt(0) as number;
    const tr = (b[i] as string).codePointAt(0) as number;
    if (r === tr) {
      continue;
    }
    // follow r's fold orbit looking for tr
    let f = SimpleFold(r);
    while (f !== r && f !== tr) {
      f = SimpleFold(f);
    }
    if (f !== tr) {
      return false;
    }
  }
  return true;
}

// unicode.IsSpace: the White_Space property ('\t', '\n', '\v', '\f',
// '\r', ' ', U+0085, U+00A0 and the Z category spaces). JS's trim() also
// removes U+FEFF and keeps U+0085.
function isSpace(r: number): boolean {
  switch (r) {
    case 0x09:
    case 0x0a:
    case 0x0b:
    case 0x0c:
    case 0x0d:
    case 0x20:
    case 0x85:
    case 0xa0:
    case 0x1680:
    case 0x2028:
    case 0x2029:
    case 0x202f:
    case 0x205f:
    case 0x3000:
      return true;
  }
  return r >= 0x2000 && r <= 0x200a;
}

// strings.TrimSpace returns s with all leading and trailing white space
// removed, as defined by Unicode.
export function trimSpace(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isSpace(s.charCodeAt(start))) {
    start++;
  }
  while (end > start && isSpace(s.charCodeAt(end - 1))) {
    end--;
  }
  return s.slice(start, end);
}

// strings.Trim returns s with all leading and trailing code points
// contained in cutset removed.
export function trim(s: string, cutset: string): string {
  const cut = new Set(cutset);
  const chars = [...s];
  let start = 0;
  let end = chars.length;
  while (start < end && cut.has(chars[start] as string)) {
    start++;
  }
  while (end > start && cut.has(chars[end - 1] as string)) {
    end--;
  }
  return chars.slice(start, end).join("");
}
