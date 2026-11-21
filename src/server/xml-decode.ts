// Upstream: the subset of Go's encoding/xml Unmarshal that Event.BindBody
// reaches with an XML body: the root element's child elements are matched to
// struct fields by their `xml` tag (or Go field name), with xml.copyValue's
// scalar rules. The document is tokenized like the strict Decoder, so
// malformed syntax, names and attribute values are errors, but attribute
// values are dropped: namespaces and the ",attr"/",chardata" tag options are
// not supported. No upstream endpoint binds XML.

import { NumError, parseGoFloat, structValue } from "@/server/unmarshal-request-data";
import type {
  FieldType,
  Kind,
  StructDst,
  StructField,
  StructType,
} from "@/server/unmarshal-request-data";
import { decodeUTF8Bytes, setOwn } from "@/server/json-decode";

interface XmlElement {
  name: string;
  children: Array<XmlElement>;
  text: string;
}

export class XmlSyntaxError extends Error {
  constructor(message: string) {
    super(`XML syntax error: ${message}`);
    this.name = "XmlSyntaxError";
  }
}

// the predefined entities; strict mode knows no others
// oxlint-disable-next-line quality/no-known-value-widening -- the lookup takes the entity name as a runtime string, guarded by Object.hasOwn below; the open Record lets it index by string without an assertion
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
function inTable(table: ReadonlyArray<number>, r: number): boolean {
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
    (r >= 0x20 && r <= 0xd7_ff) ||
    (r >= 0xe0_00 && r <= 0xff_fd) ||
    (r >= 0x1_00_00 && r <= 0x10_ff_ff)
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
            if (n <= 0x10_ff_ffn) {
              // string(rune(n)): surrogate halves become U+FFFD
              const r = Number(n);
              text = r >= 0xd8_00 && r <= 0xdf_ff ? "\ufffd" : String.fromCodePoint(r);
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
    if (r >= 0xd8_00 && r <= 0xdf_ff) {
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
        case "other":
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
const first: ReadonlyArray<number> = [
  0x00_3a, 0x00_3a, 1, 0x00_41, 0x00_5a, 1, 0x00_5f, 0x00_5f, 1, 0x00_61, 0x00_7a, 1, 0x00_c0,
  0x00_d6, 1, 0x00_d8, 0x00_f6, 1, 0x00_f8, 0x00_ff, 1, 0x01_00, 0x01_31, 1, 0x01_34, 0x01_3e, 1,
  0x01_41, 0x01_48, 1, 0x01_4a, 0x01_7e, 1, 0x01_80, 0x01_c3, 1, 0x01_cd, 0x01_f0, 1, 0x01_f4,
  0x01_f5, 1, 0x01_fa, 0x02_17, 1, 0x02_50, 0x02_a8, 1, 0x02_bb, 0x02_c1, 1, 0x03_86, 0x03_86, 1,
  0x03_88, 0x03_8a, 1, 0x03_8c, 0x03_8c, 1, 0x03_8e, 0x03_a1, 1, 0x03_a3, 0x03_ce, 1, 0x03_d0,
  0x03_d6, 1, 0x03_da, 0x03_e0, 2, 0x03_e2, 0x03_f3, 1, 0x04_01, 0x04_0c, 1, 0x04_0e, 0x04_4f, 1,
  0x04_51, 0x04_5c, 1, 0x04_5e, 0x04_81, 1, 0x04_90, 0x04_c4, 1, 0x04_c7, 0x04_c8, 1, 0x04_cb,
  0x04_cc, 1, 0x04_d0, 0x04_eb, 1, 0x04_ee, 0x04_f5, 1, 0x04_f8, 0x04_f9, 1, 0x05_31, 0x05_56, 1,
  0x05_59, 0x05_59, 1, 0x05_61, 0x05_86, 1, 0x05_d0, 0x05_ea, 1, 0x05_f0, 0x05_f2, 1, 0x06_21,
  0x06_3a, 1, 0x06_41, 0x06_4a, 1, 0x06_71, 0x06_b7, 1, 0x06_ba, 0x06_be, 1, 0x06_c0, 0x06_ce, 1,
  0x06_d0, 0x06_d3, 1, 0x06_d5, 0x06_d5, 1, 0x06_e5, 0x06_e6, 1, 0x09_05, 0x09_39, 1, 0x09_3d,
  0x09_3d, 1, 0x09_58, 0x09_61, 1, 0x09_85, 0x09_8c, 1, 0x09_8f, 0x09_90, 1, 0x09_93, 0x09_a8, 1,
  0x09_aa, 0x09_b0, 1, 0x09_b2, 0x09_b2, 1, 0x09_b6, 0x09_b9, 1, 0x09_dc, 0x09_dd, 1, 0x09_df,
  0x09_e1, 1, 0x09_f0, 0x09_f1, 1, 0x0a_05, 0x0a_0a, 1, 0x0a_0f, 0x0a_10, 1, 0x0a_13, 0x0a_28, 1,
  0x0a_2a, 0x0a_30, 1, 0x0a_32, 0x0a_33, 1, 0x0a_35, 0x0a_36, 1, 0x0a_38, 0x0a_39, 1, 0x0a_59,
  0x0a_5c, 1, 0x0a_5e, 0x0a_5e, 1, 0x0a_72, 0x0a_74, 1, 0x0a_85, 0x0a_8b, 1, 0x0a_8d, 0x0a_8d, 1,
  0x0a_8f, 0x0a_91, 1, 0x0a_93, 0x0a_a8, 1, 0x0a_aa, 0x0a_b0, 1, 0x0a_b2, 0x0a_b3, 1, 0x0a_b5,
  0x0a_b9, 1, 0x0a_bd, 0x0a_e0, 35, 0x0b_05, 0x0b_0c, 1, 0x0b_0f, 0x0b_10, 1, 0x0b_13, 0x0b_28, 1,
  0x0b_2a, 0x0b_30, 1, 0x0b_32, 0x0b_33, 1, 0x0b_36, 0x0b_39, 1, 0x0b_3d, 0x0b_3d, 1, 0x0b_5c,
  0x0b_5d, 1, 0x0b_5f, 0x0b_61, 1, 0x0b_85, 0x0b_8a, 1, 0x0b_8e, 0x0b_90, 1, 0x0b_92, 0x0b_95, 1,
  0x0b_99, 0x0b_9a, 1, 0x0b_9c, 0x0b_9c, 1, 0x0b_9e, 0x0b_9f, 1, 0x0b_a3, 0x0b_a4, 1, 0x0b_a8,
  0x0b_aa, 1, 0x0b_ae, 0x0b_b5, 1, 0x0b_b7, 0x0b_b9, 1, 0x0c_05, 0x0c_0c, 1, 0x0c_0e, 0x0c_10, 1,
  0x0c_12, 0x0c_28, 1, 0x0c_2a, 0x0c_33, 1, 0x0c_35, 0x0c_39, 1, 0x0c_60, 0x0c_61, 1, 0x0c_85,
  0x0c_8c, 1, 0x0c_8e, 0x0c_90, 1, 0x0c_92, 0x0c_a8, 1, 0x0c_aa, 0x0c_b3, 1, 0x0c_b5, 0x0c_b9, 1,
  0x0c_de, 0x0c_de, 1, 0x0c_e0, 0x0c_e1, 1, 0x0d_05, 0x0d_0c, 1, 0x0d_0e, 0x0d_10, 1, 0x0d_12,
  0x0d_28, 1, 0x0d_2a, 0x0d_39, 1, 0x0d_60, 0x0d_61, 1, 0x0e_01, 0x0e_2e, 1, 0x0e_30, 0x0e_30, 1,
  0x0e_32, 0x0e_33, 1, 0x0e_40, 0x0e_45, 1, 0x0e_81, 0x0e_82, 1, 0x0e_84, 0x0e_84, 1, 0x0e_87,
  0x0e_88, 1, 0x0e_8a, 0x0e_8d, 3, 0x0e_94, 0x0e_97, 1, 0x0e_99, 0x0e_9f, 1, 0x0e_a1, 0x0e_a3, 1,
  0x0e_a5, 0x0e_a7, 2, 0x0e_aa, 0x0e_ab, 1, 0x0e_ad, 0x0e_ae, 1, 0x0e_b0, 0x0e_b0, 1, 0x0e_b2,
  0x0e_b3, 1, 0x0e_bd, 0x0e_bd, 1, 0x0e_c0, 0x0e_c4, 1, 0x0f_40, 0x0f_47, 1, 0x0f_49, 0x0f_69, 1,
  0x10_a0, 0x10_c5, 1, 0x10_d0, 0x10_f6, 1, 0x11_00, 0x11_00, 1, 0x11_02, 0x11_03, 1, 0x11_05,
  0x11_07, 1, 0x11_09, 0x11_09, 1, 0x11_0b, 0x11_0c, 1, 0x11_0e, 0x11_12, 1, 0x11_3c, 0x11_40, 2,
  0x11_4c, 0x11_50, 2, 0x11_54, 0x11_55, 1, 0x11_59, 0x11_59, 1, 0x11_5f, 0x11_61, 1, 0x11_63,
  0x11_69, 2, 0x11_6d, 0x11_6e, 1, 0x11_72, 0x11_73, 1, 0x11_75, 0x11_9e, 41, 0x11_a8, 0x11_ab, 3,
  0x11_ae, 0x11_af, 1, 0x11_b7, 0x11_b8, 1, 0x11_ba, 0x11_ba, 1, 0x11_bc, 0x11_c2, 1, 0x11_eb,
  0x11_f0, 5, 0x11_f9, 0x11_f9, 1, 0x1e_00, 0x1e_9b, 1, 0x1e_a0, 0x1e_f9, 1, 0x1f_00, 0x1f_15, 1,
  0x1f_18, 0x1f_1d, 1, 0x1f_20, 0x1f_45, 1, 0x1f_48, 0x1f_4d, 1, 0x1f_50, 0x1f_57, 1, 0x1f_59,
  0x1f_5b, 2, 0x1f_5d, 0x1f_5d, 1, 0x1f_5f, 0x1f_7d, 1, 0x1f_80, 0x1f_b4, 1, 0x1f_b6, 0x1f_bc, 1,
  0x1f_be, 0x1f_be, 1, 0x1f_c2, 0x1f_c4, 1, 0x1f_c6, 0x1f_cc, 1, 0x1f_d0, 0x1f_d3, 1, 0x1f_d6,
  0x1f_db, 1, 0x1f_e0, 0x1f_ec, 1, 0x1f_f2, 0x1f_f4, 1, 0x1f_f6, 0x1f_fc, 1, 0x21_26, 0x21_26, 1,
  0x21_2a, 0x21_2b, 1, 0x21_2e, 0x21_2e, 1, 0x21_80, 0x21_82, 1, 0x30_07, 0x30_07, 1, 0x30_21,
  0x30_29, 1, 0x30_41, 0x30_94, 1, 0x30_a1, 0x30_fa, 1, 0x31_05, 0x31_2c, 1, 0x4e_00, 0x9f_a5, 1,
  0xac_00, 0xd7_a3, 1,
];
// xml second: [lo, hi, stride] triples
const second: ReadonlyArray<number> = [
  0x00_2d, 0x00_2e, 1, 0x00_30, 0x00_39, 1, 0x00_b7, 0x00_b7, 1, 0x02_d0, 0x02_d1, 1, 0x03_00,
  0x03_45, 1, 0x03_60, 0x03_61, 1, 0x03_87, 0x03_87, 1, 0x04_83, 0x04_86, 1, 0x05_91, 0x05_a1, 1,
  0x05_a3, 0x05_b9, 1, 0x05_bb, 0x05_bd, 1, 0x05_bf, 0x05_bf, 1, 0x05_c1, 0x05_c2, 1, 0x05_c4,
  0x06_40, 124, 0x06_4b, 0x06_52, 1, 0x06_60, 0x06_69, 1, 0x06_70, 0x06_70, 1, 0x06_d6, 0x06_dc, 1,
  0x06_dd, 0x06_df, 1, 0x06_e0, 0x06_e4, 1, 0x06_e7, 0x06_e8, 1, 0x06_ea, 0x06_ed, 1, 0x06_f0,
  0x06_f9, 1, 0x09_01, 0x09_03, 1, 0x09_3c, 0x09_3c, 1, 0x09_3e, 0x09_4c, 1, 0x09_4d, 0x09_4d, 1,
  0x09_51, 0x09_54, 1, 0x09_62, 0x09_63, 1, 0x09_66, 0x09_6f, 1, 0x09_81, 0x09_83, 1, 0x09_bc,
  0x09_bc, 1, 0x09_be, 0x09_bf, 1, 0x09_c0, 0x09_c4, 1, 0x09_c7, 0x09_c8, 1, 0x09_cb, 0x09_cd, 1,
  0x09_d7, 0x09_d7, 1, 0x09_e2, 0x09_e3, 1, 0x09_e6, 0x09_ef, 1, 0x0a_02, 0x0a_3c, 58, 0x0a_3e,
  0x0a_3f, 1, 0x0a_40, 0x0a_42, 1, 0x0a_47, 0x0a_48, 1, 0x0a_4b, 0x0a_4d, 1, 0x0a_66, 0x0a_6f, 1,
  0x0a_70, 0x0a_71, 1, 0x0a_81, 0x0a_83, 1, 0x0a_bc, 0x0a_bc, 1, 0x0a_be, 0x0a_c5, 1, 0x0a_c7,
  0x0a_c9, 1, 0x0a_cb, 0x0a_cd, 1, 0x0a_e6, 0x0a_ef, 1, 0x0b_01, 0x0b_03, 1, 0x0b_3c, 0x0b_3c, 1,
  0x0b_3e, 0x0b_43, 1, 0x0b_47, 0x0b_48, 1, 0x0b_4b, 0x0b_4d, 1, 0x0b_56, 0x0b_57, 1, 0x0b_66,
  0x0b_6f, 1, 0x0b_82, 0x0b_83, 1, 0x0b_be, 0x0b_c2, 1, 0x0b_c6, 0x0b_c8, 1, 0x0b_ca, 0x0b_cd, 1,
  0x0b_d7, 0x0b_d7, 1, 0x0b_e7, 0x0b_ef, 1, 0x0c_01, 0x0c_03, 1, 0x0c_3e, 0x0c_44, 1, 0x0c_46,
  0x0c_48, 1, 0x0c_4a, 0x0c_4d, 1, 0x0c_55, 0x0c_56, 1, 0x0c_66, 0x0c_6f, 1, 0x0c_82, 0x0c_83, 1,
  0x0c_be, 0x0c_c4, 1, 0x0c_c6, 0x0c_c8, 1, 0x0c_ca, 0x0c_cd, 1, 0x0c_d5, 0x0c_d6, 1, 0x0c_e6,
  0x0c_ef, 1, 0x0d_02, 0x0d_03, 1, 0x0d_3e, 0x0d_43, 1, 0x0d_46, 0x0d_48, 1, 0x0d_4a, 0x0d_4d, 1,
  0x0d_57, 0x0d_57, 1, 0x0d_66, 0x0d_6f, 1, 0x0e_31, 0x0e_31, 1, 0x0e_34, 0x0e_3a, 1, 0x0e_46,
  0x0e_46, 1, 0x0e_47, 0x0e_4e, 1, 0x0e_50, 0x0e_59, 1, 0x0e_b1, 0x0e_b1, 1, 0x0e_b4, 0x0e_b9, 1,
  0x0e_bb, 0x0e_bc, 1, 0x0e_c6, 0x0e_c6, 1, 0x0e_c8, 0x0e_cd, 1, 0x0e_d0, 0x0e_d9, 1, 0x0f_18,
  0x0f_19, 1, 0x0f_20, 0x0f_29, 1, 0x0f_35, 0x0f_39, 2, 0x0f_3e, 0x0f_3f, 1, 0x0f_71, 0x0f_84, 1,
  0x0f_86, 0x0f_8b, 1, 0x0f_90, 0x0f_95, 1, 0x0f_97, 0x0f_97, 1, 0x0f_99, 0x0f_ad, 1, 0x0f_b1,
  0x0f_b7, 1, 0x0f_b9, 0x0f_b9, 1, 0x20_d0, 0x20_dc, 1, 0x20_e1, 0x30_05, 3876, 0x30_2a, 0x30_2f, 1,
  0x30_31, 0x30_35, 1, 0x30_99, 0x30_9a, 1, 0x30_9d, 0x30_9e, 1, 0x30_fc, 0x30_fe, 1,
];

function isExported(name: string): boolean {
  return /\p{Lu}/u.test(String.fromCodePoint(name.codePointAt(0) ?? 0));
}

// xml.Unmarshal into a struct described by type.
export function unmarshalXML(body: Uint8Array, dst: StructDst, type: StructType): void {
  fillStruct(parseDocument(decodeUTF8Bytes(body)), dst, type);
}

interface XmlField {
  field: StructField;
  // the object that holds the field (embedded structs are stored under their type name)
  holder: (dst: StructDst) => StructDst;
}

function xmlFields(type: StructType): Array<XmlField> {
  const out: Array<XmlField> = [];
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

function fillStruct(el: XmlElement, root: StructDst, type: StructType): void {
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
      const list = Array.isArray(dst[field.name]) ? (dst[field.name] as Array<unknown>) : [];
      list.push(elementValue(child, t.elem));
      setOwn(dst, field.name, list);
    } else {
      setOwn(dst, field.name, elementValue(child, t, dst[field.name]));
    }
  }
}

// the bit sizes of the sized integer kinds; the other kinds have no entry (64 bits)
const bits: Partial<Record<Kind, number>> = {
  int8: 8,
  int16: 16,
  int32: 32,
  uint8: 8,
  uint16: 16,
  uint32: 32,
};

// oxlint-disable-next-line quality/no-unknown-returns -- the element's value as the Go type t: any value of that type
function elementValue(el: XmlElement, t: FieldType, current?: unknown): unknown {
  while (typeof t === "object" && t.kind === "pointer") {
    t = t.elem;
  }
  if (typeof t === "object") {
    if (t.kind === "struct") {
      const target = typeof current === "object" && current !== null ? (current as StructDst) : {};
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
        // oxlint-disable-next-line quality/no-known-value-widening -- elementValue returns the field's Go value, which is unknown in general (a text field's unmarshaler result); this is one of its literal results
        return false;
      }
      if (["1", "t", "T", "true", "TRUE", "True"].includes(trimmed)) {
        // oxlint-disable-next-line quality/no-known-value-widening -- elementValue returns the field's Go value, which is unknown in general (a text field's unmarshaler result); this is one of its literal results
        return true;
      }
      if (["0", "f", "F", "false", "FALSE", "False"].includes(trimmed)) {
        // oxlint-disable-next-line quality/no-known-value-widening -- elementValue returns the field's Go value, which is unknown in general (a text field's unmarshaler result); this is one of its literal results
        return false;
      }
      throw new NumError("ParseBool", trimmed, "invalid syntax");
    case "float32":
      return text === "" ? 0 : Math.fround(parseGoFloat(trimmed, 32));
    case "float64":
      return text === "" ? 0 : parseGoFloat(trimmed, 64);
    default: {
      if (text === "") {
        // oxlint-disable-next-line quality/no-known-value-widening -- elementValue returns the field's Go value, which is unknown in general (a text field's unmarshaler result); this is one of its literal results
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
  return s.replaceAll(
    /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,
    "",
  );
}
