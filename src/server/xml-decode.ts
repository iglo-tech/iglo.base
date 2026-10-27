// Upstream: the subset of Go's encoding/xml Unmarshal that Event.BindBody
// reaches with an XML body: the root element's child elements are matched to
// struct fields by their `xml` tag (or Go field name), with xml.copyValue's
// scalar rules. The document is tokenized like the strict Decoder, so
// malformed syntax, names and attribute values are errors, but attribute
// values are dropped: namespaces and the ",attr"/",chardata" tag options are
// not supported. No upstream endpoint binds XML.

import {
  NumError,
  parseGoFloat,
  structValue,
  type FieldType,
  type StructField,
  type StructType,
} from "@/server/unmarshal-request-data";
import { decodeUTF8Bytes, setOwn } from "@/server/json-decode";

interface XmlElement {
  name: string;
  children: XmlElement[];
  text: string;
}

export class XmlSyntaxError extends Error {
  constructor(message: string) {
    super(`XML syntax error: ${message}`);
    this.name = "XmlSyntaxError";
  }
}

// the predefined entities; strict mode knows no others
const entity: Record<string, string> = { lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' };

// xml isNameByte
function isNameByte(c: string): boolean {
  return /^[A-Za-z0-9_:.-]$/.test(c);
}

// characters readName takes: name bytes and any non-ASCII character
function isNameChar(c: string): boolean {
  return isNameByte(c) || c >= "\u0080";
}

// unicode.Is for the [lo, hi, stride] triples below
function inTable(table: readonly number[], r: number): boolean {
  for (let k = 0; k < table.length; k += 3) {
    const lo = table[k] as number;
    const hi = table[k + 1] as number;
    if (r >= lo && r <= hi) {
      return (r - lo) % (table[k + 2] as number) === 0;
    }
  }
  return false;
}

// xml isName: the first character from the first table, the rest from
// either; invalid UTF-8 (a lone surrogate from decodeUTF8Bytes) fails
function isName(s: string): boolean {
  let firstChar = true;
  for (const ch of s) {
    const r = ch.codePointAt(0) as number;
    if (!inTable(first, r) && (firstChar || !inTable(second, r))) {
      return false;
    }
    firstChar = false;
  }
  return !firstChar;
}

// xml isInCharacterRange: the Char production of XML 1.0, section 2.2
function isInCharacterRange(r: number): boolean {
  return (
    r === 0x09 ||
    r === 0x0a ||
    r === 0x0d ||
    (r >= 0x20 && r <= 0xd7ff) ||
    (r >= 0xe000 && r <= 0xfffd) ||
    (r >= 0x10000 && r <= 0x10ffff)
  );
}

// Decoder.text (strict mode) for one run of element text, a CDATA section
// or a quoted attribute value: entity and character references are
// resolved (outside CDATA), "\r\n" and "\r" become "\n", and the result
// must be valid UTF-8 holding only XML characters.
function decodeText(raw: string, cdata: boolean, quoted = false): string {
  if (!cdata && !quoted && raw.includes("]]>")) {
    throw new XmlSyntaxError("unescaped ]]> not in CDATA section");
  }
  let out = "";
  let prev = "";
  for (let i = 0; i < raw.length;) {
    const c = raw[i] as string;
    if (c === "&" && !cdata) {
      let j = i + 1;
      let text: string | undefined;
      if (raw[j] === "#") {
        j++;
        let base = 10;
        if (raw[j] === "x") {
          base = 16;
          j++;
        }
        const start = j;
        while (j < raw.length && (base === 16 ? /[0-9a-fA-F]/ : /[0-9]/).test(raw[j] as string)) {
          j++;
        }
        if (raw[j] === ";") {
          const digits = raw.slice(start, j);
          if (digits !== "") {
            const n = BigInt(base === 16 ? `0x${digits}` : digits);
            if (n <= 0x10ffffn) {
              // string(rune(n)): surrogate halves become U+FFFD
              const r = Number(n);
              text = r >= 0xd800 && r <= 0xdfff ? "\ufffd" : String.fromCodePoint(r);
            }
          }
        }
      } else {
        while (j < raw.length && isNameChar(raw[j] as string)) {
          j++;
        }
        if (raw[j] === ";") {
          text = Object.hasOwn(entity, raw.slice(i + 1, j))
            ? entity[raw.slice(i + 1, j)]
            : undefined;
        }
      }
      if (text === undefined) {
        const ent = raw[j] === ";" ? raw.slice(i, j + 1) : `${raw.slice(i, j)} (no semicolon)`;
        throw new XmlSyntaxError(`invalid character entity ${ent}`);
      }
      out += text;
      prev = "";
      i = j + 1;
      continue;
    }
    // We must rewrite unescaped \r and \r\n into \n.
    if (c === "\r") {
      out += "\n";
    } else if (!(prev === "\r" && c === "\n")) {
      out += c;
    }
    prev = c;
    i++;
  }

  // Inspect each rune for being a disallowed character.
  for (const ch of out) {
    const r = ch.codePointAt(0) as number;
    if (r >= 0xd800 && r <= 0xdfff) {
      throw new XmlSyntaxError("invalid UTF-8");
    }
    if (!isInCharacterRange(r)) {
      throw new XmlSyntaxError(
        `illegal character code U+${r.toString(16).toUpperCase().padStart(4, "0")}`,
      );
    }
  }
  return out;
}

// procInst: the value of a param="..." pseudo-attribute ("" if none)
function procInst(param: string, s: string): string {
  const key = `${param}=`;
  let i = 0;
  let sep = "";
  while (i < s.length) {
    const sub = s.slice(i);
    const k = sub.indexOf(key);
    if (k < 0 || key.length + k >= sub.length) {
      return "";
    }
    i += key.length + k + 1;
    const c = sub[key.length + k] as string;
    if (c === "'" || c === '"') {
      sep = c;
      break;
    }
  }
  if (sep === "") {
    return "";
  }
  const j = s.indexOf(sep, i);
  return j < 0 ? "" : s.slice(i, j);
}

const eof = (): XmlSyntaxError => new XmlSyntaxError("unexpected EOF");

type Token =
  | { kind: "start"; name: string; empty: boolean }
  | { kind: "end"; name: string }
  | { kind: "text"; text: string }
  | { kind: "other" };

// Decoder.rawToken in strict mode (no CharsetReader), over the text from
// decodeUTF8Bytes. Attribute values are checked and dropped. Returns
// undefined at the end of the input.
function tokenizer(src: string): () => Token | undefined {
  let i = 0;
  const mustgetc = (): string => {
    if (i >= src.length) {
      throw eof();
    }
    return src[i++] as string;
  };
  // Decoder.space
  const space = (): void => {
    while (i < src.length && " \r\n\t".includes(src[i] as string)) {
      i++;
    }
  };
  // Decoder.name: undefined when no name starts here
  const name = (): string | undefined => {
    const start = i;
    while (i < src.length && isNameChar(src[i] as string)) {
      i++;
    }
    if (i === start) {
      if (i >= src.length) {
        throw eof();
      }
      return undefined;
    }
    if (i >= src.length) {
      throw eof(); // readName reads the byte that ends the name
    }
    const s = src.slice(start, i);
    if (!isName(s)) {
      throw new XmlSyntaxError(`invalid XML name: ${s}`);
    }
    return s;
  };
  // Decoder.nsname: at most one colon
  const nsname = (): string | undefined => {
    const s = name();
    return s === undefined || s.split(":").length > 2 ? undefined : s;
  };

  return () => {
    if (i >= src.length) {
      return undefined;
    }
    if (src[i] !== "<") {
      const next = src.indexOf("<", i);
      const end = next < 0 ? src.length : next;
      const text = decodeText(src.slice(i, end), false);
      i = end;
      return { kind: "text", text };
    }
    i++;
    let b = mustgetc();
    switch (b) {
      case "/": {
        const end = nsname();
        if (end === undefined) {
          throw new XmlSyntaxError("expected element name after </");
        }
        space();
        if (mustgetc() !== ">") {
          throw new XmlSyntaxError(`invalid characters between </${end} and >`);
        }
        return { kind: "end", name: end };
      }

      case "?": {
        const target = name();
        if (target === undefined) {
          throw new XmlSyntaxError("expected target name after <?");
        }
        space();
        const start = i;
        let b0 = "";
        for (;;) {
          b = mustgetc();
          if (b0 === "?" && b === ">") {
            break;
          }
          b0 = b;
        }
        if (target === "xml") {
          const content = src.slice(start, i - 2);
          const ver = procInst("version", content);
          if (ver !== "" && ver !== "1.0") {
            throw new Error(
              `xml: unsupported version ${JSON.stringify(ver)}; only version 1.0 is supported`,
            );
          }
          const enc = procInst("encoding", content);
          if (enc !== "" && enc.toLowerCase() !== "utf-8") {
            throw new Error(
              `xml: encoding ${JSON.stringify(enc)} declared but Decoder.CharsetReader is nil`,
            );
          }
        }
        return { kind: "other" };
      }

      case "!": {
        b = mustgetc();
        if (b === "-") {
          if (mustgetc() !== "-") {
            throw new XmlSyntaxError("invalid sequence <!- not part of <!--");
          }
          // the comment ends at the first "--", which must be followed by ">"
          const dashes = src.indexOf("--", i);
          if (dashes < 0 || dashes + 2 >= src.length) {
            throw eof();
          }
          if (src[dashes + 2] !== ">") {
            throw new XmlSyntaxError('invalid sequence "--" not allowed in comments');
          }
          i = dashes + 3;
          return { kind: "other" };
        }
        if (b === "[") {
          for (const c of "CDATA[") {
            if (mustgetc() !== c) {
              throw new XmlSyntaxError("invalid <![ sequence");
            }
          }
          const end = src.indexOf("]]>", i);
          if (end < 0) {
            throw new XmlSyntaxError("unexpected EOF in CDATA section");
          }
          const text = decodeText(src.slice(i, end), true);
          i = end + 3;
          return { kind: "text", text };
        }
        // a directive: up to the ">" that closes it, outside quotes, with
        // nested <...> and comments
        let inquote = "";
        let depth = 0;
        for (;;) {
          b = mustgetc();
          if (inquote === "" && b === ">" && depth === 0) {
            break;
          }
          if (b === inquote) {
            inquote = "";
          } else if (inquote !== "") {
            // inside quotes
          } else if (b === "'" || b === '"') {
            inquote = b;
          } else if (b === ">") {
            depth--;
          } else if (b === "<") {
            if (src.startsWith("!--", i)) {
              i += 3;
              const close = src.indexOf("-->", i);
              if (close < 0) {
                throw eof();
              }
              i = close + 3;
            } else {
              // Go reads the bytes that did not match "!--" again
              depth++;
            }
          }
        }
        return { kind: "other" };
      }
    }

    // a start element
    i--;
    const start = nsname();
    if (start === undefined) {
      throw new XmlSyntaxError("expected element name after <");
    }
    for (;;) {
      space();
      b = mustgetc();
      if (b === "/") {
        if (mustgetc() !== ">") {
          throw new XmlSyntaxError("expected /> in element");
        }
        return { kind: "start", name: start, empty: true };
      }
      if (b === ">") {
        return { kind: "start", name: start, empty: false };
      }
      i--;
      if (nsname() === undefined) {
        throw new XmlSyntaxError("expected attribute name in element");
      }
      space();
      if (mustgetc() !== "=") {
        throw new XmlSyntaxError("attribute name without = in element");
      }
      space();
      const quote = mustgetc();
      if (quote !== '"' && quote !== "'") {
        throw new XmlSyntaxError("unquoted or missing attribute value in element");
      }
      let end = i;
      while (end < src.length && src[end] !== quote) {
        if (src[end] === "<") {
          throw new XmlSyntaxError("unescaped < inside quoted string");
        }
        end++;
      }
      decodeText(src.slice(i, end), false, true);
      i = end < src.length ? end + 1 : end;
    }
  };
}

// parses the first element of the document, as Decoder.Decode reads it:
// anything before it is checked and skipped, anything after it is not read
function parseDocument(src: string): XmlElement {
  const next = tokenizer(src);

  const element = (name: string, empty: boolean): XmlElement => {
    const el: XmlElement = { name, children: [], text: "" };
    if (empty) {
      return el;
    }
    for (;;) {
      const tok = next();
      if (tok === undefined) {
        throw new XmlSyntaxError("unexpected EOF");
      }
      switch (tok.kind) {
        case "start":
          el.children.push(element(tok.name, tok.empty));
          break;
        case "end":
          if (tok.name !== el.name) {
            throw new XmlSyntaxError(`element <${el.name}> closed by </${tok.name}>`);
          }
          return el;
        case "text":
          el.text += tok.text;
          break;
      }
    }
  };

  for (;;) {
    const tok = next();
    if (tok === undefined) {
      throw new Error("EOF");
    }
    if (tok.kind === "start") {
      return element(tok.name, tok.empty);
    }
    if (tok.kind === "end") {
      throw new XmlSyntaxError(`unexpected end element </${tok.name}>`);
    }
  }
}

// xml first: [lo, hi, stride] triples
const first: readonly number[] = [
  0x003a, 0x003a, 1, 0x0041, 0x005a, 1, 0x005f, 0x005f, 1, 0x0061, 0x007a, 1, 0x00c0, 0x00d6, 1,
  0x00d8, 0x00f6, 1, 0x00f8, 0x00ff, 1, 0x0100, 0x0131, 1, 0x0134, 0x013e, 1, 0x0141, 0x0148, 1,
  0x014a, 0x017e, 1, 0x0180, 0x01c3, 1, 0x01cd, 0x01f0, 1, 0x01f4, 0x01f5, 1, 0x01fa, 0x0217, 1,
  0x0250, 0x02a8, 1, 0x02bb, 0x02c1, 1, 0x0386, 0x0386, 1, 0x0388, 0x038a, 1, 0x038c, 0x038c, 1,
  0x038e, 0x03a1, 1, 0x03a3, 0x03ce, 1, 0x03d0, 0x03d6, 1, 0x03da, 0x03e0, 2, 0x03e2, 0x03f3, 1,
  0x0401, 0x040c, 1, 0x040e, 0x044f, 1, 0x0451, 0x045c, 1, 0x045e, 0x0481, 1, 0x0490, 0x04c4, 1,
  0x04c7, 0x04c8, 1, 0x04cb, 0x04cc, 1, 0x04d0, 0x04eb, 1, 0x04ee, 0x04f5, 1, 0x04f8, 0x04f9, 1,
  0x0531, 0x0556, 1, 0x0559, 0x0559, 1, 0x0561, 0x0586, 1, 0x05d0, 0x05ea, 1, 0x05f0, 0x05f2, 1,
  0x0621, 0x063a, 1, 0x0641, 0x064a, 1, 0x0671, 0x06b7, 1, 0x06ba, 0x06be, 1, 0x06c0, 0x06ce, 1,
  0x06d0, 0x06d3, 1, 0x06d5, 0x06d5, 1, 0x06e5, 0x06e6, 1, 0x0905, 0x0939, 1, 0x093d, 0x093d, 1,
  0x0958, 0x0961, 1, 0x0985, 0x098c, 1, 0x098f, 0x0990, 1, 0x0993, 0x09a8, 1, 0x09aa, 0x09b0, 1,
  0x09b2, 0x09b2, 1, 0x09b6, 0x09b9, 1, 0x09dc, 0x09dd, 1, 0x09df, 0x09e1, 1, 0x09f0, 0x09f1, 1,
  0x0a05, 0x0a0a, 1, 0x0a0f, 0x0a10, 1, 0x0a13, 0x0a28, 1, 0x0a2a, 0x0a30, 1, 0x0a32, 0x0a33, 1,
  0x0a35, 0x0a36, 1, 0x0a38, 0x0a39, 1, 0x0a59, 0x0a5c, 1, 0x0a5e, 0x0a5e, 1, 0x0a72, 0x0a74, 1,
  0x0a85, 0x0a8b, 1, 0x0a8d, 0x0a8d, 1, 0x0a8f, 0x0a91, 1, 0x0a93, 0x0aa8, 1, 0x0aaa, 0x0ab0, 1,
  0x0ab2, 0x0ab3, 1, 0x0ab5, 0x0ab9, 1, 0x0abd, 0x0ae0, 35, 0x0b05, 0x0b0c, 1, 0x0b0f, 0x0b10, 1,
  0x0b13, 0x0b28, 1, 0x0b2a, 0x0b30, 1, 0x0b32, 0x0b33, 1, 0x0b36, 0x0b39, 1, 0x0b3d, 0x0b3d, 1,
  0x0b5c, 0x0b5d, 1, 0x0b5f, 0x0b61, 1, 0x0b85, 0x0b8a, 1, 0x0b8e, 0x0b90, 1, 0x0b92, 0x0b95, 1,
  0x0b99, 0x0b9a, 1, 0x0b9c, 0x0b9c, 1, 0x0b9e, 0x0b9f, 1, 0x0ba3, 0x0ba4, 1, 0x0ba8, 0x0baa, 1,
  0x0bae, 0x0bb5, 1, 0x0bb7, 0x0bb9, 1, 0x0c05, 0x0c0c, 1, 0x0c0e, 0x0c10, 1, 0x0c12, 0x0c28, 1,
  0x0c2a, 0x0c33, 1, 0x0c35, 0x0c39, 1, 0x0c60, 0x0c61, 1, 0x0c85, 0x0c8c, 1, 0x0c8e, 0x0c90, 1,
  0x0c92, 0x0ca8, 1, 0x0caa, 0x0cb3, 1, 0x0cb5, 0x0cb9, 1, 0x0cde, 0x0cde, 1, 0x0ce0, 0x0ce1, 1,
  0x0d05, 0x0d0c, 1, 0x0d0e, 0x0d10, 1, 0x0d12, 0x0d28, 1, 0x0d2a, 0x0d39, 1, 0x0d60, 0x0d61, 1,
  0x0e01, 0x0e2e, 1, 0x0e30, 0x0e30, 1, 0x0e32, 0x0e33, 1, 0x0e40, 0x0e45, 1, 0x0e81, 0x0e82, 1,
  0x0e84, 0x0e84, 1, 0x0e87, 0x0e88, 1, 0x0e8a, 0x0e8d, 3, 0x0e94, 0x0e97, 1, 0x0e99, 0x0e9f, 1,
  0x0ea1, 0x0ea3, 1, 0x0ea5, 0x0ea7, 2, 0x0eaa, 0x0eab, 1, 0x0ead, 0x0eae, 1, 0x0eb0, 0x0eb0, 1,
  0x0eb2, 0x0eb3, 1, 0x0ebd, 0x0ebd, 1, 0x0ec0, 0x0ec4, 1, 0x0f40, 0x0f47, 1, 0x0f49, 0x0f69, 1,
  0x10a0, 0x10c5, 1, 0x10d0, 0x10f6, 1, 0x1100, 0x1100, 1, 0x1102, 0x1103, 1, 0x1105, 0x1107, 1,
  0x1109, 0x1109, 1, 0x110b, 0x110c, 1, 0x110e, 0x1112, 1, 0x113c, 0x1140, 2, 0x114c, 0x1150, 2,
  0x1154, 0x1155, 1, 0x1159, 0x1159, 1, 0x115f, 0x1161, 1, 0x1163, 0x1169, 2, 0x116d, 0x116e, 1,
  0x1172, 0x1173, 1, 0x1175, 0x119e, 41, 0x11a8, 0x11ab, 3, 0x11ae, 0x11af, 1, 0x11b7, 0x11b8, 1,
  0x11ba, 0x11ba, 1, 0x11bc, 0x11c2, 1, 0x11eb, 0x11f0, 5, 0x11f9, 0x11f9, 1, 0x1e00, 0x1e9b, 1,
  0x1ea0, 0x1ef9, 1, 0x1f00, 0x1f15, 1, 0x1f18, 0x1f1d, 1, 0x1f20, 0x1f45, 1, 0x1f48, 0x1f4d, 1,
  0x1f50, 0x1f57, 1, 0x1f59, 0x1f5b, 2, 0x1f5d, 0x1f5d, 1, 0x1f5f, 0x1f7d, 1, 0x1f80, 0x1fb4, 1,
  0x1fb6, 0x1fbc, 1, 0x1fbe, 0x1fbe, 1, 0x1fc2, 0x1fc4, 1, 0x1fc6, 0x1fcc, 1, 0x1fd0, 0x1fd3, 1,
  0x1fd6, 0x1fdb, 1, 0x1fe0, 0x1fec, 1, 0x1ff2, 0x1ff4, 1, 0x1ff6, 0x1ffc, 1, 0x2126, 0x2126, 1,
  0x212a, 0x212b, 1, 0x212e, 0x212e, 1, 0x2180, 0x2182, 1, 0x3007, 0x3007, 1, 0x3021, 0x3029, 1,
  0x3041, 0x3094, 1, 0x30a1, 0x30fa, 1, 0x3105, 0x312c, 1, 0x4e00, 0x9fa5, 1, 0xac00, 0xd7a3, 1,
];
// xml second: [lo, hi, stride] triples
const second: readonly number[] = [
  0x002d, 0x002e, 1, 0x0030, 0x0039, 1, 0x00b7, 0x00b7, 1, 0x02d0, 0x02d1, 1, 0x0300, 0x0345, 1,
  0x0360, 0x0361, 1, 0x0387, 0x0387, 1, 0x0483, 0x0486, 1, 0x0591, 0x05a1, 1, 0x05a3, 0x05b9, 1,
  0x05bb, 0x05bd, 1, 0x05bf, 0x05bf, 1, 0x05c1, 0x05c2, 1, 0x05c4, 0x0640, 124, 0x064b, 0x0652, 1,
  0x0660, 0x0669, 1, 0x0670, 0x0670, 1, 0x06d6, 0x06dc, 1, 0x06dd, 0x06df, 1, 0x06e0, 0x06e4, 1,
  0x06e7, 0x06e8, 1, 0x06ea, 0x06ed, 1, 0x06f0, 0x06f9, 1, 0x0901, 0x0903, 1, 0x093c, 0x093c, 1,
  0x093e, 0x094c, 1, 0x094d, 0x094d, 1, 0x0951, 0x0954, 1, 0x0962, 0x0963, 1, 0x0966, 0x096f, 1,
  0x0981, 0x0983, 1, 0x09bc, 0x09bc, 1, 0x09be, 0x09bf, 1, 0x09c0, 0x09c4, 1, 0x09c7, 0x09c8, 1,
  0x09cb, 0x09cd, 1, 0x09d7, 0x09d7, 1, 0x09e2, 0x09e3, 1, 0x09e6, 0x09ef, 1, 0x0a02, 0x0a3c, 58,
  0x0a3e, 0x0a3f, 1, 0x0a40, 0x0a42, 1, 0x0a47, 0x0a48, 1, 0x0a4b, 0x0a4d, 1, 0x0a66, 0x0a6f, 1,
  0x0a70, 0x0a71, 1, 0x0a81, 0x0a83, 1, 0x0abc, 0x0abc, 1, 0x0abe, 0x0ac5, 1, 0x0ac7, 0x0ac9, 1,
  0x0acb, 0x0acd, 1, 0x0ae6, 0x0aef, 1, 0x0b01, 0x0b03, 1, 0x0b3c, 0x0b3c, 1, 0x0b3e, 0x0b43, 1,
  0x0b47, 0x0b48, 1, 0x0b4b, 0x0b4d, 1, 0x0b56, 0x0b57, 1, 0x0b66, 0x0b6f, 1, 0x0b82, 0x0b83, 1,
  0x0bbe, 0x0bc2, 1, 0x0bc6, 0x0bc8, 1, 0x0bca, 0x0bcd, 1, 0x0bd7, 0x0bd7, 1, 0x0be7, 0x0bef, 1,
  0x0c01, 0x0c03, 1, 0x0c3e, 0x0c44, 1, 0x0c46, 0x0c48, 1, 0x0c4a, 0x0c4d, 1, 0x0c55, 0x0c56, 1,
  0x0c66, 0x0c6f, 1, 0x0c82, 0x0c83, 1, 0x0cbe, 0x0cc4, 1, 0x0cc6, 0x0cc8, 1, 0x0cca, 0x0ccd, 1,
  0x0cd5, 0x0cd6, 1, 0x0ce6, 0x0cef, 1, 0x0d02, 0x0d03, 1, 0x0d3e, 0x0d43, 1, 0x0d46, 0x0d48, 1,
  0x0d4a, 0x0d4d, 1, 0x0d57, 0x0d57, 1, 0x0d66, 0x0d6f, 1, 0x0e31, 0x0e31, 1, 0x0e34, 0x0e3a, 1,
  0x0e46, 0x0e46, 1, 0x0e47, 0x0e4e, 1, 0x0e50, 0x0e59, 1, 0x0eb1, 0x0eb1, 1, 0x0eb4, 0x0eb9, 1,
  0x0ebb, 0x0ebc, 1, 0x0ec6, 0x0ec6, 1, 0x0ec8, 0x0ecd, 1, 0x0ed0, 0x0ed9, 1, 0x0f18, 0x0f19, 1,
  0x0f20, 0x0f29, 1, 0x0f35, 0x0f39, 2, 0x0f3e, 0x0f3f, 1, 0x0f71, 0x0f84, 1, 0x0f86, 0x0f8b, 1,
  0x0f90, 0x0f95, 1, 0x0f97, 0x0f97, 1, 0x0f99, 0x0fad, 1, 0x0fb1, 0x0fb7, 1, 0x0fb9, 0x0fb9, 1,
  0x20d0, 0x20dc, 1, 0x20e1, 0x3005, 3876, 0x302a, 0x302f, 1, 0x3031, 0x3035, 1, 0x3099, 0x309a, 1,
  0x309d, 0x309e, 1, 0x30fc, 0x30fe, 1,
];

function isExported(name: string): boolean {
  return /\p{Lu}/u.test(String.fromCodePoint(name.codePointAt(0) ?? 0));
}

// xml.Unmarshal into a struct described by type.
export function unmarshalXML(
  body: Uint8Array,
  dst: Record<string, unknown>,
  type: StructType,
): void {
  fillStruct(parseDocument(decodeUTF8Bytes(body)), dst, type);
}

interface XmlField {
  field: StructField;
  // the object that holds the field (embedded structs are stored under their type name)
  holder: (dst: Record<string, unknown>) => Record<string, unknown>;
}

function xmlFields(type: StructType): XmlField[] {
  const out: XmlField[] = [];
  for (const field of type.fields) {
    const tag = field.tags?.xml ?? "";
    if (tag === "-") {
      continue;
    }
    if (field.embedded && typeof field.type === "object" && field.type.kind === "struct") {
      for (const inner of xmlFields(field.type)) {
        out.push({ ...inner, holder: (dst) => inner.holder(structValue(dst, field.name)) });
      }
      continue;
    }
    if (isExported(field.name)) {
      out.push({ field, holder: (dst) => dst });
    }
  }
  return out;
}

function fillStruct(el: XmlElement, root: Record<string, unknown>, type: StructType): void {
  const fields = xmlFields(type);
  for (const child of el.children) {
    const found = fields.find(
      (f) => (f.field.tags?.xml?.split(",")[0] || f.field.name) === child.name,
    );
    if (!found) {
      continue;
    }
    const { field } = found;
    const dst = found.holder(root);
    let t: FieldType = field.type;
    while (typeof t === "object" && t.kind === "pointer") {
      t = t.elem;
    }
    if (typeof t === "object" && t.kind === "slice") {
      const list = Array.isArray(dst[field.name]) ? (dst[field.name] as unknown[]) : [];
      list.push(elementValue(child, t.elem));
      setOwn(dst, field.name, list);
    } else {
      setOwn(dst, field.name, elementValue(child, t, dst[field.name]));
    }
  }
}

const bits: Record<string, number> = {
  int8: 8,
  int16: 16,
  int32: 32,
  uint8: 8,
  uint16: 16,
  uint32: 32,
};

function elementValue(el: XmlElement, t: FieldType, current?: unknown): unknown {
  while (typeof t === "object" && t.kind === "pointer") {
    t = t.elem;
  }
  if (typeof t === "object") {
    if (t.kind === "struct") {
      const target =
        typeof current === "object" && current !== null ? (current as Record<string, unknown>) : {};
      fillStruct(el, target, t);
      return target;
    }
    if (t.kind === "text") {
      return t.unmarshalText(el.text);
    }
    return undefined; // nested slices are not supported
  }
  // xml copyValue: empty text is the zero value, other text is trimmed
  // and parsed with strconv (so whitespace-only text is an error)
  const text = el.text;
  const trimmed = trimSpace(text);
  switch (t) {
    case "string":
    case "any":
      return text;
    case "bool":
      if (text === "") {
        return false;
      }
      if (["1", "t", "T", "true", "TRUE", "True"].includes(trimmed)) {
        return true;
      }
      if (["0", "f", "F", "false", "FALSE", "False"].includes(trimmed)) {
        return false;
      }
      throw new NumError("ParseBool", trimmed, "invalid syntax");
    case "float32":
      return text === "" ? 0 : Math.fround(parseGoFloat(trimmed, 32));
    case "float64":
      return text === "" ? 0 : parseGoFloat(trimmed, 64);
    default: {
      if (text === "") {
        return 0;
      }
      // strconv.ParseInt / ParseUint with base 10
      const unsigned = t.startsWith("u");
      if (!(unsigned ? /^[0-9]+$/ : /^[+-]?[0-9]+$/).test(trimmed)) {
        throw new NumError(unsigned ? "ParseUint" : "ParseInt", trimmed, "invalid syntax");
      }
      const n = BigInt(trimmed);
      const size = BigInt(bits[t] ?? 64);
      const [min, max] = unsigned
        ? [0n, 2n ** size - 1n]
        : [-(2n ** (size - 1n)), 2n ** (size - 1n) - 1n];
      if (n < min || n > max) {
        throw new NumError(unsigned ? "ParseUint" : "ParseInt", trimmed, "value out of range");
      }
      return Number(n);
    }
  }
}

// strings.TrimSpace: unicode.IsSpace characters at both ends
function trimSpace(s: string): string {
  return s.replace(
    /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,
    "",
  );
}
