// Upstream: Go go1.27.2 src/regexp/syntax/parse.go.
//
// A line-by-line port, so a pattern is accepted or rejected exactly as Go
// does, with the same tree and the same error text.
//
// Go strings are bytes. The pattern is a JS string in the form of
// src/tools/unicode/utf8.ts (an invalid UTF-8 byte is a lone surrogate
// U+DC80..U+DCFF), or bytes. Go only slices the pattern at rune boundaries
// and compares single bytes with ASCII, so slicing the JS string by UTF-16
// code units gives the same substrings, and the error's expr is the same
// text (an invalid byte stays a lone surrogate there).
//
// The parser keeps Go's free list of Regexp nodes (reuse/newRegexp): the
// size and height limits count allocations and cache results per node, so
// node recycling must match Go's for the limits to fire on the same
// patterns.

import { perlGroup, posixGroup, type charGroup } from "@/tools/regexp/syntax/perl-groups";
import {
  OpAlternate,
  OpAnyChar,
  OpAnyCharNotNL,
  OpBeginLine,
  OpBeginText,
  OpCapture,
  OpCharClass,
  OpConcat,
  OpEmptyMatch,
  OpEndLine,
  OpEndText,
  OpLiteral,
  OpNoMatch,
  OpNoWordBoundary,
  OpPlus,
  OpQuest,
  OpRepeat,
  OpStar,
  OpWordBoundary,
  Regexp,
  opPseudo,
  type Op,
} from "@/tools/regexp/syntax/regexp";
import {
  Categories,
  FoldCategory,
  FoldScript,
  MaxRune,
  Scripts,
  SimpleFold,
  type RangeTable,
} from "@/tools/unicode/letter";
import { CategoryAliases } from "@/tools/unicode/tables";
import { DecodeRuneInString, RuneError, RuneSelf, goString } from "@/tools/unicode/utf8";

// An ErrorCode describes a failure to parse a regular expression.
export type ErrorCode = string;

// Unexpected error
export const ErrInternalError: ErrorCode = "regexp/syntax: internal error";

// Parse errors
export const ErrInvalidCharClass: ErrorCode = "invalid character class";
export const ErrInvalidCharRange: ErrorCode = "invalid character class range";
export const ErrInvalidEscape: ErrorCode = "invalid escape sequence";
export const ErrInvalidNamedCapture: ErrorCode = "invalid named capture";
export const ErrInvalidPerlOp: ErrorCode = "invalid or unsupported Perl syntax";
export const ErrInvalidRepeatOp: ErrorCode = "invalid nested repetition operator";
export const ErrInvalidRepeatSize: ErrorCode = "invalid repeat count";
export const ErrInvalidUTF8: ErrorCode = "invalid UTF-8";
export const ErrMissingBracket: ErrorCode = "missing closing ]";
export const ErrMissingParen: ErrorCode = "missing closing )";
export const ErrMissingRepeatArgument: ErrorCode = "missing argument to repetition operator";
export const ErrTrailingBackslash: ErrorCode = "trailing backslash at end of expression";
export const ErrUnexpectedParen: ErrorCode = "unexpected )";
export const ErrNestingDepth: ErrorCode = "expression nests too deeply";
export const ErrLarge: ErrorCode = "expression too large";

// An Error describes a failure to parse a regular expression and gives the
// offending expression. Its message is Go's Error() text.
export class RegexpSyntaxError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly expr: string,
  ) {
    super("error parsing regexp: " + code + ": `" + expr + "`");
    this.name = "RegexpSyntaxError";
  }
}

// Flags control the behavior of the parser and record information about
// regexp context (Go's uint16 Flags).
export type Flags = number;

export const FoldCase: Flags = 1 << 0; // case-insensitive match
export const Literal: Flags = 1 << 1; // treat pattern as literal string
export const ClassNL: Flags = 1 << 2; // allow character classes like [^a-z] and [[:space:]] to match newline
export const DotNL: Flags = 1 << 3; // allow . to match newline
export const OneLine: Flags = 1 << 4; // treat ^ and $ as only matching at beginning and end of text
export const NonGreedy: Flags = 1 << 5; // make repetition operators default to non-greedy
export const PerlX: Flags = 1 << 6; // allow Perl extensions
export const UnicodeGroups: Flags = 1 << 7; // allow \p{Han}, \P{Han} for Unicode group and negation
export const WasDollar: Flags = 1 << 8; // regexp OpEndText was $, not \z
export const Simple: Flags = 1 << 9; // regexp contains no counted repetition

export const MatchNL: Flags = ClassNL | DotNL;

export const Perl: Flags = ClassNL | OneLine | PerlX | UnicodeGroups; // as close to Perl as possible
export const POSIX: Flags = 0; // POSIX syntax

const flagsMask = 0xffff;

// Pseudo-ops for parsing stack (opPseudo + iota; literals here because
// regexp.ts imports this module).
const opLeftParen: Op = 128;
const opVerticalBar: Op = 129;

// maxHeight is the maximum height of a regexp parse tree.
// As an optimization, we don't even bother calculating heights
// until we've allocated at least maxHeight Regexp structures.
const maxHeight = 1000;

// maxSize is the maximum size of a compiled regexp in Insts.
const instSize = 5 * 8; // byte, 2 uint32, slice is 5 64-bit words
const maxSize = Math.trunc((128 << 20) / instSize);

// maxRunes is the maximum number of runes allowed in a regexp tree
// counting the runes in all the nodes.
const runeSize = 4; // rune is int32
const maxRunes = Math.trunc((128 << 20) / runeSize);

// Go panics with these codes from the limit checks; parse recovers them.
class limitPanic {
  constructor(readonly code: ErrorCode) {}
}

class parser {
  flags: Flags = 0; // parse mode flags
  stack: Regexp[] = []; // stack of parsed expressions
  free: Regexp | null = null;
  numCap = 0; // number of capturing groups seen
  wholeRegexp = "";
  tmpClass: number[] = []; // temporary char class work space
  numRegexp = 0; // number of regexps allocated
  numRunes = 0; // number of runes in char classes
  repeats = 0; // product of all repetitions seen
  height: Map<Regexp, number> | null = null; // regexp height, for height limit check
  size: Map<Regexp, number> | null = null; // regexp compiled size, for size limit check

  newRegexp(op: Op): Regexp {
    let re = this.free;
    if (re !== null) {
      this.free = re.nextFree;
      re.flags = 0;
      re.sub = [];
      re.rune = [];
      re.min = 0;
      re.max = 0;
      re.cap = 0;
      re.name = "";
      re.nextFree = null;
    } else {
      re = new Regexp(op);
      this.numRegexp++;
    }
    re.op = op;
    return re;
  }

  reuse(re: Regexp): void {
    this.height?.delete(re);
    re.nextFree = this.free;
    this.free = re;
  }

  checkLimits(re: Regexp): void {
    if (this.numRunes > maxRunes) {
      throw new limitPanic(ErrLarge);
    }
    this.checkSize(re);
    this.checkHeight(re);
  }

  checkSize(re: Regexp): void {
    if (this.size === null) {
      // We haven't started tracking size yet.
      // Do a relatively cheap check to see if we need to start.
      // Maintain the product of all the repeats we've seen
      // and don't track if the total number of regexp nodes
      // we've seen times the repeat product is in budget.
      if (this.repeats === 0) {
        this.repeats = 1;
      }
      if (re.op === OpRepeat) {
        let n = re.max;
        if (n === -1) {
          n = re.min;
        }
        if (n <= 0) {
          n = 1;
        }
        if (n > Math.trunc(maxSize / this.repeats)) {
          this.repeats = maxSize;
        } else {
          this.repeats *= n;
        }
      }
      if (this.numRegexp < Math.trunc(maxSize / this.repeats)) {
        return;
      }

      // We need to start tracking size.
      // Make the map and belatedly populate it
      // with info about everything we've constructed so far.
      this.size = new Map();
      for (const sre of this.stack) {
        this.checkSize(sre);
      }
    }

    if (this.calcSize(re, true) > maxSize) {
      throw new limitPanic(ErrLarge);
    }
  }

