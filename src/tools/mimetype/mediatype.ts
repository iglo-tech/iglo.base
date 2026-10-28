// Upstream: Go go1.27.2 src/mime/mediatype.go (ParseMediaType and its
// helpers) and src/mime/grammar.go (isTSpecial, isTokenChar): the media type
// parser gabriel-vasile/mimetype uses to compare MIME types.
//
// Strings are JS strings. Go works on UTF-8 bytes, but every byte the
// grammar accepts is ASCII, so a non-ASCII UTF-16 unit (or a lone surrogate,
// the string form of an invalid byte) fails the same checks a non-ASCII Go
// byte fails. The Unicode-aware steps (strings.ToLower, strings.TrimSpace,
// strings.TrimLeftFunc(unicode.IsSpace)) follow Go: ToLower is needed only
// up to whether the result is a token, which only ASCII letters and the two
// runes that lower to ASCII (U+0130 to 'i', U+212A to 'k') can affect.

import { isSpace } from "@/tools/mimetype/go-bytes";

export class MediaTypeError extends Error {}

export const ErrInvalidMediaParameter = new MediaTypeError("mime: invalid media parameter");
const errNoMediaType = new MediaTypeError("mime: no media type");
const errNoSlashAfterFirstToken = new MediaTypeError("mime: expected slash after first token");
const errNoTokenAfterSlash = new MediaTypeError("mime: expected token after slash");
const errUnexpectedContentAfterMediaSubtype = new MediaTypeError(
  "mime: unexpected content after media subtype",
);
const errDuplicateParamName = new MediaTypeError("mime: duplicate parameter name");

// checkMediaTypeDisposition
function checkMediaTypeDisposition(s: string): MediaTypeError | null {
  let [typ, rest] = consumeToken(s);
  if (typ === "") {
    return errNoMediaType;
  }
  if (rest === "") {
    return null;
  }
  if (!rest.startsWith("/")) {
    return errNoSlashAfterFirstToken;
  }
  rest = rest.slice(1);
  const [subtype, rest2] = consumeToken(rest);
  if (subtype === "") {
    return errNoTokenAfterSlash;
  }
  if (rest2 !== "") {
    return errUnexpectedContentAfterMediaSubtype;
  }
  return null;
}

// ParseMediaType parses a media type value and any optional
// parameters, per RFC 1521.  Media types are the values in
// Content-Type and Content-Disposition headers (RFC 2183).
// On success, ParseMediaType returns the media type converted
// to lowercase and trimmed of white space and a non-nil map.
// If there is an error parsing the optional parameter,
// the media type will be returned along with the error
// [ErrInvalidMediaParameter].
// The returned map, params, maps from the lowercase
// attribute to the attribute value with its case preserved.
export function parseMediaType(
  v: string,
): [mediatype: string, params: Map<string, string> | null, err: MediaTypeError | null] {
  const semi = v.indexOf(";");
  const base = semi === -1 ? v : v.slice(0, semi);
  const mediatype = trimSpace(toLower(base));

  const err = checkMediaTypeDisposition(mediatype);
  if (err !== null) {
    return ["", null, err];
  }

  const params = new Map<string, string>();

  // Map of base parameter name -> parameter name -> value
  // for parameters containing a '*' character.
  // Lazily initialized.
  let continuation: Map<string, Map<string, string>> | null = null;

  v = v.slice(base.length);
  while (v.length > 0) {
    v = trimLeftSpace(v);
    if (v.length === 0) {
      break;
    }
    const [key, value, rest] = consumeMediaParam(v);
    if (key === "") {
      if (trimSpace(rest) === ";") {
        // Ignore trailing semicolons.
        // Not an error.
        break;
      }
      // Parse error.
      return [mediatype, null, ErrInvalidMediaParameter];
    }

    let pmap = params;
    const star = key.indexOf("*");
    if (star !== -1) {
      const baseName = key.slice(0, star);
      continuation ??= new Map();
      let m = continuation.get(baseName);
      if (m === undefined) {
        m = new Map();
        continuation.set(baseName, m);
      }
      pmap = m;
    }
    const existing = pmap.get(key);
    if (existing !== undefined && existing !== value) {
      // Duplicate parameter names are incorrect, but we allow them if they are equal.
      return ["", null, errDuplicateParamName];
    }
    pmap.set(key, value);
    v = rest;
  }

  // Stitch together any continuations or things with stars
  // (i.e. RFC 2231 things with stars: "foo*0" or "foo*")
  for (const [key, pieceMap] of continuation ?? []) {
    const singlePartKey = key + "*";
    const single = pieceMap.get(singlePartKey);
    if (single !== undefined) {
      const decv = decode2231Enc(single);
      if (decv !== null) {
        params.set(key, decv);
      }
      continue;
    }

    let buf = "";
    let valid = false;
    for (let n = 0; ; n++) {
      const simplePart = `${key}*${n}`;
      const simple = pieceMap.get(simplePart);
      if (simple !== undefined) {
        valid = true;
        buf += simple;
        continue;
      }
      const encodedPart = simplePart + "*";
      const encoded = pieceMap.get(encodedPart);
      if (encoded === undefined) {
        break;
      }
      valid = true;
      if (n === 0) {
        const decv = decode2231Enc(encoded);
        if (decv !== null) {
          buf += decv;
        }
      } else {
        buf += percentHexUnescape(encoded) ?? "";
      }
    }
    if (valid) {
      params.set(key, buf);
    }
  }

  return [mediatype, params, null];
}

