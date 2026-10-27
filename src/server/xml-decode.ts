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

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    switch (e) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return String.fromCodePoint(
          e.startsWith("#x") ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)),
        );
    }
  });
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
        el.text += src.slice(i + 9, end);
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
      el.text += decodeEntities(src.slice(i, end));
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
