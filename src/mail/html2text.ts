// Upstream: tools/mailer/html2text.go
//
// golang.org/x/net/html's Parse is ported in src/tools/html.

import { trimSpace } from "@/collections/go-strings";
import { parse } from "@/tools/html/parse";
import { ElementNode, type Node, TextNode } from "@/tools/html/node";

// Go's regexp `\s+` (RE2's \s is [\t\n\f\r ])
const whitespaceRegex = /[\t\n\f\r ]+/g;

const tagsToSkip = [
  "style",
  "script",
  "iframe",
  "applet",
  "object",
  "svg",
  "img",
  "button",
  "form",
  "textarea",
  "input",
  "select",
  "option",
  "template",
];

const inlineTags = ["a", "span", "small", "strike", "strong", "sub", "sup", "em", "b", "u", "i"];

// a strings.Builder
class Builder {
  text = "";
}

// Very rudimentary auto HTML to Text mail body converter.
//
// Caveats:
// - This method doesn't check for correctness of the HTML document.
// - Links will be converted to "[text](url)" format.
// - List items (<li>) are prefixed with "- ".
// - Indentation is stripped (both tabs and spaces).
// - Trailing spaces are preserved.
// - Multiple consequence newlines are collapsed as one unless multiple <br> tags are used.
export function html2Text(htmlDocument: string): string {
  const doc = parse(htmlDocument);

  const builder = new Builder();
  let canAddNewLine = false;

  // see https://pkg.go.dev/golang.org/x/net/html#Parse
  const f = (n: Node, activeBuilder: Builder | null): void => {
    const isLink = n.type === ElementNode && n.data === "a";

    if (isLink) {
      activeBuilder = new Builder();
    } else if (activeBuilder === null) {
      activeBuilder = builder;
    }

    if (n.type === TextNode) {
      let txt = n.data.replace(whitespaceRegex, " ");

      // the prev node has new line so it is safe to trim the indentation
      if (!canAddNewLine) {
        txt = txt.replace(/^ +/, "");
      }

      if (txt !== "") {
        activeBuilder.text += txt;
        canAddNewLine = true;
      }
    } else if (n.type === ElementNode) {
      if (n.data === "br") {
        // always write new lines when <br> tag is used
        activeBuilder.text += "\r\n";
        canAddNewLine = false;
      } else if (canAddNewLine && !inlineTags.includes(n.data)) {
        activeBuilder.text += "\r\n";
        canAddNewLine = false;
      }

      // prefix list items with dash
      if (n.data === "li") {
        activeBuilder.text += "- ";
      }
    }

    for (let c = n.firstChild; c !== null; c = c.nextSibling) {
      if (c.type !== ElementNode || !tagsToSkip.includes(c.data)) {
        f(c, activeBuilder);
      }
    }

    // format links as [label](href)
    if (isLink) {
      let linkTxt = trimSpace(activeBuilder.text);
      if (linkTxt === "") {
        linkTxt = "LINK";
      }

      builder.text += "[" + linkTxt + "]";

      // link href attr extraction
      for (const a of n.attr) {
        if (a.key === "href") {
          if (a.val !== "") {
            builder.text += "(" + a.val + ")";
          }
          break;
        }
      }

      activeBuilder.text = "";
    }
  };

  f(doc, builder);

  return trimSpace(builder.text);
}
