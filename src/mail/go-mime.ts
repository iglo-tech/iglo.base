// Upstream: the Go standard library parts the mailer's output depends on:
// mime/encodedword.go (WordEncoder.Encode), mime/quotedprintable/writer.go,
// net/mail/message.go (Address.String), net/http/header.go (Header.Set and
// Write) and net/textproto (CanonicalMIMEHeaderKey, TrimString), Go 1.27.
//
// Go works on the UTF-8 bytes of a string; so do these ports. Their output
// is ASCII except where Go writes the input bytes through (an address's
// local part, header values that need no encoding).

const encoder = new TextEncoder();

const upperhex = "0123456789ABCDEF";

// the byte length of the UTF-8 sequence that starts with b (the input
// comes from TextEncoder, so it is valid)
function runeLen(b: number): number {
  if (b < 0x80) {
    return 1;
  }
  if (b >= 0xf0) {
    return 4;
  }
  if (b >= 0xe0) {
    return 3;
  }
  return 2;
}

// -------------------------------------------------------------------
// mime.WordEncoder

export type WordEncoder = "b" | "q";

export const BEncoding: WordEncoder = "b";
export const QEncoding: WordEncoder = "q";

const maxEncodedWordLen = 75;
// "=?UTF-8?q?" and "?="
const maxContentLen = maxEncodedWordLen - 10 - 2;
// base64.StdEncoding.DecodedLen(maxContentLen)
const maxBase64Len = Math.floor(maxContentLen / 4) * 3;

// Encode returns the encoded-word form of s. If s is ASCII without special
// characters, it is returned unchanged. The provided charset is the IANA
// charset name of s. It is case insensitive.
export function wordEncode(e: WordEncoder, charset: string, s: string): string {
  if (!needsEncoding(s)) {
    return s;
  }
  return encodeWord(e, charset, s);
}

function needsEncoding(s: string): boolean {
  for (const ch of s) {
    const b = ch.codePointAt(0) as number;
    if ((b < 0x20 || b > 0x7e) && b !== 0x09) {
      return true;
    }
  }
  return false;
}

function encodeWord(e: WordEncoder, charset: string, s: string): string {
  let buf = openWord(e, charset);
  const bytes = encoder.encode(s);
  if (e === BEncoding) {
    buf += bEncode(e, charset, bytes);
  } else {
    buf += qEncode(e, charset, bytes);
  }
  return buf + "?=";
}

function bEncode(e: WordEncoder, charset: string, s: Uint8Array): string {
  // base64.StdEncoding.EncodedLen
  if (!isUTF8(charset) || Math.ceil(s.length / 3) * 4 <= maxContentLen) {
    return Buffer.from(s).toString("base64");
  }

  // If the charset is UTF-8, it must not split runes between words
  let out = "";
  let currentLen = 0;
  let last = 0;
  let n = 0;
  for (let i = 0; i < s.length; i += n) {
    n = runeLen(s[i] as number);

    if (currentLen + n <= maxBase64Len) {
      currentLen += n;
    } else {
      out += Buffer.from(s.subarray(last, i)).toString("base64");
      out += splitWord(e, charset);
      last = i;
      currentLen = n;
    }
  }
  return out + Buffer.from(s.subarray(last)).toString("base64");
}

function qEncode(e: WordEncoder, charset: string, s: Uint8Array): string {
  if (!isUTF8(charset)) {
    return writeQString(s);
  }

  // If the charset is UTF-8, it must not split runes between words
  let out = "";
  let currentLen = 0;
  let n = 0;
  for (let i = 0; i < s.length; i += n) {
    const b = s[i] as number;
    // Multi-byte characters must not be split across encoded-words.
    // See RFC 2047, section 5.3.
    let encLen: number;
    if (b >= 0x20 && b <= 0x7e && b !== 0x3d && b !== 0x3f && b !== 0x5f) {
      n = 1;
      encLen = 1;
    } else {
      n = runeLen(b);
      encLen = 3 * n;
    }

    if (currentLen + encLen > maxContentLen) {
      out += splitWord(e, charset);
      currentLen = 0;
    }
    out += writeQString(s.subarray(i, i + n));
    currentLen += encLen;
  }
  return out;
}

function writeQString(s: Uint8Array): string {
  let out = "";
  for (const b of s) {
    if (b === 0x20) {
      out += "_";
    } else if (b >= 0x21 && b <= 0x7e && b !== 0x3d && b !== 0x3f && b !== 0x5f) {
      out += String.fromCharCode(b);
    } else {
      out += "=" + upperhex[b >> 4] + upperhex[b & 0x0f];
    }
  }
  return out;
}

function openWord(e: WordEncoder, charset: string): string {
  return `=?${charset}?${e}?`;
}

function splitWord(e: WordEncoder, charset: string): string {
  return "?= " + openWord(e, charset);
}

function isUTF8(charset: string): boolean {
  return charset.toLowerCase() === "utf-8";
}

// -------------------------------------------------------------------
// mime/quotedprintable.Writer: Write of the whole input, then Close

