// Upstream: Go go1.27.2 src/regexp/onepass.go.
//
// "One-pass" regexp execution.
// Some regexps can be analyzed to determine that they never need
// backtracking: they are guaranteed to run in one pass over the string
// without bothering to save all the usual NFA state.
// Detect those and execute them more quickly.
//
// The one-pass machine gives the same results as the NFA; Go's tests check
// that. It matters for results through LiteralPrefix, whose prefix comes
// from onePassPrefix when the program is one-pass. The machine itself is
// doOnePass in exec.ts.

import { FoldCase } from "@/tools/regexp/syntax/parse";
import {
  EmptyBeginText,
  EmptyEndText,
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
  type Prog,
} from "@/tools/regexp/syntax/prog";
import { MaxRune, SimpleFold } from "@/tools/unicode/letter";
import { RuneError, runeString } from "@/tools/unicode/utf8";

// A onePassProg is a compiled one-pass regular expression program.
// It is the same as syntax.Prog except for the use of onePassInst.
export interface onePassProg {
  inst: onePassInst[];
  start: number; // index of start instruction
  numCap: number; // number of InstCapture insts in re
}

// A onePassInst is a single instruction in a one-pass regular expression program.
// It is the same as syntax.Inst except for the new 'Next' field.
export class onePassInst extends Inst {
  next: number[] = [];
}

// onePassInst{Inst: inst}
function copyInst(inst: Inst): onePassInst {
  const i = new onePassInst(inst.op);
  i.out = inst.out;
  i.arg = inst.arg;
  i.rune = inst.rune;
  return i;
}

// onePassPrefix returns a literal string that all matches for the
// regexp must start with. Complete is true if the prefix
// is the entire match. Pc is the index of the last rune instruction
// in the string. The onePassPrefix skips over the mandatory
// EmptyBeginText.
export function onePassPrefix(p: Prog): [prefix: string, complete: boolean, pc: number] {
  let i = p.inst[p.start] as Inst;
  if (i.op !== InstEmptyWidth || (i.arg & EmptyBeginText) === 0) {
    return ["", i.op === InstMatch, p.start];
  }
  let pc = i.out;
  i = p.inst[pc] as Inst;
  while (i.op === InstNop) {
    pc = i.out;
    i = p.inst[pc] as Inst;
  }
  // Avoid allocation of buffer if prefix is empty.
  if (i.baseOp() !== InstRune || i.rune.length !== 1) {
    return ["", i.op === InstMatch, p.start];
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
    pc = i.out;
    i = p.inst[i.out] as Inst;
  }
  let complete = false;
  if (
    i.op === InstEmptyWidth &&
    (i.arg & EmptyEndText) !== 0 &&
    (p.inst[i.out] as Inst).op === InstMatch
  ) {
    complete = true;
  }
  return [buf, complete, pc];
}

// onePassNext selects the next actionable state of the prog, based on the input character.
// It should only be called when i.Op == InstAlt or InstAltMatch, and from the one-pass machine.
// One of the alternates may ultimately lead without input to end of line. If the instruction
// is InstAltMatch the path to the InstMatch is in i.Out, the normal node in i.Next.
export function onePassNext(i: onePassInst, r: number): number {
  const next = i.matchRunePos(r);
  if (next >= 0) {
    return i.next[next] as number;
  }
  if (i.op === InstAltMatch) {
    return i.out;
  }
  return 0;
}

// Sparse Array implementation is used as a queueOnePass.
class queueOnePass {
  sparse: Uint32Array;
  dense: Uint32Array;
  size = 0;
  nextIndex = 0;

  constructor(size: number) {
    this.sparse = new Uint32Array(size);
    this.dense = new Uint32Array(size);
  }

  empty(): boolean {
    return this.nextIndex >= this.size;
  }

  next(): number {
    const n = this.dense[this.nextIndex] as number;
    this.nextIndex++;
    return n;
  }

  clear(): void {
    this.size = 0;
    this.nextIndex = 0;
  }

  contains(u: number): boolean {
    if (u >= this.sparse.length) {
      return false;
    }
    const s = this.sparse[u] as number;
    return s < this.size && this.dense[s] === u;
  }

  insert(u: number): void {
    if (!this.contains(u)) {
      this.insertNew(u);
    }
  }

  insertNew(u: number): void {
    if (u >= this.sparse.length) {
      return;
    }
    this.sparse[u] = this.size;
    this.dense[this.size] = u;
    this.size++;
  }
}

