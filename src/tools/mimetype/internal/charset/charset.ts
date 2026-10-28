// Upstream: gabriel-vasile/mimetype v1.4.15 internal/charset/charset.go.
//
// A charset is a Go string of the input's bytes; here it is in the string
// form of src/tools/unicode/utf8.ts (bytesToText: an invalid UTF-8 byte is
// the lone surrogate U+DC80+n), so it round-trips to the same bytes.

import {
  decodeRune,
  hasPrefix,
  index,
  lit,
  runeStart,
  trimSpace,
  valid,
  RuneError,
} from "@/tools/mimetype/go-bytes";
import { getAnAttribute, skipAComment } from "@/tools/mimetype/internal/markup/markup";
import { Bytes, IgnoreCase, byteIsWS } from "@/tools/mimetype/internal/scan/bytes";
import { bytesToText } from "@/tools/types/go-json";

const F = 0; /* character never appears in text */
const T = 1; /* character appears in plain ASCII text */
const I = 2; /* character appears in ISO-8859 text */
const X = 3; /* character appears in non-ISO extended ASCII (Mac, IBM PC) */

const boms: { bom: Uint8Array; enc: string }[] = [
  { bom: Uint8Array.of(0xef, 0xbb, 0xbf), enc: "utf-8" },
  { bom: Uint8Array.of(0x00, 0x00, 0xfe, 0xff), enc: "utf-32be" },
  { bom: Uint8Array.of(0xff, 0xfe, 0x00, 0x00), enc: "utf-32le" },
  { bom: Uint8Array.of(0xfe, 0xff), enc: "utf-16be" },
  { bom: Uint8Array.of(0xff, 0xfe), enc: "utf-16le" },
];

// https://github.com/file/file/blob/fa93fb9f7d21935f1c7644c47d2975d31f12b812/src/encoding.c#L241
// prettier-ignore
const textChars = Uint8Array.of(
  /*                  BEL BS HT LF VT FF CR    */
  F, F, F, F, F, F, F, T, T, T, T, T, T, T, F, F, /* 0x0X */
  /*                              ESC          */
  F, F, F, F, F, F, F, F, F, F, F, T, F, F, F, F, /* 0x1X */
  T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, /* 0x2X */
  T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, /* 0x3X */
  T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, /* 0x4X */
  T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, /* 0x5X */
  T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, /* 0x6X */
  T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, F, /* 0x7X */
  /*            NEL                            */
  X, X, X, X, X, T, X, X, X, X, X, X, X, X, X, X, /* 0x8X */
  X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, /* 0x9X */
  I, I, I, I, I, I, I, I, I, I, I, I, I, I, I, I, /* 0xaX */
  I, I, I, I, I, I, I, I, I, I, I, I, I, I, I, I, /* 0xbX */
  I, I, I, I, I, I, I, I, I, I, I, I, I, I, I, I, /* 0xcX */
  I, I, I, I, I, I, I, I, I, I, I, I, I, I, I, I, /* 0xdX */
  I, I, I, I, I, I, I, I, I, I, I, I, I, I, I, I, /* 0xeX */
  I, I, I, I, I, I, I, I, I, I, I, I, I, I, I, I, /* 0xfX */
);

// FromBOM returns the charset declared in the BOM of content.
export function fromBOM(content: Uint8Array): string {
  for (const b of boms) {
    if (hasPrefix(content, b.bom)) {
      return b.enc;
    }
  }
  return "";
}

// FromPlain returns the charset of a plain text. It relies on BOM presence
// and it falls back on checking each byte in content.
export function fromPlain(content: Uint8Array): string {
  if (content.length === 0) {
    return "";
  }
  const cset = fromBOM(content);
  if (cset !== "") {
    return cset;
  }
  const origContent = content;
  // Try to detect UTF-8.
  // First eliminate any partial rune at the end.
  for (let i = content.length - 1; i >= 0 && i > content.length - 4; i--) {
    const b = content[i] as number;
    if (b < 0x80) {
      break;
    }
    if (runeStart(b)) {
      content = content.subarray(0, i);
      break;
    }
  }
  // ASCII is a subset of UTF8. Follow W3C recommendation and replace with UTF8.
  if (valid(content)) {
    return "utf-8";
  }

  return latin(origContent);
}

function latin(content: Uint8Array): string {
  let hasControlBytes = false;
  for (const b of content) {
    const t = textChars[b] as number;
    if (t !== T && t !== I) {
      return "";
    }
    if (b >= 0x80 && b <= 0x9f) {
      hasControlBytes = true;
    }
  }
  // Code range 0x80 to 0x9F is reserved for control characters in ISO-8859-1
  // (so-called C1 Controls). Windows 1252, however, has printable punctuation
  // characters in this range.
  if (hasControlBytes) {
    return "windows-1252";
  }
  return "iso-8859-1";
}

// FromXML returns the charset of an XML document. It relies on the XML
// header <?xml version="1.0" encoding="UTF-8"?> and falls back on the plain
// text content.
export function fromXML(content: Uint8Array): string {
  const cset = fromXMLHeader(new Bytes(content));
  if (cset !== "") {
    return cset;
  }
  return fromPlain(content);
}

const xmlDecl = lit("<?xml");
const encodingName = lit("encoding");

