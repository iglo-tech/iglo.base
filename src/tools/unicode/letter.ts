// Upstream: Go go1.27.2 src/unicode/letter.go (RangeTable, Is, SimpleFold
// and the case tables behind it) and src/unicode/graphic.go (IsPrint, In).
//
// Only what regexp/syntax uses. The data comes from tables.ts, generated
// from Go's tables.go (scripts/unicode/generate-tables.ts), so the Unicode
// version is Go's, not the JS engine's. The tables are decoded on first use
// and kept in module-level caches of constant data (no per-call state).

import {
  asciiFold as asciiFoldText,
  CaseRanges as caseRangesText,
  caseOrbit as caseOrbitText,
  Categories as categoriesText,
  FoldCategory as foldCategoryText,
  FoldScript as foldScriptText,
  printLatin1 as printLatin1Text,
  Scripts as scriptsText,
} from "@/tools/unicode/tables";

export const MaxRune = 0x10ffff; // Maximum valid Unicode code point.
export const ReplacementChar = 0xfffd; // Represents invalid code points.
export const MaxASCII = 0x7f; // maximum ASCII value.
export const MaxLatin1 = 0xff; // maximum Latin-1 value.

// RangeTable defines a set of Unicode code points by listing the ranges of
// code points within the set: Go's R16 followed by R32, as flat
// lo, hi, stride triples in increasing order.
export interface RangeTable {
  readonly ranges: readonly number[];
}

function decodeTable(text: string): RangeTable {
  const ranges: number[] = [];
  if (text !== "") {
    for (const item of text.split(",")) {
      const [bounds = "", stride = "1"] = item.split("/");
      const [lo = "", hi = lo] = bounds.split("-");
      ranges.push(Number.parseInt(lo, 16), Number.parseInt(hi, 16), Number.parseInt(stride, 16));
    }
  }
  return { ranges };
}

function decodeTables(texts: Record<string, string>): Map<string, RangeTable> {
  const out = new Map<string, RangeTable>();
  for (const [name, text] of Object.entries(texts)) {
    out.set(name, decodeTable(text));
  }
  return out;
}

let categories: Map<string, RangeTable> | undefined;
let scripts: Map<string, RangeTable> | undefined;
let foldCategory: Map<string, RangeTable> | undefined;
let foldScript: Map<string, RangeTable> | undefined;

// Categories is the set of Unicode category tables.
export function Categories(): Map<string, RangeTable> {
  categories ??= decodeTables(categoriesText);
  return categories;
}

// Scripts is the set of Unicode script tables.
export function Scripts(): Map<string, RangeTable> {
  scripts ??= decodeTables(scriptsText);
  return scripts;
}

// FoldCategory maps a category name to a table of code points outside the
// category that are equivalent under simple case folding to code points
// inside the category. If there is no entry for a category name, there are
// no such points.
export function FoldCategory(): Map<string, RangeTable> {
  foldCategory ??= decodeTables(foldCategoryText);
  return foldCategory;
}

// FoldScript maps a script name to a table of code points outside the
// script that are equivalent under simple case folding to code points
// inside the script. If there is no entry for a script name, there are no
// such points.
export function FoldScript(): Map<string, RangeTable> {
  foldScript ??= decodeTables(foldScriptText);
  return foldScript;
}

// Is reports whether the rune is in the specified table of ranges.
// (Go searches linearly or binary depending on the table size; the answer
// is the same.)
export function Is(rangeTab: RangeTable, r: number): boolean {
  const ranges = rangeTab.ranges;
  let lo = 0;
  let hi = ranges.length / 3;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    const rlo = ranges[3 * m] as number;
    const rhi = ranges[3 * m + 1] as number;
    if (rlo <= r && r <= rhi) {
      const stride = ranges[3 * m + 2] as number;
      return stride === 1 || (r - rlo) % stride === 0;
    }
    if (r < rlo) {
      hi = m;
    } else {
      lo = m + 1;
    }
  }
  return false;
}

// In reports whether the rune is a member of one of the ranges.
export function In(r: number, ...ranges: RangeTable[]): boolean {
  return ranges.some((inside) => Is(inside, r));
}

let printLatin1: RangeTable | undefined;
let printRanges: RangeTable[] | undefined;

