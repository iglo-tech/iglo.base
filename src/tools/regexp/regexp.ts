// Upstream: Go go1.27.2 src/regexp/regexp.go.
//
// Strings and positions: inputs are JS strings, and every index (find*Index,
// literal positions) is a Go byte offset into the UTF-8 encoding of the
// input, as upstream's callers see them. A string is encoded to bytes as
// textToBytes in src/tools/types/go-json.ts does, the inverse of the Go
// string form of src/tools/unicode/utf8.ts: a lone surrogate U+DC80+n is the
// invalid byte 0x80+n, which the matcher reads as Go reads an invalid byte
// (one U+FFFD step of width 1), and any other lone surrogate, which no Go
// string can hold, is U+FFFD (three bytes). Returned strings are slices of
// those bytes decoded back to that form, so a match never splits a
// surrogate pair and round-trips through textToBytes.
//
// Compile errors are thrown as RegexpSyntaxError (Go returns them). Go's
// []byte methods are left out except Match; Go's nil results are null.
// The io.RuneReader methods, Copy, Expand, ExpandString, the iterator
// methods and the text marshaling methods are left out.

import { find, input, type program } from "@/tools/regexp/exec";
import { compileOnePass, onePassPrefix } from "@/tools/regexp/onepass";
import { Compile } from "@/tools/regexp/syntax/compile";
import { POSIX, Parse, Perl, type Flags } from "@/tools/regexp/syntax/parse";
import {
  OpAlternate,
  OpAnyChar,
  OpAnyCharNotNL,
  OpCapture,
  OpCharClass,
  OpConcat,
  OpLiteral,
  OpPlus,
  OpRepeat,
  type Regexp as syntaxRegexp,
} from "@/tools/regexp/syntax/regexp";
import { Simplify } from "@/tools/regexp/syntax/simplify";
import { bytesToText, textToBytes } from "@/tools/types/go-json";
import { Categories, Is, IsPrint, type RangeTable } from "@/tools/unicode/letter";
import { DecodeRuneInString, RuneError, goString } from "@/tools/unicode/utf8";

const encoder = new TextEncoder();
const surrogate = /[\ud800-\udfff]/;

// the UTF-8 bytes of s, as described in the header
function toBytes(s: string): Uint8Array {
  return surrogate.test(s) ? textToBytes(s) : encoder.encode(s);
}

// a text and its bytes; slice gives the text of a byte range
class text {
  readonly bytes: Uint8Array;
  // s itself when every byte is ASCII, so a byte range is a code unit range
  private readonly ascii: string | null;

  constructor(s: string | Uint8Array) {
    if (typeof s === "string") {
      this.bytes = toBytes(s);
      this.ascii = this.bytes.length === s.length && !surrogate.test(s) ? s : null;
    } else {
      this.bytes = s;
      this.ascii = null;
    }
  }

  slice(a: number, b: number): string {
    if (this.ascii !== null) {
      return this.ascii.slice(a, b);
    }
    return bytesToText(this.bytes.subarray(a, b));
  }
}

// Regexp is the representation of a compiled regular expression.
export class Regexp {
  readonly #expr: string; // as passed to Compile
  readonly #numSubexp: number;
  readonly #subexpNames: string[];
  readonly #prefixComplete: boolean; // prefix is the entire regexp
  readonly #p: program;

  private constructor(
    expr: string,
    numSubexp: number,
    subexpNames: string[],
    prefixComplete: boolean,
    p: program,
  ) {
    this.#expr = expr;
    this.#numSubexp = numSubexp;
    this.#subexpNames = subexpNames;
    this.#prefixComplete = prefixComplete;
    this.#p = p;
  }

  // compile of regexp.go: Compile is compile(expr, Perl, false) and
  // CompilePOSIX compile(expr, POSIX, true). The expr is kept in the Go
  // string form (a lone surrogate other than an invalid byte is U+FFFD).
  static compile(expr: string, mode: Flags, longest: boolean): Regexp {
    expr = goString(expr);
    let re = Parse(expr, mode);
    const maxCap = re.maxCap();
    const capNames = re.capNames();

    re = Simplify(re) as syntaxRegexp;
    const prog = Compile(re);
    const p: program = {
      prog,
      onepass: compileOnePass(prog),
      prefix: "",
      prefixBytes: new Uint8Array(0),
      prefixRune: 0,
      prefixEnd: 0,
      cond: prog.startCond(),
      minInputLen: minInputLen(re),
      longest,
      machines: [],
    };
    let prefixComplete: boolean;
    if (p.onepass === null) {
      [p.prefix, prefixComplete] = prog.prefix();
    } else {
      [p.prefix, prefixComplete, p.prefixEnd] = onePassPrefix(prog);
    }
    if (p.prefix !== "") {
      p.prefixBytes = encoder.encode(p.prefix);
      p.prefixRune = DecodeRuneInString(p.prefix)[0];
    }
    return new Regexp(expr, maxCap, capNames, prefixComplete, p);
  }

