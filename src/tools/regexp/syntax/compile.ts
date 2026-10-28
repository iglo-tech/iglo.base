// Upstream: Go go1.27.2 src/regexp/syntax/compile.go.

import { FoldCase, NonGreedy, type Flags } from "@/tools/regexp/syntax/parse";
import {
  EmptyBeginLine,
  EmptyBeginText,
  EmptyEndLine,
  EmptyEndText,
  EmptyNoWordBoundary,
  EmptyWordBoundary,
  Inst,
  InstAlt,
  InstCapture,
  InstEmptyWidth,
  InstFail,
  InstMatch,
  InstNop,
  InstRune,
  InstRune1,
  InstRuneAny,
  InstRuneAnyNotNL,
  Prog,
  type EmptyOp,
  type InstOp,
} from "@/tools/regexp/syntax/prog";
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
  OpStar,
  OpWordBoundary,
  type Regexp,
} from "@/tools/regexp/syntax/regexp";
import { MaxRune, SimpleFold } from "@/tools/unicode/letter";

// A patchList is a list of instruction pointers that need to be filled in (patched).
// Because the pointers haven't been filled in yet, we can reuse their storage
// to hold the list. It's kind of sleazy, but works well in practice.
// See https://swtch.com/~rsc/regexp/regexp1.html for inspiration.
//
// These aren't really pointers: they're integers, so we can reinterpret them
// this way without using package unsafe. A value l.head denotes
// p.inst[l.head>>1].Out (l.head&1==0) or .Arg (l.head&1==1).
// head == 0 denotes the empty list, okay because we start every program
// with a fail instruction, so we'll never want to point at its output link.
interface patchList {
  head: number;
  tail: number;
}

function makePatchList(n: number): patchList {
  return { head: n, tail: n };
}

function patch(l: patchList, p: Prog, val: number): void {
  let head = l.head;
  while (head !== 0) {
    const i = p.inst[head >>> 1] as Inst;
    if ((head & 1) === 0) {
      head = i.out;
      i.out = val;
    } else {
      head = i.arg;
      i.arg = val;
    }
  }
}

function append(l1: patchList, p: Prog, l2: patchList): patchList {
  if (l1.head === 0) {
    return l2;
  }
  if (l2.head === 0) {
    return l1;
  }

  const i = p.inst[l1.tail >>> 1] as Inst;
  if ((l1.tail & 1) === 0) {
    i.out = l2.head;
  } else {
    i.arg = l2.head;
  }
  return { head: l1.head, tail: l2.tail };
}

// A frag represents a compiled program fragment.
interface frag {
  i: number; // index of first instruction
  out: patchList; // where to record end instruction
  nullable: boolean; // whether fragment can match empty string
}

function emptyFrag(): frag {
  return { i: 0, out: { head: 0, tail: 0 }, nullable: false };
}

// Compile compiles the regexp into a program to be executed.
// The regexp should have been simplified already (returned from re.Simplify).
export function Compile(re: Regexp): Prog {
  const c = new compiler();
  const f = c.compile(re);
  patch(f.out, c.p, c.inst(InstMatch).i);
  c.p.start = f.i;
  return c.p;
}

const anyRuneNotNL = [0, 0x0a - 1, 0x0a + 1, MaxRune];
const anyRune = [0, MaxRune];

class compiler {
  p = new Prog();

  constructor() {
    this.p.numCap = 2; // implicit ( and ) for whole match $0
    this.inst(InstFail);
  }

  compile(re: Regexp): frag {
    switch (re.op) {
      case OpNoMatch:
        return this.fail();
      case OpEmptyMatch:
        return this.nop();
      case OpLiteral: {
        if (re.rune.length === 0) {
          return this.nop();
        }
        let f = emptyFrag();
        for (let j = 0; j < re.rune.length; j++) {
          const f1 = this.rune(re.rune.slice(j, j + 1), re.flags);
          if (j === 0) {
            f = f1;
          } else {
            f = this.cat(f, f1);
          }
        }
        return f;
      }
      case OpCharClass:
        return this.rune(re.rune, re.flags);
      case OpAnyCharNotNL:
        return this.rune(anyRuneNotNL, 0);
      case OpAnyChar:
        return this.rune(anyRune, 0);
      case OpBeginLine:
        return this.empty(EmptyBeginLine);
      case OpEndLine:
        return this.empty(EmptyEndLine);
      case OpBeginText:
        return this.empty(EmptyBeginText);
      case OpEndText:
        return this.empty(EmptyEndText);
      case OpWordBoundary:
        return this.empty(EmptyWordBoundary);
      case OpNoWordBoundary:
        return this.empty(EmptyNoWordBoundary);
      case OpCapture: {
        const bra = this.cap(re.cap << 1);
        const sub = this.compile(re.sub[0] as Regexp);
        const ket = this.cap((re.cap << 1) | 1);
        return this.cat(this.cat(bra, sub), ket);
      }
      case OpStar:
        return this.star(this.compile(re.sub[0] as Regexp), (re.flags & NonGreedy) !== 0);
      case OpPlus:
        return this.plus(this.compile(re.sub[0] as Regexp), (re.flags & NonGreedy) !== 0);
      case OpQuest:
        return this.quest(this.compile(re.sub[0] as Regexp), (re.flags & NonGreedy) !== 0);
      case OpConcat: {
        if (re.sub.length === 0) {
          return this.nop();
        }
        let f = emptyFrag();
        re.sub.forEach((sub, i) => {
          if (i === 0) {
            f = this.compile(sub);
          } else {
            f = this.cat(f, this.compile(sub));
          }
        });
        return f;
      }
      case OpAlternate: {
        let f = emptyFrag();
        for (const sub of re.sub) {
          f = this.alt(f, this.compile(sub));
        }
        return f;
      }
    }
    throw new Error("regexp: unhandled case in compile");
  }

