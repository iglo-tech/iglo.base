// Upstream: golang.org/x/net v0.61.0 html/const.go
//
// The whitespace sets are defined in parse.go upstream. They are kept here so
// that doctype.ts can use them without importing parse.ts, which would form a cycle.

import type { Node } from "@/tools/html/node";

// whitespace is the set of ASCII whitespace characters the parser trims.
export const whitespace = " \t\r\n\f";

// whitespaceOrNUL is whitespace plus NUL.
export const whitespaceOrNUL = whitespace + "\x00";

// Section 12.2.4.2 of the HTML5 specification says "The following elements
// have varying levels of special parsing rules".
// https://html.spec.whatwg.org/multipage/syntax.html#the-stack-of-open-elements
const isSpecialElementSet = new Set<string>([
  "address",
  "applet",
  "area",
  "article",
  "aside",
  "base",
  "basefont",
  "bgsound",
  "blockquote",
  "body",
  "br",
  "button",
  "caption",
  "center",
  "col",
  "colgroup",
  "dd",
  "details",
  "dir",
  "div",
  "dl",
  "dt",
  "embed",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "hr",
  "html",
  "iframe",
  "img",
  "input",
  "keygen", // "keygen" has been removed from the spec, but are kept here for backwards compatibility.
  "li",
  "link",
  "listing",
  "main",
  "marquee",
  "menu",
  "meta",
  "nav",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "ol",
  "p",
  "param",
  "plaintext",
  "pre",
  "script",
  "section",
  "select",
  "source",
  "style",
  "summary",
  "table",
  "tbody",
  "td",
  "template",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "track",
  "ul",
  "wbr",
  "xmp",
]);

export function isSpecialElement(element: Node): boolean {
  switch (element.namespace) {
    case "":
    case "html":
      return isSpecialElementSet.has(element.data);
    case "math":
      switch (element.data) {
        case "mi":
        case "mo":
        case "mn":
        case "ms":
        case "mtext":
        case "annotation-xml":
          return true;
      }
      break;
    case "svg":
      switch (element.data) {
        case "foreignObject":
        case "desc":
        case "title":
          return true;
      }
      break;
  }
  return false;
}