  calcSize(re: Regexp, force: boolean): number {
    const sizes = this.size as Map<Regexp, number>;
    if (!force) {
      const size = sizes.get(re);
      if (size !== undefined) {
        return size;
      }
    }

    let size = 0;
    switch (re.op) {
      case OpLiteral:
        size = re.rune.length;
        break;
      case OpCapture:
      case OpStar:
        // star can be 1+ or 2+; assume 2 pessimistically
        size = 2 + this.calcSize(re.sub[0] as Regexp, false);
        break;
      case OpPlus:
      case OpQuest:
        size = 1 + this.calcSize(re.sub[0] as Regexp, false);
        break;
      case OpConcat:
        for (const sub of re.sub) {
          size += this.calcSize(sub, false);
        }
        break;
      case OpAlternate:
        for (const sub of re.sub) {
          size += this.calcSize(sub, false);
        }
        if (re.sub.length > 1) {
          size += re.sub.length - 1;
        }
        break;
      case OpRepeat: {
        const sub = this.calcSize(re.sub[0] as Regexp, false);
        if (re.max === -1) {
          if (re.min === 0) {
            size = 2 + sub; // x*
          } else {
            size = 1 + re.min * sub; // xxx+
          }
          break;
        }
        // x{2,5} = xx(x(x(x)?)?)?
        size = re.max * sub + (re.max - re.min);
        break;
      }
    }

    size = Math.max(1, size);
    sizes.set(re, size);
    return size;
  }

  checkHeight(re: Regexp): void {
    if (this.numRegexp < maxHeight) {
      return;
    }
    if (this.height === null) {
      this.height = new Map();
      for (const sre of this.stack) {
        this.checkHeight(sre);
      }
    }
    if (this.calcHeight(re, true) > maxHeight) {
      throw new limitPanic(ErrNestingDepth);
    }
  }

  calcHeight(re: Regexp, force: boolean): number {
    const heights = this.height as Map<Regexp, number>;
    if (!force) {
      const h = heights.get(re);
      if (h !== undefined) {
        return h;
      }
    }
    let h = 1;
    for (const sub of re.sub) {
      const hsub = this.calcHeight(sub, false);
      if (h < 1 + hsub) {
        h = 1 + hsub;
      }
    }
    heights.set(re, h);
    return h;
  }

  // Parse stack manipulation.

  // push pushes the regexp re onto the parse stack and returns the regexp.
  push(re: Regexp): Regexp | null {
    this.numRunes += re.rune.length;
    const rs = re.rune;
    if (re.op === OpCharClass && rs.length === 2 && rs[0] === rs[1]) {
      // Single rune.
      if (this.maybeConcat(rs[0] as number, this.flags & ~FoldCase)) {
        return null;
      }
      re.op = OpLiteral;
      re.rune = rs.slice(0, 1);
      re.flags = this.flags & ~FoldCase;
    } else if (
      (re.op === OpCharClass &&
        rs.length === 4 &&
        rs[0] === rs[1] &&
        rs[2] === rs[3] &&
        SimpleFold(rs[0] as number) === rs[2] &&
        SimpleFold(rs[2] as number) === rs[0]) ||
      (re.op === OpCharClass &&
        rs.length === 2 &&
        (rs[0] as number) + 1 === rs[1] &&
        SimpleFold(rs[0] as number) === rs[1] &&
        SimpleFold(rs[1] as number) === rs[0])
    ) {
      // Case-insensitive rune like [Aa] or [Δδ].
      if (this.maybeConcat(rs[0] as number, this.flags | FoldCase)) {
        return null;
      }

      // Rewrite as (case-insensitive) literal.
      re.op = OpLiteral;
      re.rune = rs.slice(0, 1);
      re.flags = this.flags | FoldCase;
    } else {
      // Incremental concatenation.
      this.maybeConcat(-1, 0);
    }

    this.stack.push(re);
    this.checkLimits(re);
    return re;
  }

  // maybeConcat implements incremental concatenation
  // of literal runes into string nodes. The parser calls this
  // before each push, so only the top fragment of the stack
  // might need processing. Since this is called before a push,
  // the topmost literal is no longer subject to operators like *
  // (Otherwise ab* would turn into (ab)*.)
  // If r >= 0 and there's a node left over, maybeConcat uses it
  // to push r with the given flags.
  // maybeConcat reports whether r was pushed.
  maybeConcat(r: number, flags: Flags): boolean {
    const n = this.stack.length;
    if (n < 2) {
      return false;
    }

    const re1 = this.stack[n - 1] as Regexp;
    const re2 = this.stack[n - 2] as Regexp;
    if (
      re1.op !== OpLiteral ||
      re2.op !== OpLiteral ||
      (re1.flags & FoldCase) !== (re2.flags & FoldCase)
    ) {
      return false;
    }

    // Push re1 into re2.
    re2.rune.push(...re1.rune);

    // Reuse re1 if possible.
    if (r >= 0) {
      re1.rune = [r];
      re1.flags = flags;
      return true;
    }

    this.stack.length = n - 1;
    this.reuse(re1);
    return false; // did not push r
  }

  // literal pushes a literal regexp for the rune r on the stack.
  literal(r: number): void {
    const re = this.newRegexp(OpLiteral);
    re.flags = this.flags;
    if ((this.flags & FoldCase) !== 0) {
      r = minFoldRune(r);
    }
    re.rune = [r];
    this.push(re);
  }

  // op pushes a regexp with the given op onto the stack
  // and returns that regexp.
  op(op: Op): Regexp {
    const re = this.newRegexp(op);
    re.flags = this.flags;
    // push only returns null for a char class of one rune
    return this.push(re) as Regexp;
  }

  // repeat replaces the top stack element with itself repeated according to op, min, max.
  // before is the regexp suffix starting at the repetition operator.
  // after is the regexp suffix following after the repetition operator.
  // repeat returns an updated 'after' and an error, if any.
  repeat(
    op: Op,
    min: number,
    max: number,
    before: string,
    after: string,
    lastRepeat: string,
  ): string {
    let flags = this.flags;
    if ((this.flags & PerlX) !== 0) {
      if (after.length > 0 && after[0] === "?") {
        after = after.slice(1);
        flags ^= NonGreedy;
      }
      if (lastRepeat !== "") {
        // In Perl it is not allowed to stack repetition operators:
        // a** is a syntax error, not a doubled star, and a++ means
        // something else entirely, which we don't support!
        throw new RegexpSyntaxError(
          ErrInvalidRepeatOp,
          lastRepeat.slice(0, lastRepeat.length - after.length),
        );
      }
    }
    const n = this.stack.length;
    if (n === 0) {
      throw new RegexpSyntaxError(
        ErrMissingRepeatArgument,
        before.slice(0, before.length - after.length),
      );
    }
    const sub = this.stack[n - 1] as Regexp;
    if (sub.op >= opPseudo) {
      throw new RegexpSyntaxError(
        ErrMissingRepeatArgument,
        before.slice(0, before.length - after.length),
      );
    }

    const re = this.newRegexp(op);
    re.min = min;
    re.max = max;
    re.flags = flags;
    re.sub = [sub];
    this.stack[n - 1] = re;
    this.checkLimits(re);

    if (op === OpRepeat && (min >= 2 || max >= 2) && !repeatIsValid(re, 1000)) {
      throw new RegexpSyntaxError(
        ErrInvalidRepeatSize,
        before.slice(0, before.length - after.length),
      );
    }

    return after;
  }

  // concat replaces the top of the stack (above the topmost '|' or '(') with its concatenation.
  concat(): Regexp | null {
    this.maybeConcat(-1, 0);

    // Scan down to find pseudo-operator | or (.
    let i = this.stack.length;
    while (i > 0 && (this.stack[i - 1] as Regexp).op < opPseudo) {
      i--;
    }
    const subs = this.stack.slice(i);
    this.stack.length = i;

    // Empty concatenation is special case.
    if (subs.length === 0) {
      return this.push(this.newRegexp(OpEmptyMatch));
    }

    return this.push(this.collapse(subs, OpConcat));
  }

  // alternate replaces the top of the stack (above the topmost '(') with its alternation.
  alternate(): Regexp | null {
    // Scan down to find pseudo-operator (.
    // There are no | above (.
    let i = this.stack.length;
    while (i > 0 && (this.stack[i - 1] as Regexp).op < opPseudo) {
      i--;
    }
    const subs = this.stack.slice(i);
    this.stack.length = i;

    // Make sure top class is clean.
    // All the others already are (see swapVerticalBar).
    if (subs.length > 0) {
      cleanAlt(subs[subs.length - 1] as Regexp);
    }

    // Empty alternate is special case
    // (shouldn't happen but easy to handle).
    if (subs.length === 0) {
      return this.push(this.newRegexp(OpNoMatch));
    }

    return this.push(this.collapse(subs, OpAlternate));
  }

