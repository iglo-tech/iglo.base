// Upstream: the subset of Go's encoding/xml Unmarshal that Event.BindBody
// reaches with an XML body: the root element's child elements are matched to
// struct fields by their `xml` tag (or Go field name), with xml.copyValue's
// scalar rules. Attributes, namespaces and the ",attr"/",chardata" tag
// options are not supported; no upstream endpoint binds XML.

import {
  NumError,
  structValue,
  type FieldType,
  type StructField,
  type StructType,
} from "@/server/unmarshal-request-data";
import { setOwn } from "@/server/json-decode";

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

// xml isNameByte, plus any non-ASCII character (readName accepts them)
function isNameChar(c: string): boolean {
  return /^[A-Za-z0-9_:.-]$/.test(c) || c >= "\u0080";
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

// Decoder.text (strict mode) for one run of element text or a CDATA
// section: entity and character references are resolved (outside CDATA),
// "\r\n" and "\r" become "\n", and the result must hold only XML
// characters.
function decodeText(raw: string, cdata: boolean): string {
  if (!cdata && raw.includes("]]>")) {
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
    if (!isInCharacterRange(r)) {
      throw new XmlSyntaxError(
        `illegal character code U+${r.toString(16).toUpperCase().padStart(4, "0")}`,
      );
    }
  }
  return out;
}

// parses the first element of the document
function parseDocument(src: string): XmlElement {
  let i = 0;
  const skipMisc = (): void => {
    for (;;) {
      const ws = /^\s*/.exec(src.slice(i));
      i += ws ? ws[0].length : 0;
      if (src.startsWith("<?", i)) {
        const end = src.indexOf("?>", i);
        if (end < 0) {
          throw new XmlSyntaxError("unexpected EOF");
        }
        i = end + 2;
      } else if (src.startsWith("<!--", i)) {
        const end = src.indexOf("-->", i);
        if (end < 0) {
          throw new XmlSyntaxError("unexpected EOF");
        }
        i = end + 3;
      } else if (src.startsWith("<!", i)) {
        const end = src.indexOf(">", i);
        if (end < 0) {
          throw new XmlSyntaxError("unexpected EOF");
        }
        i = end + 1;
      } else {
        return;
      }
    }
  };

  const element = (): XmlElement => {
    const open = /^<([^\s/>]+)[^>]*?(\/?)>/.exec(src.slice(i));
    if (!open) {
      throw new XmlSyntaxError(i >= src.length ? "unexpected EOF" : "expected element");
    }
    i += open[0].length;
    const el: XmlElement = { name: open[1] as string, children: [], text: "" };
    if (open[2] === "/") {
      return el;
    }
    for (;;) {
      if (i >= src.length) {
        throw new XmlSyntaxError("unexpected EOF");
      }
      if (src.startsWith("</", i)) {
        const close = /^<\/([^\s>]+)\s*>/.exec(src.slice(i));
        if (!close || close[1] !== el.name) {
          throw new XmlSyntaxError(`element <${el.name}> closed by </${close?.[1] ?? ""}>`);
        }
        i += close[0].length;
        return el;
      }
      if (src.startsWith("<![CDATA[", i)) {
        const end = src.indexOf("]]>", i);
        if (end < 0) {
          throw new XmlSyntaxError("unexpected EOF in CDATA section");
        }
        el.text += decodeText(src.slice(i + 9, end), true);
        i = end + 3;
        continue;
      }
      if (src.startsWith("<!--", i) || src.startsWith("<?", i)) {
        skipMisc();
        continue;
      }
      if (src[i] === "<") {
        el.children.push(element());
        continue;
      }
      const next = src.indexOf("<", i);
      const end = next < 0 ? src.length : next;
      el.text += decodeText(src.slice(i, end), false);
      i = end;
    }
  };

  skipMisc();
  if (i >= src.length) {
    throw new Error("EOF");
  }
  return element();
}

function isExported(name: string): boolean {
  return /\p{Lu}/u.test(String.fromCodePoint(name.codePointAt(0) ?? 0));
}

// xml.Unmarshal into a struct described by type.
export function unmarshalXML(src: string, dst: Record<string, unknown>, type: StructType): void {
  fillStruct(parseDocument(src), dst, type);
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
  const text = el.text;
  const trimmed = text.trim();
  switch (t) {
    case "string":
    case "any":
      return text;
    case "bool":
      if (trimmed === "") {
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
    case "float64": {
      if (trimmed === "") {
        return 0;
      }
      const n = Number(trimmed);
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed) || Number.isNaN(n)) {
        throw new NumError("ParseFloat", trimmed, "invalid syntax");
      }
      return t === "float32" ? Math.fround(n) : n;
    }
    default: {
      if (trimmed === "") {
        return 0;
      }
      const unsigned = t.startsWith("u");
      if (!(unsigned ? /^\+?[0-9]+$/ : /^[+-]?[0-9]+$/).test(trimmed)) {
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