// mergeRuneSets merges two non-intersecting runesets, and returns the merged result,
// and a NextIp array. The idea is that if a rune matches the OnePassRunes at index
// i, NextIp[i/2] is the target. If the input sets intersect, an empty runeset and a
// NextIp array with the single element mergeFailed is returned.
// The code assumes that both inputs contain ordered and non-intersecting rune pairs.
const mergeFailed = 0xffffffff;

function mergeRuneSets(
  leftRunes: readonly number[],
  rightRunes: readonly number[],
  leftPC: number,
  rightPC: number,
): [number[], number[]] {
  const leftLen = leftRunes.length;
  const rightLen = rightRunes.length;
  if ((leftLen & 0x1) !== 0 || (rightLen & 0x1) !== 0) {
    throw new Error("mergeRuneSets odd length []rune");
  }
  let lx = 0;
  let rx = 0;
  const merged: number[] = [];
  const next: number[] = [];

  let ix = -1;
  const extend = (newLow: number, newArray: readonly number[], pc: number): boolean => {
    if (ix > 0 && (newArray[newLow] as number) <= (merged[ix] as number)) {
      return false;
    }
    merged.push(newArray[newLow] as number, newArray[newLow + 1] as number);
    ix += 2;
    next.push(pc);
    return true;
  };

  while (lx < leftLen || rx < rightLen) {
    let ok: boolean;
    if (rx >= rightLen) {
      ok = extend(lx, leftRunes, leftPC);
      lx += 2;
    } else if (lx >= leftLen) {
      ok = extend(rx, rightRunes, rightPC);
      rx += 2;
    } else if ((rightRunes[rx] as number) < (leftRunes[lx] as number)) {
      ok = extend(rx, rightRunes, rightPC);
      rx += 2;
    } else {
      ok = extend(lx, leftRunes, leftPC);
      lx += 2;
    }
    if (!ok) {
      return [[], [mergeFailed]];
    }
  }
  return [merged, next];
}

// cleanupOnePass drops working memory, and restores certain shortcut instructions.
function cleanupOnePass(prog: onePassProg, original: Prog): void {
  original.inst.forEach((instOriginal, ix) => {
    switch (instOriginal.op) {
      case InstAlt:
      case InstAltMatch:
      case InstRune:
        break;
      case InstCapture:
      case InstEmptyWidth:
      case InstNop:
      case InstMatch:
      case InstFail:
        (prog.inst[ix] as onePassInst).next = [];
        break;
      case InstRune1:
      case InstRuneAny:
      case InstRuneAnyNotNL:
        prog.inst[ix] = copyInst(instOriginal);
        break;
    }
  });
}

// onePassCopy creates a copy of the original Prog, as we'll be modifying it.
function onePassCopy(prog: Prog): onePassProg {
  const p: onePassProg = {
    start: prog.start,
    numCap: prog.numCap,
    inst: prog.inst.map(copyInst),
  };

  // Go takes pointers to the Out and Arg fields here; a field is an
  // instruction index and whether it is Arg.
  const get = (f: field): number => {
    const i = p.inst[f.pc] as onePassInst;
    return f.arg ? i.arg : i.out;
  };
  const set = (f: field, v: number): void => {
    const i = p.inst[f.pc] as onePassInst;
    if (f.arg) {
      i.arg = v;
    } else {
      i.out = v;
    }
  };

  // rewrites one or more common Prog constructs that enable some otherwise
  // non-onepass Progs to be onepass. A:BD (for example) means an InstAlt at
  // ip A, that points to ips B & C.
  // A:BC + B:DA => A:BC + B:CD
  // A:BC + B:DC => A:DC + B:DC
  for (let pc = 0; pc < p.inst.length; pc++) {
    const op = (p.inst[pc] as onePassInst).op;
    if (op !== InstAlt && op !== InstAltMatch) {
      continue;
    }
    // A:Bx + B:Ay
    let pAOther: field = { pc, arg: false };
    let pAAlt: field = { pc, arg: true };
    // make sure a target is another Alt
    let instAlt = snapshot(p.inst[get(pAAlt)] as onePassInst);
    if (!(instAlt.op === InstAlt || instAlt.op === InstAltMatch)) {
      [pAAlt, pAOther] = [pAOther, pAAlt];
      instAlt = snapshot(p.inst[get(pAAlt)] as onePassInst);
      if (!(instAlt.op === InstAlt || instAlt.op === InstAltMatch)) {
        continue;
      }
    }
    const instOther = p.inst[get(pAOther)] as onePassInst;
    // Analyzing both legs pointing to Alts is for another day
    if (instOther.op === InstAlt || instOther.op === InstAltMatch) {
      // too complicated
      continue;
    }
    // simple empty transition loop
    // A:BC + B:DA => A:BC + B:DC
    let pBAlt: field = { pc: get(pAAlt), arg: false };
    let pBOther: field = { pc: get(pAAlt), arg: true };
    let patch = false;
    if (instAlt.out === pc) {
      patch = true;
    } else if (instAlt.arg === pc) {
      patch = true;
      [pBAlt, pBOther] = [pBOther, pBAlt];
    }
    if (patch) {
      set(pBAlt, get(pAOther));
    }

    // empty transition to common target
    // A:BC + B:DC => A:DC + B:DC
    if (get(pAOther) === get(pBAlt)) {
      set(pAAlt, get(pBOther));
    }
  }
  return p;
}

