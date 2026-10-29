// Upstream: golang.org/x/net v0.61.0 html/escape.go
//
// Byte-level entity handling works on Uint8Array views of UTF-8 input, as the
// Go code works on []byte. The Go functions that mutate their argument in
// place (unescape, lower; convertNewlines in token.ts) do so here too, because
// the tokenizer's rawBytes() view observes those writes.
//
// Go's strings.ToLower and strings.EqualFold, which the other files use,
// are toLower and equalFold of src/collections/go-strings.ts (Go 1.27.2's
// Unicode tables, as upstream's binary).

import { entity, entity2, longestEntityWithoutSemicolon } from "@/tools/html/entity";

// These replacements permit compatibility with old numeric entities that
// assumed Windows-1252 encoding.
// https://html.spec.whatwg.org/multipage/syntax.html#consume-a-character-reference
const replacementTable: readonly number[] = [
  0x20ac, // First entry is what 0x80 should be replaced with.
  0x0081,
  0x201a,
  0x0192,
  0x201e,
  0x2026,
  0x2020,
  0x2021,
  0x02c6,
  0x2030,
  0x0160,
  0x2039,
  0x0152,
  0x008d,
  0x017d,
  0x008f,
  0x0090,
  0x2018,
  0x2019,
  0x201c,
  0x201d,
  0x2022,
  0x2013,
  0x2014,
  0x02dc,
  0x2122,
  0x0161,
  0x203a,
  0x0153,
  0x009d,
  0x017e,
  0x0178, // Last entry is 0x9F.
  // 0x00->'�' is handled programmatically.
  // 0x0D->'\u000D' is a no-op.
];

const ampersand = 0x26;
const replacementChar = 0xfffd;

// runeLen is utf8.RuneLen: the number of bytes needed to encode r, or -1 if r
// is not a valid rune.
function runeLen(r: number): number {
  if (r < 0) return -1;
  if (r < 0x80) return 1;
  if (r < 0x800) return 2;
  if (0xd800 <= r && r <= 0xdfff) return -1;
  if (r < 0x10000) return 3;
  if (r <= 0x10ffff) return 4;
  return -1;
}

// appendRune is utf8.AppendRune for runes that runeLen accepts.
function appendRune(out: number[], r: number): void {
  if (r < 0x80) {
    out.push(r);
  } else if (r < 0x800) {
    out.push(0xc0 | (r >> 6), 0x80 | (r & 0x3f));
  } else if (r < 0x10000) {
    out.push(0xe0 | (r >> 12), 0x80 | ((r >> 6) & 0x3f), 0x80 | (r & 0x3f));
  } else {
    out.push(
      0xf0 | (r >> 18),
      0x80 | ((r >> 12) & 0x3f),
      0x80 | ((r >> 6) & 0x3f),
      0x80 | (r & 0x3f),
    );
  }
}

