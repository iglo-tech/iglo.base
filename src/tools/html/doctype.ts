// Upstream: golang.org/x/net v0.61.0 html/doctype.go
//
// Go slices the doctype text by byte offsets, and strings.ToLower can change a
// character's byte length (U+0130 is two bytes and lowercases to ASCII "i"). So
// this port works on the UTF-8 bytes too, not on UTF-16 offsets, to get the same
// key and quirks results.

import { equalFold, toLower } from "@/collections/go-strings";
import { whitespace } from "@/tools/html/const";
import { decodeUTF8, encodeUTF8 } from "@/tools/html/escape";
import { DoctypeNode, Node } from "@/tools/html/node";

// whitespaceBytes is whitespace as ASCII byte values.
const whitespaceBytes = encodeUTF8(whitespace);

// trimLeft is bytes.TrimLeft / strings.TrimLeft with an ASCII cutset.
function trimLeft(s: Uint8Array, cutset: Uint8Array): Uint8Array {
  let i = 0;
  while (i < s.length && cutset.includes(s[i]!)) {
    i++;
  }
  return s.subarray(i);
}

// indexAny is strings.IndexAny for an ASCII cutset: the index of the first
// byte of s that is in cutset, or -1.
function indexAny(s: Uint8Array, cutset: Uint8Array): number {
  for (let i = 0; i < s.length; i++) {
    if (cutset.includes(s[i]!)) {
      return i;
    }
  }
  return -1;
}

export function parseDoctype(input: string): [Node, boolean] {
  let s = encodeUTF8(input);
  const n = new Node({ type: DoctypeNode });
  let quirks = false;

  let space = indexAny(s, whitespaceBytes);
  if (space === -1) {
    space = s.length;
  }
  n.data = decodeUTF8(s.subarray(0, space));
  if (n.data !== "html") {
    quirks = true;
  }
  n.data = toLower(n.data);
  s = trimLeft(s.subarray(space), whitespaceBytes);

  if (s.length < 6) {
    return [n, quirks || s.length !== 0];
  }

  let key = toLower(decodeUTF8(s.subarray(0, 6)));
  s = s.subarray(6);
  while (key === "public" || key === "system") {
    s = trimLeft(s, whitespaceBytes);
    if (s.length === 0) {
      break;
    }
    const quote = s[0]!;
    if (quote !== 0x22 /* " */ && quote !== 0x27 /* ' */) {
      break;
    }
    s = s.subarray(1);
    const q = s.indexOf(quote);
    let id: Uint8Array;
    if (q === -1) {
      id = s;
      s = s.subarray(s.length);
    } else {
      id = s.subarray(0, q);
      s = s.subarray(q + 1);
    }
    n.attr.push({ namespace: "", key, val: decodeUTF8(id) });
    if (key === "public") {
      key = "system";
    } else {
      key = "";
    }
  }

  if (key !== "" || s.length !== 0) {
    quirks = true;
  } else if (n.attr.length > 0) {
    if (n.attr[0]!.key === "public") {
      const pub = toLower(n.attr[0]!.val);
      switch (pub) {
        case "-//w3o//dtd w3 html strict 3.0//en//":
        case "-/w3d/dtd html 4.0 transitional/en":
        case "html":
          quirks = true;
          break;
        default:
          for (const q of quirkyIDs) {
            if (pub.startsWith(q)) {
              quirks = true;
              break;
            }
          }
      }
      if (
        n.attr.length === 1 &&
        (pub.startsWith("-//w3c//dtd html 4.01 frameset//") ||
          pub.startsWith("-//w3c//dtd html 4.01 transitional//"))
      ) {
        quirks = true;
      }
    }
    const lastAttr = n.attr[n.attr.length - 1]!;
    if (
      lastAttr.key === "system" &&
      equalFold(lastAttr.val, "http://www.ibm.com/data/dtd/v11/ibmxhtml1-transitional.dtd")
    ) {
      quirks = true;
    }
  }

  return [n, quirks];
}

const quirkyIDs: readonly string[] = [
  "+//silmaril//dtd html pro v0r11 19970101//",
  "-//advasoft ltd//dtd html 3.0 aswedit + extensions//",
  "-//as//dtd html 3.0 aswedit + extensions//",
  "-//ietf//dtd html 2.0 level 1//",
  "-//ietf//dtd html 2.0 level 2//",
  "-//ietf//dtd html 2.0 strict level 1//",
  "-//ietf//dtd html 2.0 strict level 2//",
  "-//ietf//dtd html 2.0 strict//",
  "-//ietf//dtd html 2.0//",
  "-//ietf//dtd html 2.1e//",
  "-//ietf//dtd html 3.0//",
  "-//ietf//dtd html 3.2 final//",
  "-//ietf//dtd html 3.2//",
  "-//ietf//dtd html 3//",
  "-//ietf//dtd html level 0//",
  "-//ietf//dtd html level 1//",
  "-//ietf//dtd html level 2//",
  "-//ietf//dtd html level 3//",
  "-//ietf//dtd html strict level 0//",
  "-//ietf//dtd html strict level 1//",
  "-//ietf//dtd html strict level 2//",
  "-//ietf//dtd html strict level 3//",
  "-//ietf//dtd html strict//",
  "-//ietf//dtd html//",
  "-//metrius//dtd metrius presentational//",
  "-//microsoft//dtd internet explorer 2.0 html strict//",
  "-//microsoft//dtd internet explorer 2.0 html//",
  "-//microsoft//dtd internet explorer 2.0 tables//",
  "-//microsoft//dtd internet explorer 3.0 html strict//",
  "-//microsoft//dtd internet explorer 3.0 html//",
  "-//microsoft//dtd internet explorer 3.0 tables//",
  "-//netscape comm. corp.//dtd html//",
  "-//netscape comm. corp.//dtd strict html//",
  "-//o'reilly and associates//dtd html 2.0//",
  "-//o'reilly and associates//dtd html extended 1.0//",
  "-//o'reilly and associates//dtd html extended relaxed 1.0//",
  "-//softquad software//dtd hotmetal pro 6.0::19990601::extensions to html 4.0//",
  "-//softquad//dtd hotmetal pro 4.0::19971010::extensions to html 4.0//",
  "-//spyglass//dtd html 2.0 extended//",
  "-//sq//dtd html 2.0 hotmetal + extensions//",
  "-//sun microsystems corp.//dtd hotjava html//",
  "-//sun microsystems corp.//dtd hotjava strict html//",
  "-//w3c//dtd html 3 1995-03-24//",
  "-//w3c//dtd html 3.2 draft//",
  "-//w3c//dtd html 3.2 final//",
  "-//w3c//dtd html 3.2//",
  "-//w3c//dtd html 3.2s draft//",
  "-//w3c//dtd html 4.0 frameset//",
  "-//w3c//dtd html 4.0 transitional//",
  "-//w3c//dtd html experimental 19960712//",
  "-//w3c//dtd html experimental 970421//",
  "-//w3c//dtd w3 html//",
  "-//w3o//dtd w3 html 3.0//",
  "-//webtechs//dtd mozilla html 2.0//",
  "-//webtechs//dtd mozilla html//",
];