  // collapse returns the result of applying op to sub.
  // If sub contains op nodes, they all get hoisted up
  // so that there is never a concat of a concat or an
  // alternate of an alternate.
  collapse(subs: Regexp[], op: Op): Regexp {
    if (subs.length === 1) {
      return subs[0] as Regexp;
    }
    let re = this.newRegexp(op);
    re.sub = [];
    for (const sub of subs) {
      if (sub.op === op) {
        re.sub.push(...sub.sub);
        this.reuse(sub);
      } else {
        re.sub.push(sub);
      }
    }
    if (op === OpAlternate) {
      re.sub = this.factor(re.sub);
      if (re.sub.length === 1) {
        const old = re;
        re = re.sub[0] as Regexp;
        this.reuse(old);
      }
    }
    return re;
  }

  // factor factors common prefixes from the alternation list sub.
  // It returns a replacement list and frees (passes to p.reuse) any
  // removed *Regexps.
  //
  // For example,
  //
  //	ABC|ABD|AEF|BCX|BCY
  //
  // simplifies by literal prefix extraction to
  //
  //	A(B(C|D)|EF)|BC(X|Y)
  //
  // which simplifies by character class introduction to
  //
  //	A(B[CD]|EF)|BC[XY]
  factor(sub: Regexp[]): Regexp[] {
    if (sub.length < 2) {
      return sub;
    }

    // Round 1: Factor out common literal prefixes.
    let str: number[] = [];
    let strflags = 0;
    let start = 0;
    let out: Regexp[] = [];
    for (let i = 0; i <= sub.length; i++) {
      // Invariant: sub[start:i] consists of regexps that all begin
      // with str as modified by strflags.
      let istr: number[] = [];
      let iflags = 0;
      if (i < sub.length) {
        [istr, iflags] = this.leadingString(sub[i] as Regexp);
        if (iflags === strflags) {
          let same = 0;
          while (same < str.length && same < istr.length && str[same] === istr[same]) {
            same++;
          }
          if (same > 0) {
            // Matches at least one rune in current range.
            // Keep going around.
            str = str.slice(0, same);
            continue;
          }
        }
      }

      // Found end of a run with common leading literal string:
      // sub[start:i] all begin with str[:len(str)], but sub[i]
      // does not even begin with str[0].
      //
      // Factor out common string and append factored expression to out.
      if (i === start) {
        // Nothing to do - run of length 0.
      } else if (i === start + 1) {
        // Just one: don't bother factoring.
        out.push(sub[start] as Regexp);
      } else {
        // Construct factored form: prefix(suffix1|suffix2|...)
        const prefix = this.newRegexp(OpLiteral);
        prefix.flags = strflags;
        prefix.rune = str.slice();

        for (let j = start; j < i; j++) {
          sub[j] = this.removeLeadingString(sub[j] as Regexp, str.length);
          this.checkLimits(sub[j] as Regexp);
        }
        const suffix = this.collapse(sub.slice(start, i), OpAlternate); // recurse

        const re = this.newRegexp(OpConcat);
        re.sub = [prefix, suffix];
        out.push(re);
      }

      // Prepare for next iteration.
      start = i;
      str = istr;
      strflags = iflags;
    }
    sub = out;

    // Round 2: Factor out common simple prefixes,
    // just the first piece of each concatenation.
    // This will be good enough a lot of the time.
    //
    // Complex subexpressions (e.g. involving quantifiers)
    // are not safe to factor because that collapses their
    // distinct paths through the automaton, which affects
    // correctness in some cases.
    start = 0;
    out = [];
    let first: Regexp | null = null;
    for (let i = 0; i <= sub.length; i++) {
      // Invariant: sub[start:i] consists of regexps that all begin with ifirst.
      let ifirst: Regexp | null = null;
      if (i < sub.length) {
        ifirst = this.leadingRegexp(sub[i] as Regexp);
        if (
          first !== null &&
          first.equal(ifirst) &&
          // first must be a character class OR a fixed repeat of a character class.
          (isCharClass(first) ||
            (first.op === OpRepeat &&
              first.min === first.max &&
              isCharClass(first.sub[0] as Regexp)))
        ) {
          continue;
        }
      }

      // Found end of a run with common leading regexp:
      // sub[start:i] all begin with first but sub[i] does not.
      //
      // Factor out common regexp and append factored expression to out.
      if (i === start) {
        // Nothing to do - run of length 0.
      } else if (i === start + 1) {
        // Just one: don't bother factoring.
        out.push(sub[start] as Regexp);
      } else {
        // Construct factored form: prefix(suffix1|suffix2|...)
        const prefix = first as Regexp;
        for (let j = start; j < i; j++) {
          const reuse = j !== start; // prefix came from sub[start]
          sub[j] = this.removeLeadingRegexp(sub[j] as Regexp, reuse);
          this.checkLimits(sub[j] as Regexp);
        }
        const suffix = this.collapse(sub.slice(start, i), OpAlternate); // recurse

        const re = this.newRegexp(OpConcat);
        re.sub = [prefix, suffix];
        out.push(re);
      }

      // Prepare for next iteration.
      start = i;
      first = ifirst;
    }
    sub = out;

    // Round 3: Collapse runs of single literals into character classes.
    start = 0;
    out = [];
    for (let i = 0; i <= sub.length; i++) {
      // Invariant: sub[start:i] consists of regexps that are either
      // literal runes or character classes.
      if (i < sub.length && isCharClass(sub[i] as Regexp)) {
        continue;
      }

      // sub[i] is not a char or char class;
      // emit char class for sub[start:i]...
      if (i === start) {
        // Nothing to do - run of length 0.
      } else if (i === start + 1) {
        out.push(sub[start] as Regexp);
      } else {
        // Make new char class.
        // Start with most complex regexp in sub[start].
        let max = start;
        for (let j = start + 1; j < i; j++) {
          const m = sub[max] as Regexp;
          const s = sub[j] as Regexp;
          if (m.op < s.op || (m.op === s.op && m.rune.length < s.rune.length)) {
            max = j;
          }
        }
        [sub[start], sub[max]] = [sub[max] as Regexp, sub[start] as Regexp];

        for (let j = start + 1; j < i; j++) {
          mergeCharClass(sub[start] as Regexp, sub[j] as Regexp);
          this.reuse(sub[j] as Regexp);
        }
        cleanAlt(sub[start] as Regexp);
        out.push(sub[start] as Regexp);
      }

      // ... and then emit sub[i].
      if (i < sub.length) {
        out.push(sub[i] as Regexp);
      }
      start = i + 1;
    }
    sub = out;

    // Round 4: Collapse runs of empty matches into a single empty match.
    out = [];
    for (let i = 0; i < sub.length; i++) {
      if (
        i + 1 < sub.length &&
        (sub[i] as Regexp).op === OpEmptyMatch &&
        (sub[i + 1] as Regexp).op === OpEmptyMatch
      ) {
        continue;
      }
      out.push(sub[i] as Regexp);
    }
    sub = out;

    return sub;
  }

  // leadingString returns the leading literal string that re begins with.
  leadingString(re: Regexp): [number[], Flags] {
    if (re.op === OpConcat && re.sub.length > 0) {
      re = re.sub[0] as Regexp;
    }
    if (re.op !== OpLiteral) {
      return [[], 0];
    }
    return [re.rune, re.flags & FoldCase];
  }

  // removeLeadingString removes the first n leading runes
  // from the beginning of re. It returns the replacement for re.
  removeLeadingString(re: Regexp, n: number): Regexp {
    if (re.op === OpConcat && re.sub.length > 0) {
      // Removing a leading string in a concatenation
      // might simplify the concatenation.
      const sub = this.removeLeadingString(re.sub[0] as Regexp, n);
      re.sub[0] = sub;
      if (sub.op === OpEmptyMatch) {
        this.reuse(sub);
        switch (re.sub.length) {
          case 0:
          case 1:
            // Impossible but handle.
            re.op = OpEmptyMatch;
            re.sub = [];
            break;
          case 2: {
            const old = re;
            re = re.sub[1] as Regexp;
            this.reuse(old);
            break;
          }
          default:
            re.sub.splice(0, 1);
        }
      }
      return re;
    }

    if (re.op === OpLiteral) {
      re.rune.splice(0, n);
      if (re.rune.length === 0) {
        re.op = OpEmptyMatch;
      }
    }
    return re;
  }

  // leadingRegexp returns the leading regexp that re begins with.
  leadingRegexp(re: Regexp): Regexp | null {
    if (re.op === OpEmptyMatch) {
      return null;
    }
    if (re.op === OpConcat && re.sub.length > 0) {
      const sub = re.sub[0] as Regexp;
      if (sub.op === OpEmptyMatch) {
        return null;
      }
      return sub;
    }
    return re;
  }