// unescapeEntity attempts to consume a character reference from s[src:],
// returning the rune, potential second rune, and number of bytes consumed
// (which indicates the length of the character reference). It is assumed that
// the first byte of s is '&'. attribute should be true if parsing an attribute
// value.
export function unescapeEntity(s: Uint8Array, attribute: boolean): [number, number, number] {
  // https://html.spec.whatwg.org/multipage/syntax.html#consume-a-character-reference

  // i starts at 1 because we already know that s[0] == '&'.
  let i = 1;

  if (s.length <= 1) {
    return [ampersand, 0, 1];
  }

  if (s[i] === 0x23 /* # */) {
    if (s.length <= 2) {
      // We need to have at least "&#".
      return [ampersand, 0, 1];
    }
    i++;
    let c = s[i]!;
    let hex = false;
    if (c === 0x78 /* x */ || c === 0x58 /* X */) {
      hex = true;
      i++;
    }

    const i0 = i;
    let x = 0;
    while (i < s.length) {
      c = s[i]!;
      let d: number;
      let mult: number;
      if (hex) {
        mult = 16;
        if (0x30 <= c && c <= 0x39) {
          d = c - 0x30;
        } else if (0x61 <= c && c <= 0x66) {
          d = c - 0x61 + 10;
        } else if (0x41 <= c && c <= 0x46) {
          d = c - 0x41 + 10;
        } else {
          break;
        }
      } else {
        mult = 10;
        if (0x30 <= c && c <= 0x39) {
          d = c - 0x30;
        } else {
          break;
        }
      }
      if (x <= 0x10ffff) {
        x = mult * x + d;
      }
      i++;
    }

    if (i === i0) {
      // No characters matched.
      return [ampersand, 0, 1];
    }

    if (i < s.length && s[i] === 0x3b /* ; */) {
      i++;
    }

    if (0x80 <= x && x <= 0x9f) {
      // Replace characters from Windows-1252 with UTF-8 equivalents.
      x = replacementTable[x - 0x80]!;
    } else if (x === 0 || (0xd800 <= x && x <= 0xdfff) || x > 0x10ffff) {
      // Replace invalid characters with the replacement character.
      x = replacementChar;
    }

    return [x, 0, i];
  }

  // Consume the maximum number of characters possible, with the
  // consumed characters matching one of the named references.

  while (i < s.length) {
    const c = s[i]!;
    i++;
    // Lower-cased characters are more common in entities, so we check for them first.
    if ((0x61 <= c && c <= 0x7a) || (0x41 <= c && c <= 0x5a) || (0x30 <= c && c <= 0x39)) {
      continue;
    }
    if (c !== 0x3b /* ; */) {
      i--;
    }
    break;
  }

  // Entity names are ASCII, so decoding them is exact.
  const entityName = decodeUTF8(s.subarray(1, i));
  if (entityName === "") {
    // No-op.
  } else if (
    attribute &&
    entityName[entityName.length - 1] !== ";" &&
    s.length > i &&
    s[i] === 0x3d /* = */
  ) {
    // No-op.
  } else {
    const x = entity.get(entityName) ?? 0;
    const x2 = entity2.get(entityName) ?? [0, 0];
    if (x !== 0) {
      return [x, 0, i];
    } else if (x2[0] !== 0) {
      return [x2[0], x2[1], i];
    } else if (!attribute) {
      const maxLen = Math.min(entityName.length - 1, longestEntityWithoutSemicolon);
      for (let j = maxLen; j > 1; j--) {
        const prefix = entity.get(entityName.slice(0, j)) ?? 0;
        if (prefix !== 0) {
          return [prefix, 0, j + 1];
        }
      }
    }
  }

  return [ampersand, 0, 1];
}

// unescape unescapes b's entites, so that "a&lt;b" becomes "a<b". It attempts
// to do so in place, but if the unescaped value is longer than the input it
// allocates a new buffer. attribute should be true if parsing an attribute
// value.
export function unescape(b: Uint8Array, attribute: boolean): Uint8Array {
  const firstAmp = b.indexOf(ampersand);
  if (firstAmp === -1) {
    return b;
  }

  // out[0:n] is the output. While reusingB, out is b itself, as in Go, so the
  // writes below overwrite already-consumed input.
  let out = b;
  let n = firstAmp;
  let reusingB = true;
  const put = (c: number): void => {
    if (n === out.length) {
      const grown = new Uint8Array(Math.max(16, out.length * 2));
      grown.set(out.subarray(0, n));
      out = grown;
    }
    out[n++] = c;
  };

  let src = firstAmp;
  while (src < b.length) {
    if (b[src] !== ampersand) {
      put(b[src]!);
      src++;
      continue;
    }

    const [r1, r2, entityNameLen] = unescapeEntity(b.subarray(src), attribute);
    if (entityNameLen === 1 && r1 === ampersand) {
      // Not an entity
      put(ampersand);
      src++;
      continue;
    }

    // Compute replacement length
    let replLen = runeLen(r1);
    if (r2 !== 0) {
      replLen += runeLen(r2);
    }

    // If the name of the entity is shorter than the width of the
    // replacement runes then we need to expand the output to fit the
    // replacement, so stop writing into b.
    if (replLen > entityNameLen && reusingB) {
      out = out.slice(0, n);
      reusingB = false;
    }
    const repl: number[] = [];
    appendRune(repl, r1);
    if (r2 !== 0) {
      appendRune(repl, r2);
    }
    for (const c of repl) {
      put(c);
    }

    src += entityNameLen;
  }

  return out.subarray(0, n);
}

// lower lower-cases the A-Z bytes in b in-place, so that "aBc" becomes "abc".
export function lower(b: Uint8Array): Uint8Array {
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!;
    if (0x41 <= c && c <= 0x5a) {
      b[i] = c + 0x20;
    }
  }
  return b;
}

