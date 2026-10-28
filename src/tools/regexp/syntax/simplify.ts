// Upstream: Go go1.27.2 src/regexp/syntax/simplify.go.
//
// Go's (*Regexp).Simplify is a function here, so the Regexp class in
// regexp.ts keeps the parser's shape. As in Go, the result may share nodes
// with the input, and nodes are compared by identity.

import { NonGreedy, type Flags } from "@/tools/regexp/syntax/parse";
import {
  OpAlternate,
  OpCapture,
  OpConcat,
  OpEmptyMatch,
  OpNoMatch,
  OpPlus,
  OpQuest,
  OpRepeat,
  OpStar,
  Regexp,
  type Op,
} from "@/tools/regexp/syntax/regexp";

// Simplify returns a regexp equivalent to re but without counted repetitions
// and with various other simplifications, such as rewriting /(?:a+)+/ to /a+/.
// The resulting regexp will execute correctly but its string representation
// will not produce the same parse tree, because capturing parentheses
// may have been duplicated or removed. For example, the simplified form
// for /(x){1,2}/ is /(x)(x)?/ but both parentheses capture as $1.
// The returned regexp may share structure with or be the original.
export function Simplify(re: Regexp | null): Regexp | null {
  if (re === null) {
    return null;
  }
  switch (re.op) {
    case OpCapture:
    case OpConcat:
    case OpAlternate: {
      // Simplify children, building new Regexp if children change.
      let nre = re;
      re.sub.forEach((sub, i) => {
        const nsub = Simplify(sub) as Regexp;
        if (nre === re && nsub !== sub) {
          // Start a copy.
          nre = copyRegexp(re);
          nre.rune = [];
          nre.sub = re.sub.slice(0, i);
        }
        if (nre !== re) {
          nre.sub.push(nsub);
        }
      });
      return nre;
    }

    case OpStar:
    case OpPlus:
    case OpQuest: {
      const sub = Simplify(re.sub[0] as Regexp) as Regexp;
      return simplify1(re.op, re.flags, sub, re);
    }

    case OpRepeat: {
      // Special special case: x{0} matches the empty string
      // and doesn't even need to consider x.
      if (re.min === 0 && re.max === 0) {
        return new Regexp(OpEmptyMatch);
      }

      // The fun begins.
      const sub = Simplify(re.sub[0] as Regexp) as Regexp;

      // x{n,} means at least n matches of x.
      if (re.max === -1) {
        // Special case: x{0,} is x*.
        if (re.min === 0) {
          return simplify1(OpStar, re.flags, sub, null);
        }

        // Special case: x{1,} is x+.
        if (re.min === 1) {
          return simplify1(OpPlus, re.flags, sub, null);
        }

        // General case: x{4,} is xxxx+.
        const nre = new Regexp(OpConcat);
        for (let i = 0; i < re.min - 1; i++) {
          nre.sub.push(sub);
        }
        nre.sub.push(simplify1(OpPlus, re.flags, sub, null));
        return nre;
      }

      // Special case x{0} handled above.

      // Special case: x{1} is just x.
      if (re.min === 1 && re.max === 1) {
        return sub;
      }

      // General case: x{n,m} means n copies of x and m copies of x?
      // The machine will do less work if we nest the final m copies,
      // so that x{2,5} = xx(x(x(x)?)?)?

      // Build leading prefix: xx.
      let prefix: Regexp | null = null;
      if (re.min > 0) {
        prefix = new Regexp(OpConcat);
        for (let i = 0; i < re.min; i++) {
          prefix.sub.push(sub);
        }
      }

      // Build and attach suffix: (x(x(x)?)?)?
      if (re.max > re.min) {
        let suffix = simplify1(OpQuest, re.flags, sub, null);
        for (let i = re.min + 1; i < re.max; i++) {
          const nre2 = new Regexp(OpConcat);
          nre2.sub.push(sub, suffix);
          suffix = simplify1(OpQuest, re.flags, nre2, null);
        }
        if (prefix === null) {
          return suffix;
        }
        prefix.sub.push(suffix);
      }
      if (prefix !== null) {
        return prefix;
      }

      // Some degenerate case like min > max or min < max < 0.
      // Handle as impossible match.
      return new Regexp(OpNoMatch);
    }
  }

  return re;
}

// simplify1 implements Simplify for the unary OpStar,
// OpPlus, and OpQuest operators. It returns the simple regexp
// equivalent to
//
//	Regexp{Op: op, Flags: flags, Sub: {sub}}
//
// under the assumption that sub is already simple, and
// without first allocating that structure. If the regexp
// to be returned turns out to be equivalent to re, simplify1
// returns re instead.
//
// simplify1 is factored out of Simplify because the implementation
// for other operators generates these unary expressions.
// Letting them call simplify1 makes sure the expressions they
// generate are simple.
function simplify1(op: Op, flags: Flags, sub: Regexp, re: Regexp | null): Regexp {
  // Special case: repeat the empty string as much as
  // you want, but it's still the empty string.
  if (sub.op === OpEmptyMatch) {
    return sub;
  }
  // The operators are idempotent if the flags match.
  if (op === sub.op && (flags & NonGreedy) === (sub.flags & NonGreedy)) {
    return sub;
  }
  if (
    re !== null &&
    re.op === op &&
    (re.flags & NonGreedy) === (flags & NonGreedy) &&
    sub === re.sub[0]
  ) {
    return re;
  }

  re = new Regexp(op);
  re.flags = flags;
  re.sub.push(sub);
  return re;
}

// *nre = *re
function copyRegexp(re: Regexp): Regexp {
  const nre = new Regexp(re.op);
  nre.flags = re.flags;
  nre.sub = re.sub;
  nre.rune = re.rune;
  nre.min = re.min;
  nre.max = re.max;
  nre.cap = re.cap;
  nre.name = re.name;
  return nre;
}
