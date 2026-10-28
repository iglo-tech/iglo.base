// Upstream: Go go1.27.2 src/regexp/syntax/regexp.go and op_string.go.
//
// Op values are Go's numbers (OpNoMatch = 1 … OpAlternate = 19), which
// upstream's RandomStringByRegex prints in its "unsupported pattern
// operator %d" error. Go's Sub0/Rune0 inline storage has no counterpart:
// sub and rune are plain arrays.

import {
  FoldCase,
  NonGreedy,
  WasDollar,
  minFold,
  maxFold,
  inCharClass,
} from "@/tools/regexp/syntax/parse";
import { IsPrint, MaxRune, SimpleFold } from "@/tools/unicode/letter";
import { runeString } from "@/tools/unicode/utf8";

// An Op is a single regular expression operator.
export type Op = number;

// Operators are listed in precedence order, tightest binding to weakest.
// Character class operators are listed simplest to most complex
// (OpLiteral, OpCharClass, OpAnyCharNotNL, OpAnyChar).
export const OpNoMatch: Op = 1; // matches no strings
export const OpEmptyMatch: Op = 2; // matches empty string
export const OpLiteral: Op = 3; // matches Runes sequence
export const OpCharClass: Op = 4; // matches Runes interpreted as range pair list
export const OpAnyCharNotNL: Op = 5; // matches any character except newline
export const OpAnyChar: Op = 6; // matches any character
export const OpBeginLine: Op = 7; // matches empty string at beginning of line
export const OpEndLine: Op = 8; // matches empty string at end of line
export const OpBeginText: Op = 9; // matches empty string at beginning of text
export const OpEndText: Op = 10; // matches empty string at end of text
export const OpWordBoundary: Op = 11; // matches word boundary `\b`
export const OpNoWordBoundary: Op = 12; // matches word non-boundary `\B`
export const OpCapture: Op = 13; // capturing subexpression with index Cap, optional name Name
export const OpStar: Op = 14; // matches Sub[0] zero or more times
export const OpPlus: Op = 15; // matches Sub[0] one or more times
export const OpQuest: Op = 16; // matches Sub[0] zero or one times
export const OpRepeat: Op = 17; // matches Sub[0] at least Min times, at most Max (Max == -1 is no limit)
export const OpConcat: Op = 18; // matches concatenation of Subs
export const OpAlternate: Op = 19; // matches alternation of Subs

export const opPseudo: Op = 128; // where pseudo-ops start

const opNames = [
  "NoMatch",
  "EmptyMatch",
  "Literal",
  "CharClass",
  "AnyCharNotNL",
  "AnyChar",
  "BeginLine",
  "EndLine",
  "BeginText",
  "EndText",
  "WordBoundary",
  "NoWordBoundary",
  "Capture",
  "Star",
  "Plus",
  "Quest",
  "Repeat",
  "Concat",
  "Alternate",
];

// Op.String() (op_string.go)
export function opString(op: Op): string {
  if (op >= 1 && op <= 19) {
    return opNames[op - 1] as string;
  }
  if (op === 128) {
    return "opPseudo";
  }
  return `Op(${op})`;
}

// A Regexp is a node in a regular expression syntax tree.
export class Regexp {
  op: Op; // operator
  flags = 0;
  sub: Regexp[] = []; // subexpressions, if any
  rune: number[] = []; // matched runes, for OpLiteral, OpCharClass
  min = 0; // min for OpRepeat
  max = 0; // max for OpRepeat
  cap = 0; // capturing index, for OpCapture
  name = ""; // capturing name, for OpCapture
  // the parser's free list link (Go keeps it in Sub0[0])
  nextFree: Regexp | null = null;

  constructor(op: Op) {
    this.op = op;
  }

  // Equal reports whether x and y have identical structure.
  equal(y: Regexp | null): boolean {
    return regexpEqual(this, y);
  }

  // String returns the Perl syntax of the regular expression.
  toString(): string {
    const flags = new Map<Regexp, number>();
    let [must, cant] = calcFlags(this, flags);
    must |= (cant & ~flagI) << negShift;
    if (must !== 0) {
      must |= flagOff;
    }
    const b: string[] = [];
    writeRegexp(b, this, must, flags);
    return b.join("");
  }

