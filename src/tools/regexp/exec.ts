// Upstream: Go go1.27.2 src/regexp/exec.go (the NFA, or pike VM, and the
// one-pass machine), the input types and find of src/regexp/regexp.go, and
// utf8.DecodeRune and DecodeLastRune of src/unicode/utf8/utf8.go.
//
// The matcher runs on the UTF-8 bytes of the input, as Go's inputBytes does,
// so positions are Go's byte offsets and an invalid byte is one RuneError
// step of width 1. Go's io.RuneReader input has no counterpart.
//
// Go's lazyFlag (the runes before and after a position) is passed as two
// numbers, and input.step packs a rune and its width into one number, so the
// inner loops allocate nothing. Go's sync.Pool of machines is a free list
// per Regexp: a machine is in use only during one find, and a callback such
// as replaceAllStringFunc's can run the same Regexp again.

import { onePassNext, type onePassProg } from "@/tools/regexp/onepass";
import {
  EmptyBeginLine,
  EmptyBeginText,
  EmptyEndLine,
  EmptyEndText,
  EmptyImpossible,
  EmptyNoWordBoundary,
  EmptyWordBoundary,
  Inst,
  InstAlt,
  InstAltMatch,
  InstCapture,
  InstEmptyWidth,
  InstFail,
  InstMatch,
  InstNop,
  InstRune,
  InstRune1,
  InstRuneAny,
  InstRuneAnyNotNL,
  IsWordChar,
  type EmptyOp,
  type Prog,
} from "@/tools/regexp/syntax/prog";

const RuneError = 0xfffd;
export const endOfText = -1;

// The compiled state of a Regexp that find uses (the unexported fields of
// Go's Regexp).
export interface program {
  prog: Prog; // compiled program
  onepass: onePassProg | null; // onepass program or nil
  prefix: string; // required prefix in unanchored matches
  prefixBytes: Uint8Array; // prefix, as a []byte
  prefixRune: number; // first rune in prefix
  prefixEnd: number; // pc for last rune in prefix
  cond: EmptyOp; // empty-width conditions required at start of match
  minInputLen: number; // minimum length of the input in bytes
  longest: boolean; // whether regexp prefers leftmost-longest match
  machines: machine[]; // free machines
}