// fromXML in Go.
function fromXMLHeader(s: Bytes): string {
  const lxml = xmlDecl.length;
  for (;;) {
    s.trimLWS();
    if (s.length <= lxml) {
      return "";
    }

    const [i, k] = s.search(xmlDecl, 0);
    if (i === -1) {
      return "";
    }
    s.advance(i + k);
    let hasMore = true;
    while (hasMore) {
      const [aName, aVal, more] = getAnAttribute(s);
      hasMore = more;
      if (
        new Bytes(aName ?? undefined).match(encodingName, 0) !== -1 &&
        aVal !== null &&
        aVal.length !== 0
      ) {
        return bytesToText(aVal);
      }
    }
  }
}

// FromHTML returns the charset of an HTML document. It first looks if a BOM is
// present and if so uses it to determine the charset. If no BOM is present,
// it relies on the meta tag <meta charset="UTF-8"> and falls back on the
// plain text content.
export function fromHTML(content: Uint8Array): string {
  let cset = fromBOM(content);
  if (cset !== "") {
    return cset;
  }
  cset = fromHTMLMeta(new Bytes(content));
  if (cset !== "") {
    return cset;
  }
  return fromPlain(content);
}

const dontKnow = 0;
const doNeedPragma = 1;
const doNotNeedPragma = 2;

const metaTag = lit("<META");
const bodyTag = lit("<BODY");
const contentType = lit("CONTENT-TYPE");

// fromHTML in Go.
function fromHTMLMeta(s: Bytes): string {
  const lmeta = metaTag.length;
  for (;;) {
    if (skipAComment(s)) {
      continue;
    }
    if (s.length <= lmeta) {
      return "";
    }
    // Abort when <body is reached.
    if (s.match(bodyTag, IgnoreCase) !== -1) {
      return "";
    }
    if (s.match(metaTag, IgnoreCase) === -1) {
      s.b = s.b.subarray(1); // safe to slice instead of s.Advance(1) because bounds are checked
      continue;
    }
    s.b = s.b.subarray(lmeta);
    const c = s.pop();
    if (c === 0 || (!byteIsWS(c) && c !== 0x2f)) {
      return "";
    }
    const attrList = new Set<string>();
    let gotPragma = false;
    let needPragma = dontKnow;

    let charset = "";
    let hasMore = true;
    while (hasMore) {
      const [aNameB, aValB, more] = getAnAttribute(s);
      hasMore = more;
      const aName = toLower(aNameB ?? new Uint8Array(0));
      if (attrList.has(aName)) {
        continue;
      }
      // processing step
      if (aName.length === 0 && (aValB === null || aValB.length === 0)) {
        if (needPragma === dontKnow) {
          continue;
        }
        if (needPragma === doNeedPragma && !gotPragma) {
          continue;
        }
      }
      attrList.add(aName);
      switch (aName) {
        case "http-equiv":
          if (new Bytes(aValB ?? undefined).match(contentType, IgnoreCase) !== -1) {
            gotPragma = true;
          }
          break;
        case "content":
          charset = bytesToText(extractCharsetFromMeta(new Bytes(aValB ?? undefined)) ?? "");
          if (charset.length !== 0) {
            needPragma = doNeedPragma;
          }
          break;
        case "charset":
          charset = bytesToText(aValB ?? "");
          needPragma = doNotNeedPragma;
          break;
      }
    }

    if (needPragma === dontKnow || (needPragma === doNeedPragma && !gotPragma)) {
      continue;
    }

    return charset;
  }
}

// strings.ToLower(string(b)) as far as fromHTML can tell. Go lowers each
// rune with unicode.ToLower and writes an invalid byte as U+FFFD. The only
// non-ASCII runes whose lower case is ASCII are U+0130 (to 'i') and U+212A
// (to 'k'); those and ASCII are lowered as Go does, and any other rune is
// kept. So a name equals "http-equiv", "content" or "charset" exactly when
// Go's does, and names equal here are equal in Go. Names Go lowers to the
// same string but this keeps apart (as "\u00c4" and "\u00e4") are neither of
// the three, and a repeat of such a name changes nothing in fromHTML.
function toLower(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length;) {
    const [r, size] = decodeRune(b, i);
    i += size;
    if (r === RuneError && size === 1) {
      out += "�";
    } else if (r >= 0x41 && r <= 0x5a) {
      out += String.fromCharCode(r + 0x20);
    } else if (r === 0x130) {
      out += "i";
    } else if (r === 0x212a) {
      out += "k";
    } else {
      out += String.fromCodePoint(r);
    }
  }
  return out;
}

const charsetName = lit("charset");

// https://html.spec.whatwg.org/multipage/urls-and-fetching.html#algorithm-for-extracting-a-character-encoding-from-a-meta-element
export function extractCharsetFromMeta(s: Bytes): Uint8Array | null {
  for (;;) {
    const i = index(s.b, charsetName);
    if (i === -1) {
      return null;
    }
    s.advance(i + charsetName.length);
    while (byteIsWS(s.peek())) {
      s.advance(1);
    }
    if (s.pop() !== 0x3d) {
      continue;
    }
    while (byteIsWS(s.peek())) {
      s.advance(1);
    }
    const quote = s.peek();
    if (quote === 0) {
      return null;
    }
    if (quote === 0x22 || quote === 0x27) {
      s.advance(1);
      return trimSpace(s.popUntil(quote).b);
    }

    return trimSpace(s.popUntil(0x3b, 0x09, 0x0a, 0x0c, 0x0d, 0x20).b);
  }
}