  // removeLeadingRegexp removes the leading regexp in re.
  // It returns the replacement for re.
  // If reuse is true, it passes the removed regexp (if no longer needed) to p.reuse.
  removeLeadingRegexp(re: Regexp, reuse: boolean): Regexp {
    if (re.op === OpConcat && re.sub.length > 0) {
      if (reuse) {
        this.reuse(re.sub[0] as Regexp);
      }
      re.sub.splice(0, 1);
      switch (re.sub.length) {
        case 0:
          re.op = OpEmptyMatch;
          re.sub = [];
          break;
        case 1: {
          const old = re;
          re = re.sub[0] as Regexp;
          this.reuse(old);
          break;
        }
      }
      return re;
    }
    if (reuse) {
      this.reuse(re);
    }
    return this.newRegexp(OpEmptyMatch);
  }

  // parseRepeat parses {min} (max=min) or {min,} (max=-1) or {min,max}.
  // If s is not of that form, it returns ok == false.
  // If s has the right form but the values are too big, it returns min == -1, ok == true.
  parseRepeat(s: string): [min: number, max: number, rest: string, ok: boolean] {
    const fail: [number, number, string, boolean] = [0, 0, "", false];
    if (s === "" || s[0] !== "{") {
      return fail;
    }
    s = s.slice(1);
    let min: number;
    let max: number;
    let ok1: boolean;
    [min, s, ok1] = this.parseInt(s);
    if (!ok1) {
      return [min, 0, "", false];
    }
    if (s === "") {
      return [min, 0, "", false];
    }
    if (s[0] !== ",") {
      max = min;
    } else {
      s = s.slice(1);
      if (s === "") {
        return [min, 0, "", false];
      }
      if (s[0] === "}") {
        max = -1;
      } else {
        [max, s, ok1] = this.parseInt(s);
        if (!ok1) {
          return [min, max, "", false];
        } else if (max < 0) {
          // parseInt found too big a number
          min = -1;
        }
      }
    }
    if (s === "" || s[0] !== "}") {
      return [min, max, "", false];
    }
    return [min, max, s.slice(1), true];
  }

  // parsePerlFlags parses a Perl flag setting or non-capturing group or both,
  // like (?i) or (?: or (?i:.  It removes the prefix from s and updates the parse state.
  // The caller must have ensured that s begins with "(?".
  parsePerlFlags(s: string): string {
    let t = s;

    // Check for named captures, first introduced in Python's regexp library.
    // As usual, there are three slightly different syntaxes:
    //
    //   (?P<name>expr)   the original, introduced by Python
    //   (?<name>expr)    the .NET alteration, adopted by Perl 5.10
    //   (?'name'expr)    another .NET alteration, adopted by Perl 5.10
    //
    // Perl 5.10 gave in and implemented the Python version too,
    // but they claim that the last two are the preferred forms.
    // PCRE and languages based on it (specifically, PHP and Ruby)
    // support all three as well. EcmaScript 4 uses only the Python form.
    //
    // In both the open source world (via Code Search) and the
    // Google source tree, (?P<expr>name) and (?<expr>name) are the
    // dominant forms of named captures and both are supported.
    const startsWithP = t.length > 4 && t[2] === "P" && t[3] === "<";
    const startsWithName = t.length > 3 && t[2] === "<";

    if (startsWithP || startsWithName) {
      // position of expr start
      let exprStartPos = 4;
      if (startsWithName) {
        exprStartPos = 3;
      }

      // Pull out name.
      const end = t.indexOf(">");
      if (end < 0) {
        checkUTF8(t);
        throw new RegexpSyntaxError(ErrInvalidNamedCapture, s);
      }

      const capture = t.slice(0, end + 1); // "(?P<name>" or "(?<name>"
      const name = t.slice(exprStartPos, end); // "name"
      checkUTF8(name);
      if (!isValidCaptureName(name)) {
        throw new RegexpSyntaxError(ErrInvalidNamedCapture, capture);
      }

      // Like ordinary capture, but named.
      this.numCap++;
      const re = this.op(opLeftParen);
      re.cap = this.numCap;
      re.name = name;
      return t.slice(end + 1);
    }

    // Non-capturing group. Might also twiddle Perl flags.
    let c: number;
    t = t.slice(2); // skip (?
    let flags = this.flags;
    let sign = +1;
    let sawFlag = false;
    loop: while (t !== "") {
      [c, t] = nextRune(t);
      switch (c) {
        default:
          break loop;

        // Flags.
        case 0x69: // 'i'
          flags |= FoldCase;
          sawFlag = true;
          break;
        case 0x6d: // 'm'
          flags &= ~OneLine;
          sawFlag = true;
          break;
        case 0x73: // 's'
          flags |= DotNL;
          sawFlag = true;
          break;
        case 0x55: // 'U'
          flags |= NonGreedy;
          sawFlag = true;
          break;

        // Switch to negation.
        case 0x2d: // '-'
          if (sign < 0) {
            break loop;
          }
          sign = -1;
          // Invert flags so that | above turn into &^ and vice versa.
          // We'll invert flags again before using it below.
          flags = ~flags & flagsMask;
          sawFlag = false;
          break;

        // End of flags, starting group or not.
        case 0x3a: // ':'
        case 0x29: // ')'
          if (sign < 0) {
            if (!sawFlag) {
              break loop;
            }
            flags = ~flags & flagsMask;
          }
          if (c === 0x3a) {
            // Open new group
            this.op(opLeftParen);
          }
          this.flags = flags;
          return t;
      }
    }

    throw new RegexpSyntaxError(ErrInvalidPerlOp, s.slice(0, s.length - t.length));
  }

  // parseInt parses a decimal integer.
  parseInt(s: string): [n: number, rest: string, ok: boolean] {
    if (s === "" || s[0] === undefined || s[0] < "0" || "9" < s[0]) {
      return [0, "", false];
    }
    // Disallow leading zeros.
    if (s.length >= 2 && s[0] === "0" && "0" <= (s[1] as string) && (s[1] as string) <= "9") {
      return [0, "", false];
    }
    let t = s;
    while (s !== "" && "0" <= (s[0] as string) && (s[0] as string) <= "9") {
      s = s.slice(1);
    }
    const rest = s;
    // Have digits, compute value.
    t = t.slice(0, t.length - s.length);
    let n = 0;
    for (let i = 0; i < t.length; i++) {
      // Avoid overflow.
      if (n >= 1e8) {
        n = -1;
        break;
      }
      n = n * 10 + t.charCodeAt(i) - 0x30;
    }
    return [n, rest, true];
  }

  // parseVerticalBar handles a | in the input.
  parseVerticalBar(): void {
    this.concat();

    // The concatenation we just parsed is on top of the stack.
    // If it sits above an opVerticalBar, swap it below
    // (things below an opVerticalBar become an alternation).
    // Otherwise, push a new vertical bar.
    if (!this.swapVerticalBar()) {
      this.op(opVerticalBar);
    }
  }

  // If the top of the stack is an element followed by an opVerticalBar
  // swapVerticalBar swaps the two and returns true.
  // Otherwise it returns false.
  swapVerticalBar(): boolean {
    // If above and below vertical bar are literal or char class,
    // can merge into a single char class.
    const stack = this.stack;
    const n = stack.length;
    if (
      n >= 3 &&
      (stack[n - 2] as Regexp).op === opVerticalBar &&
      isCharClass(stack[n - 1] as Regexp) &&
      isCharClass(stack[n - 3] as Regexp)
    ) {
      let re1 = stack[n - 1] as Regexp;
      let re3 = stack[n - 3] as Regexp;
      // Make re3 the more complex of the two.
      if (re1.op > re3.op) {
        [re1, re3] = [re3, re1];
        stack[n - 3] = re3;
      }
      mergeCharClass(re3, re1);
      this.reuse(re1);
      stack.length = n - 1;
      return true;
    }

    if (n >= 2) {
      const re1 = stack[n - 1] as Regexp;
      const re2 = stack[n - 2] as Regexp;
      if (re2.op === opVerticalBar) {
        if (n >= 3) {
          // Now out of reach.
          // Clean opportunistically.
          cleanAlt(stack[n - 3] as Regexp);
        }
        stack[n - 2] = re1;
        stack[n - 1] = re2;
        return true;
      }
    }
    return false;
  }