interface field {
  pc: number;
  arg: boolean;
}

// a copy of an instruction's op and links (Go copies the Inst value)
function snapshot(i: Inst): { op: number; out: number; arg: number } {
  return { op: i.op, out: i.out, arg: i.arg };
}

const anyRuneNotNL = [0, 0x0a - 1, 0x0a + 1, MaxRune];
const anyRune = [0, MaxRune];

// makeOnePass creates a onepass Prog, if possible. It is possible if at any alt,
// the match engine can always tell which branch to take. The routine may modify
// p if it is turned into a onepass Prog. If it isn't possible for this to be a
// onepass Prog, the Prog nil is returned. makeOnePass is recursive
// to the size of the Prog.
function makeOnePass(p: onePassProg): onePassProg | null {
  // If the machine is very long, it's not worth the time to check if we can use one pass.
  if (p.inst.length >= 1000) {
    return null;
  }

  const instQueue = new queueOnePass(p.inst.length);
  const visitQueue = new queueOnePass(p.inst.length);
  const onePassRunes: number[][] = Array.from({ length: p.inst.length }, () => []);

  // fill sets inst.Next to len(onePassRunes[pc])/2+1 copies of inst.Out
  const fillNext = (inst: onePassInst, pc: number): void => {
    inst.next = Array.from(
      { length: (onePassRunes[pc] as number[]).length / 2 + 1 },
      () => inst.out,
    );
  };

  // check that paths from Alt instructions are unambiguous, and rebuild the new
  // program as a onepass program
  const check = (pc: number, m: boolean[]): boolean => {
    let ok = true;
    const inst = p.inst[pc] as onePassInst;
    if (visitQueue.contains(pc)) {
      return ok;
    }
    visitQueue.insert(pc);
    switch (inst.op) {
      case InstAlt:
      case InstAltMatch: {
        ok = check(inst.out, m) && check(inst.arg, m);
        // check no-input paths to InstMatch
        let matchOut = m[inst.out] as boolean;
        let matchArg = m[inst.arg] as boolean;
        if (matchOut && matchArg) {
          ok = false;
          break;
        }
        // Match on empty goes in inst.Out
        if (matchArg) {
          [inst.out, inst.arg] = [inst.arg, inst.out];
          [matchOut, matchArg] = [matchArg, matchOut];
        }
        if (matchOut) {
          m[pc] = true;
          inst.op = InstAltMatch;
        }

        // build a dispatch operator from the two legs of the alt.
        [onePassRunes[pc], inst.next] = mergeRuneSets(
          onePassRunes[inst.out] as number[],
          onePassRunes[inst.arg] as number[],
          inst.out,
          inst.arg,
        );
        if (inst.next.length > 0 && inst.next[0] === mergeFailed) {
          ok = false;
          break;
        }
        break;
      }
      case InstCapture:
      case InstNop:
      case InstEmptyWidth:
        ok = check(inst.out, m);
        m[pc] = m[inst.out] as boolean;
        // pass matching runes back through these no-ops.
        onePassRunes[pc] = (onePassRunes[inst.out] as number[]).slice();
        fillNext(inst, pc);
        break;
      case InstMatch:
      case InstFail:
        m[pc] = inst.op === InstMatch;
        break;
      case InstRune: {
        m[pc] = false;
        if (inst.next.length > 0) {
          break;
        }
        instQueue.insert(inst.out);
        if (inst.rune.length === 0) {
          onePassRunes[pc] = [];
          inst.next = [inst.out];
          break;
        }
        let runes: number[] = [];
        if (inst.rune.length === 1 && (inst.arg & FoldCase) !== 0) {
          const r0 = inst.rune[0] as number;
          runes.push(r0, r0);
          for (let r1 = SimpleFold(r0); r1 !== r0; r1 = SimpleFold(r1)) {
            runes.push(r1, r1);
          }
          runes.sort((a, b) => a - b);
        } else {
          runes = inst.rune.slice();
        }
        onePassRunes[pc] = runes;
        fillNext(inst, pc);
        inst.op = InstRune;
        break;
      }
      case InstRune1: {
        m[pc] = false;
        if (inst.next.length > 0) {
          break;
        }
        instQueue.insert(inst.out);
        const runes: number[] = [];
        // expand case-folded runes
        if ((inst.arg & FoldCase) !== 0) {
          const r0 = inst.rune[0] as number;
          runes.push(r0, r0);
          for (let r1 = SimpleFold(r0); r1 !== r0; r1 = SimpleFold(r1)) {
            runes.push(r1, r1);
          }
          runes.sort((a, b) => a - b);
        } else {
          runes.push(inst.rune[0] as number, inst.rune[0] as number);
        }
        onePassRunes[pc] = runes;
        fillNext(inst, pc);
        inst.op = InstRune;
        break;
      }
      case InstRuneAny:
        m[pc] = false;
        if (inst.next.length > 0) {
          break;
        }
        instQueue.insert(inst.out);
        onePassRunes[pc] = anyRune.slice();
        inst.next = [inst.out];
        break;
      case InstRuneAnyNotNL:
        m[pc] = false;
        if (inst.next.length > 0) {
          break;
        }
        instQueue.insert(inst.out);
        onePassRunes[pc] = anyRuneNotNL.slice();
        fillNext(inst, pc);
        break;
    }
    return ok;
  };

  instQueue.clear();
  instQueue.insert(p.start);
  const m: boolean[] = Array.from({ length: p.inst.length }, () => false);
  let result: onePassProg | null = p;
  while (!instQueue.empty()) {
    visitQueue.clear();
    const pc = instQueue.next();
    if (!check(pc, m)) {
      result = null;
      break;
    }
  }
  if (result !== null) {
    result.inst.forEach((inst, i) => {
      inst.rune = onePassRunes[i] as number[];
    });
  }
  return result;
}

