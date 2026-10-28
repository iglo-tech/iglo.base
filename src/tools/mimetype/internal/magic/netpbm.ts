// Upstream: gabriel-vasile/mimetype v1.4.15 internal/magic/netpbm.go.

import { hasPrefix, lit } from "@/tools/mimetype/go-bytes";
import { ASCIISpaces, Bytes, byteIsWS } from "@/tools/mimetype/internal/scan/bytes";

// NetPBM matches a Netpbm Portable BitMap ASCII/Binary file.
//
// See: https://en.wikipedia.org/wiki/Netpbm
export function NetPBM(raw: Uint8Array, _limit: number): boolean {
  return netp(raw, "P1\n", "P4\n");
}

// NetPGM matches a Netpbm Portable GrayMap ASCII/Binary file.
//
// See: https://en.wikipedia.org/wiki/Netpbm
export function NetPGM(raw: Uint8Array, _limit: number): boolean {
  return netp(raw, "P2\n", "P5\n");
}

// NetPPM matches a Netpbm Portable PixMap ASCII/Binary file.
//
// See: https://en.wikipedia.org/wiki/Netpbm
export function NetPPM(raw: Uint8Array, _limit: number): boolean {
  return netp(raw, "P3\n", "P6\n");
}

const p7 = lit("P7\n");
const tupltype = lit("TUPLTYPE");
const widthHdr = lit("WIDTH ");
const heightHdr = lit("HEIGHT ");
const depth = lit("DEPTH ");
const maxval = lit("MAXVAL ");
const endhdr = lit("ENDHDR");

// NetPAM matches a Netpbm Portable Arbitrary Map file.
//
// See: https://en.wikipedia.org/wiki/Netpbm
export function NetPAM(raw: Uint8Array, _limit: number): boolean {
  if (!hasPrefix(raw, p7)) {
    return false;
  }
  let w = false;
  let h = false;
  let d = false;
  let m = false;
  let e = false;
  const s = new Bytes(raw);
  // Read line by line.
  for (let i = 0; i < 128; i++) {
    const l = s.line();
    // If the line is empty or a comment, skip.
    if (l.length === 0 || l.peek() === 0x23) {
      if (s.length === 0) {
        return false;
      }
      continue;
    } else if (hasPrefix(l.b, tupltype)) {
      continue;
    } else if (hasPrefix(l.b, widthHdr)) {
      w = true;
    } else if (hasPrefix(l.b, heightHdr)) {
      h = true;
    } else if (hasPrefix(l.b, depth)) {
      d = true;
    } else if (hasPrefix(l.b, maxval)) {
      m = true;
    } else if (hasPrefix(l.b, endhdr)) {
      e = true;
    }
    // When we reached header, return true if we collected all four required headers.
    // WIDTH, HEIGHT, DEPTH and MAXVAL.
    if (e) {
      return w && h && d && m;
    }
  }
  return false;
}

function netp(raw: Uint8Array, ...prefixes: string[]): boolean {
  const s = new Bytes(raw);
  let foundPrefix = "";
  for (const p of prefixes) {
    if (hasPrefix(s.b, lit(p))) {
      foundPrefix = p;
    }
  }
  if (foundPrefix === "") {
    return false;
  }
  s.advance(foundPrefix.length); // jump over P1, P2, P3, etc.

  let l = new Bytes();
  // Read line by line.
  for (let i = 0; i < 128; i++) {
    l = s.line();
    // If the line is a comment, skip.
    if (l.peek() === 0x23) {
      continue;
    }
    // If line has leading whitespace, then skip over whitespace.
    while (byteIsWS(l.peek())) {
      l.advance(1);
    }
    if (s.length === 0 || l.length > 0) {
      break;
    }
  }

  // At this point l should be the two integers denoting the size of the matrix.
  const width = l.popUntil(...ASCIISpaces);
  while (byteIsWS(l.peek())) {
    l.advance(1);
  }
  const height = l.popUntil(...ASCIISpaces);

  const w = parseInt64(width.b);
  const h = parseInt64(height.b);
  return w !== null && h !== null && w > 0n && h > 0n;
}

const maxInt64 = (1n << 63n) - 1n;

// strconv.ParseInt(string(b), 10, 64), or null for an error: an optional
// sign, then one or more decimal digits, within the int64 range.
function parseInt64(b: Uint8Array): bigint | null {
  let i = 0;
  let neg = false;
  if (b.length > 0 && (b[0] === 0x2b || b[0] === 0x2d)) {
    neg = b[0] === 0x2d;
    i = 1;
  }
  if (i === b.length) {
    return null;
  }
  let v = 0n;
  for (; i < b.length; i++) {
    const c = b[i] as number;
    if (c < 0x30 || c > 0x39) {
      return null;
    }
    v = v * 10n + BigInt(c - 0x30);
    if (v > maxInt64 + 1n) {
      return null;
    }
  }
  if (neg) {
    return -v;
  }
  return v > maxInt64 ? null : v;
}