  // parseRightParen handles a ) in the input.
  parseRightParen(): void {
    this.concat();
    if (this.swapVerticalBar()) {
      // pop vertical bar
      this.stack.length--;
    }
    this.alternate();

    const n = this.stack.length;
    if (n < 2) {
      throw new RegexpSyntaxError(ErrUnexpectedParen, this.wholeRegexp);
    }
    const re1 = this.stack[n - 1] as Regexp;
    const re2 = this.stack[n - 2] as Regexp;
    this.stack.length = n - 2;
    if (re2.op !== opLeftParen) {
      throw new RegexpSyntaxError(ErrUnexpectedParen, this.wholeRegexp);
    }
    // Restore flags at time of paren.
    this.flags = re2.flags;
    if (re2.cap === 0) {
      // Just for grouping.
      this.push(re1);
    } else {
      re2.op = OpCapture;
      re2.sub = [re1];
      this.push(re2);
    }
  }

  // parseEscape parses an escape sequence at the beginning of s
  // and returns the rune.
  parseEscape(s: string): [r: number, rest: string] {
    let t = s.slice(1);
    if (t === "") {
      throw new RegexpSyntaxError(ErrTrailingBackslash, "");
    }
    let c: number;
    [c, t] = nextRune(t);

    escape: switch (c) {
      default:
        if (c < RuneSelf && !isalnum(c)) {
          // Escaped non-word characters are always themselves.
          // PCRE is not quite so rigorous: it accepts things like
          // \q, but we don't. We once rejected \_, but too many
          // programs and people insist on using it, so allow \_.
          return [c, t];
        }
        break;

      // Octal escapes.
      case 0x31: // '1'
      case 0x32:
      case 0x33:
      case 0x34:
      case 0x35:
      case 0x36:
      case 0x37: // '7'
      case 0x30: {
        // '0'
        // Single non-zero digit is a backreference; not supported
        if (c !== 0x30 && (t === "" || (t[0] as string) < "0" || (t[0] as string) > "7")) {
          break;
        }
        // Consume up to three octal digits; already have one.
        let r = c - 0x30;
        for (let i = 1; i < 3; i++) {
          if (t === "" || (t[0] as string) < "0" || (t[0] as string) > "7") {
            break;
          }
          r = r * 8 + t.charCodeAt(0) - 0x30;
          t = t.slice(1);
        }
        return [r, t];
      }

      // Hexadecimal escapes.
      case 0x78: {
        // 'x'
        if (t === "") {
          break;
        }
        [c, t] = nextRune(t);
        if (c === 0x7b) {
          // '{'
          // Any number of digits in braces.
          // Perl accepts any text at all; it ignores all text
          // after the first non-hex digit. We require only hex digits,
          // and at least one.
          let nhex = 0;
          let r = 0;
          for (;;) {
            if (t === "") {
              break escape;
            }
            [c, t] = nextRune(t);
            if (c === 0x7d) {
              // '}'
              break;
            }
            const v = unhex(c);
            if (v < 0) {
              break escape;
            }
            r = r * 16 + v;
            if (r > MaxRune) {
              break escape;
            }
            nhex++;
          }
          if (nhex === 0) {
            break escape;
          }
          return [r, t];
        }

        // Easy case: two hex digits.
        const x = unhex(c);
        [c, t] = nextRune(t);
        const y = unhex(c);
        if (x < 0 || y < 0) {
          break;
        }
        return [x * 16 + y, t];
      }

      // C escapes. There is no case 'b', to avoid misparsing
      // the Perl word-boundary \b as the C backspace \b
      // when in POSIX mode. In Perl, /\b/ means word-boundary
      // but /[\b]/ means backspace. We don't support that.
      // If you want a backspace, embed a literal backspace
      // character or use \x08.
      case 0x61: // 'a'
        return [0x07, t];
      case 0x66: // 'f'
        return [0x0c, t];
      case 0x6e: // 'n'
        return [0x0a, t];
      case 0x72: // 'r'
        return [0x0d, t];
      case 0x74: // 't'
        return [0x09, t];
      case 0x76: // 'v'
        return [0x0b, t];
    }
    throw new RegexpSyntaxError(ErrInvalidEscape, s.slice(0, s.length - t.length));
  }

  // parseClassChar parses a character class character at the beginning of s
  // and returns it.
  parseClassChar(s: string, wholeClass: string): [r: number, rest: string] {
    if (s === "") {
      throw new RegexpSyntaxError(ErrMissingBracket, wholeClass);
    }

    // Allow regular escape sequences even though
    // many need not be escaped in this context.
    if (s[0] === "\\") {
      return this.parseEscape(s);
    }

    return nextRune(s);
  }

  // parsePerlClassEscape parses a leading Perl character class escape like \d
  // from the beginning of s. If one is present, it appends the characters to r
  // and returns the new slice r and the remainder of the string.
  parsePerlClassEscape(s: string, r: number[]): [out: number[], rest: string] | null {
    if ((this.flags & PerlX) === 0 || s.length < 2 || s[0] !== "\\") {
      return null;
    }
    const g = perlGroup.get(s.slice(0, 2));
    if (g === undefined) {
      return null;
    }
    return [this.appendGroup(r, g), s.slice(2)];
  }

  // parseNamedClass parses a leading POSIX named character class like [:alnum:]
  // from the beginning of s. If one is present, it appends the characters to r
  // and returns the new slice r and the remainder of the string.
  parseNamedClass(s: string, r: number[]): [out: number[], rest: string] | null {
    if (s.length < 2 || s[0] !== "[" || s[1] !== ":") {
      return null;
    }

    let i = s.slice(2).indexOf(":]");
    if (i < 0) {
      return null;
    }
    i += 2;
    const name = s.slice(0, i + 2);
    s = s.slice(i + 2);
    const g = posixGroup.get(name);
    if (g === undefined) {
      throw new RegexpSyntaxError(ErrInvalidCharRange, name);
    }
    return [this.appendGroup(r, g), s];
  }

  appendGroup(r: number[], g: charGroup): number[] {
    if ((this.flags & FoldCase) === 0) {
      if (g.sign < 0) {
        r = appendNegatedClass(r, g.class);
      } else {
        r = appendClass(r, g.class);
      }
    } else {
      this.tmpClass = appendFoldedClass([], g.class);
      const tmp = cleanClass(this.tmpClass);
      if (g.sign < 0) {
        r = appendNegatedClass(r, tmp);
      } else {
        r = appendClass(r, tmp);
      }
    }
    return r;
  }

  // parseUnicodeClass parses a leading Unicode character class like \p{Han}
  // from the beginning of s. If one is present, it appends the characters to r
  // and returns the new slice r and the remainder of the string.
  parseUnicodeClass(s: string, r: number[]): [out: number[], rest: string] | null {
    if (
      (this.flags & UnicodeGroups) === 0 ||
      s.length < 2 ||
      s[0] !== "\\" ||
      (s[1] !== "p" && s[1] !== "P")
    ) {
      return null;
    }

    // Committed to parse or return error.
    let sign = +1;
    if (s[1] === "P") {
      sign = -1;
    }
    let t = s.slice(2);
    let c: number;
    [c, t] = nextRune(t);
    let seq: string;
    let name: string;
    if (c !== 0x7b) {
      // Single-letter name.
      seq = s.slice(0, s.length - t.length);
      name = seq.slice(2);
    } else {
      // Name is in braces.
      const end = s.indexOf("}");
      if (end < 0) {
        checkUTF8(s);
        throw new RegexpSyntaxError(ErrInvalidCharRange, s);
      }
      seq = s.slice(0, end + 1);
      t = s.slice(end + 1);
      name = s.slice(3, end);
      checkUTF8(name);
    }

    // Group can have leading negation too.  \p{^Han} == \P{Han}, \P{^Han} == \p{Han}.
    if (name !== "" && name[0] === "^") {
      sign = -sign;
      name = name.slice(1);
    }

    const [tab, fold, tsign] = unicodeTable(name);
    if (tab === null) {
      throw new RegexpSyntaxError(ErrInvalidCharRange, seq);
    }
    if (tsign < 0) {
      sign = -sign;
    }

    if ((this.flags & FoldCase) === 0 || fold === null) {
      if (sign > 0) {
        r = appendTable(r, tab);
      } else {
        r = appendNegatedTable(r, tab);
      }
    } else {
      // Merge and clean tab and fold in a temporary buffer.
      // This is necessary for the negative case and just tidy
      // for the positive case.
      let tmp = appendTable([], tab);
      tmp = appendTable(tmp, fold);
      this.tmpClass = tmp;
      tmp = cleanClass(this.tmpClass);
      if (sign > 0) {
        r = appendClass(r, tmp);
      } else {
        r = appendNegatedClass(r, tmp);
      }
    }
    return [r, t];
  }

