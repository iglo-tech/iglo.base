// Upstream: Go go1.27.2 src/regexp/syntax/prog.go.
//
// InstOp and EmptyOp keep Go's numeric values. Out and Arg are Go's uint32
// fields; they are plain numbers here. Prefix returns the prefix both as
// text (the src/tools/unicode/utf8.ts string form) and as its UTF-8 bytes,
// which the matcher searches for.

import { FoldCase } from "@/tools/regexp/syntax/parse";
import { SimpleFold } from "@/tools/unicode/letter";
import { RuneError, ValidRune, runeString } from "@/tools/unicode/utf8";

// An InstOp is an instruction opcode.
export type InstOp = number;

export const InstAlt: InstOp = 0;
export const InstAltMatch: InstOp = 1;
export const InstCapture: InstOp = 2;
export const InstEmptyWidth: InstOp = 3;
export const InstMatch: InstOp = 4;
export const InstFail: InstOp = 5;
export const InstNop: InstOp = 6;
export const InstRune: InstOp = 7;
export const InstRune1: InstOp = 8;
export const InstRuneAny: InstOp = 9;
export const InstRuneAnyNotNL: InstOp = 10;

const instOpNames = [
  "InstAlt",
  "InstAltMatch",
  "InstCapture",
  "InstEmptyWidth",
  "InstMatch",
  "InstFail",
  "InstNop",
  "InstRune",
  "InstRune1",
  "InstRuneAny",
  "InstRuneAnyNotNL",
];

// InstOp.String()
export function instOpString(i: InstOp): string {
  return instOpNames[i] ?? "";
}

// An EmptyOp specifies a kind or mixture of zero-width assertions.
export type EmptyOp = number;

export const EmptyBeginLine: EmptyOp = 1 << 0;
export const EmptyEndLine: EmptyOp = 1 << 1;
export const EmptyBeginText: EmptyOp = 1 << 2;
export const EmptyEndText: EmptyOp = 1 << 3;
export const EmptyWordBoundary: EmptyOp = 1 << 4;
export const EmptyNoWordBoundary: EmptyOp = 1 << 5;

// ^EmptyOp(0): Go's EmptyOp is a uint8
export const EmptyImpossible: EmptyOp = 0xff;

// EmptyOpContext returns the zero-width assertions
// satisfied at the position between the runes r1 and r2.
// Passing r1 == -1 indicates that the position is
// at the beginning of the text.
// Passing r2 == -1 indicates that the position is
// at the end of the text.
export function EmptyOpContext(r1: number, r2: number): EmptyOp {
  let op: EmptyOp = EmptyNoWordBoundary;
  let boundary = 0;
  if (IsWordChar(r1)) {
    boundary = 1;
  } else if (r1 === 0x0a) {
    op |= EmptyBeginLine;
  } else if (r1 < 0) {
    op |= EmptyBeginText | EmptyBeginLine;
  }
  if (IsWordChar(r2)) {
    boundary ^= 1;
  } else if (r2 === 0x0a) {
    op |= EmptyEndLine;
  } else if (r2 < 0) {
    op |= EmptyEndText | EmptyEndLine;
  }
  if (boundary !== 0) {
    // IsWordChar(r1) != IsWordChar(r2)
    op ^= EmptyWordBoundary | EmptyNoWordBoundary;
  }
  return op;
}

// IsWordChar reports whether r is considered a “word character”
// during the evaluation of the \b and \B zero-width assertions.
// These assertions are ASCII-only: the word characters are [A-Za-z0-9_].
export function IsWordChar(r: number): boolean {
  // Test for lowercase letters first, as these occur more
  // frequently than uppercase letters in common cases.
  return (
    (0x61 <= r && r <= 0x7a) || (0x41 <= r && r <= 0x5a) || (0x30 <= r && r <= 0x39) || r === 0x5f
  );
}

// An Inst is a single instruction in a regular expression program.
export class Inst {
  op: InstOp;
  out = 0; // all but InstMatch, InstFail
  arg = 0; // InstAlt, InstAltMatch, InstCapture, InstEmptyWidth
  rune: number[] = [];