const lineMaxLen = 76;

// quotedPrintable encodes data as a quotedprintable.Writer (not Binary)
// that is written once and closed.
export function quotedPrintable(data: Uint8Array): string {
  let out = "";
  let line = "";
  let cr = false;

  const flush = (): void => {
    out += line;
    line = "";
  };
  const insertCRLF = (): void => {
    line += "\r\n";
    flush();
  };
  const insertSoftLineBreak = (): void => {
    line += "=";
    insertCRLF();
  };
  const encode = (b: number): void => {
    if (lineMaxLen - 1 - line.length < 3) {
      insertSoftLineBreak();
    }
    line += "=" + upperhex[b >> 4] + upperhex[b & 0x0f];
  };
  const checkLastByte = (): void => {
    if (line.length === 0) {
      return;
    }
    const b = line.charCodeAt(line.length - 1);
    if (isWhitespace(b)) {
      line = line.slice(0, -1);
      encode(b);
    }
  };
  const write = (p: Uint8Array): void => {
    for (const b of p) {
      if (b === 0x0a || b === 0x0d) {
        if (cr && b === 0x0a) {
          cr = false;
          continue;
        }

        if (b === 0x0d) {
          cr = true;
        }

        checkLastByte();
        insertCRLF();
        continue;
      }

      if (line.length === lineMaxLen - 1) {
        insertSoftLineBreak();
      }

      line += String.fromCharCode(b);
      cr = false;
    }
  };

  let n = 0;
  for (let i = 0; i < data.length; i++) {
    const b = data[i] as number;
    if (b >= 0x21 && b <= 0x7e && b !== 0x3d) {
      continue;
    }
    if (isWhitespace(b) || b === 0x0a || b === 0x0d) {
      continue;
    }

    if (i > n) {
      write(data.subarray(n, i));
      n = i;
    }

    encode(b);
    n++;
  }
  if (n !== data.length) {
    write(data.subarray(n));
  }

  // Close
  checkLastByte();
  flush();

  return out;
}

function isWhitespace(b: number): boolean {
  return b === 0x20 || b === 0x09;
}

// -------------------------------------------------------------------
// net/mail.Address

export interface Address {
  name: string;
  address: string;
}

