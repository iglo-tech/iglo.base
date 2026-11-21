// Upstream: tools/inflector/inflector.go
//
// The Go RE2 patterns are translated by hand to JS RegExp. Both use ASCII
// \w ([0-9A-Za-z_]) and \W, so the classes below mean the same in both.
// Characters are Unicode code points, as Go's runes. Sanitize takes a JS
// RegExp pattern.

// columnifyRemoveRegex: Go `[^\w\.\*\-\_\@\#]+`. Every non-ASCII
// character is outside the class; without the u flag JS removes both halves
// of a surrogate pair, which removes the same character.
const columnifyRemoveRegex = /[^\w.*\-_@#]+/g;

// snakecaseSplitRegex: Go `[\W_]+`
const snakecaseSplitRegex = /[\W_]+/;

// unicode.IsSpace
const goSpace = String.raw`\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
const trimSpaceRegex = new RegExp(`^[${goSpace}]+|[${goSpace}]+$`, "g");

const letterRegex = /^\p{L}$/u;
const numberRegex = /^\p{N}$/u;

// strings.TrimSpace (unicode.IsSpace, which unlike JS trim() includes
// U+0085 and excludes U+FEFF)
function trimSpace(s: string): string {
  return s.replaceAll(trimSpaceRegex, "");
}

// Greek letters with iota subscript, whose simple uppercase mapping (the
// one Go's unicode.ToUpper uses) is a titlecase letter, while JS's full
// mapping expands them to two characters
function greekIotaUpper(cp: number): number | undefined {
  if (
    (cp >= 0x1f_80 && cp <= 0x1f_87) ||
    (cp >= 0x1f_90 && cp <= 0x1f_97) ||
    (cp >= 0x1f_a0 && cp <= 0x1f_a7)
  ) {
    return cp + 8;
  }
  switch (cp) {
    case 0x1f_b3:
      return 0x1f_bc;
    case 0x1f_c3:
      return 0x1f_cc;
    case 0x1f_f3:
      return 0x1f_fc;
  }
  return undefined;
}

// unicode.ToUpper: the simple (one to one) uppercase mapping. JS only has
// the full mapping; where it expands to several characters (ß, ŉ, ﬀ ...)
// Go's simple mapping keeps the character, except for the Greek letters
// above.
export function toUpperRune(ch: string): string {
  const upper = ch.toUpperCase();
  if ([...upper].length === 1) {
    return upper;
  }
  const greek = greekIotaUpper(ch.codePointAt(0) as number);
  return greek === undefined ? ch : String.fromCodePoint(greek);
}

// UcFirst converts the first character of a string into uppercase.
export function ucFirst(str: string): string {
  if (str === "") {
    return "";
  }
  const first = String.fromCodePoint(str.codePointAt(0) as number);
  return toUpperRune(first) + str.slice(first.length);
}

// Columnify strips invalid db identifier characters.
export function columnify(str: string): string {
  return str.replaceAll(columnifyRemoveRegex, "");
}

// Sentenize converts and normalizes a string into a sentence.
export function sentenize(str: string): string {
  str = trimSpace(str);
  if (str === "") {
    return "";
  }
  str = ucFirst(str);
  // Go compares the last byte; '.', '?' and '!' are ASCII, so the last
  // UTF-16 unit gives the same answer
  const lastChar = str.at(-1);
  if (lastChar !== "." && lastChar !== "?" && lastChar !== "!") {
    return str + ".";
  }
  return str;
}

// Sanitize removes all characters matching the JS RegExp removePattern.
// Throws if the pattern is not a valid regular expression.
export function sanitize(str: string, removePattern: string): string {
  return str.replaceAll(new RegExp(removePattern, "g"), "");
}

// Snakecase removes all non word characters and converts any english text
// into snake case. "ABBREVIATIONS" are preserved, eg. "myTestDB" becomes
// "my_test_db".
export function snakecase(str: string): string {
  let result = "";
  // split at any non word character and underscore; the words are ASCII
  // letters and digits only
  for (const word of str.split(snakecaseSplitRegex)) {
    if (word === "") {
      continue;
    }
    if (result.length > 0) {
      result += "_";
    }
    for (let i = 0; i < word.length; i++) {
      const c = word[i] as string;
      // an uppercase letter that does not follow another uppercase letter
      if (isASCIIUpper(c) && i > 0 && !isASCIIUpper(word[i - 1] as string)) {
        result += "_";
      }
      result += c;
    }
  }
  return result.toLowerCase();
}

function isASCIIUpper(c: string): boolean {
  return c >= "A" && c <= "Z";
}

// Camelize converts the provided string to its "CamelCased" version (non
// alphanumeric characters are removed), eg. "send_email" becomes
// "SendEmail".
export function camelize(str: string): string {
  let result = "";
  let isPrevSpecial = false;
  for (const c of str) {
    if (!letterRegex.test(c) && !numberRegex.test(c)) {
      isPrevSpecial = true;
      continue;
    }
    if (isPrevSpecial || result.length === 0) {
      isPrevSpecial = false;
      result += toUpperRune(c);
    } else {
      result += c;
    }
  }
  return result;
}