  // MaxCap walks the regexp to find the maximum capture index.
  maxCap(): number {
    let m = 0;
    if (this.op === OpCapture) {
      m = this.cap;
    }
    for (const sub of this.sub) {
      const n = sub.maxCap();
      if (m < n) {
        m = n;
      }
    }
    return m;
  }

  // CapNames walks the regexp to find the names of capturing groups.
  capNames(): string[] {
    const names: string[] = Array.from({ length: this.maxCap() + 1 }, () => "");
    this.collectCapNames(names);
    return names;
  }

  private collectCapNames(names: string[]): void {
    if (this.op === OpCapture) {
      names[this.cap] = this.name;
    }
    for (const sub of this.sub) {
      sub.collectCapNames(names);
    }
  }
}

function regexpEqual(x: Regexp | null, y: Regexp | null): boolean {
  if (x === null || y === null) {
    return x === y;
  }
  if (x.op !== y.op) {
    return false;
  }
  switch (x.op) {
    case OpEndText:
      // The parse flags remember whether this is \z or \Z.
      if ((x.flags & WasDollar) !== (y.flags & WasDollar)) {
        return false;
      }
      break;

    case OpLiteral:
    case OpCharClass:
      return (x.flags & FoldCase) === (y.flags & FoldCase) && runesEqual(x.rune, y.rune);

    case OpAlternate:
    case OpConcat:
      return (
        x.sub.length === y.sub.length && x.sub.every((sub, i) => regexpEqual(sub, y.sub[i] ?? null))
      );

    case OpStar:
    case OpPlus:
    case OpQuest:
      if (
        (x.flags & NonGreedy) !== (y.flags & NonGreedy) ||
        !regexpEqual(x.sub[0] ?? null, y.sub[0] ?? null)
      ) {
        return false;
      }
      break;

    case OpRepeat:
      if (
        (x.flags & NonGreedy) !== (y.flags & NonGreedy) ||
        x.min !== y.min ||
        x.max !== y.max ||
        !regexpEqual(x.sub[0] ?? null, y.sub[0] ?? null)
      ) {
        return false;
      }
      break;

    case OpCapture:
      if (
        x.cap !== y.cap ||
        x.name !== y.name ||
        !regexpEqual(x.sub[0] ?? null, y.sub[0] ?? null)
      ) {
        return false;
      }
      break;
  }
  return true;
}

function runesEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((r, i) => r === b[i]);
}

// printFlags is a bit set indicating which flags (including non-capturing
// parens) to print around a regexp.
const flagI = 1 << 0; // (?i:
const flagM = 1 << 1; // (?m:
const flagS = 1 << 2; // (?s:
const flagOff = 1 << 3; // )
const flagPrec = 1 << 4; // (?: )
const negShift = 5; // flagI<<negShift is (?-i:

// addSpan enables the flags f around start..last, by setting flags[start] =
// f and flags[last] = flagOff.
function addSpan(start: Regexp, last: Regexp, f: number, flags: Map<Regexp, number>): void {
  flags.set(start, f);
  flags.set(last, (flags.get(last) ?? 0) | flagOff); // maybe start==last
}

