// Upstream: gabriel-vasile/mimetype v1.4.15 internal/scan/bytes.go.
//
// Package scan has functions for scanning byte slices.
//
// Go's Bytes is a byte slice whose pointer-receiver methods reslice it in
// place. Here a Bytes holds a Uint8Array view in `b`, and those methods
// replace the view; value-receiver methods (firstNonWS, search, match) leave
// it alone. Where Go copies a Bytes value, the port makes a new Bytes over the
// same view (clone), so the copy moves independently.

import { beUint32, hasPrefix, index, leUint16, leUint32 } from "@/tools/mimetype/go-bytes";

// Bytes is a byte slice with helper methods for easier scanning.
export class Bytes {
  constructor(public b: Uint8Array = new Uint8Array(0)) {}

  get length(): number {
    return this.b.length;
  }

  clone(): Bytes {
    return new Bytes(this.b);
  }

  advance(n: number): boolean {
    if (n < 0 || this.b.length < n) {
      return false;
    }
    this.b = this.b.subarray(n);
    return true;
  }

  // TrimLWS trims whitespace from beginning of the bytes.
  trimLWS(): void {
    let firstNonWS = 0;
    for (; firstNonWS < this.b.length && byteIsWS(this.b[firstNonWS] as number); firstNonWS++) {
      // advance
    }

    this.b = this.b.subarray(firstNonWS);
  }

  // TrimRWS trims whitespace from the end of the bytes.
  trimRWS(): void {
    let lb = this.b.length;
    while (lb > 0 && byteIsWS(this.b[lb - 1] as number)) {
      this.b = this.b.subarray(0, lb - 1);
      lb--;
    }
  }

  // FirstNonWS returns the first non-whitespace character from b,
  // or 0x00 if no such character is found.
  firstNonWS(): number {
    for (const c of this.b) {
      if (byteIsWS(c)) {
        continue;
      }
      return c;
    }

    return 0x00;
  }

  // Peek one byte from b or 0x00 if b is empty.
  peek(): number {
    if (this.b.length > 0) {
      return this.b[0] as number;
    }
    return 0;
  }

  // Pop one byte from b or 0x00 if b is empty.
  pop(): number {
    if (this.b.length > 0) {
      const ret = this.b[0] as number;
      this.b = this.b.subarray(1);
      return ret;
    }
    return 0;
  }

  // PopN pops n bytes from b or nil if b is empty.
  popN(n: number): Uint8Array | null {
    if (this.b.length >= n) {
      const ret = this.b.subarray(0, n);
      this.b = this.b.subarray(n);
      return ret;
    }
    return null;
  }

  // PopUntil will advance b until, but not including, the first occurrence of stopAt
  // character. If no occurrence is found, then it will advance until the end of b.
  // The returned Bytes is a slice of all the bytes that we're advanced over.
  //
  // Go searches with bytes.IndexAny(b, string(stopAt)); every caller passes
  // ASCII stop bytes, for which that is a plain byte search.
  popUntil(...stopAt: number[]): Bytes {
    if (this.b.length === 0) {
      return new Bytes();
    }
    let i = this.b.findIndex((c) => stopAt.includes(c));
    if (i === -1) {
      i = this.b.length;
    }

    const prefix = this.b.subarray(0, i);
    this.b = this.b.subarray(i);
    return new Bytes(prefix);
  }

  // ReadSlice is the same as PopUntil, but the returned value includes stopAt as well.
  readSlice(stopAt: number): Bytes {
    if (this.b.length === 0) {
      return new Bytes();
    }
    let i = this.b.indexOf(stopAt);
    if (i === -1) {
      i = this.b.length;
    } else {
      i++;
    }

    const prefix = this.b.subarray(0, i);
    this.b = this.b.subarray(i);
    return new Bytes(prefix);
  }

  // Line returns the first line from b and advances b with the length of the
  // line. One new line character is trimmed after the line if it exists.
  line(): Bytes {
    const line = this.popUntil(0x0a);
    const lline = line.b.length;
    if (lline > 0 && line.b[lline - 1] === 0x0d) {
      line.b = line.b.subarray(0, lline - 1);
    }
    this.advance(1);
    return line;
  }