// DecodeRune at b[pos], packed as (rune+1)*8 + width; endOfText (packed as
// 0) past the end.
function decodeRune(b: Uint8Array, pos: number): number {
  const n = b.length;
  if (pos >= n) {
    return 0;
  }
  const b0 = b[pos] as number;
  if (b0 < 0x80) {
    return (b0 + 1) * 8 + 1;
  }
  const invalid = (RuneError + 1) * 8 + 1;
  // utf8 first and acceptRanges: sequence size and the second byte's range
  let size: number;
  let lo = 0x80;
  let hi = 0xbf;
  if (b0 >= 0xc2 && b0 <= 0xdf) {
    size = 2;
  } else if (b0 >= 0xe0 && b0 <= 0xef) {
    size = 3;
    if (b0 === 0xe0) {
      lo = 0xa0;
    } else if (b0 === 0xed) {
      hi = 0x9f;
    }
  } else if (b0 >= 0xf0 && b0 <= 0xf4) {
    size = 4;
    if (b0 === 0xf0) {
      lo = 0x90;
    } else if (b0 === 0xf4) {
      hi = 0x8f;
    }
  } else {
    return invalid;
  }
  if (pos + size > n) {
    return invalid;
  }
  const b1 = b[pos + 1] as number;
  if (b1 < lo || hi < b1) {
    return invalid;
  }
  if (size === 2) {
    return (((b0 & 0x1f) << 6) | (b1 & 0x3f)) * 8 + 8 + 2;
  }
  const b2 = b[pos + 2] as number;
  if (b2 < 0x80 || 0xbf < b2) {
    return invalid;
  }
  if (size === 3) {
    return (((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f)) * 8 + 8 + 3;
  }
  const b3 = b[pos + 3] as number;
  if (b3 < 0x80 || 0xbf < b3) {
    return invalid;
  }
  return (((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f)) * 8 + 8 + 4;
}

function packedRune(p: number): number {
  return (p >>> 3) - 1;
}

function packedWidth(p: number): number {
  return p & 7;
}

// DecodeLastRune of b[:end]: the rune only.
function decodeLastRune(b: Uint8Array, end: number): number {
  let start = end - 1;
  const r = b[start] as number;
  if (r < 0x80) {
    return r;
  }
  const lim = Math.max(end - 4, 0);
  for (start--; start >= lim; start--) {
    if (((b[start] as number) & 0xc0) !== 0x80) {
      break;
    }
  }
  if (start < 0) {
    start = 0;
  }
  const p = decodeRune(b.subarray(0, end), start);
  if (start + packedWidth(p) !== end) {
    return RuneError;
  }
  return packedRune(p);
}

// input scans the UTF-8 bytes of the text (Go's inputBytes and
// inputString).
export class input {
  constructor(readonly bytes: Uint8Array) {}

  // step advances one rune: the rune and its width, packed (see
  // decodeRune).
  step(pos: number): number {
    return decodeRune(this.bytes, pos);
  }

  hasPrefix(re: program): boolean {
    return indexOf(this.bytes, re.prefixBytes, 0) === 0;
  }

  index(re: program, pos: number): number {
    const i = indexOf(this.bytes, re.prefixBytes, pos);
    return i < 0 ? -1 : i - pos;
  }

  // context returns the runes before and after pos (Go's lazyFlag).
  context(pos: number): [r1: number, r2: number] {
    const b = this.bytes;
    let r1 = endOfText;
    let r2 = endOfText;
    // 0 < pos && pos <= len(i.str)
    if (pos - 1 >= 0 && pos - 1 < b.length) {
      r1 = decodeLastRune(b, pos);
    }
    // 0 <= pos && pos < len(i.str)
    if (pos >= 0 && pos < b.length) {
      r2 = packedRune(decodeRune(b, pos));
    }
    return [r1, r2];
  }
}

// bytes.Index(b[from:], sep) + from, or -1.
function indexOf(b: Uint8Array, sep: Uint8Array, from: number): number {
  const n = sep.length;
  if (n === 0) {
    return from;
  }
  const first = sep[0] as number;
  const last = b.length - n;
  for (let i = b.indexOf(first, from); i >= 0 && i <= last; i = b.indexOf(first, i + 1)) {
    let j = 1;
    while (j < n && b[i + j] === sep[j]) {
      j++;
    }
    if (j === n) {
      return i;
    }
  }
  return -1;
}

// lazyFlag.match: whether the empty-width conditions op hold between the
// runes r1 and r2.
export function flagMatch(op: EmptyOp, r1: number, r2: number): boolean {
  if (op === 0) {
    return true;
  }
  if ((op & EmptyBeginLine) !== 0) {
    if (r1 !== 0x0a && r1 >= 0) {
      return false;
    }
    op &= ~EmptyBeginLine;
  }
  if ((op & EmptyBeginText) !== 0) {
    if (r1 >= 0) {
      return false;
    }
    op &= ~EmptyBeginText;
  }
  if (op === 0) {
    return true;
  }
  if ((op & EmptyEndLine) !== 0) {
    if (r2 !== 0x0a && r2 >= 0) {
      return false;
    }
    op &= ~EmptyEndLine;
  }
  if ((op & EmptyEndText) !== 0) {
    if (r2 >= 0) {
      return false;
    }
    op &= ~EmptyEndText;
  }
  if (op === 0) {
    return true;
  }
  if (IsWordChar(r1) !== IsWordChar(r2)) {
    op &= ~EmptyWordBoundary;
  } else {
    op &= ~EmptyNoWordBoundary;
  }
  return op === 0;
}

// A queue is a 'sparse array' holding pending threads of execution.
// See https://research.swtch.com/2008/03/using-uninitialized-memory-for-fun-and.html
//
// An entry holds both the instruction pc (pcs) and the actual thread (ts).
// Some queue entries are just place holders so that the machine
// knows it has considered that pc. Such entries have t == nil.
class queue {
  sparse: Uint32Array;
  pcs: Uint32Array;
  ts: (thread | null)[];
  size = 0; // len(dense)

  constructor(n: number) {
    this.sparse = new Uint32Array(n);
    this.pcs = new Uint32Array(n);
    this.ts = Array.from({ length: n }, () => null);
  }
}

// A thread is the state of a single path through the machine:
// an instruction and a corresponding capture array.
// See https://swtch.com/~rsc/regexp/regexp2.html
class thread {
  constructor(
    public inst: Inst,
    public cap: number[],
  ) {}
}

// A machine holds all the state during an NFA simulation for p.
export class machine {
  p: Prog; // compiled program
  q0: queue; // two queues for runq, nextq
  q1: queue;
  pool: thread[] = []; // pool of available threads
  matched = false; // whether a match was found
  matchcap: number[] = []; // capture information for the match

  constructor(p: Prog) {
    this.p = p;
    const n = p.inst.length;
    this.q0 = new queue(n);
    this.q1 = new queue(n);
  }

  init(ncap: number): void {
    if (this.matchcap.length !== ncap) {
      // the pooled threads' capture arrays have the old length
      this.pool = [];
      this.matchcap = Array.from({ length: ncap }, () => -1);
    }
  }

  // alloc allocates a new thread with the given instruction.
  // It uses the free pool if possible.
  alloc(i: Inst): thread {
    const t = this.pool.pop();
    if (t !== undefined) {
      t.inst = i;
      return t;
    }
    return new thread(
      i,
      Array.from({ length: this.matchcap.length }, () => 0),
    );
  }

  // match runs the machine over the input starting at pos.
  // It reports whether a match was found.
  // If so, m.matchcap holds the submatch information.
  match(re: program, i: input, pos: number): boolean {
    const startCond = re.cond;
    if (startCond === EmptyImpossible) {
      // impossible
      return false;
    }
    this.matched = false;
    this.matchcap.fill(-1);
    let runq = this.q0;
    let nextq = this.q1;
    let r = endOfText;
    let r1 = endOfText;
    let width = 0;
    let width1 = 0;
    let p = i.step(pos);
    r = packedRune(p);
    width = packedWidth(p);
    if (r !== endOfText) {
      p = i.step(pos + width);
      r1 = packedRune(p);
      width1 = packedWidth(p);
    }
    let flag1: number;
    let flag2: number;
    if (pos === 0) {
      flag1 = -1;
      flag2 = r;
    } else {
      [flag1, flag2] = i.context(pos);
    }
    for (;;) {
      if (runq.size === 0) {
        if ((startCond & EmptyBeginText) !== 0 && pos !== 0) {
          // Anchored match, past beginning of text.
          break;
        }
        if (this.matched) {
          // Have match; finished exploring alternatives.
          break;
        }
        if (re.prefix.length > 0 && r1 !== re.prefixRune) {
          // Match requires literal prefix; fast search for it.
          const advance = i.index(re, pos);
          if (advance < 0) {
            break;
          }
          pos += advance;
          p = i.step(pos);
          r = packedRune(p);
          width = packedWidth(p);
          p = i.step(pos + width);
          r1 = packedRune(p);
          width1 = packedWidth(p);
        }
      }
      if (!this.matched) {
        if (this.matchcap.length > 0) {
          this.matchcap[0] = pos;
        }
        this.add(runq, this.p.start, pos, this.matchcap, flag1, flag2, null);
      }
      flag1 = r;
      flag2 = r1;
      this.step(re.longest, runq, nextq, pos, pos + width, r, flag1, flag2);
      if (width === 0) {
        break;
      }
      if (this.matchcap.length === 0 && this.matched) {
        // Found a match and not paying attention
        // to where it is, so any match will do.
        break;
      }
      pos += width;
      r = r1;
      width = width1;
      if (r !== endOfText) {
        p = i.step(pos + width);
        r1 = packedRune(p);
        width1 = packedWidth(p);
      }
      const q = runq;
      runq = nextq;
      nextq = q;
    }
    this.clear(nextq);
    return this.matched;
  }

  // clear frees all threads on the thread queue.
  clear(q: queue): void {
    for (let j = 0; j < q.size; j++) {
      const t = q.ts[j];
      if (t) {
        this.pool.push(t);
      }
    }
    q.size = 0;
  }

  // step executes one step of the machine, running each of the threads
  // on runq and appending new threads to nextq.
  // The step processes the rune c (which may be endOfText),
  // which starts at position pos and ends at nextPos.
  // nextCond gives the setting for the empty-width flags after c.
  step(
    longest: boolean,
    runq: queue,
    nextq: queue,
    pos: number,
    nextPos: number,
    c: number,
    next1: number,
    next2: number,
  ): void {
    for (let j = 0; j < runq.size; j++) {
      let t = runq.ts[j] as thread | null;
      if (t === null) {
        continue;
      }
      if (
        longest &&
        this.matched &&
        t.cap.length > 0 &&
        (this.matchcap[0] as number) < (t.cap[0] as number)
      ) {
        this.pool.push(t);
        continue;
      }
      const i = t.inst;
      let add = false;
      switch (i.op) {
        default:
          throw new Error("bad inst");

        case InstMatch:
          if (
            t.cap.length > 0 &&
            (!longest || !this.matched || (this.matchcap[1] as number) < pos)
          ) {
            t.cap[1] = pos;
            copy(this.matchcap, t.cap);
          }
          if (!longest) {
            // First-match mode: cut off all lower-priority threads.
            for (let k = j + 1; k < runq.size; k++) {
              const d = runq.ts[k];
              if (d) {
                this.pool.push(d);
              }
            }
            runq.size = 0;
          }
          this.matched = true;
          break;

        case InstRune:
          add = i.matchRune(c);
          break;
        case InstRune1:
          add = c === i.rune[0];
          break;
        case InstRuneAny:
          add = true;
          break;
        case InstRuneAnyNotNL:
          add = c !== 0x0a;
          break;
      }
      if (add) {
        t = this.add(nextq, i.out, nextPos, t.cap, next1, next2, t);
      }
      if (t !== null) {
        this.pool.push(t);
      }
    }
    runq.size = 0;
  }

  // add adds an entry to q for pc, unless the q already has such an entry.
  // It also recursively adds an entry for all instructions reachable from pc by following
  // empty-width conditions satisfied by cond.  pos gives the current position
  // in the input.
  add(
    q: queue,
    pc: number,
    pos: number,
    cap: number[],
    cond1: number,
    cond2: number,
    t: thread | null,
  ): thread | null {
    for (;;) {
      if (pc === 0) {
        return t;
      }
      const k = q.sparse[pc] as number;
      if (k < q.size && q.pcs[k] === pc) {
        return t;
      }

      const j = q.size++;
      q.ts[j] = null;
      q.pcs[j] = pc;
      q.sparse[pc] = j;

      const i = this.p.inst[pc] as Inst;
      switch (i.op) {
        default:
          throw new Error("unhandled");
        case InstFail:
          // nothing
          return t;
        case InstAlt:
        case InstAltMatch:
          t = this.add(q, i.out, pos, cap, cond1, cond2, t);
          pc = i.arg;
          continue;
        case InstEmptyWidth:
          if (flagMatch(i.arg, cond1, cond2)) {
            pc = i.out;
            continue;
          }
          return t;
        case InstNop:
          pc = i.out;
          continue;
        case InstCapture:
          if (i.arg < cap.length) {
            const opos = cap[i.arg] as number;
            cap[i.arg] = pos;
            this.add(q, i.out, pos, cap, cond1, cond2, null);
            cap[i.arg] = opos;
            return t;
          }
          pc = i.out;
          continue;
        case InstMatch:
        case InstRune:
        case InstRune1:
        case InstRuneAny:
        case InstRuneAnyNotNL:
          if (t === null) {
            t = this.alloc(i);
          } else {
            t.inst = i;
          }
          if (cap.length > 0 && t.cap !== cap) {
            copy(t.cap, cap);
          }
          q.ts[j] = t;
          return null;
      }
    }
  }
}

function copy(dst: number[], src: readonly number[]): void {
  const n = Math.min(dst.length, src.length);
  for (let k = 0; k < n; k++) {
    dst[k] = src[k] as number;
  }
}

// doOnePass implements r.find using the one-pass execution engine.
function doOnePass(re: program, i: input, pos: number, ncap: number): number[] | null {
  const startCond = re.cond;
  if (startCond === EmptyImpossible) {
    // impossible
    return null;
  }
  const onepass = re.onepass as onePassProg;

  const matchcap = Array.from({ length: ncap }, () => -1);
  let matched = false;

  let r = endOfText;
  let r1 = endOfText;
  let width = 0;
  let width1 = 0;
  let p = i.step(pos);
  r = packedRune(p);
  width = packedWidth(p);
  if (r !== endOfText) {
    p = i.step(pos + width);
    r1 = packedRune(p);
    width1 = packedWidth(p);
  }
  let flag1: number;
  let flag2: number;
  if (pos === 0) {
    flag1 = -1;
    flag2 = r;
  } else {
    [flag1, flag2] = i.context(pos);
  }
  let pc = onepass.start;
  let inst = onepass.inst[pc] as Inst;
  // If there is a simple literal prefix, skip over it.
  if (pos === 0 && flagMatch(inst.arg, flag1, flag2) && re.prefix.length > 0) {
    // Match requires literal prefix; fast search for it.
    if (!i.hasPrefix(re)) {
      return null;
    }
    pos += re.prefixBytes.length;
    p = i.step(pos);
    r = packedRune(p);
    width = packedWidth(p);
    p = i.step(pos + width);
    r1 = packedRune(p);
    width1 = packedWidth(p);
    [flag1, flag2] = i.context(pos);
    pc = re.prefixEnd;
  }
  run: for (;;) {
    const oinst = onepass.inst[pc] as (typeof onepass.inst)[number];
    inst = oinst;
    pc = inst.out;
    switch (inst.op) {
      default:
        throw new Error("bad inst");
      case InstMatch:
        matched = true;
        if (matchcap.length > 0) {
          matchcap[0] = 0;
          matchcap[1] = pos;
        }
        break run;
      case InstRune:
        if (!inst.matchRune(r)) {
          break run;
        }
        break;
      case InstRune1:
        if (r !== inst.rune[0]) {
          break run;
        }
        break;
      case InstRuneAny:
        // Nothing
        break;
      case InstRuneAnyNotNL:
        if (r === 0x0a) {
          break run;
        }
        break;
      // peek at the input rune to see which branch of the Alt to take
      case InstAlt:
      case InstAltMatch:
        pc = onePassNext(oinst, r);
        continue;
      case InstFail:
        break run;
      case InstNop:
        continue;
      case InstEmptyWidth:
        if (!flagMatch(inst.arg, flag1, flag2)) {
          break run;
        }
        continue;
      case InstCapture:
        if (inst.arg < matchcap.length) {
          matchcap[inst.arg] = pos;
        }
        continue;
    }
    if (width === 0) {
      break;
    }
    flag1 = r;
    flag2 = r1;
    pos += width;
    r = r1;
    width = width1;
    if (r !== endOfText) {
      p = i.step(pos + width);
      r1 = packedRune(p);
      width1 = packedWidth(p);
    }
  }

  if (!matched) {
    return null;
  }
  return matchcap;
}

// find finds the leftmost match in the input and returns the position
// of its subexpressions (ncap of them).
//
// null is returned if no matches are found and non-null if matches are found.
export function find(re: program, i: input, pos: number, ncap: number): number[] | null {
  if (i.bytes.length < re.minInputLen) {
    return null;
  }

  if (re.onepass !== null) {
    return doOnePass(re, i, pos, ncap);
  }

  const m = re.machines.pop() ?? new machine(re.prog);
  try {
    m.init(ncap);
    if (!m.match(re, i, pos)) {
      return null;
    }
    return m.matchcap.slice();
  } finally {
    re.machines.push(m);
  }
}