  // String returns the source text used to compile the regular expression.
  string(): string {
    return this.#expr;
  }

  toString(): string {
    return this.#expr;
  }

  // Longest makes future searches prefer the leftmost-longest match.
  // That is, when matching against text, the regexp returns a match that
  // begins as early as possible in the input (leftmost), and among those
  // it chooses a match that is as long as possible.
  longest(): void {
    this.#p.longest = true;
  }

  // NumSubexp returns the number of parenthesized subexpressions in this Regexp.
  numSubexp(): number {
    return this.#numSubexp;
  }

  // SubexpNames returns the names of the parenthesized subexpressions
  // in this Regexp. The name for the first sub-expression is names[1],
  // so that if m is a match slice, the name for m[i] is SubexpNames()[i].
  // Since the Regexp as a whole cannot be named, names[0] is always
  // the empty string. The slice should not be modified.
  subexpNames(): readonly string[] {
    return this.#subexpNames;
  }

  // SubexpIndex returns the index of the first subexpression with the given name,
  // or -1 if there is no subexpression with that name.
  //
  // Note that multiple subexpressions can be written using the same name, as in
  // (?P<bob>a+)(?P<bob>b+), which declares two subexpressions named "bob".
  // In this case, SubexpIndex returns the index of the leftmost such subexpression
  // in the regular expression.
  subexpIndex(name: string): number {
    if (name !== "") {
      const i = this.#subexpNames.indexOf(name);
      if (i >= 0) {
        return i;
      }
    }
    return -1;
  }