  uint16(): [number, boolean] {
    if (this.b.length < 2) {
      return [0, false];
    }
    const v = leUint16(this.b, 0);
    this.b = this.b.subarray(2);
    return [v, true];
  }

  uint32(): [number, boolean] {
    if (this.b.length < 4) {
      return [0, false];
    }
    const v = leUint32(this.b, 0);
    this.b = this.b.subarray(4);
    return [v, true];
  }

  uint32be(): [number, boolean] {
    if (this.b.length < 4) {
      return [0, false];
    }
    const v = beUint32(this.b, 0);
    this.b = this.b.subarray(4);
    return [v, true];
  }

  // Search for occurrences of pattern p inside b at any index.
  // It returns the index where p was found in b and how many bytes were needed
  // for matching the pattern.
  search(p: Uint8Array, flags: number): [i: number, l: number] {
    const lb = this.b.length;
    const lp = p.length;
    if (lp === 0) {
      return [0, 0];
    }
    if (lb === 0) {
      return [-1, 0];
    }
    if (flags === 0) {
      const i = index(this.b, p);
      if (i === -1) {
        return [-1, 0];
      }
      return [i, lp];
    }

    for (let i = 0; i < lb; i++) {
      if (lb - i < lp) {
        return [-1, 0];
      }
      const l = new Bytes(this.b.subarray(i)).match(p, flags);
      if (l !== -1) {
        return [i, l];
      }
    }

    return [-1, 0];
  }

  // Match returns how many bytes were needed to match pattern p.
  // It returns -1 if p does not match b.
  match(p: Uint8Array, flags: number): number {
    const l = this.b.length;
    if (p.length === 0) {
      return 0;
    }
    if (l === 0) {
      return -1;
    }
    const b = new Bytes(this.b);
    // Some cases we can handle with a simple bytes.HasPrefix.
    if (flags === 0 || flags === FullWord) {
      if (!hasPrefix(b.b, p)) {
        return -1;
      }
      b.b = b.b.subarray(p.length);
      p = p.subarray(p.length);
    } else {
      while (b.b.length > 0) {
        // If we finished all we were looking for from p.
        if (p.length === 0) {
          break;
        }
        const p0 = p[0] as number;
        const b0 = b.b[0] as number;
        if ((flags & IgnoreCase) > 0 && isUpper(p0)) {
          if (upper(b0) !== p0) {
            return -1;
          }
          b.b = b.b.subarray(1);
          p = p.subarray(1);
        } else if ((flags & CompactWS) > 0 && byteIsWS(p0)) {
          p = p.subarray(1);
          if (!byteIsWS(b0)) {
            return -1;
          }
          b.b = b.b.subarray(1);
          if (p.length > 0 && !byteIsWS(p[0] as number)) {
            b.trimLWS();
          }
        } else {
          if (b0 !== p0) {
            return -1;
          }
          b.b = b.b.subarray(1);
          p = p.subarray(1);
        }
      }
    }
    // out:
    // If p still has leftover characters, it means it didn't fully match b.
    if (p.length > 0) {
      return -1;
    }
    if ((flags & FullWord) > 0) {
      if (b.b.length > 0 && !byteIsWS(b.b[0] as number)) {
        return -1;
      }
    }
    return l - b.b.length;
  }
}

// CompactWS will make one whitespace from pattern to match one or more spaces from input.
export const CompactWS = 1 << 0;
// IgnoreCase will match lower case from pattern with lower case from input.
// IgnoreCase will match upper case from pattern with both lower and upper case from input.
// This flag is not really well named,
export const IgnoreCase = 1 << 1;
// FullWord ensures the input ends with a full word (it's followed by spaces.)
export const FullWord = 1 << 2;

function isUpper(c: number): boolean {
  return c >= 0x41 && c <= 0x5a;
}
function upper(c: number): number {
  if (c >= 0x61 && c <= 0x7a) {
    return c - 0x20;
  }
  return c;
}

export function byteIsWS(b: number): boolean {
  return b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b === 0x20;
}

export const ASCIISpaces = [0x20, 0x0d, 0x0a, 0x0c, 0x09];
export const ASCIIDigits = [0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39];