  inst(op: InstOp): frag {
    // TODO: impose length limit
    const f: frag = { i: this.p.inst.length, out: { head: 0, tail: 0 }, nullable: true };
    this.p.inst.push(new Inst(op));
    return f;
  }

  nop(): frag {
    const f = this.inst(InstNop);
    f.out = makePatchList(f.i << 1);
    return f;
  }

  fail(): frag {
    return emptyFrag();
  }

  cap(arg: number): frag {
    const f = this.inst(InstCapture);
    f.out = makePatchList(f.i << 1);
    (this.p.inst[f.i] as Inst).arg = arg;

    if (this.p.numCap < arg + 1) {
      this.p.numCap = arg + 1;
    }
    return f;
  }

  cat(f1: frag, f2: frag): frag {
    // concat of failure is failure
    if (f1.i === 0 || f2.i === 0) {
      return emptyFrag();
    }

    // TODO: elide nop

    patch(f1.out, this.p, f2.i);
    return { i: f1.i, out: f2.out, nullable: f1.nullable && f2.nullable };
  }

  alt(f1: frag, f2: frag): frag {
    // alt of failure is other
    if (f1.i === 0) {
      return f2;
    }
    if (f2.i === 0) {
      return f1;
    }

    const f = this.inst(InstAlt);
    const i = this.p.inst[f.i] as Inst;
    i.out = f1.i;
    i.arg = f2.i;
    f.out = append(f1.out, this.p, f2.out);
    f.nullable = f1.nullable || f2.nullable;
    return f;
  }

  quest(f1: frag, nongreedy: boolean): frag {
    const f = this.inst(InstAlt);
    const i = this.p.inst[f.i] as Inst;
    if (nongreedy) {
      i.arg = f1.i;
      f.out = makePatchList(f.i << 1);
    } else {
      i.out = f1.i;
      f.out = makePatchList((f.i << 1) | 1);
    }
    f.out = append(f.out, this.p, f1.out);
    return f;
  }

  // loop returns the fragment for the main loop of a plus or star.
  // For plus, it can be used after changing the entry to f1.i.
  // For star, it can be used directly when f1 can't match an empty string.
  // (When f1 can match an empty string, f1* must be implemented as (f1+)?
  // to get the priority match order correct.)
  loop(f1: frag, nongreedy: boolean): frag {
    const f = this.inst(InstAlt);
    const i = this.p.inst[f.i] as Inst;
    if (nongreedy) {
      i.arg = f1.i;
      f.out = makePatchList(f.i << 1);
    } else {
      i.out = f1.i;
      f.out = makePatchList((f.i << 1) | 1);
    }
    patch(f1.out, this.p, f.i);
    return f;
  }

  star(f1: frag, nongreedy: boolean): frag {
    if (f1.nullable) {
      // Use (f1+)? to get priority match order correct.
      // See golang.org/issue/46123.
      return this.quest(this.plus(f1, nongreedy), nongreedy);
    }
    return this.loop(f1, nongreedy);
  }

  plus(f1: frag, nongreedy: boolean): frag {
    return { i: f1.i, out: this.loop(f1, nongreedy).out, nullable: f1.nullable };
  }

  empty(op: EmptyOp): frag {
    const f = this.inst(InstEmptyWidth);
    (this.p.inst[f.i] as Inst).arg = op;
    f.out = makePatchList(f.i << 1);
    return f;
  }

  rune(r: number[], flags: Flags): frag {
    const f = this.inst(InstRune);
    f.nullable = false;
    const i = this.p.inst[f.i] as Inst;
    i.rune = r;
    flags &= FoldCase; // only relevant flag is FoldCase
    if (r.length !== 1 || SimpleFold(r[0] as number) === r[0]) {
      // and sometimes not even that
      flags &= ~FoldCase;
    }
    i.arg = flags;
    f.out = makePatchList(f.i << 1);

    // Special cases for exec machine.
    if ((flags & FoldCase) === 0 && (r.length === 1 || (r.length === 2 && r[0] === r[1]))) {
      i.op = InstRune1;
    } else if (r.length === 2 && r[0] === 0 && r[1] === MaxRune) {
      i.op = InstRuneAny;
    } else if (
      r.length === 4 &&
      r[0] === 0 &&
      r[1] === 0x0a - 1 &&
      r[2] === 0x0a + 1 &&
      r[3] === MaxRune
    ) {
      i.op = InstRuneAnyNotNL;
    }

    return f;
  }
}
