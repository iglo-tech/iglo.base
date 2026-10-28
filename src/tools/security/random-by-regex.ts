// Upstream: tools/security/random_by_regex.go
//
// The pattern is parsed by the port of Go's regexp/syntax
// (src/tools/regexp/syntax/parse.ts), so it is accepted or rejected as
// upstream does, with Go's error text, and the string is built from the same
// tree. Runes are written as Go's string(rune) does: a surrogate or an out of
// range rune becomes U+FFFD.

import { Parse, Perl, type Flags } from "@/tools/regexp/syntax/parse";
import {
  OpAlternate,
  OpAnyChar,
  OpAnyCharNotNL,
  OpCapture,
  OpCharClass,
  OpConcat,
  OpLiteral,
  OpPlus,
  OpQuest,
  OpRepeat,
  OpStar,
  type Regexp,
} from "@/tools/regexp/syntax/regexp";
import { secureIntN } from "@/tools/security/random";
import { runeString, runesString } from "@/tools/unicode/utf8";

const defaultMaxRepeat = 6;

const anyCharNotNLPairs = [0x41, 0x5a, 0x61, 0x7a, 0x30, 0x39]; // 'A', 'Z', 'a', 'z', '0', '9'

// RandomStringByRegex generates a random string matching the regex pattern.
// optFlags are OR-ed together; without any, Perl is used.
//
// NB! While the source of the randomness is crypto.getRandomValues this
// method is not recommended to be used on its own in critical secure
// contexts because the generated length could vary too much on the used
// pattern and may not be as secure as simply calling RandomString.
//
// Throws the parser's RegexpSyntaxError for an invalid pattern, and an Error
// with upstream's text for a tree it cannot generate from.
export function randomStringByRegex(pattern: string, ...optFlags: Flags[]): string {
  let flags = 0;
  if (optFlags.length === 0) {
    flags = Perl;
  } else {
    for (const f of optFlags) {
      flags |= f;
    }
  }

  const r = Parse(pattern, flags);

  const sb: string[] = [];
  writeRandomStringByRegex(r, sb);
  return sb.join("");
}

function writeRandomStringByRegex(r: Regexp, sb: string[]): void {
  // https://pkg.go.dev/regexp/syntax#Op
  switch (r.op) {
    case OpCharClass:
      sb.push(runeString(randomRuneFromPairs(r.rune)));
      return;
    case OpAnyChar:
    case OpAnyCharNotNL:
      sb.push(runeString(randomRuneFromPairs(anyCharNotNLPairs)));
      return;
    case OpAlternate:
      writeRandomStringByRegex(r.sub[randomNumber(r.sub.length)] as Regexp, sb);
      return;
    case OpConcat:
      for (const sub of r.sub) {
        writeRandomStringByRegex(sub, sb);
      }
      return;
    case OpRepeat:
      repeatRandomStringByRegex(r.sub[0] as Regexp, sb, r.min, r.max);
      return;
    case OpQuest:
      repeatRandomStringByRegex(r.sub[0] as Regexp, sb, 0, 1);
      return;
    case OpPlus:
      repeatRandomStringByRegex(r.sub[0] as Regexp, sb, 1, -1);
      return;
    case OpStar:
      repeatRandomStringByRegex(r.sub[0] as Regexp, sb, 0, -1);
      return;
    case OpCapture:
      writeRandomStringByRegex(r.sub[0] as Regexp, sb);
      return;
    case OpLiteral:
      sb.push(runesString(r.rune));
      return;
    default:
      throw new Error(`unsupported pattern operator ${r.op}`);
  }
}

function repeatRandomStringByRegex(r: Regexp, sb: string[], min: number, max: number): void {
  if (max < 0) {
    max = defaultMaxRepeat;
  }

  if (max < min) {
    max = min;
  }

  let n = min;
  if (max !== min) {
    n += randomNumber(max - min);
  }

  for (let i = 0; i < n; i++) {
    writeRandomStringByRegex(r, sb);
  }
}

function randomRuneFromPairs(pairs: readonly number[]): number {
  if (pairs.length % 2 !== 0) {
    throw new Error("invalid pairs slice: odd number of elements");
  }

  // Pre-calculate the cumulative size of all ranges to make the selection process more efficient.
  const cumulativeSizes: number[] = [];
  let totalRunes = 0;
  for (let i = 0; i < pairs.length; i += 2) {
    const start = pairs[i] as number;
    const end = pairs[i + 1] as number;
    if (start > end) {
      throw new Error(`invalid range: start '${runeString(start)}' > end '${runeString(end)}'`);
    }
    totalRunes += end - start + 1;
    cumulativeSizes.push(totalRunes);
  }

  if (totalRunes === 0) {
    throw new Error("no runes to choose from");
  }

  // Select a random number in the range of total runes.
  const runeNumber = randomNumber(totalRunes);

  // Find which range the selected number falls into using the pre-calculated cumulative sizes.
  for (let i = 0; i < cumulativeSizes.length; i++) {
    const size = cumulativeSizes[i] as number;
    if (runeNumber < size) {
      const startRune = pairs[i * 2] as number;
      const previousSize = i > 0 ? (cumulativeSizes[i - 1] as number) : 0;
      return startRune + (runeNumber - previousSize);
    }
  }

  // This part should be unreachable if the logic is correct.
  // It indicates a bug in this function or in randomNumber.
  throw new Error("unreachable: failed to find a rune");
}

// crypto/rand.Int(rand.Reader, big.NewInt(maxSoft)): uniform in [0, maxSoft).
function randomNumber(maxSoft: number): number {
  return secureIntN(maxSoft);
}
