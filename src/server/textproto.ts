// Upstream: Go's net/textproto/reader.go (go1.27.2), the part that
// mime/multipart uses: readMIMEHeader with its size and count limits,
// readLineSlice, readContinuedLineSlice, skipSpace, upcomingHeaderKeys'
// buffer fill and canonicalMIMEHeaderKey; and MIMEHeader's Get and Del
// (header.go).
//
// Header keys and values are kept as Go strings of bytes: one character
// per byte (latin1), so their lengths are Go's byte lengths. A caller
// that needs the text decodes it (headerText).

import type { Reader as BufReader } from "@/server/bufio";

// TODO: This should be a distinguishable error (ErrMessageTooLarge)
// to allow mime/multipart and net/http to detect it.
export const errMessageTooLarge = new Error("message too large");

// A ProtocolError describes a protocol violation such as an invalid
// response or a hung-up connection.
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

// A MIMEHeader represents a MIME-style header mapping keys to sets of
// values.
export class MIMEHeader {
  readonly #m = new Map<string, string[]>();

  // Get gets the first value associated with the given key, or "".
  get(key: string): string {
    return this.#m.get(canonicalMIMEHeaderKeyString(key))?.[0] ?? "";
  }

  // Del deletes the values associated with key.
  del(key: string): void {
    this.#m.delete(canonicalMIMEHeaderKeyString(key));
  }

  // the values of a canonical key, as stored
  values(key: string): string[] | undefined {
    return this.#m.get(key);
  }

  set(key: string, values: string[]): void {
    this.#m.set(key, values);
  }

  entries(): IterableIterator<[string, string[]]> {
    return this.#m.entries();
  }
}

// the text of a header value (its bytes read as UTF-8)
export function headerText(value: string): string {
  let ascii = true;
  for (let i = 0; i < value.length && ascii; i++) {
    ascii = value.charCodeAt(i) < 0x80;
  }
  if (ascii) {
    return value;
  }
  return new TextDecoder().decode(Buffer.from(value, "latin1"));
}

function bytesString(b: Uint8Array): string {
  if (b.length <= 256) {
    return String.fromCharCode(...b);
  }
  return Buffer.from(b.buffer, b.byteOffset, b.length).toString("latin1");
}

// A Reader implements convenience methods for reading requests or
// responses from a text protocol network connection.
export class Reader {
  readonly R: BufReader;
  #buf: number[] = []; // a re-usable buffer for readContinuedLineSlice

  constructor(r: BufReader) {
    this.R = r;
  }

