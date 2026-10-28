// Upstream: Go go1.27.2 src/bytes/bytes.go (HasPrefix, Equal, Index,
// IndexByte, Contains, Trim, TrimSpace), src/encoding/binary/binary.go
// (LittleEndian and BigEndian Uint16 and Uint32), src/unicode/utf8/utf8.go
// (DecodeRune, RuneStart, Valid) and src/unicode/graphic.go (IsSpace): the
// parts of Go's standard library that gabriel-vasile/mimetype uses on bytes.
//
// Byte slices are Uint8Array views. Go panics on an out-of-range index; the
// mimetype code never indexes out of range (it is fuzzed for that), so the
// readers here do not check bounds either.

// bytes.HasPrefix
export function hasPrefix(s: Uint8Array, prefix: Uint8Array): boolean {
  if (s.length < prefix.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i++) {
    if (s[i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

// bytes.Equal
export function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && hasPrefix(a, b);
}

// bytes.Index
export function index(s: Uint8Array, sep: Uint8Array): number {
  const n = sep.length;
  if (n === 0) {
    return 0;
  }
  const first = sep[0] as number;
  const last = s.length - n;
  for (let i = s.indexOf(first); i !== -1 && i <= last; i = s.indexOf(first, i + 1)) {
    let j = 1;
    while (j < n && s[i + j] === sep[j]) {
      j++;
    }
    if (j === n) {
      return i;
    }
  }
  return -1;
}

// bytes.Contains
export function contains(b: Uint8Array, subslice: Uint8Array): boolean {
  return index(b, subslice) !== -1;
}

// bytes.Trim with an ASCII cutset.
export function trim(s: Uint8Array, cutset: string): Uint8Array {
  const cut = (c: number) => cutset.includes(String.fromCharCode(c));
  let start = 0;
  while (start < s.length && cut(s[start] as number)) {
    start++;
  }
  let stop = s.length;
  while (stop > start && cut(s[stop - 1] as number)) {
    stop--;
  }
  return s.subarray(start, stop);
}

// bytes.TrimSpace: leading and trailing white space as defined by Unicode
// (unicode.IsSpace on the UTF-8 decoded runes; an invalid byte is
// utf8.RuneError, which is not a space).
export function trimSpace(s: Uint8Array): Uint8Array {
  const starts: number[] = [];
  const spaces: boolean[] = [];
  for (let i = 0; i < s.length;) {
    const [r, size] = decodeRune(s, i);
    starts.push(i);
    spaces.push(isSpace(r) && !(r === RuneError && size === 1));
    i += size;
  }
  let first = 0;
  while (first < spaces.length && spaces[first]) {
    first++;
  }
  let last = spaces.length;
  while (last > first && spaces[last - 1]) {
    last--;
  }
  const start = first < starts.length ? (starts[first] as number) : s.length;
  const stop = last < starts.length ? (starts[last] as number) : s.length;
  return s.subarray(start, Math.max(start, stop));
}

// binary.LittleEndian.Uint16
export function leUint16(b: Uint8Array, off: number): number {
  return (b[off] as number) | ((b[off + 1] as number) << 8);
}

// binary.LittleEndian.Uint32
export function leUint32(b: Uint8Array, off: number): number {
  return (
    ((b[off] as number) |
      ((b[off + 1] as number) << 8) |
      ((b[off + 2] as number) << 16) |
      ((b[off + 3] as number) << 24)) >>>
    0
  );
}

// binary.BigEndian.Uint16
export function beUint16(b: Uint8Array, off: number): number {
  return ((b[off] as number) << 8) | (b[off + 1] as number);
}

// binary.BigEndian.Uint32
export function beUint32(b: Uint8Array, off: number): number {
  return (
    (((b[off] as number) << 24) |
      ((b[off + 1] as number) << 16) |
      ((b[off + 2] as number) << 8) |
      (b[off + 3] as number)) >>>
    0
  );
}

// []byte(s) for a Go string literal written with \x escapes: each char code
// (all below 0x100) is one byte.
export function lit(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    out[i] = s.charCodeAt(i);
  }
  return out;
}

export const RuneError = 0xfffd;

// utf8.DecodeRune of p[i:]: the rune and its width, (RuneError, 1) for an
// invalid encoding and (RuneError, 0) at the end.
export function decodeRune(p: Uint8Array, i: number): [rune: number, size: number] {
  const n = p.length - i;
  if (n < 1) {
    return [RuneError, 0];
  }
  const p0 = p[i] as number;
  if (p0 < 0x80) {
    return [p0, 1];
  }
  let size: number;
  let lo = 0x80;
  let hi = 0xbf;
  if (p0 >= 0xc2 && p0 <= 0xdf) {
    size = 2;
  } else if (p0 >= 0xe0 && p0 <= 0xef) {
    size = 3;
    if (p0 === 0xe0) {
      lo = 0xa0;
    } else if (p0 === 0xed) {
      hi = 0x9f;
    }
  } else if (p0 >= 0xf0 && p0 <= 0xf4) {
    size = 4;
    if (p0 === 0xf0) {
      lo = 0x90;
    } else if (p0 === 0xf4) {
      hi = 0x8f;
    }
  } else {
    return [RuneError, 1];
  }
  if (n < size) {
    return [RuneError, 1];
  }
  const b1 = p[i + 1] as number;
  if (b1 < lo || hi < b1) {
    return [RuneError, 1];
  }
  for (let k = 2; k < size; k++) {
    const b = p[i + k] as number;
    if (b < 0x80 || 0xbf < b) {
      return [RuneError, 1];
    }
  }
  if (size === 2) {
    return [((p0 & 0x1f) << 6) | (b1 & 0x3f), 2];
  }
  const b2 = p[i + 2] as number;
  if (size === 3) {
    return [((p0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f), 3];
  }
  const b3 = p[i + 3] as number;
  return [((p0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f), 4];
}

// utf8.RuneStart
export function runeStart(b: number): boolean {
  return (b & 0xc0) !== 0x80;
}

// utf8.Valid
export function valid(p: Uint8Array): boolean {
  for (let i = 0; i < p.length;) {
    const [r, size] = decodeRune(p, i);
    if (r === RuneError && size === 1) {
      return false;
    }
    i += size;
  }
  return true;
}

// unicode.IsSpace: '\t', '\n', '\v', '\f', '\r', ' ', U+0085 (NEL),
// U+00A0 (NBSP), and the other White_Space runes (category Z and the
// property Pattern_White_Space).
export function isSpace(r: number): boolean {
  if (r <= 0xff) {
    switch (r) {
      case 0x09:
      case 0x0a:
      case 0x0b:
      case 0x0c:
      case 0x0d:
      case 0x20:
      case 0x85:
      case 0xa0:
        return true;
    }
    return false;
  }
  return (
    r === 0x1680 ||
    (r >= 0x2000 && r <= 0x200a) ||
    r === 0x2028 ||
    r === 0x2029 ||
    r === 0x202f ||
    r === 0x205f ||
    r === 0x3000
  );
}