  // LiteralPrefix returns a literal string that must begin any match
  // of the regular expression re. It returns the boolean true if the
  // literal string comprises the entire regular expression.
  literalPrefix(): [prefix: string, complete: boolean] {
    return [this.#p.prefix, this.#prefixComplete];
  }

  // MatchString reports whether the string s
  // contains any match of the regular expression re.
  matchString(s: string): boolean {
    return find(this.#p, new input(toBytes(s)), 0, 0) !== null;
  }

  // Match reports whether the byte slice b
  // contains any match of the regular expression re.
  match(b: Uint8Array): boolean {
    return find(this.#p, new input(b), 0, 0) !== null;
  }

  // the find of regexp.go on a text
  #find(t: text, pos: number, ncap: number): number[] | null {
    return find(this.#p, new input(t.bytes), pos, ncap);
  }

  // The number of capture values in the program may correspond
  // to fewer capturing expressions than are in the regexp.
  // For example, "(a){0}" turns into an empty program, so the
  // maximum capture in the program is 0 but we need to return
  // an expression for \1.  Pad appends -1s to the slice a as needed.
  #pad(a: number[] | null): number[] | null {
    if (a === null) {
      // No match.
      return null;
    }
    const n = (1 + this.#numSubexp) * 2;
    while (a.length < n) {
      a.push(-1);
    }
    return a;
  }

  // matches yields the location of successive matches in the input text.
  *#matches(t: text, max: number, ncap: number): Generator<number[]> {
    if (max === 0) {
      return;
    }
    const end = t.bytes.length;
    const i = new input(t.bytes);
    for (let pos = 0, prevMatchEnd = -1; pos <= end;) {
      const matches = find(this.#p, i, pos, ncap);
      if (matches === null) {
        break;
      }

      let accept = true;
      if (matches[1] === pos) {
        // We've found an empty match.
        if (matches[0] === prevMatchEnd) {
          // We don't allow an empty match right
          // after a previous match, so ignore it.
          accept = false;
        }
        const width = i.step(pos) & 7;
        if (width > 0) {
          pos += width;
        } else {
          pos = end + 1;
        }
      } else {
        pos = matches[1] as number;
      }
      prevMatchEnd = matches[1] as number;

      if (accept) {
        yield this.#pad(matches) as number[];
        if (max > 0) {
          if (--max === 0) {
            return;
          }
        }
      }
    }
  }

  // FindString returns the text of the leftmost match for re in s.
  // The return value is the empty string both for an empty match and for no match.
  // To distinguish those two cases, use FindStringIndex or FindStringSubmatch.
  findString(s: string): string {
    const t = new text(s);
    const a = this.#find(t, 0, 2);
    if (a === null) {
      return "";
    }
    return t.slice(a[0] as number, a[1] as number);
  }

  // FindStringIndex returns the location of the leftmost match for re in s.
  // The match itself is at s[m[0]:m[1]] (byte offsets).
  // The return value is null for no match.
  findStringIndex(s: string): number[] | null {
    const m = this.#find(new text(s), 0, 2);
    if (m === null) {
      return null;
    }
    return m.slice(0, 2);
  }

  // FindStringSubmatch returns the first match for re in s, including submatches.
  // The overall match is s[0], the first submatch is s[1], and so on.
  // The return value is null for no match.
  findStringSubmatch(s: string): string[] | null {
    const t = new text(s);
    const a = this.#find(t, 0, this.#p.prog.numCap);
    if (a === null) {
      return null;
    }
    const ret: string[] = [];
    for (let i = 0; i < 1 + this.#numSubexp; i++) {
      ret.push(
        2 * i < a.length && (a[2 * i] as number) >= 0
          ? t.slice(a[2 * i] as number, a[2 * i + 1] as number)
          : "",
      );
    }
    return ret;
  }

  // FindStringSubmatchIndex returns the first match for re in s, including submatches.
  // The overall match is s[m[0]:m[1]], the first submatch is s[m[2]:m[3]], and so on.
  // The return value is null for no match.
  findStringSubmatchIndex(s: string): number[] | null {
    return this.#pad(this.#find(new text(s), 0, this.#p.prog.numCap));
  }

  // FindAllString returns all the matches for re in s.
  // If n >= 0, FindAllString returns no more than n matches.
  // The return value is null for no match.
  findAllString(s: string, n: number): string[] | null {
    const t = new text(s);
    const out: string[] = [];
    for (const m of this.#matches(t, n, 2)) {
      out.push(t.slice(m[0] as number, m[1] as number));
    }
    return out.length === 0 ? null : out;
  }

  // FindAllStringIndex returns the locations of all matches for re in s.
  // If n >= 0, FindAllStringIndex returns no more than n matches.
  // The return value is null for no match.
  findAllStringIndex(s: string, n: number): number[][] | null {
    const out: number[][] = [];
    for (const m of this.#matches(new text(s), n, 2)) {
      out.push([m[0] as number, m[1] as number]);
    }
    return out.length === 0 ? null : out;
  }

  // FindAllStringSubmatch returns the locations of all matches for re in s,
  // including submatch locations.
  // In each returned match m, m[0] is the overall match,
  // m[1] is the first submatch, and so on.
  // If n >= 0, FindAllStringSubmatch returns no more than n matches.
  // The return value is null for no match.
  findAllStringSubmatch(s: string, n: number): string[][] | null {
    const t = new text(s);
    const out: string[][] = [];
    for (const m of this.#matches(t, n, this.#p.prog.numCap)) {
      const sub: string[] = [];
      for (let i = 0; i < m.length / 2; i++) {
        sub.push(
          (m[2 * i] as number) >= 0 ? t.slice(m[2 * i] as number, m[2 * i + 1] as number) : "",
        );
      }
      out.push(sub);
    }
    return out.length === 0 ? null : out;
  }

  // FindAllStringSubmatchIndex returns the locations of all matches for re in s,
  // including submatch locations.
  // In each returned match m, the overall match is s[m[0]:m[1]],
  // the first submatch is s[m[2]:m[3]], and so on.
  // If n >= 0, FindAllStringSubmatchIndex returns no more than n matches.
  // The return value is null for no match.
  findAllStringSubmatchIndex(s: string, n: number): number[][] | null {
    const out: number[][] = [];
    for (const m of this.#matches(new text(s), n, this.#p.prog.numCap)) {
      out.push(m.slice());
    }
    return out.length === 0 ? null : out;
  }

  // ReplaceAllString returns a copy of src, replacing matches of the Regexp
  // with the replacement string repl.
  // Inside repl, $ signs are interpreted as in Expand: $name or ${name},
  // where a purely numeric name like $1 refers to the submatch with that
  // index, other names to (?P<name>...) groups, and $$ is a literal $.
  replaceAllString(src: string, repl: string): string {
    let n = 2;
    if (repl.includes("$")) {
      n = 2 * (this.#numSubexp + 1);
    }
    const template = goString(repl);
    return this.#replaceAll(src, n, (t, m) => this.#expand(template, t, m));
  }

  // ReplaceAllLiteralString returns a copy of src, replacing matches of the Regexp
  // with the replacement string repl. The replacement repl is substituted directly,
  // without using Expand.
  replaceAllLiteralString(src: string, repl: string): string {
    // normalized like every other input, so that a lone high surrogate in
    // repl cannot pair with an invalid byte (U+DC80+n) of src
    const literal = goString(repl);
    return this.#replaceAll(src, 2, () => literal);
  }

  // ReplaceAllStringFunc returns a copy of src in which all matches of the
  // Regexp have been replaced by the return value of function repl applied
  // to the matched substring. The replacement returned by repl is substituted
  // directly, without using Expand.
  replaceAllStringFunc(src: string, repl: (s: string) => string): string {
    return this.#replaceAll(src, 2, (t, m) =>
      goString(repl(t.slice(m[0] as number, m[1] as number))),
    );
  }

  #replaceAll(src: string, nmatch: number, repl: (t: text, m: number[]) => string): string {
    const t = new text(src);
    const i = new input(t.bytes);
    let lastMatchEnd = 0; // end position of the most recent match
    let searchPos = 0; // position where we next look for a match
    let buf = "";
    const endPos = t.bytes.length;
    if (nmatch > this.#p.prog.numCap) {
      nmatch = this.#p.prog.numCap;
    }

    while (searchPos <= endPos) {
      const a = find(this.#p, i, searchPos, nmatch);
      if (a === null || a.length === 0) {
        break; // no more matches
      }

      // Copy the unmatched characters before this match.
      buf += t.slice(lastMatchEnd, a[0] as number);

      // Now insert a copy of the replacement string, but not for a
      // match of the empty string immediately after another match.
      // (Otherwise, we get double replacement for patterns that
      // match both empty and nonempty strings.)
      if ((a[1] as number) > lastMatchEnd || a[0] === 0) {
        buf += repl(t, a);
      }
      lastMatchEnd = a[1] as number;

      // Advance past this match; always advance at least one character.
      const width = i.step(searchPos) & 7;
      if (searchPos + width > (a[1] as number)) {
        searchPos += width;
      } else if (searchPos + 1 > (a[1] as number)) {
        // This clause is only needed at the end of the input
        // string. In that case, DecodeRuneInString returns width=0.
        searchPos++;
      } else {
        searchPos = a[1] as number;
      }
    }

    // Copy the unmatched characters after the last match.
    buf += t.slice(lastMatchEnd, endPos);

    // Go appends bytes, so invalid bytes from separate pieces can join into
    // valid UTF-8 (C3 + A9 = "é"); decode the joined bytes once more.
    return goString(buf);
  }

  // expand of regexp.go: the template with $name and ${name} replaced by
  // the submatches of match in src.
  #expand(template: string, src: text, m: readonly number[]): string {
    let dst = "";
    while (template.length > 0) {
      const k = template.indexOf("$");
      if (k < 0) {
        break;
      }
      dst += template.slice(0, k);
      template = template.slice(k + 1);
      if (template !== "" && template[0] === "$") {
        // Treat $$ as $.
        dst += "$";
        template = template.slice(1);
        continue;
      }
      const x = extract(template);
      if (x === null) {
        // Malformed; treat $ as raw text.
        dst += "$";
        continue;
      }
      const { name, num, rest } = x;
      template = rest;
      if (num >= 0) {
        if (2 * num + 1 < m.length && (m[2 * num] as number) >= 0) {
          dst += src.slice(m[2 * num] as number, m[2 * num + 1] as number);
        }
      } else {
        for (let i = 0; i < this.#subexpNames.length; i++) {
          if (name === this.#subexpNames[i] && 2 * i + 1 < m.length && (m[2 * i] as number) >= 0) {
            dst += src.slice(m[2 * i] as number, m[2 * i + 1] as number);
            break;
          }
        }
      }
    }
    return dst + template;
  }

  // Split slices s into substrings separated by the expression and returns a slice of
  // the substrings between those expression matches.
  //
  // The slice returned by this method consists of all the substrings of s
  // not contained in the slice returned by FindAllString. When called on an expression
  // that contains no metacharacters, it is equivalent to strings.SplitN.
  //
  // The count determines the number of substrings to return:
  //   - n > 0: at most n substrings; the last substring will be the unsplit remainder;
  //   - n == 0: the result is null (zero substrings);
  //   - n < 0: all substrings.
  split(s: string, n: number): string[] | null {
    if (n === 0) {
      return null;
    }
    if (this.#expr.length > 0 && s.length === 0) {
      return [""];
    }

    const t = new text(s);
    const matches = this.findAllStringIndex(s, n) ?? [];
    const strings: string[] = [];

    let beg = 0;
    let end = 0;
    for (const m of matches) {
      if (n > 0 && strings.length >= n - 1) {
        break;
      }

      end = m[0] as number;
      if (m[1] !== 0) {
        strings.push(t.slice(beg, end));
      }
      beg = m[1] as number;
    }

    if (end !== t.bytes.length) {
      strings.push(t.slice(beg, t.bytes.length));
    }

    return strings;
  }
}

// minInputLen walks the regexp to find the minimum length of any matchable input.
function minInputLen(re: syntaxRegexp): number {
  switch (re.op) {
    default:
      return 0;
    case OpAnyChar:
    case OpAnyCharNotNL:
    case OpCharClass:
      return 1;
    case OpLiteral: {
      let l = 0;
      for (const r of re.rune) {
        if (r === RuneError) {
          l++;
        } else {
          l += runeLen(r);
        }
      }
      return l;
    }
    case OpCapture:
    case OpPlus:
      return minInputLen(re.sub[0] as syntaxRegexp);
    case OpRepeat:
      return re.min * minInputLen(re.sub[0] as syntaxRegexp);
    case OpConcat: {
      let l = 0;
      for (const sub of re.sub) {
        l += minInputLen(sub);
      }
      return l;
    }
    case OpAlternate: {
      let l = minInputLen(re.sub[0] as syntaxRegexp);
      for (const sub of re.sub.slice(1)) {
        const lnext = minInputLen(sub);
        if (lnext < l) {
          l = lnext;
        }
      }
      return l;
    }
  }
}

// utf8.RuneLen: -1 for a surrogate or a rune out of range
function runeLen(r: number): number {
  if (r < 0) {
    return -1;
  }
  if (r < 0x80) {
    return 1;
  }
  if (r < 0x800) {
    return 2;
  }
  if (0xd800 <= r && r <= 0xdfff) {
    return -1;
  }
  if (r < 0x10000) {
    return 3;
  }
  if (r <= 0x10ffff) {
    return 4;
  }
  return -1;
}

// extract returns the name from a leading "name" or "{name}" in str.
// (The $ has already been removed by the caller.)
// If it is a number, extract returns num set to that number; otherwise num = -1.
function extract(str: string): { name: string; num: number; rest: string } | null {
  if (str === "") {
    return null;
  }
  let brace = false;
  if (str[0] === "{") {
    brace = true;
    str = str.slice(1);
  }
  let i = 0;
  while (i < str.length) {
    const [rune, size] = DecodeRuneInString(str.slice(i));
    if (!isLetter(rune) && !isDigit(rune) && rune !== 0x5f) {
      break;
    }
    i += size;
  }
  if (i === 0) {
    // empty name is not okay
    return null;
  }
  const name = str.slice(0, i);
  if (brace) {
    if (i >= str.length || str[i] !== "}") {
      // missing closing brace
      return null;
    }
    i++;
  }

  // Parse number.
  let num = 0;
  for (let j = 0; j < name.length; j++) {
    const c = name.charCodeAt(j);
    if (c < 0x30 || 0x39 < c || num >= 1e8) {
      num = -1;
      break;
    }
    num = num * 10 + c - 0x30;
  }
  // Disallow leading zeros.
  if (name[0] === "0" && name.length > 1) {
    num = -1;
  }

  return { name, num, rest: str.slice(i) };
}

// unicode.IsLetter and unicode.IsDigit
function isLetter(r: number): boolean {
  return Is(Categories().get("L") as RangeTable, r);
}

function isDigit(r: number): boolean {
  if (r <= 0xff) {
    return 0x30 <= r && r <= 0x39;
  }
  return Is(Categories().get("Nd") as RangeTable, r);
}

// Compile parses a regular expression and returns, if successful,
// a Regexp object that can be used to match against text. It throws a
// RegexpSyntaxError with Go's error text otherwise.
//
// When matching against text, the regexp returns a match that
// begins as early as possible in the input (leftmost), and among those
// it chooses the one that a backtracking search would have found first.
// This so-called leftmost-first matching is the same semantics
// that Perl, Python, and other implementations use, although this
// package implements it without the expense of backtracking.
// For POSIX leftmost-longest matching, see CompilePOSIX.
export function compile(expr: string): Regexp {
  return Regexp.compile(expr, Perl, false);
}

// CompilePOSIX is like Compile but restricts the regular expression
// to POSIX ERE (egrep) syntax and changes the match semantics to
// leftmost-longest.
export function compilePOSIX(expr: string): Regexp {
  return Regexp.compile(expr, POSIX, true);
}

// MustCompile is like Compile but throws Go's panic text if the
// expression cannot be parsed.
export function mustCompile(str: string): Regexp {
  try {
    return compile(str);
  } catch (error) {
    throw new Error(`regexp: Compile(${quote(str)}): ${(error as Error).message}`, {
      cause: error,
    });
  }
}

// MatchString reports whether the string s
// contains any match of the regular expression pattern.
// More complicated queries need to use Compile and the full Regexp interface.
export function matchString(pattern: string, s: string): boolean {
  return compile(pattern).matchString(s);
}

// Match reports whether the byte slice b
// contains any match of the regular expression pattern.
// More complicated queries need to use Compile and the full Regexp interface.
export function match(pattern: string, b: Uint8Array): boolean {
  return compile(pattern).match(b);
}

const specialBytes = String.raw`\.+*?()|[]{}^$`;

// QuoteMeta returns a string that escapes all regular expression metacharacters
// inside the argument text; the returned string is a regular expression matching
// the literal text.
export function quoteMeta(s: string): string {
  let out = "";
  for (const c of s) {
    if (specialBytes.includes(c)) {
      out += "\\";
    }
    out += c;
  }
  return out;
}

// strconv.CanBackquote and strconv.Quote, for MustCompile's text
function quote(s: string): string {
  s = goString(s);
  if (canBackquote(s)) {
    return "`" + s + "`";
  }
  let out = '"';
  for (let i = 0; i < s.length;) {
    const [r, width] = DecodeRuneInString(s.slice(i));
    if (isInvalidByte(s, i)) {
      out += "\\x" + (s.charCodeAt(i) - 0xdc00).toString(16).padStart(2, "0");
    } else if (r === 0x22 || r === 0x5c) {
      out += "\\" + String.fromCharCode(r);
    } else if (IsPrint(r)) {
      out += String.fromCodePoint(r);
    } else {
      out += escapeRune(r);
    }
    i += width;
  }
  return out + '"';
}

// whether s[i] is an invalid UTF-8 byte (U+DC80..U+DCFF in the Go string
// form)
function isInvalidByte(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return c >= 0xdc80 && c <= 0xdcff;
}

function escapeRune(r: number): string {
  switch (r) {
    case 0x07:
      return "\\a";
    case 0x08:
      return "\\b";
    case 0x0c:
      return "\\f";
    case 0x0a:
      return "\\n";
    case 0x0d:
      return "\\r";
    case 0x09:
      return "\\t";
    case 0x0b:
      return "\\v";
  }
  if (r < 0x20 || r === 0x7f) {
    return "\\x" + r.toString(16).padStart(2, "0");
  }
  if (r < 0x10000) {
    return "\\u" + r.toString(16).padStart(4, "0");
  }
  return "\\U" + r.toString(16).padStart(8, "0");
}

function canBackquote(s: string): boolean {
  for (let i = 0; i < s.length;) {
    if (isInvalidByte(s, i)) {
      return false;
    }
    const [r, width] = DecodeRuneInString(s.slice(i));
    i += width;
    if (r > 0x7f) {
      if (r === 0xfeff) {
        return false;
      }
      continue;
    }
    if ((r < 0x20 && r !== 0x09) || r === 0x60 || r === 0x7f) {
      return false;
    }
  }
  return true;
}
