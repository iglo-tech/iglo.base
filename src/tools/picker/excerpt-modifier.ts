// Upstream: tools/picker/excerpt_modifier.go
//
// golang.org/x/net/html's Parse is ported in src/tools/html. Go measures
// the builder and the result in UTF-8 bytes and cuts by runes; so does
// this port.

import { trimSpace } from "@/collections/go-strings";
import { toInt } from "@/records/cast";
import { parse } from "@/tools/html/parse";
import { ElementNode, type Node, TextNode } from "@/tools/html/node";
import type { Modifier } from "@/tools/picker/modifiers";
import { toBool } from "@/tools/types/cast";

// Go's regexp `\s+` (RE2's \s is [\t\n\f\r ])
const whitespaceRegex = /[\t\n\f\r ]+/g;

const excludeTags = [
  "head",
  "style",
  "script",
  "iframe",
  "embed",
  "applet",
  "object",
  "svg",
  "img",
  "picture",
  "dialog",
  "template",
  "button",
  "form",
  "textarea",
  "input",
  "select",
  "option",
];

const inlineTags = [
  "a",
  "abbr",
  "acronym",
  "b",
  "bdo",
  "big",
  "br",
  "button",
  "cite",
  "code",
  "em",
  "i",
  "label",
  "q",
  "small",
  "span",
  "strong",
  "strike",
  "sub",
  "sup",
  "time",
];

const encoder = new TextEncoder();

function byteLength(s: string): number {
  return encoder.encode(s).length;
}

export class ExcerptModifier implements Modifier {
  constructor(
    readonly max: number, // approximate max excerpt length
    readonly withEllipsis: boolean, // if enabled will add ellipsis when the plain text length > max
  ) {}

  // Modify implements the [Modifier.Modify] interface method.
  //
  // It returns a plain text excerpt/short-description from a formatted
  // html string (non-string values are kept untouched).
  modify(value: unknown): unknown {
    if (typeof value !== "string") {
      // not a string -> return as it is without applying the modifier
      // (we don't throw an error because the modifier could be applied for a missing expand field)
      return value;
    }

    let builder = "";
    let builderLen = 0; // in bytes
    const write = (s: string): void => {
      builder += s;
      builderLen += byteLength(s);
    };

    const doc = parse(value);

    let hasPrevSpace = false;

    // for all node types and more details check
    // https://pkg.go.dev/golang.org/x/net/html#Parse
    const stripTags = (n: Node): void => {
      if (n.type === TextNode) {
        // collapse multiple spaces into one
        let txt = n.data.replace(whitespaceRegex, " ");

        if (hasPrevSpace) {
          txt = txt.replace(/^ +/, "");
        }

        if (txt !== "") {
          hasPrevSpace = txt.endsWith(" ");

          write(txt);
        }
      }

      // excerpt max has been reached => no need to further iterate
      // (+2 for the extra whitespace suffix/prefix that will be trimmed later)
      if (builderLen > this.max + 2) {
        return;
      }

      for (let c = n.firstChild; c !== null; c = c.nextSibling) {
        if (c.type !== ElementNode || !excludeTags.includes(c.data)) {
          const isBlock = c.type === ElementNode && !inlineTags.includes(c.data);

          if (isBlock && !hasPrevSpace) {
            write(" ");
            hasPrevSpace = true;
          }

          stripTags(c);

          if (isBlock && !hasPrevSpace) {
            write(" ");
            hasPrevSpace = true;
          }
        }
      }
    };
    stripTags(doc);

    let result = trimSpace(builder);

    if (byteLength(result) > this.max) {
      // note: casted to []rune to properly account for multi-byte chars
      const runes = Array.from(result);
      if (runes.length > this.max) {
        result = runes.slice(0, this.max).join("");
        result = trimSpace(result);
        if (this.withEllipsis) {
          result += "...";
        }
      }
    }

    return result;
  }
}

// newExcerptModifier validates the specified raw string arguments and
// initializes a new ExcerptModifier.
//
// This method is usually invoked in initModifer().
export function newExcerptModifier(...args: string[]): ExcerptModifier {
  const totalArgs = args.length;

  if (totalArgs === 0) {
    throw new Error("max argument is required - expected (max, withEllipsis?)");
  }

  if (totalArgs > 2) {
    throw new Error("too many arguments - expected (max, withEllipsis?)");
  }

  const max = Number(toInt(args[0]));
  if (max <= 0) {
    throw new Error("max argument must be > 0");
  }

  let withEllipsis = false;
  if (totalArgs > 1) {
    withEllipsis = toBool(args[1]);
  }

  return new ExcerptModifier(max, withEllipsis);
}