// calcFlags calculates the flags to print around each subexpression in re,
// storing that information in flags[sub] for each affected subexpression.
// calcFlags also calculates the flags that must be active or can't be
// active around re and returns those flags.
function calcFlags(re: Regexp, flags: Map<Regexp, number>): [must: number, cant: number] {
  switch (re.op) {
    default:
      return [0, 0];

    case OpLiteral:
      // If literal is fold-sensitive, return (flagI, 0) or (0, flagI)
      // according to whether (?i) is active.
      // If literal is not fold-sensitive, return 0, 0.
      for (const r of re.rune) {
        if (minFold <= r && r <= maxFold && SimpleFold(r) !== r) {
          if ((re.flags & FoldCase) !== 0) {
            return [flagI, 0];
          }
          return [0, flagI];
        }
      }
      return [0, 0];

    case OpCharClass:
      // If literal is fold-sensitive, return 0, flagI - (?i) has been compiled out.
      // If literal is not fold-sensitive, return 0, 0.
      for (let i = 0; i < re.rune.length; i += 2) {
        const lo = Math.max(minFold, re.rune[i] as number);
        const hi = Math.min(maxFold, re.rune[i + 1] as number);
        for (let r = lo; r <= hi; r++) {
          for (let f = SimpleFold(r); f !== r; f = SimpleFold(f)) {
            if (!(lo <= f && f <= hi) && !inCharClass(f, re.rune)) {
              return [0, flagI];
            }
          }
        }
      }
      return [0, 0];

    case OpAnyCharNotNL: // (?-s).
      return [0, flagS];

    case OpAnyChar: // (?s).
      return [flagS, 0];

    case OpBeginLine:
    case OpEndLine: // (?m)^ (?m)$
      return [flagM, 0];

    case OpEndText:
      if ((re.flags & WasDollar) !== 0) {
        // (?-m)$
        return [0, flagM];
      }
      return [0, 0];

    case OpCapture:
    case OpStar:
    case OpPlus:
    case OpQuest:
    case OpRepeat:
      return calcFlags(re.sub[0] as Regexp, flags);

    case OpConcat:
    case OpAlternate: {
      // Gather the must and cant for each subexpression.
      // When we find a conflicting subexpression, insert the necessary
      // flags around the previously identified span and start over.
      let must = 0;
      let cant = 0;
      let allCant = 0;
      let start = 0;
      let last = 0;
      let did = false;
      re.sub.forEach((sub, i) => {
        const [subMust, subCant] = calcFlags(sub, flags);
        if ((must & subCant) !== 0 || (subMust & cant) !== 0) {
          if (must !== 0) {
            addSpan(re.sub[start] as Regexp, re.sub[last] as Regexp, must, flags);
          }
          must = 0;
          cant = 0;
          start = i;
          did = true;
        }
        must |= subMust;
        cant |= subCant;
        allCant |= subCant;
        if (subMust !== 0) {
          last = i;
        }
        if (must === 0 && start === i) {
          start++;
        }
      });
      if (!did) {
        // No conflicts: pass the accumulated must and cant upward.
        return [must, cant];
      }
      if (must !== 0) {
        // Conflicts found; need to finish final span.
        addSpan(re.sub[start] as Regexp, re.sub[last] as Regexp, must, flags);
      }
      return [0, allCant];
    }
  }
}