  // parseClass parses a character class at the beginning of s
  // and pushes it onto the parse stack.
  parseClass(s: string): string {
    let t = s.slice(1); // chop [
    const re = this.newRegexp(OpCharClass);
    re.flags = this.flags;
    re.rune = [];

    let sign = +1;
    if (t !== "" && t[0] === "^") {
      sign = -1;
      t = t.slice(1);

      // If character class does not match \n, add it here,
      // so that negation later will do the right thing.
      if ((this.flags & ClassNL) === 0) {
        re.rune.push(0x0a, 0x0a);
      }
    }

    let cls = re.rune;
    let first = true; // ] and - are okay as first char in class
    while (t === "" || t[0] !== "]" || first) {
      // POSIX: - is only okay unescaped as first or last in class.
      // Perl: - is okay anywhere.
      if (
        t !== "" &&
        t[0] === "-" &&
        (this.flags & PerlX) === 0 &&
        !first &&
        (t.length === 1 || t[1] !== "]")
      ) {
        const [, size] = DecodeRuneInString(t.slice(1));
        throw new RegexpSyntaxError(ErrInvalidCharRange, t.slice(0, 1 + size));
      }
      first = false;

      // Look for POSIX [:alnum:] etc.
      if (t.length > 2 && t[0] === "[" && t[1] === ":") {
        const named = this.parseNamedClass(t, cls);
        if (named !== null) {
          [cls, t] = named;
          continue;
        }
      }

      // Look for Unicode character group like \p{Han}.
      const unicode = this.parseUnicodeClass(t, cls);
      if (unicode !== null) {
        [cls, t] = unicode;
        continue;
      }

      // Look for Perl character class symbols (extension).
      const perl = this.parsePerlClassEscape(t, cls);
      if (perl !== null) {
        [cls, t] = perl;
        continue;
      }

      // Single character or simple range.
      let rng = t;
      let lo: number;
      let hi: number;
      [lo, t] = this.parseClassChar(t, s);
      hi = lo;
      // [a-] means (a|-) so check for final ].
      if (t.length >= 2 && t[0] === "-" && t[1] !== "]") {
        t = t.slice(1);
        [hi, t] = this.parseClassChar(t, s);
        if (hi < lo) {
          rng = rng.slice(0, rng.length - t.length);
          throw new RegexpSyntaxError(ErrInvalidCharRange, rng);
        }
      }
      if ((this.flags & FoldCase) === 0) {
        cls = appendRange(cls, lo, hi);
      } else {
        cls = appendFoldedRange(cls, lo, hi);
      }
    }
    t = t.slice(1); // chop ]

    re.rune = cls;
    cls = cleanClass(re.rune);
    if (sign < 0) {
      cls = negateClass(cls);
    }
    re.rune = cls;
    this.push(re);
    return t;
  }
}

// minFoldRune returns the minimum rune fold-equivalent to r.
function minFoldRune(r: number): number {
  if (r < minFold || r > maxFold) {
    return r;
  }
  let m = r;
  const r0 = r;
  for (r = SimpleFold(r); r !== r0; r = SimpleFold(r)) {
    m = Math.min(m, r);
  }
  return m;
}

// repeatIsValid reports whether the repetition re is valid.
// Valid means that the combination of the top-level repetition
// and any inner repetitions does not exceed n copies of the
// innermost thing.
// This function rewalks the regexp tree and is called for every repetition,
// so we have to worry about inducing quadratic behavior in the parser.
// We avoid this by only calling repeatIsValid when min or max >= 2.
// In that case the depth of any >= 2 nesting can only get to 9 without
// triggering a parse error, so each subtree can only be rewalked 9 times.
function repeatIsValid(re: Regexp, n: number): boolean {
  if (re.op === OpRepeat) {
    let m = re.max;
    if (m === 0) {
      return true;
    }
    if (m < 0) {
      m = re.min;
    }
    if (m > n) {
      return false;
    }
    if (m > 0) {
      n = Math.trunc(n / m);
    }
  }
  for (const sub of re.sub) {
    if (!repeatIsValid(sub, n)) {
      return false;
    }
  }
  return true;
}

// cleanAlt cleans re for eventual inclusion in an alternation.
function cleanAlt(re: Regexp): void {
  if (re.op === OpCharClass) {
    re.rune = cleanClass(re.rune);
    const rs = re.rune;
    if (rs.length === 2 && rs[0] === 0 && rs[1] === MaxRune) {
      re.rune = [];
      re.op = OpAnyChar;
      return;
    }
    if (
      rs.length === 4 &&
      rs[0] === 0 &&
      rs[1] === 0x0a - 1 &&
      rs[2] === 0x0a + 1 &&
      rs[3] === MaxRune
    ) {
      re.rune = [];
      re.op = OpAnyCharNotNL;
      return;
    }
  }
}

function literalRegexp(s: string, flags: Flags): Regexp {
  const re = new Regexp(OpLiteral);
  re.flags = flags;
  for (const c of s) {
    re.rune.push(c.codePointAt(0) as number);
  }
  return re;
}

// Parsing.

// Parse parses a regular expression string s, controlled by the specified
// Flags, and returns a regular expression parse tree. It throws a
// RegexpSyntaxError with Go's error text when s is not valid.
//
// s is a JS string (Go's bytes as described in src/tools/unicode/utf8.ts)
// or the bytes themselves.
export function Parse(s: string | Uint8Array, flags: Flags): Regexp {
  const str = goString(s);
  try {
    return parse(str, flags & flagsMask);
  } catch (error) {
    if (error instanceof limitPanic) {
      // too big or too deep
      throw new RegexpSyntaxError(error.code, str);
    }
    throw error;
  }
}

function parse(s: string, flags: Flags): Regexp {
  if ((flags & Literal) !== 0) {
    // Trivial parser for literal string.
    checkUTF8(s);
    return literalRegexp(s, flags);
  }

  // Otherwise, must do real work.
  const p = new parser();
  let c: number;
  let op: Op;
  let lastRepeat = "";
  p.flags = flags;
  p.wholeRegexp = s;
  let t = s;
  while (t !== "") {
    let repeat = "";
    bigSwitch: switch (t[0]) {
      default:
        [c, t] = nextRune(t);
        p.literal(c);
        break;

      case "(":
        if ((p.flags & PerlX) !== 0 && t.length >= 2 && t[1] === "?") {
          // Flag changes and non-capturing groups.
          t = p.parsePerlFlags(t);
          break;
        }
        p.numCap++;
        p.op(opLeftParen).cap = p.numCap;
        t = t.slice(1);
        break;
      case "|":
        p.parseVerticalBar();
        t = t.slice(1);
        break;
      case ")":
        p.parseRightParen();
        t = t.slice(1);
        break;
      case "^":
        if ((p.flags & OneLine) !== 0) {
          p.op(OpBeginText);
        } else {
          p.op(OpBeginLine);
        }
        t = t.slice(1);
        break;
      case "$":
        if ((p.flags & OneLine) !== 0) {
          p.op(OpEndText).flags |= WasDollar;
        } else {
          p.op(OpEndLine);
        }
        t = t.slice(1);
        break;
      case ".":
        if ((p.flags & DotNL) !== 0) {
          p.op(OpAnyChar);
        } else {
          p.op(OpAnyCharNotNL);
        }
        t = t.slice(1);
        break;
      case "[":
        t = p.parseClass(t);
        break;
      case "*":
      case "+":
      case "?": {
        const before = t;
        switch (t[0]) {
          case "*":
            op = OpStar;
            break;
          case "+":
            op = OpPlus;
            break;
          default:
            op = OpQuest;
        }
        let after = t.slice(1);
        after = p.repeat(op, 0, 0, before, after, lastRepeat);
        repeat = before;
        t = after;
        break;
      }
      case "{": {
        op = OpRepeat;
        const before = t;
        const [min, max, after0, ok] = p.parseRepeat(t);
        if (!ok) {
          // If the repeat cannot be parsed, { is a literal.
          p.literal(0x7b);
          t = t.slice(1);
          break;
        }
        if (min < 0 || min > 1000 || max > 1000 || (max >= 0 && min > max)) {
          // Numbers were too big, or max is present and min > max.
          throw new RegexpSyntaxError(
            ErrInvalidRepeatSize,
            before.slice(0, before.length - after0.length),
          );
        }
        const after = p.repeat(op, min, max, before, after0, lastRepeat);
        repeat = before;
        t = after;
        break;
      }
      case "\\": {
        if ((p.flags & PerlX) !== 0 && t.length >= 2) {
          switch (t[1]) {
            case "A":
              p.op(OpBeginText);
              t = t.slice(2);
              break bigSwitch;
            case "b":
              p.op(OpWordBoundary);
              t = t.slice(2);
              break bigSwitch;
            case "B":
              p.op(OpNoWordBoundary);
              t = t.slice(2);
              break bigSwitch;
            case "C":
              // any byte; not supported
              throw new RegexpSyntaxError(ErrInvalidEscape, t.slice(0, 2));
            case "Q": {
              // \Q ... \E: the ... is always literals
              let lit: string;
              const rest = t.slice(2);
              const end = rest.indexOf("\\E");
              if (end < 0) {
                lit = rest;
                t = "";
              } else {
                lit = rest.slice(0, end);
                t = rest.slice(end + 2);
              }
              while (lit !== "") {
                [c, lit] = nextRune(lit);
                p.literal(c);
              }
              break bigSwitch;
            }
            case "z":
              p.op(OpEndText);
              t = t.slice(2);
              break bigSwitch;
          }
        }

        const re = p.newRegexp(OpCharClass);
        re.flags = p.flags;

        // Look for Unicode character group like \p{Han}
        if (t.length >= 2 && (t[1] === "p" || t[1] === "P")) {
          const unicode = p.parseUnicodeClass(t, []);
          if (unicode !== null) {
            [re.rune, t] = unicode;
            p.push(re);
            break bigSwitch;
          }
        }

        // Perl character class escape.
        const perl = p.parsePerlClassEscape(t, []);
        if (perl !== null) {
          [re.rune, t] = perl;
          p.push(re);
          break bigSwitch;
        }
        p.reuse(re);

        // Ordinary single-character escape.
        [c, t] = p.parseEscape(t);
        p.literal(c);
        break;
      }
    }
    lastRepeat = repeat;
  }

  p.concat();
  if (p.swapVerticalBar()) {
    // pop vertical bar
    p.stack.length--;
  }
  p.alternate();

  const n = p.stack.length;
  if (n !== 1) {
    throw new RegexpSyntaxError(ErrMissingParen, s);
  }
  return p.stack[0] as Regexp;
}