// String formats the address as a valid RFC 5322 address. If the address's
// name contains non-ASCII characters the name will be rendered according to
// RFC 2047.
export function addressString(a: Address): string {
  // Format address local@domain
  const at = a.address.lastIndexOf("@");
  let local: string;
  let domain = "";
  if (at < 0) {
    // This is a malformed address ("@" is required in addr-spec);
    // treat the whole address as local-part.
    local = a.address;
  } else {
    local = a.address.slice(0, at);
    domain = a.address.slice(at + 1);
  }

  // Add quotes if needed
  const localBytes = encoder.encode(local);
  let quoteLocal = false;
  let i = 0;
  for (const ch of local) {
    const r = ch.codePointAt(0) as number;
    const size = encoder.encode(ch).length;
    if (!isAtext(r, false)) {
      // Dots are okay if they are surrounded by atext.
      // We only need to check that the previous byte is
      // not a dot, and this isn't the end of the string.
      if (!(r === 0x2e && i > 0 && localBytes[i - 1] !== 0x2e && i < localBytes.length - 1)) {
        quoteLocal = true;
        break;
      }
    }
    i += size;
  }
  if (quoteLocal) {
    local = quoteString(local);
  }

  const s = "<" + local + "@" + domain + ">";

  if (a.name === "") {
    return s;
  }

  // If every character is printable ASCII, quoting is simple.
  let allPrintable = true;
  for (const ch of a.name) {
    const r = ch.codePointAt(0) as number;
    // isWSP here should actually be isFWS,
    // but we don't support folding yet.
    if ((!isVchar(r) && !isWSP(r)) || isMultibyte(r)) {
      allPrintable = false;
      break;
    }
  }
  if (allPrintable) {
    return quoteString(a.name) + " " + s;
  }

  // Text in an encoded-word in a display-name must not contain certain
  // characters like quotes or parentheses (see RFC 2047 section 5.3).
  // When this is the case encode the name using base64 encoding.
  if (/["#$%&'(),.:;<>@[\]^`{|}~]/.test(a.name)) {
    return wordEncode(BEncoding, "utf-8", a.name) + " " + s;
  }
  return wordEncode(QEncoding, "utf-8", a.name) + " " + s;
}

// isAtext reports whether r is an RFC 5322 atext character.
// If dot is true, period is included.
function isAtext(r: number, dot: boolean): boolean {
  if (r === 0x2e) {
    return dot;
  }
  // RFC 5322 3.2.3. specials
  if ('()<>[]:;@\\,"'.includes(String.fromCodePoint(r))) {
    return false;
  }
  return isVchar(r);
}

// isQtext reports whether r is an RFC 5322 qtext character.
function isQtext(r: number): boolean {
  // Printable US-ASCII, excluding backslash or quote.
  if (r === 0x5c || r === 0x22) {
    return false;
  }
  return isVchar(r);
}

// quoteString renders a string as an RFC 5322 quoted-string.
function quoteString(s: string): string {
  let b = '"';
  for (const ch of s) {
    const r = ch.codePointAt(0) as number;
    if (isQtext(r) || isWSP(r)) {
      b += ch;
    } else if (isVchar(r)) {
      b += "\\" + ch;
    }
  }
  return b + '"';
}

// isVchar reports whether r is an RFC 5322 VCHAR character.
function isVchar(r: number): boolean {
  // Visible (printing) characters.
  return (0x21 <= r && r <= 0x7e) || isMultibyte(r);
}

// isMultibyte reports whether r is a multi-byte UTF-8 character
// as supported by RFC 6532.
function isMultibyte(r: number): boolean {
  return r >= 0x80;
}

// isWSP reports whether r is a WSP (white space).
// WSP is a space or horizontal tab (RFC 5234 Appendix B).
function isWSP(r: number): boolean {
  return r === 0x20 || r === 0x09;
}

// -------------------------------------------------------------------
// net/http.Header (Set, Get and Write), with textproto's key rules

// a header in wire order is written by writeHeader; the keys are kept
// canonical by setHeader
export type Header = Map<string, string>;

// Set sets the header entry associated with key to the single element
// value. The key is canonicalized by CanonicalMIMEHeaderKey.
export function setHeader(h: Header, key: string, value: string): void {
  h.set(canonicalMIMEHeaderKey(key), value);
}

// Get gets the first value associated with the given key ("" when none).
export function getHeader(h: Header, key: string): string {
  return h.get(canonicalMIMEHeaderKey(key)) ?? "";
}

// Write writes a header in wire format: the keys sorted, invalid names
// dropped, newlines in values replaced by spaces and the values trimmed.
export function writeHeader(h: Header): string {
  let out = "";
  const keys = [...h.keys()].toSorted(compareBytes);
  for (const key of keys) {
    if (!validHeaderFieldName(key)) {
      // This could be an error. In the common case of
      // writing response headers, however, we have no good
      // way to provide the error back to the server
      // handler, so just drop invalid headers instead.
      continue;
    }
    const v = trimString((h.get(key) as string).replace(/[\r\n]/g, " "));
    out += key + ": " + v + "\r\n";
  }
  return out;
}

// strings.Compare (byte order of the UTF-8 encodings)
function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

// CanonicalMIMEHeaderKey returns the canonical format of the MIME header
// key s: the first letter and any letter following a hyphen upper case,
// the rest lower case. A key with an invalid byte (a space included) is
// returned unchanged.
export function canonicalMIMEHeaderKey(s: string): string {
  for (let i = 0; i < s.length; i++) {
    if (!validHeaderFieldByte(s.charCodeAt(i))) {
      return s;
    }
  }
  let out = "";
  let upper = true;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (upper && c >= 0x61 && c <= 0x7a) {
      c -= 0x20;
    } else if (!upper && c >= 0x41 && c <= 0x5a) {
      c += 0x20;
    }
    out += String.fromCharCode(c);
    upper = c === 0x2d; // for next time
  }
  return out;
}

// httpguts.ValidHeaderFieldName: a non-empty RFC 7230 token
function validHeaderFieldName(v: string): boolean {
  if (v.length === 0) {
    return false;
  }
  for (let i = 0; i < v.length; i++) {
    if (!validHeaderFieldByte(v.charCodeAt(i))) {
      return false;
    }
  }
  return true;
}

// tchar = "!" / "#" / "$" / "%" / "&" / "'" / "*" / "+" / "-" / "." /
//         "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
function validHeaderFieldByte(c: number): boolean {
  if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) {
    return true;
  }
  return c < 0x80 && "!#$%&'*+-.^_`|~".includes(String.fromCharCode(c));
}

// textproto.TrimString returns s without leading and trailing ASCII space
// (space, tab, CR and LF).
function trimString(s: string): string {
  return s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
}

// -------------------------------------------------------------------

// strconv.Quote (fmt's %q of a string): printable characters as they
// are, quotes and backslashes escaped, control characters as Go escapes
// them
export function quote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const r = ch.codePointAt(0) as number;
    if (ch === '"' || ch === "\\") {
      out += "\\" + ch;
    } else if (r >= 0x20 && r !== 0x7f && !(r >= 0x80 && r < 0xa0)) {
      out += ch;
    } else {
      out +=
        quoteEscapes[r] ??
        (r < 0x80
          ? `\\x${r.toString(16).padStart(2, "0")}`
          : `\\u${r.toString(16).padStart(4, "0")}`);
    }
  }
  return out + '"';
}

const quoteEscapes: { [r: number]: string } = {
  0x07: "\\a",
  0x08: "\\b",
  0x0c: "\\f",
  0x0a: "\\n",
  0x0d: "\\r",
  0x09: "\\t",
  0x0b: "\\v",
};