  // readLineSlice reads a single line from r, up to lim bytes long (or
  // unlimited if lim is less than 0), eliding the final \r or \r\n from
  // the returned string.
  async readLineSlice(lim: number): Promise<[Uint8Array | undefined, unknown]> {
    // the pieces of a line longer than the buffer, joined at its end
    const pieces: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const [l, more, err] = await this.R.readLine();
      if (err !== undefined) {
        return [undefined, err];
      }
      const piece = l as Uint8Array;
      if (lim >= 0 && length + piece.length > lim) {
        return [undefined, errMessageTooLarge];
      }
      // Avoid the copy if the first call produced a full line.
      if (pieces.length === 0 && !more) {
        return [piece, undefined];
      }
      pieces.push(piece.slice());
      length += piece.length;
      if (!more) {
        break;
      }
    }
    const line = new Uint8Array(length);
    let offset = 0;
    for (const piece of pieces) {
      line.set(piece, offset);
      offset += piece.length;
    }
    return [line, undefined];
  }

  // readContinuedLineSlice reads continued lines from the reader buffer,
  // returning a byte slice with all lines. The validateFirstLine function
  // is run on the first read line, and if it returns an error then this
  // error is returned from readContinuedLineSlice. It reads up to lim
  // bytes of data (or unlimited if lim is less than 0).
  async readContinuedLineSlice(
    lim: number,
    validateFirstLine: (line: Uint8Array) => unknown,
  ): Promise<[Uint8Array | undefined, unknown]> {
    // Read the first line.
    const [line, err] = await this.readLineSlice(lim);
    if (err !== undefined) {
      return [undefined, err];
    }
    const first = line as Uint8Array;
    if (first.length === 0) {
      // blank line - no continuation
      return [first, undefined];
    }

    const verr = validateFirstLine(first);
    if (verr !== undefined) {
      return [undefined, verr];
    }

    // Optimistically assume that we have started to buffer the next line
    // and it starts with an ASCII letter (the next header key), or a blank
    // line, so we can avoid copying that buffered data around in memory
    // and skipping over non-existent whitespace.
    if (this.R.buffered() > 1) {
      const [peek] = await this.R.peek(2);
      if (
        (peek.length > 0 && (isASCIILetter(peek[0] as number) || peek[0] === 0x0a)) ||
        (peek.length === 2 && peek[0] === 0x0d && peek[1] === 0x0a)
      ) {
        return [trim(first), undefined];
      }
    }

    // ReadByte or the next readLineSlice will flush the read buffer;
    // copy the slice into buf.
    this.#buf = [...trim(first)];

    if (lim < 0) {
      lim = Number.MAX_SAFE_INTEGER;
    }
    lim -= this.#buf.length;

    // Read continuation lines.
    while ((await this.skipSpace()) > 0) {
      this.#buf.push(0x20);
      if (this.#buf.length >= lim) {
        return [undefined, errMessageTooLarge];
      }
      const [next, lineErr] = await this.readLineSlice(lim - this.#buf.length);
      if (lineErr !== undefined) {
        return [undefined, lineErr];
      }
      for (const c of trim(next as Uint8Array)) {
        this.#buf.push(c);
      }
    }
    return [Uint8Array.from(this.#buf), undefined];
  }

  // skipSpace skips R over all spaces and returns the number of bytes
  // skipped.
  async skipSpace(): Promise<number> {
    let n = 0;
    for (;;) {
      const [c, err] = await this.R.readByte();
      if (err !== undefined) {
        // Bufio will keep err until next read.
        break;
      }
      if (c !== 0x20 && c !== 0x09) {
        this.R.unreadByte();
        break;
      }
      n++;
    }
    return n;
  }
}

function isASCIILetter(b: number): boolean {
  b |= 0x20; // make lower case
  return b >= 0x61 && b <= 0x7a;
}

// trim returns s with leading and trailing spaces and tabs removed.
// It does not assume Unicode or UTF-8.
function trim(s: Uint8Array): Uint8Array {
  let i = 0;
  while (i < s.length && (s[i] === 0x20 || s[i] === 0x09)) {
    i++;
  }
  s = s.subarray(i);
  let n = s.length - 1;
  while (n >= 0 && (s[n] === 0x20 || s[n] === 0x09)) {
    n--;
  }
  return s.subarray(0, n + 1);
}

// readMIMEHeader is a version of ReadMIMEHeader which takes a limit on the
// header size. It is called by the mime/multipart package.
//
// The header is a sequence of possibly continued Key: Value lines ending
// in a blank line. The result maps CanonicalMIMEHeaderKey(key) to a
// sequence of values in the same order encountered in the input. Go
// returns the header read so far with most errors; mime/multipart drops
// it, so only the error is returned then.
export async function readMIMEHeader(
  r: Reader,
  maxMemory: number,
  maxHeaders: number,
): Promise<[MIMEHeader | undefined, unknown]> {
  if (maxMemory < 0) {
    return [undefined, errMessageTooLarge];
  }

  // upcomingHeaderKeys: force a buffer load if empty (the size hint it
  // computes only presizes Go's map)
  await r.R.peek(1);

  const m = new MIMEHeader();

  // The first line cannot start with a leading space.
  {
    const [buf, err] = await r.R.peek(1);
    if (err === undefined && (buf[0] === 0x20 || buf[0] === 0x09)) {
      const errorLimit = 80; // arbitrary limit on how much of the line we'll quote
      const [line, lineErr] = await r.readLineSlice(errorLimit);
      if (lineErr !== undefined) {
        return [m, lineErr];
      }
      return [
        m,
        new ProtocolError(`malformed MIME header initial line: ${goQuote(line as Uint8Array)}`),
      ];
    }
  }

  for (;;) {
    const [kv, err] = await r.readContinuedLineSlice(maxMemory, mustHaveFieldNameColon);
    if (kv === undefined || kv.length === 0) {
      return [m, err];
    }

    // Key ends at first colon.
    const colon = kv.indexOf(0x3a);
    if (colon < 0) {
      return [m, new ProtocolError(`malformed MIME header line: ${goQuote(kv)}`)];
    }
    const k = kv.subarray(0, colon);
    const v = kv.subarray(colon + 1);
    const [key, ok] = canonicalMIMEHeaderKey(bytesString(k));
    if (!ok) {
      return [m, new ProtocolError(`malformed MIME header line: ${goQuote(kv)}`)];
    }
    for (let i = 0; i < v.length; i++) {
      if (!validHeaderValueByte(v[i] as number)) {
        return [m, new ProtocolError(`malformed MIME header line: ${goQuote(kv)}`)];
      }
    }

    maxHeaders--;
    if (maxHeaders < 0) {
      return [undefined, errMessageTooLarge];
    }

    // Skip initial spaces in value.
    let start = 0;
    while (start < v.length && (v[start] === 0x20 || v[start] === 0x09)) {
      start++;
    }
    const value = bytesString(v.subarray(start));

    const vv = m.values(key);
    if (vv === undefined) {
      // Account for per-entry overhead.
      // 200 bytes is based on benchmarks circa Go 1.20.
      const mapEntryOverhead = 200;

      maxMemory -= key.length;
      maxMemory -= mapEntryOverhead;
    }
    maxMemory -= value.length;
    if (maxMemory < 0) {
      return [m, errMessageTooLarge];
    }
    if (vv === undefined) {
      m.set(key, [value]);
    } else {
      vv.push(value);
    }

    if (err !== undefined) {
      return [m, err];
    }
  }
}

// mustHaveFieldNameColon ensures that, per RFC 7230, the field-name is on
// a single line, so the first line must contain a colon.
function mustHaveFieldNameColon(line: Uint8Array): unknown {
  if (line.indexOf(0x3a) < 0) {
    return new ProtocolError(`malformed MIME header: missing colon: ${goQuote(line)}`);
  }
  return undefined;
}

// the valid bytes of a header field name (RFC 7230 token characters)
const headerFieldBytes = new Uint8Array(256);
for (const c of "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!#$%&'*+-.^_`|~") {
  headerFieldBytes[c.charCodeAt(0)] = 1;
}

// validHeaderFieldByte reports whether c is a valid byte in a header field
// name.
function validHeaderFieldByte(c: number): boolean {
  return headerFieldBytes[c] === 1;
}

// validHeaderValueByte reports whether c is a valid byte in a header field
// value: VCHAR, SP, HTAB or obs-text (%x80-FF).
function validHeaderValueByte(c: number): boolean {
  return (c >= 0x20 && c !== 0x7f) || c === 0x09;
}

// canonicalMIMEHeaderKey returns the canonical format of a header key (a
// Go string of bytes): the first letter and any letter following a hyphen
// in upper case, the rest in lower case. ok is true if the key contains
// only valid characters and spaces; a key with spaces is accepted but not
// canonicalized.
function canonicalMIMEHeaderKey(a: string): [string, boolean] {
  if (a.length === 0) {
    return ["", false];
  }

  // See if a looks like a header key. If not, return it unchanged.
  let noCanon = false;
  let canonical = true;
  let upper = true;
  for (let i = 0; i < a.length; i++) {
    const c = a.charCodeAt(i);
    if (validHeaderFieldByte(c)) {
      if ((upper && c >= 0x61 && c <= 0x7a) || (!upper && c >= 0x41 && c <= 0x5a)) {
        canonical = false;
      }
      upper = c === 0x2d;
      continue;
    }
    // Don't canonicalize.
    if (c === 0x20) {
      // We accept invalid headers with a space before the
      // colon, but must not canonicalize them.
      // See https://go.dev/issue/34540.
      noCanon = true;
      continue;
    }
    return [a, false];
  }
  if (noCanon || canonical) {
    return [a, true];
  }

  let out = "";
  upper = true;
  for (let i = 0; i < a.length; i++) {
    let c = a.charCodeAt(i);
    // Canonicalize: first letter upper case
    // and upper case after each dash.
    if (upper && c >= 0x61 && c <= 0x7a) {
      c -= 0x20;
    } else if (!upper && c >= 0x41 && c <= 0x5a) {
      c += 0x20;
    }
    out += String.fromCharCode(c);
    upper = c === 0x2d; // for next time
  }
  return [out, true];
}

// CanonicalMIMEHeaderKey for the keys of Get and Del: a key with invalid
// header field bytes (or a space) is returned without modifications.
function canonicalMIMEHeaderKeyString(s: string): string {
  for (let i = 0; i < s.length; i++) {
    if (!validHeaderFieldByte(s.charCodeAt(i))) {
      return s;
    }
  }
  return canonicalMIMEHeaderKey(s)[0];
}

const quoteEscapes = new Map<number, string>([
  [0x22, '\\"'],
  [0x5c, "\\\\"],
  [0x0a, "\\n"],
  [0x0d, "\\r"],
  [0x09, "\\t"],
]);

// Go's %q of a byte slice, for error texts (which no response shows):
// printable ASCII as is, the rest escaped (Go keeps printable UTF-8)
export function goQuote(b: Uint8Array): string {
  let out = '"';
  for (const c of b) {
    const escape = quoteEscapes.get(c);
    if (escape !== undefined) {
      out += escape;
    } else if (c >= 0x20 && c < 0x7f) {
      out += String.fromCharCode(c);
    } else {
      out += `\\x${c.toString(16).padStart(2, "0")}`;
    }
  }
  return `${out}"`;
}