// compileOnePass returns a new *syntax.Prog suitable for onePass execution if the original Prog
// can be recharacterized as a one-pass regexp program, or syntax.nil if the
// Prog cannot be converted. For a one pass prog, the fundamental condition that must
// be true is: at any InstAlt, there must be no ambiguity about what branch to  take.
export function compileOnePass(prog: Prog): onePassProg | null {
  if (prog.start === 0) {
    return null;
  }
  // onepass regexp is anchored
  const start = prog.inst[prog.start] as Inst;
  if (start.op !== InstEmptyWidth || (start.arg & EmptyBeginText) !== EmptyBeginText) {
    return null;
  }
  let hasAlt = false;
  for (const inst of prog.inst) {
    if (inst.op === InstAlt || inst.op === InstAltMatch) {
      hasAlt = true;
      break;
    }
  }
  // If we have alternates, every instruction leading to InstMatch must be EmptyEndText.
  // Also, any match on empty text must be $.
  for (const inst of prog.inst) {
    const opOut = (prog.inst[inst.out] as Inst).op;
    switch (inst.op) {
      default:
        if (opOut === InstMatch && hasAlt) {
          return null;
        }
        break;
      case InstAlt:
      case InstAltMatch:
        if (opOut === InstMatch || (prog.inst[inst.arg] as Inst).op === InstMatch) {
          return null;
        }
        break;
      case InstEmptyWidth:
        if (opOut === InstMatch) {
          if ((inst.arg & EmptyEndText) === EmptyEndText) {
            continue;
          }
          return null;
        }
        break;
    }
  }
  // Creates a slightly optimized copy of the original Prog
  // that cleans up some Prog idioms that block valid onepass programs
  let p: onePassProg | null = onePassCopy(prog);

  // checkAmbiguity on InstAlts, build onepass Prog if possible
  p = makeOnePass(p);

  if (p !== null) {
    cleanupOnePass(p, prog);
  }
  return p;
}