// isValidCaptureName reports whether name
// is a valid capture name: [A-Za-z0-9_]+.
// PCRE limits names to 32 bytes.
// Python rejects names starting with digits.
// We don't enforce either of those.
function isValidCaptureName(name: string): boolean {
  if (name === "") {
    return false;
  }
  for (const ch of name) {
    const c = ch.codePointAt(0) as number;
    if (c !== 0x5f && !isalnum(c)) {
      return false;
    }
  }
  return true;
}

// can this be represented as a character class?
// single-rune literal string, char class, ., and .|\n.
function isCharClass(re: Regexp): boolean {
  return (
    (re.op === OpLiteral && re.rune.length === 1) ||
    re.op === OpCharClass ||
    re.op === OpAnyCharNotNL ||
    re.op === OpAnyChar
  );
}

// does re match r?
function matchRune(re: Regexp, r: number): boolean {
  switch (re.op) {
    case OpLiteral:
      return re.rune.length === 1 && re.rune[0] === r;
    case OpCharClass:
      for (let i = 0; i < re.rune.length; i += 2) {
        if ((re.rune[i] as number) <= r && r <= (re.rune[i + 1] as number)) {
          return true;
        }
      }
      return false;
    case OpAnyCharNotNL:
      return r !== 0x0a;
    case OpAnyChar:
      return true;
  }
  return false;
}

// mergeCharClass makes dst = dst|src.
// The caller must ensure that dst.Op >= src.Op,
// to reduce the amount of copying.
function mergeCharClass(dst: Regexp, src: Regexp): void {
  switch (dst.op) {
    case OpAnyChar:
      // src doesn't add anything.
      break;
    case OpAnyCharNotNL:
      // src might add \n
      if (matchRune(src, 0x0a)) {
        dst.op = OpAnyChar;
      }
      break;
    case OpCharClass:
      // src is simpler, so either literal or char class
      if (src.op === OpLiteral) {
        dst.rune = appendLiteral(dst.rune, src.rune[0] as number, src.flags);
      } else {
        dst.rune = appendClass(dst.rune, src.rune);
      }
      break;
    case OpLiteral: {
      // both literal
      const d = dst.rune[0] as number;
      if (src.rune[0] === d && src.flags === dst.flags) {
        break;
      }
      dst.op = OpCharClass;
      dst.rune = appendLiteral([], d, dst.flags);
      dst.rune = appendLiteral(dst.rune, src.rune[0] as number, src.flags);
      break;
    }
  }
}

const anyTable: RangeTable = { ranges: [0, 0xffff, 1, 0x10000, MaxRune, 1] };

const asciiTable: RangeTable = { ranges: [0, 0x7f, 1] };

const asciiFoldTable: RangeTable = {
  ranges: [
    0,
    0x7f,
    1,
    0x017f, // Old English long s (ſ), folds to S/s.
    0x017f,
    1,
    0x212a, // Kelvin K, folds to K/k.
    0x212a,
    1,
  ],
};

// aliases is a lazily constructed copy of unicode.CategoryAliases and
// unicode.Scripts but with the keys passed through canonicalName, to
// support inexact matches (a module-level cache of constant data).
let aliases: { categories: Map<string, string>; scripts: Map<string, string> } | undefined;

// initAliases initializes categoryAliases by canonicalizing unicode.CategoryAliases.
function initAliases(): { categories: Map<string, string>; scripts: Map<string, string> } {
  const categories = new Map<string, string>();
  const scripts = new Map<string, string>();
  for (const [name, actual] of Object.entries(CategoryAliases)) {
    categories.set(canonicalName(name), actual);
  }
  for (const name of Scripts().keys()) {
    scripts.set(canonicalName(name), name);
  }
  return { categories, scripts };
}

// canonicalName returns the canonical lookup string for name.
// The canonical name has a leading uppercase letter and then lowercase letters,
// and it omits all underscores, spaces, and hyphens.
// (We could have used all lowercase, but this way most package unicode
// map keys are already canonical.)
function canonicalName(name: string): string {
  let b = "";
  let first = true;
  for (let i = 0; i < name.length; i++) {
    let c = name.charCodeAt(i);
    if (c === 0x5f || c === 0x2d || c === 0x20) {
      continue;
    }
    if (first) {
      if (0x61 <= c && c <= 0x7a) {
        c -= 0x20;
      }
      first = false;
    } else if (0x41 <= c && c <= 0x5a) {
      c += 0x20;
    }
    b += String.fromCharCode(c);
  }
  return b;
}

// unicodeTable returns the unicode.RangeTable identified by name
// and the table of additional fold-equivalent code points.
// If sign < 0, the result should be inverted.
function unicodeTable(
  name: string,
): [tab: RangeTable | null, fold: RangeTable | null, sign: number] {
  name = canonicalName(name);

  // Special cases: Any, Assigned, and ASCII.
  // Also LC is the only non-canonical Categories key, so handle it here.
  switch (name) {
    case "Any":
      return [anyTable, anyTable, +1];
    case "Assigned": {
      const cn = Categories().get("Cn") as RangeTable;
      return [cn, cn, -1]; // invert Cn (unassigned)
    }
    case "Ascii":
      return [asciiTable, asciiFoldTable, +1];
    case "Lc":
      return [Categories().get("LC") ?? null, FoldCategory().get("LC") ?? null, +1];
  }
  const cat = Categories().get(name);
  if (cat !== undefined) {
    return [cat, FoldCategory().get(name) ?? null, +1];
  }
  const script = Scripts().get(name);
  if (script !== undefined) {
    return [script, FoldScript().get(name) ?? null, +1];
  }

  // unicode.CategoryAliases makes liberal use of underscores in its names
  // (they are defined that way by Unicode), but we want to match ignoring
  // the underscores, so make our own map with canonical names.
  aliases ??= initAliases();
  const actualCategory = aliases.categories.get(name);
  if (actualCategory !== undefined && actualCategory !== "") {
    return [
      Categories().get(actualCategory) ?? null,
      FoldCategory().get(actualCategory) ?? null,
      +1,
    ];
  }
  const actualScript = aliases.scripts.get(name);
  if (actualScript !== undefined && actualScript !== "") {
    return [Scripts().get(actualScript) ?? null, FoldScript().get(actualScript) ?? null, +1];
  }
  return [null, null, 0];
}