  constructor(op: InstOp) {
    this.op = op;
  }

  // op returns i.Op but merges all the Rune special cases into InstRune
  baseOp(): InstOp {
    const op = this.op;
    if (op === InstRune1 || op === InstRuneAny || op === InstRuneAnyNotNL) {
      return InstRune;
    }
    return op;
  }

  // MatchRune reports whether the instruction matches (and consumes) r.
  // It should only be called when i.Op == InstRune.
  matchRune(r: number): boolean {
    return this.matchRunePos(r) !== noMatch;
  }

  // MatchRunePos checks whether the instruction matches (and consumes) r.
  // If so, MatchRunePos returns the index of the matching rune pair
  // (or, when len(i.Rune) == 1, rune singleton).
  // If not, MatchRunePos returns -1.
  // MatchRunePos should only be called when i.Op == InstRune.
  matchRunePos(r: number): number {
    const rune = this.rune;

    switch (rune.length) {
      case 0:
        return noMatch;

      case 1: {
        // Special case: single-rune slice is from literal string, not char class.
        const r0 = rune[0] as number;
        if (r === r0) {
          return 0;
        }
        if ((this.arg & FoldCase) !== 0) {
          for (let r1 = SimpleFold(r0); r1 !== r0; r1 = SimpleFold(r1)) {
            if (r === r1) {
              return 0;
            }
          }
        }
        return noMatch;
      }

      case 2:
        if (r >= (rune[0] as number) && r <= (rune[1] as number)) {
          return 0;
        }
        return noMatch;

      case 4:
      case 6:
      case 8:
        // Linear search for a few pairs.
        // Should handle ASCII well.
        for (let j = 0; j < rune.length; j += 2) {
          if (r < (rune[j] as number)) {
            return noMatch;
          }
          if (r <= (rune[j + 1] as number)) {
            return j / 2;
          }
        }
        return noMatch;
    }

    // Otherwise binary search.
    let lo = 0;
    let hi = rune.length / 2;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      const c = rune[2 * m] as number;
      if (c <= r) {
        if (r <= (rune[2 * m + 1] as number)) {
          return m;
        }
        lo = m + 1;
      } else {
        hi = m;
      }
    }
    return noMatch;
  }

  // MatchEmptyWidth reports whether the instruction matches
  // an empty string between the runes before and after.
  // It should only be called when i.Op == InstEmptyWidth.
  matchEmptyWidth(before: number, after: number): boolean {
    switch (this.arg) {
      case EmptyBeginLine:
        return before === 0x0a || before === -1;
      case EmptyEndLine:
        return after === 0x0a || after === -1;
      case EmptyBeginText:
        return before === -1;
      case EmptyEndText:
        return after === -1;
      case EmptyWordBoundary:
        return IsWordChar(before) !== IsWordChar(after);
      case EmptyNoWordBoundary:
        return IsWordChar(before) === IsWordChar(after);
    }
    throw new Error("unknown empty width arg");
  }

  toString(): string {
    const b: string[] = [];
    dumpInst(b, this);
    return b.join("");
  }
}

const noMatch = -1;

// A Prog is a compiled regular expression program.
export class Prog {
  inst: Inst[] = [];
  start = 0; // index of start instruction
  numCap = 0; // number of InstCapture insts in re

  toString(): string {
    const b: string[] = [];
    dumpProg(b, this);
    return b.join("");
  }

  // skipNop follows any no-op or capturing instructions.
  skipNop(pc: number): Inst {
    let i = this.inst[pc] as Inst;
    while (i.op === InstNop || i.op === InstCapture) {
      i = this.inst[i.out] as Inst;
    }
    return i;
  }