// writeRegexp writes the Perl syntax for the regular expression re to b.
function writeRegexp(b: string[], re: Regexp, f: number, flags: Map<Regexp, number>): void {
  f |= flags.get(re) ?? 0;
  if ((f & flagPrec) !== 0 && (f & ~(flagOff | flagPrec)) !== 0 && (f & flagOff) !== 0) {
    // flagPrec is redundant with other flags being added and terminated
    f &= ~flagPrec;
  }
  if ((f & ~(flagOff | flagPrec)) !== 0) {
    b.push(`(?`);
    if ((f & flagI) !== 0) {
      b.push(`i`);
    }
    if ((f & flagM) !== 0) {
      b.push(`m`);
    }
    if ((f & flagS) !== 0) {
      b.push(`s`);
    }
    if ((f & ((flagM | flagS) << negShift)) !== 0) {
      b.push(`-`);
      if ((f & (flagM << negShift)) !== 0) {
        b.push(`m`);
      }
      if ((f & (flagS << negShift)) !== 0) {
        b.push(`s`);
      }
    }
    b.push(`:`);
  }
  // Go defers these closing parens; flagPrec's runs first
  const closing: string[] = [];
  if ((f & flagOff) !== 0) {
    closing.unshift(`)`);
  }
  if ((f & flagPrec) !== 0) {
    b.push(`(?:`);
    closing.unshift(`)`);
  }

  switch (re.op) {
    default:
      b.push(`<invalid op${re.op}>`);
      break;
    case OpNoMatch:
      b.push(String.raw`[^\x00-\x{10FFFF}]`);
      break;
    case OpEmptyMatch:
      b.push(`(?:)`);
      break;
    case OpLiteral:
      for (const r of re.rune) {
        escape(b, r, false);
      }
      break;
    case OpCharClass: {
      if (re.rune.length % 2 !== 0) {
        b.push(`[invalid char class]`);
        break;
      }
      b.push("[");
      const rs = re.rune;
      if (rs.length === 0) {
        b.push(String.raw`^\x00-\x{10FFFF}`);
      } else if (rs[0] === 0 && rs[rs.length - 1] === MaxRune && rs.length > 2) {
        // Contains 0 and MaxRune. Probably a negated class.
        // Print the gaps.
        b.push("^");
        for (let i = 1; i < rs.length - 1; i += 2) {
          const lo = (rs[i] as number) + 1;
          const hi = (rs[i + 1] as number) - 1;
          escape(b, lo, lo === 0x2d);
          if (lo !== hi) {
            if (hi !== lo + 1) {
              b.push("-");
            }
            escape(b, hi, hi === 0x2d);
          }
        }
      } else {
        for (let i = 0; i < rs.length; i += 2) {
          const lo = rs[i] as number;
          const hi = rs[i + 1] as number;
          escape(b, lo, lo === 0x2d);
          if (lo !== hi) {
            if (hi !== lo + 1) {
              b.push("-");
            }
            escape(b, hi, hi === 0x2d);
          }
        }
      }
      b.push("]");
      break;
    }
    case OpAnyCharNotNL:
    case OpAnyChar:
      b.push(`.`);
      break;
    case OpBeginLine:
      b.push(`^`);
      break;
    case OpEndLine:
      b.push(`$`);
      break;
    case OpBeginText:
      b.push(String.raw`\A`);
      break;
    case OpEndText:
      if ((re.flags & WasDollar) !== 0) {
        b.push(`$`);
      } else {
        b.push(String.raw`\z`);
      }
      break;
    case OpWordBoundary:
      b.push(String.raw`\b`);
      break;
    case OpNoWordBoundary:
      b.push(String.raw`\B`);
      break;
    case OpCapture: {
      if (re.name !== "") {
        b.push(`(?P<`, re.name, ">");
      } else {
        b.push("(");
      }
      const sub = re.sub[0] as Regexp;
      if (sub.op !== OpEmptyMatch) {
        writeRegexp(b, sub, flags.get(sub) ?? 0, flags);
      }
      b.push(")");
      break;
    }
    case OpStar:
    case OpPlus:
    case OpQuest:
    case OpRepeat: {
      let p = 0;
      const sub = re.sub[0] as Regexp;
      if (sub.op > OpCapture || (sub.op === OpLiteral && sub.rune.length > 1)) {
        p = flagPrec;
      }
      writeRegexp(b, sub, p, flags);

      switch (re.op) {
        case OpStar:
          b.push("*");
          break;
        case OpPlus:
          b.push("+");
          break;
        case OpQuest:
          b.push("?");
          break;
        case OpRepeat:
          b.push("{", String(re.min));
          if (re.max !== re.min) {
            b.push(",");
            if (re.max >= 0) {
              b.push(String(re.max));
            }
          }
          b.push("}");
          break;
      }
      if ((re.flags & NonGreedy) !== 0) {
        b.push("?");
      }
      break;
    }
    case OpConcat:
      for (const sub of re.sub) {
        let p = 0;
        if (sub.op === OpAlternate) {
          p = flagPrec;
        }
        writeRegexp(b, sub, p, flags);
      }
      break;
    case OpAlternate:
      re.sub.forEach((sub, i) => {
        if (i > 0) {
          b.push("|");
        }
        writeRegexp(b, sub, 0, flags);
      });
      break;
  }
  b.push(...closing);
}

const meta = String.raw`\.+*?()|[]{}^$`;

function escape(b: string[], r: number, force: boolean): void {
  if (IsPrint(r)) {
    if (meta.includes(runeString(r)) || force) {
      b.push("\\");
    }
    b.push(runeString(r));
    return;
  }

  switch (r) {
    case 0x07:
      b.push(String.raw`\a`);
      break;
    case 0x0c:
      b.push(String.raw`\f`);
      break;
    case 0x0a:
      b.push(String.raw`\n`);
      break;
    case 0x0d:
      b.push(String.raw`\r`);
      break;
    case 0x09:
      b.push(String.raw`\t`);
      break;
    case 0x0b:
      b.push(String.raw`\v`);
      break;
    default:
      if (r < 0x100) {
        b.push(String.raw`\x`, r.toString(16).padStart(2, "0"));
        break;
      }
      b.push(String.raw`\x{`, r.toString(16), "}");
  }
}