// cleanClass sorts the ranges (pairs of elements of r),
// merges them, and eliminates duplicates. It works in place and returns r.
function cleanClass(r: number[]): number[] {
  // Sort by lo increasing, hi decreasing to break ties.
  const pairs: [number, number][] = [];
  for (let i = 0; i + 1 < r.length; i += 2) {
    pairs.push([r[i] as number, r[i + 1] as number]);
  }
  pairs.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : b[1] - a[1]));
  pairs.forEach(([lo, hi], i) => {
    r[2 * i] = lo;
    r[2 * i + 1] = hi;
  });

  if (r.length < 2) {
    return r;
  }

  // Merge abutting, overlapping.
  let w = 2; // write index
  for (let i = 2; i < r.length; i += 2) {
    const lo = r[i] as number;
    const hi = r[i + 1] as number;
    if (lo <= (r[w - 1] as number) + 1) {
      // merge with previous range
      if (hi > (r[w - 1] as number)) {
        r[w - 1] = hi;
      }
      continue;
    }
    // new disjoint range
    r[w] = lo;
    r[w + 1] = hi;
    w += 2;
  }

  r.length = w;
  return r;
}

// inCharClass reports whether r is in the class.
// It assumes the class has been cleaned by cleanClass.
export function inCharClass(r: number, cls: readonly number[]): boolean {
  let lo = 0;
  let hi = cls.length / 2;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (r > (cls[2 * m + 1] as number)) {
      lo = m + 1;
    } else if (r < (cls[2 * m] as number)) {
      hi = m;
    } else {
      return true;
    }
  }
  return false;
}

// appendLiteral returns the result of appending the literal x to the class r.
function appendLiteral(r: number[], x: number, flags: Flags): number[] {
  if ((flags & FoldCase) !== 0) {
    return appendFoldedRange(r, x, x);
  }
  return appendRange(r, x, x);
}

// appendRange returns the result of appending the range lo-hi to the class r.
export function appendRange(r: number[], lo: number, hi: number): number[] {
  // Expand last range or next to last range if it overlaps or abuts.
  // Checking two ranges helps when appending case-folded
  // alphabets, so that one range can be expanding A-Z and the
  // other expanding a-z.
  const n = r.length;
  for (let i = 2; i <= 4; i += 2) {
    // twice, using i=2, i=4
    if (n >= i) {
      const rlo = r[n - i] as number;
      const rhi = r[n - i + 1] as number;
      if (lo <= rhi + 1 && rlo <= hi + 1) {
        if (lo < rlo) {
          r[n - i] = lo;
        }
        if (hi > rhi) {
          r[n - i + 1] = hi;
        }
        return r;
      }
    }
  }

  r.push(lo, hi);
  return r;
}

// minimum and maximum runes involved in folding.
// checked during test.
export const minFold = 0x0041;
export const maxFold = 0x1e943;

// appendFoldedRange returns the result of appending the range lo-hi
// and its case folding-equivalent runes to the class r.
function appendFoldedRange(r: number[], lo: number, hi: number): number[] {
  // Optimizations.
  if (lo <= minFold && hi >= maxFold) {
    // Range is full: folding can't add more.
    return appendRange(r, lo, hi);
  }
  if (hi < minFold || lo > maxFold) {
    // Range is outside folding possibilities.
    return appendRange(r, lo, hi);
  }
  if (lo < minFold) {
    // [lo, minFold-1] needs no folding.
    r = appendRange(r, lo, minFold - 1);
    lo = minFold;
  }
  if (hi > maxFold) {
    // [maxFold+1, hi] needs no folding.
    r = appendRange(r, maxFold + 1, hi);
    hi = maxFold;
  }

  // Brute force. Depend on appendRange to coalesce ranges on the fly.
  for (let c = lo; c <= hi; c++) {
    r = appendRange(r, c, c);
    let f = SimpleFold(c);
    while (f !== c) {
      r = appendRange(r, f, f);
      f = SimpleFold(f);
    }
  }
  return r;
}

// appendClass returns the result of appending the class x to the class r.
// It assume x is clean.
function appendClass(r: number[], x: readonly number[]): number[] {
  for (let i = 0; i < x.length; i += 2) {
    r = appendRange(r, x[i] as number, x[i + 1] as number);
  }
  return r;
}

// appendFoldedClass returns the result of appending the case folding of the class x to the class r.
function appendFoldedClass(r: number[], x: readonly number[]): number[] {
  for (let i = 0; i < x.length; i += 2) {
    r = appendFoldedRange(r, x[i] as number, x[i + 1] as number);
  }
  return r;
}

// appendNegatedClass returns the result of appending the negation of the class x to the class r.
// It assumes x is clean.
function appendNegatedClass(r: number[], x: readonly number[]): number[] {
  let nextLo = 0;
  for (let i = 0; i < x.length; i += 2) {
    const lo = x[i] as number;
    const hi = x[i + 1] as number;
    if (nextLo <= lo - 1) {
      r = appendRange(r, nextLo, lo - 1);
    }
    nextLo = hi + 1;
  }
  if (nextLo <= MaxRune) {
    r = appendRange(r, nextLo, MaxRune);
  }
  return r;
}

// appendTable returns the result of appending x to the class r.
function appendTable(r: number[], x: RangeTable): number[] {
  const ranges = x.ranges;
  for (let i = 0; i < ranges.length; i += 3) {
    const lo = ranges[i] as number;
    const hi = ranges[i + 1] as number;
    const stride = ranges[i + 2] as number;
    if (stride === 1) {
      r = appendRange(r, lo, hi);
      continue;
    }
    for (let c = lo; c <= hi; c += stride) {
      r = appendRange(r, c, c);
    }
  }
  return r;
}

// appendNegatedTable returns the result of appending the negation of x to the class r.
function appendNegatedTable(r: number[], x: RangeTable): number[] {
  let nextLo = 0; // lo end of next class to add
  const ranges = x.ranges;
  for (let i = 0; i < ranges.length; i += 3) {
    const lo = ranges[i] as number;
    const hi = ranges[i + 1] as number;
    const stride = ranges[i + 2] as number;
    if (stride === 1) {
      if (nextLo <= lo - 1) {
        r = appendRange(r, nextLo, lo - 1);
      }
      nextLo = hi + 1;
      continue;
    }
    for (let c = lo; c <= hi; c += stride) {
      if (nextLo <= c - 1) {
        r = appendRange(r, nextLo, c - 1);
      }
      nextLo = c + 1;
    }
  }
  if (nextLo <= MaxRune) {
    r = appendRange(r, nextLo, MaxRune);
  }
  return r;
}

// negateClass overwrites r and returns r's negation.
// It assumes the class r is already clean.
function negateClass(r: number[]): number[] {
  let nextLo = 0; // lo end of next class to add
  let w = 0; // write index
  for (let i = 0; i < r.length; i += 2) {
    const lo = r[i] as number;
    const hi = r[i + 1] as number;
    if (nextLo <= lo - 1) {
      r[w] = nextLo;
      r[w + 1] = lo - 1;
      w += 2;
    }
    nextLo = hi + 1;
  }
  r.length = w;
  if (nextLo <= MaxRune) {
    // It's possible for the negation to have one more
    // range - this one - than the original class, so use append.
    r.push(nextLo, MaxRune);
  }
  return r;
}

// checkUTF8 throws ErrInvalidUTF8 with the rest of s from the first
// invalid byte.
function checkUTF8(s: string): void {
  while (s !== "") {
    const [rune, size] = DecodeRuneInString(s);
    if (rune === RuneError && size === 1 && s.charCodeAt(0) !== RuneError) {
      throw new RegexpSyntaxError(ErrInvalidUTF8, s);
    }
    s = s.slice(size);
  }
}

function nextRune(s: string): [c: number, t: string] {
  const [c, size] = DecodeRuneInString(s);
  if (c === RuneError && size === 1 && s.charCodeAt(0) !== RuneError) {
    throw new RegexpSyntaxError(ErrInvalidUTF8, s);
  }
  return [c, s.slice(size)];
}

function isalnum(c: number): boolean {
  return (0x30 <= c && c <= 0x39) || (0x41 <= c && c <= 0x5a) || (0x61 <= c && c <= 0x7a);
}

function unhex(c: number): number {
  if (0x30 <= c && c <= 0x39) {
    return c - 0x30;
  }
  if (0x61 <= c && c <= 0x66) {
    return c - 0x61 + 10;
  }
  if (0x41 <= c && c <= 0x46) {
    return c - 0x41 + 10;
  }
  return -1;
}