function decode2231Enc(v: string): string | null {
  const q1 = v.indexOf("'");
  if (q1 === -1) {
    return null;
  }
  const charset = v.slice(0, q1);
  v = v.slice(q1 + 1);
  // TODO: ignoring the language part for now. If anybody needs it, we'll
  // need to decide how to expose it in the API. But I'm not sure
  // anybody uses it in practice.
  const q2 = v.indexOf("'");
  if (q2 === -1) {
    return null;
  }
  const extOtherVals = v.slice(q2 + 1);
  switch (toLower(charset)) {
    case "us-ascii":
    case "utf-8":
      break;
    default:
      // Empty or unsupported encoding.
      return null;
  }
  return percentHexUnescape(extOtherVals);
}

// consumeToken consumes a token from the beginning of provided
// string, per RFC 2045 section 5.1 (referenced from 2183), and return
// the token consumed and the rest of the string. Returns ("", v) on
// failure to consume at least one character.
function consumeToken(v: string): [token: string, rest: string] {
  for (let i = 0; i < v.length; i++) {
    if (!isTokenChar(v.charCodeAt(i))) {
      return [v.slice(0, i), v.slice(i)];
    }
  }
  return [v, ""];
}

// consumeValue consumes a "value" per RFC 2045, where a value is
// either a 'token' or a 'quoted-string'.  On success, consumeValue
// returns the value consumed (and de-quoted/escaped, if a
// quoted-string) and the rest of the string. On failure, returns
// ("", v).
function consumeValue(v: string): [value: string, rest: string] {
  if (v === "") {
    return ["", ""];
  }
  if (v[0] !== '"') {
    return consumeToken(v);
  }

  // parse a quoted-string
  let buffer = "";
  for (let i = 1; i < v.length; i++) {
    const r = v[i] as string;
    if (r === '"') {
      return [buffer, v.slice(i + 1)];
    }
    // When MSIE sends a full file path (in "intranet mode"), it does not
    // escape backslashes: "C:\dev\go\foo.txt", not "C:\\dev\\go\\foo.txt".
    //
    // No known MIME generators emit unnecessary backslash escapes
    // for simple token characters like numbers and letters.
    //
    // If we see an unnecessary backslash escape, assume it is from MSIE
    // and intended as a literal backslash. This makes Go servers deal better
    // with MSIE without affecting the way they handle conforming MIME
    // generators.
    if (r === "\\" && i + 1 < v.length && isTSpecial(v.charCodeAt(i + 1))) {
      buffer += v[i + 1];
      i++;
      continue;
    }
    if (r === "\r" || r === "\n") {
      return ["", v];
    }
    buffer += r;
  }
  // Did not find end quote.
  return ["", v];
}

function consumeMediaParam(v: string): [param: string, value: string, rest: string] {
  let rest = trimLeftSpace(v);
  if (!rest.startsWith(";")) {
    return ["", "", v];
  }
  rest = rest.slice(1);

  rest = trimLeftSpace(rest);
  let param: string;
  [param, rest] = consumeToken(rest);
  param = toLower(param);
  if (param === "") {
    return ["", "", v];
  }

  rest = trimLeftSpace(rest);
  if (!rest.startsWith("=")) {
    return ["", "", v];
  }
  rest = rest.slice(1);
  rest = trimLeftSpace(rest);
  const [value, rest2] = consumeValue(rest);
  if (value === "" && rest2 === rest) {
    return ["", "", v];
  }
  return [param, value, rest2];
}

function percentHexUnescape(s: string): string | null {
  // Count %, check that they're well-formed.
  let percents = 0;
  for (let i = 0; i < s.length;) {
    if (s[i] !== "%") {
      i++;
      continue;
    }
    percents++;
    if (i + 2 >= s.length || !ishex(s.charCodeAt(i + 1)) || !ishex(s.charCodeAt(i + 2))) {
      return null;
    }
    i += 3;
  }
  if (percents === 0) {
    return s;
  }

  // Go assembles bytes; an escaped byte >= 0x80 is kept as the string form
  // of src/tools/unicode/utf8.ts would show it (decoded with the bytes
  // around it). Only the value matters to callers, never in this package.
  let t = "";
  for (let i = 0; i < s.length;) {
    if (s[i] === "%") {
      t += String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      t += s[i];
      i++;
    }
  }
  return t;
}

function ishex(c: number): boolean {
  return (0x30 <= c && c <= 0x39) || (0x61 <= c && c <= 0x66) || (0x41 <= c && c <= 0x46);
}

const tspecials = '()<>@,;:\\"/[]?=';

// isTSpecial reports whether c is in 'tspecials' as defined by RFC
// 1521 and RFC 2045.
function isTSpecial(c: number): boolean {
  return c < 0x80 && tspecials.includes(String.fromCharCode(c));
}

// isTokenChar reports whether c is in 'token' as defined by RFC
// 1521 and RFC 2045.
function isTokenChar(c: number): boolean {
  // token := 1*<any (US-ASCII) CHAR except SPACE, CTLs,
  //             or tspecials>
  return c > 0x20 && c < 0x7f && !isTSpecial(c);
}

// strings.ToLower, as far as this package can tell (see the header).
function toLower(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c >= 0x41 && c <= 0x5a) {
      out += String.fromCharCode(c + 0x20);
    } else if (c === 0x130) {
      out += "i";
    } else if (c === 0x212a) {
      out += "k";
    } else {
      out += ch;
    }
  }
  return out;
}

// strings.TrimLeftFunc(s, unicode.IsSpace)
function trimLeftSpace(s: string): string {
  let i = 0;
  while (i < s.length && isSpace(s.codePointAt(i) as number)) {
    i++; // every Unicode space is in the BMP: one UTF-16 unit
  }
  return s.slice(i);
}

// strings.TrimSpace
function trimSpace(s: string): string {
  s = trimLeftSpace(s);
  let j = s.length;
  while (j > 0 && isSpace(s.charCodeAt(j - 1))) {
    j--;
  }
  return s.slice(0, j);
}