// escapeComment is like escape but escapes its input less often. Per
// https://github.com/golang/go/issues/58246 some HTML comments are (1)
// meaningful and (2) contain angle brackets that we'd like to avoid escaping
// unless we have to.
//
// "We have to" includes the '&' byte, since that introduces other escapes.
//
// It also includes those bytes (not including EOF) that would otherwise end
// the comment. Per the summary table at the bottom of comment_test.go, this is
// the '>' byte that, per above, we'd like to avoid escaping unless we have to.
//
// Studying the summary table (and T actions in its '>' column) closely, we
// only need to escape in states 43, 44, 49, 51 and 52. State 43 is at the
// start of the comment data. State 52 is after a '!'. The other three states
// are after a '-'.
//
// Our algorithm is thus to escape every '&' and to escape '>' if and only if:
//   - The '>' is after a '!' or '-' (in the unescaped data) or
//   - The '>' is at the start of the comment data (after the opening "<!--").
//
// Only ASCII characters are compared, so working on UTF-16 code units gives
// the same result as Go's byte-wise loop.
function escapeComment(s: string): string {
  // Loop:
  //   - Grow j such that s[i:j] does not need escaping.
  //   - If s[j] does need escaping, output s[i:j] and an escaped s[j],
  //     resetting i and j to point past that s[j] byte.
  let out = "";
  let i = 0;
  for (let j = 0; j < s.length; j++) {
    let escaped: string;
    switch (s[j]) {
      case "&":
        escaped = "&amp;";
        break;

      case ">":
        if (j > 0) {
          const prev = s[j - 1];
          if (prev !== "!" && prev !== "-") {
            continue;
          }
        }
        escaped = "&gt;";
        break;

      default:
        continue;
    }

    if (i < j) {
      out += s.slice(i, j);
    }
    out += escaped;
    i = j + 1;
  }

  if (i < s.length) {
    out += s.slice(i);
  }
  return out;
}

// escapeCommentString is to escapeString as escapeComment is to escape.
export function escapeCommentString(s: string): string {
  if (!/[&>]/.test(s)) {
    return s;
  }
  return escapeComment(s);
}

const escapedChars = /[&'<>"\r]/;

// escape escapes the characters that must be escaped in text and attribute
// values.
export function escape(s: string): string {
  let out = "";
  let rest = s;
  let i = rest.search(escapedChars);
  while (i !== -1) {
    out += rest.slice(0, i);
    let esc: string;
    switch (rest[i]) {
      case "&":
        esc = "&amp;";
        break;
      case "'":
        // "&#39;" is shorter than "&apos;" and apos was not in HTML until HTML5.
        esc = "&#39;";
        break;
      case "<":
        esc = "&lt;";
        break;
      case ">":
        esc = "&gt;";
        break;
      case '"':
        // "&#34;" is shorter than "&quot;".
        esc = "&#34;";
        break;
      case "\r":
        esc = "&#13;";
        break;
      default:
        throw new Error("html: unrecognized escape character");
    }
    rest = rest.slice(i + 1);
    out += esc;
    i = rest.search(escapedChars);
  }
  return out + rest;
}

// escapeString escapes special characters like "<" to become "&lt;". It
// escapes only five such characters: <, >, &, ' and ".
// unescapeString(escapeString(s)) == s always holds, but the converse isn't
// always true.
export function escapeString(s: string): string {
  if (!escapedChars.test(s)) {
    return s;
  }
  return escape(s);
}

// unescapeString unescapes entities like "&lt;" to become "<". It unescapes a
// larger range of entities than escapeString escapes. For example, "&aacute;"
// unescapes to "á", as does "&#225;" and "&xE1;".
// unescapeString(escapeString(s)) == s always holds, but the converse isn't
// always true.
export function unescapeString(s: string): string {
  if (!s.includes("&")) {
    return s;
  }
  return decodeUTF8(unescape(encodeUTF8(s), false));
}

// encodeUTF8 converts a Go string (here, a JavaScript string) to the bytes the
// tokenizer works on.
export function encodeUTF8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// decodeUTF8 converts tokenizer bytes back to a string. The BOM is kept
// (ignoreBOM), so U+FEFF in the input survives as it does in Go.
const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });

export function decodeUTF8(b: Uint8Array): string {
  return utf8Decoder.decode(b);
}