// IsPrint reports whether the rune is defined as printable by Go. Such
// characters include letters, marks, numbers, punctuation, symbols, and the
// ASCII space character, from categories L, M, N, P, S and the ASCII space
// character.
export function IsPrint(r: number): boolean {
  if (r >= 0 && r <= MaxLatin1) {
    printLatin1 ??= decodeTable(printLatin1Text);
    return Is(printLatin1, r);
  }
  const cats = Categories();
  printRanges ??= ["L", "M", "N", "P", "S"].map((name) => cats.get(name) as RangeTable);
  return In(r, ...printRanges);
}

// CaseRange: lo, hi and the UpperCase, LowerCase and TitleCase deltas;
// UpperLower (MaxRune + 1) marks an alternating upper/lower sequence.
type CaseRange = [lo: number, hi: number, upper: number, lower: number, title: number];

const UpperCase = 0;
const LowerCase = 1;
const UpperLower = MaxRune + 1;

let caseRanges: CaseRange[] | undefined;
let caseOrbit: [from: number, to: number][] | undefined;
let asciiFold: number[] | undefined;

function decodeCaseTables(): void {
  caseRanges = caseRangesText.split(",").map((item) => {
    const [lo = "", hi = "", ...deltas] = item.split(" ");
    const d = deltas.map((delta) => (delta === "UL" ? UpperLower : Number(delta)));
    return [Number.parseInt(lo, 16), Number.parseInt(hi, 16), d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
  });
  caseOrbit = caseOrbitText.split(",").map((item) => {
    const [from = "", to = ""] = item.split(" ");
    return [Number.parseInt(from, 16), Number.parseInt(to, 16)];
  });
  asciiFold = asciiFoldText.split(",").map((item) => Number.parseInt(item, 16));
}

// lookupCaseRange returns the CaseRange mapping for rune r or undefined if
// no mapping exists for r.
function lookupCaseRange(r: number, caseRange: CaseRange[]): CaseRange | undefined {
  // binary search over ranges
  let lo = 0;
  let hi = caseRange.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    const cr = caseRange[m] as CaseRange;
    if (cr[0] <= r && r <= cr[1]) {
      return cr;
    }
    if (r < cr[0]) {
      hi = m;
    } else {
      lo = m + 1;
    }
  }
  return undefined;
}

// convertCase converts r to _case using CaseRange cr.
function convertCase(_case: number, r: number, cr: CaseRange): number {
  const delta = cr[2 + _case] as number;
  if (delta > MaxRune) {
    // In an Upper-Lower sequence, which always starts with an UpperCase
    // letter, the characters at even offsets from the beginning of the
    // sequence are upper case; the ones at odd offsets are lower.
    return cr[0] + (((r - cr[0]) & ~1) | (_case & 1));
  }
  return r + delta;
}

// SimpleFold iterates over Unicode code points equivalent under the
// Unicode-defined simple case folding. Among the code points equivalent to
// rune (including rune itself), SimpleFold returns the smallest rune > r if
// one exists, or else the smallest rune >= 0. If r is not a valid Unicode
// code point, SimpleFold(r) returns r.
export function SimpleFold(r: number): number {
  if (r < 0 || r > MaxRune) {
    return r;
  }
  if (asciiFold === undefined) {
    decodeCaseTables();
  }
  const fold = asciiFold as number[];
  if (r < fold.length) {
    return fold[r] as number;
  }

  // Consult caseOrbit table for special cases.
  const orbit = caseOrbit as [number, number][];
  let lo = 0;
  let hi = orbit.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if ((orbit[m] as [number, number])[0] < r) {
      lo = m + 1;
    } else {
      hi = m;
    }
  }
  if (lo < orbit.length && (orbit[lo] as [number, number])[0] === r) {
    return (orbit[lo] as [number, number])[1];
  }

  // No folding specified. This is a one- or two-element equivalence class
  // containing rune and ToLower(rune) and ToUpper(rune) if they are
  // different from rune.
  const cr = lookupCaseRange(r, caseRanges as CaseRange[]);
  if (cr !== undefined) {
    const l = convertCase(LowerCase, r, cr);
    if (l !== r) {
      return l;
    }
    return convertCase(UpperCase, r, cr);
  }
  return r;
}
