// Upstream: the parts of Go's encoding/xml the S3 client's responses go
// through (Decoder.Token, Unmarshal into a struct with an XMLName), and
// xml.EscapeText for the request it writes.
//
// parseXml reads the first root element into a tree of elements, with local
// names and the character data directly inside each element, and stops at
// its end tag, as Decode does. The texts of the errors S3 answers can reach
// are Go's: no root element is io.EOF, which callers rely on (see
// src/tools/filesystem/blob/bucket.ts), a root with another name, a
// mismatched end tag and a cut off document. Other syntax errors keep Go's
// prefix with their own text (D26).

import { errEOF } from "@/tools/filesystem/blob/bucket";
import { bytesToText } from "@/tools/types/go-json";

export interface XmlElement {
  name: string;
  text: string;
  children: XmlElement[];
}

function syntaxError(line: number, message: string): Error {
  return new Error(`XML syntax error on line ${line}: ${message}`);
}

const entities = new Map([
  ["lt", "<"],
  ["gt", ">"],
  ["amp", "&"],
  ["apos", "'"],
  ["quot", '"'],
]);

function decodeEntities(text: string, lineAt: () => number): string {
  return text.replace(/&([^;&<]*)(;?)/g, (whole, name: string, semi: string) => {
    if (semi === "") {
      throw syntaxError(lineAt(), "invalid character entity & (no semicolon)");
    }
    const code = /^#x([0-9a-fA-F]+)$/.exec(name)?.[1] ?? /^#([0-9]+)$/.exec(name)?.[1];
    if (code !== undefined) {
      const n = Number.parseInt(code, name[1] === "x" ? 16 : 10);
      if (n > 0x10ffff) {
        throw syntaxError(lineAt(), `invalid character entity ${whole}`);
      }
      return String.fromCodePoint(n);
    }
    const entity = entities.get(name);
    if (entity === undefined) {
      throw syntaxError(lineAt(), `invalid character entity ${whole}`);
    }
    return entity;
  });
}

function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon > 0 && colon < name.length - 1 ? name.slice(colon + 1) : name;
}

// The first root element of the document; throws errEOF when it has none.
// With expected, a root of another name fails as soon as its start tag is
// read, as Unmarshal does, so what follows it may be anything (an HTML page).
export function parseXml(raw: Uint8Array | string, expected?: string): XmlElement {
  const s = bytesToText(raw);
  const stack: (XmlElement & { rawName: string })[] = [];
  let pos = 0;
  const line = (): number => s.slice(0, pos).split("\n").length;
  const unexpectedEOF = (): Error =>
    stack.length === 0 ? errEOF : syntaxError(line(), "unexpected EOF");

  for (;;) {
    const lt = s.indexOf("<", pos);
    const text = s.slice(pos, lt === -1 ? s.length : lt);
    const top = stack.at(-1);
    if (top !== undefined) {
      top.text += decodeEntities(text, line);
    }
    if (lt === -1) {
      pos = s.length;
      throw unexpectedEOF();
    }
    pos = lt;

    if (s.startsWith("<?", pos)) {
      const end = s.indexOf("?>", pos);
      if (end === -1) {
        throw unexpectedEOF();
      }
      pos = end + 2;
    } else if (s.startsWith("<!--", pos)) {
      const end = s.indexOf("-->", pos);
      if (end === -1) {
        throw unexpectedEOF();
      }
      pos = end + 3;
    } else if (s.startsWith("<![CDATA[", pos)) {
      const end = s.indexOf("]]>", pos);
      if (end === -1) {
        throw unexpectedEOF();
      }
      if (top !== undefined) {
        top.text += s.slice(pos + 9, end);
      }
      pos = end + 3;
    } else if (s.startsWith("<!", pos)) {
      const end = s.indexOf(">", pos);
      if (end === -1) {
        throw unexpectedEOF();
      }
      pos = end + 1;
    } else if (s.startsWith("</", pos)) {
      const end = s.indexOf(">", pos);
      if (end === -1) {
        throw unexpectedEOF();
      }
      const name = s.slice(pos + 2, end).trim();
      pos = end + 1;
      if (top === undefined) {
        throw syntaxError(line(), `unexpected end element </${name}>`);
      }
      if (top.rawName !== name) {
        throw syntaxError(line(), `element <${top.rawName}> closed by </${name}>`);
      }
      stack.pop();
      const parent = stack.at(-1);
      if (parent === undefined) {
        return top;
      }
      parent.children.push(top);
    } else {
      const tag = /^<([^\s/>]+)(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/.exec(s.slice(pos));
      if (tag === null) {
        pos = s.length;
        throw /^<[^\s/>]/.test(s.slice(lt))
          ? unexpectedEOF()
          : syntaxError(line(), "expected element name after <");
      }
      pos += tag[0].length;
      const rawName = tag[1] as string;
      const element = { name: localName(rawName), rawName, text: "", children: [] };
      if (stack.length === 0 && expected !== undefined && element.name !== expected) {
        throw new Error(`expected element type <${expected}> but have <${element.name}>`);
      }
      if (tag[2] === "/") {
        const parent = stack.at(-1);
        if (parent === undefined) {
          return element;
        }
        parent.children.push(element);
      } else {
        stack.push(element);
      }
    }
  }
}

// xml.Unmarshal's check of a struct's XMLName
export function parseRoot(raw: Uint8Array | string, expected: string): XmlElement {
  return parseXml(raw, expected);
}

// the text of the last child with the name ("" when there is none)
export function childText(element: XmlElement, name: string): string {
  return element.children.findLast((child) => child.name === name)?.text ?? "";
}

// xml.EscapeText
export function escapeText(s: string): string {
  return s.replace(/[&<>'"\t\n\r]/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "'":
        return "&#39;";
      case '"':
        return "&#34;";
      case "\t":
        return "&#x9;";
      case "\n":
        return "&#xA;";
      default:
        return "&#xD;";
    }
  });
}