  // Prefix returns a literal string that all matches for the
  // regexp must start with. Complete is true if the prefix
  // is the entire match.
  prefix(): [prefix: string, complete: boolean] {
    let i = this.skipNop(this.start);

    // Avoid allocation of buffer if prefix is empty.
    if (i.baseOp() !== InstRune || i.rune.length !== 1) {
      return ["", i.op === InstMatch];
    }

    // Have prefix; gather characters.
    let buf = "";
    while (
      i.baseOp() === InstRune &&
      i.rune.length === 1 &&
      (i.arg & FoldCase) === 0 &&
      i.rune[0] !== RuneError
    ) {
      buf += runeString(i.rune[0] as number);
      i = this.skipNop(i.out);
    }
    return [buf, i.op === InstMatch];
  }

  // StartCond returns the leading empty-width conditions that must
  // be true in any match. It returns ^EmptyOp(0) if no matches are possible.
  startCond(): EmptyOp {
    let flag: EmptyOp = 0;
    let pc = this.start;
    let i = this.inst[pc] as Inst;
    for (;;) {
      switch (i.op) {
        case InstEmptyWidth:
          flag |= i.arg;
          break;
        case InstFail:
          return EmptyImpossible;
        case InstCapture:
        case InstNop:
          // skip
          break;
        default:
          return flag;
      }
      pc = i.out;
      i = this.inst[pc] as Inst;
    }
  }
}

function dumpProg(b: string[], p: Prog): void {
  p.inst.forEach((i, j) => {
    let pc = String(j);
    if (pc.length < 3) {
      b.push("   ".slice(pc.length));
    }
    if (j === p.start) {
      pc += "*";
    }
    b.push(pc, "\t");
    dumpInst(b, i);
    b.push("\n");
  });
}

function dumpInst(b: string[], i: Inst): void {
  switch (i.op) {
    case InstAlt:
      b.push("alt -> ", String(i.out), ", ", String(i.arg));
      break;
    case InstAltMatch:
      b.push("altmatch -> ", String(i.out), ", ", String(i.arg));
      break;
    case InstCapture:
      b.push("cap ", String(i.arg), " -> ", String(i.out));
      break;
    case InstEmptyWidth:
      b.push("empty ", String(i.arg), " -> ", String(i.out));
      break;
    case InstMatch:
      b.push("match");
      break;
    case InstFail:
      b.push("fail");
      break;
    case InstNop:
      b.push("nop -> ", String(i.out));
      break;
    case InstRune:
      b.push("rune ", quoteToASCII(i.rune));
      if ((i.arg & FoldCase) !== 0) {
        b.push("/i");
      }
      b.push(" -> ", String(i.out));
      break;
    case InstRune1:
      b.push("rune1 ", quoteToASCII(i.rune), " -> ", String(i.out));
      break;
    case InstRuneAny:
      b.push("any -> ", String(i.out));
      break;
    case InstRuneAnyNotNL:
      b.push("anynotnl -> ", String(i.out));
      break;
  }
}

// strconv.QuoteToASCII(string(runes)): string(runes) turns an invalid
// rune into U+FFFD, which QuoteToASCII prints as �.
function quoteToASCII(runes: readonly number[]): string {
  let out = '"';
  for (let r of runes) {
    if (!ValidRune(r)) {
      r = RuneError;
    }
    if (r === 0x22 || r === 0x5c) {
      out += "\\" + String.fromCharCode(r);
    } else if (r >= 0x20 && r < 0x7f) {
      out += String.fromCharCode(r);
    } else {
      switch (r) {
        case 0x07:
          out += "\\a";
          break;
        case 0x08:
          out += "\\b";
          break;
        case 0x0c:
          out += "\\f";
          break;
        case 0x0a:
          out += "\\n";
          break;
        case 0x0d:
          out += "\\r";
          break;
        case 0x09:
          out += "\\t";
          break;
        case 0x0b:
          out += "\\v";
          break;
        default:
          if (r < 0x20 || r === 0x7f) {
            out += "\\x" + r.toString(16).padStart(2, "0");
          } else if (r < 0x10000) {
            out += "\\u" + r.toString(16).padStart(4, "0");
          } else {
            out += "\\U" + r.toString(16).padStart(8, "0");
          }
      }
    }
  }
  return out + '"';
}
