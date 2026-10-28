// Upstream: gabriel-vasile/mimetype v1.4.15 mime.go.
//
// Extend (registering formats at run time) is left out: iglo.base has no
// extension surface.
//
// A detected type's String() can carry a charset parameter taken from the
// input's bytes (an HTML or XML declaration); it is in the string form of
// src/tools/unicode/utf8.ts, so an invalid UTF-8 byte is the lone surrogate
// U+DC80+n (bytesToText).

import { fromHTML, fromPlain, fromXML } from "@/tools/mimetype/internal/charset/charset";
import type { Detector } from "@/tools/mimetype/internal/magic/magic";
import { parseMediaType } from "@/tools/mimetype/mediatype";

// MIME struct holds information about a file format: the string representation
// of the MIME type, the extension and the parent file format.
export class MIME {
  mime: string;
  aliases: readonly string[] = [];
  ext: string;
  // detector receives the raw input and a limit for the number of bytes it is
  // allowed to check. It returns whether the input matches a signature or not.
  detector: Detector | null;
  children: readonly MIME[];
  parentNode: MIME | null = null;

  constructor(
    mime: string,
    extension: string,
    detector: Detector | null,
    children: readonly MIME[] = [],
  ) {
    this.mime = mime;
    this.ext = extension;
    this.detector = detector;
    this.children = children;
  }

  // String returns the string representation of the MIME type, e.g., "application/zip".
  // String return values can change between releases, for example, when [IANA]
  // assigns a new media type. Use [MIME.Is] to avoid breaking changes.
  //
  //	mtype := mimetype.Detect(zipFile)
  //	if mtype.String() == "application/zip" { /* Plain string comparison is brittle. */ }
  //	if mtype.Is("application/zip") { /* Will continue to work between releases */ }
  //
  // [IANA]: https://www.iana.org/assignments/media-types/media-types.xhtml
  string(): string {
    return this.mime;
  }

  toString(): string {
    return this.mime;
  }

  // Extension returns the file extension associated with the MIME type.
  // It includes the leading dot, as in ".html". When the file format does not
  // have an extension, the empty string is returned.
  extension(): string {
    return this.ext;
  }

  // Parent returns the parent MIME type from the hierarchy.
  // Each MIME type has a non-nil parent, except for the root MIME type.
  //
  // For example, the application/json and text/html MIME types have text/plain as
  // their parent because they are text files that happen to contain JSON or HTML.
  // Another example is the ZIP format, which is used as container
  // for Microsoft Office files, EPUB files, JAR files, and others.
  parent(): MIME | null {
    return this.parentNode;
  }

  // Is checks whether this MIME type, or any of its [aliases], is equal to the
  // expected MIME type. MIME type equality test is done on the "type/subtype"
  // section, ignores any optional MIME parameters, ignores any leading and
  // trailing whitespace, and is case insensitive.
  //
  // [aliases]: https://github.com/gabriel-vasile/mimetype/blob/master/supported_mimes.md
  is(expectedMIME: string): boolean {
    // Parsing is needed because some detected MIME types contain parameters
    // that need to be stripped for the comparison.
    [expectedMIME] = parseMediaType(expectedMIME);
    const [found] = parseMediaType(this.mime);

    if (expectedMIME === found) {
      return true;
    }

    if (this.aliases.includes(expectedMIME)) {
      return true;
    }

    return false;
  }

  alias(...aliases: string[]): MIME {
    this.aliases = aliases;
    return this;
  }

  // match does a depth-first search on the signature tree. It returns the deepest
  // successful node for which all the children detection functions fail.
  match(input: Uint8Array, readLimit: number, root: MIME): MIME {
    for (const c of this.children) {
      if ((c.detector as Detector)(input, readLimit)) {
        return c.match(input, readLimit, root);
      }
    }

    const f = needsCharset.get(this.mime);
    let charset = "";
    if (f !== undefined) {
      // The charset comes from BOM, from HTML headers, from XML headers.
      // Limit the number of bytes searched for to 1024.
      charset = f(input.subarray(0, Math.min(input.length, 1024)));
    }
    if (this === root || charset === "") {
      return this;
    }

    return this.cloneHierarchy(charset);
  }

  // flatten transforms an hierarchy of MIMEs into a slice of MIMEs.
  flatten(): MIME[] {
    const out: MIME[] = [this];
    for (const c of this.children) {
      out.push(...c.flatten());
    }

    return out;
  }

  // hierarchy returns an easy to read list of ancestors for m.
  // For example, application/json would return json>txt>root.
  hierarchy(): string {
    let h = "";
    const chain: MIME[] = [this];
    for (let p = this.parent(); p !== null; p = p.parent()) {
      chain.push(p);
    }
    for (const m of chain) {
      let e = m.extension();
      if (e.startsWith(".")) {
        e = e.slice(1);
      }
      if (e === "") {
        // There are some MIME without extensions. When generating the hierarchy,
        // it would be confusing to use empty string as extension.
        // Use the subtype instead; ex: application/x-executable -> x-executable.
        e = m.string().split("/")[1] as string;
        if (m.is("application/octet-stream")) {
          // for octet-stream use root, because it's short and used in many places
          e = "root";
        }
      }
      h += ">" + e;
    }
    return h.slice(1);
  }

  // clone creates a new MIME with the provided optional MIME parameters.
  clone(charset: string): MIME {
    let clonedMIME = this.mime;
    if (charset !== "") {
      clonedMIME = this.mime + "; charset=" + charset;
    }

    const m = new MIME(clonedMIME, this.ext, null);
    m.aliases = this.aliases;
    return m;
  }

  // cloneHierarchy creates a clone of m and all its ancestors. The optional MIME
  // parameters are set on the last child of the hierarchy.
  cloneHierarchy(charset: string): MIME {
    const ret = this.clone(charset);
    let lastChild = ret;
    for (let p = this.parent(); p !== null; p = p.parent()) {
      const pClone = p.clone("");
      lastChild.parentNode = pClone;
      lastChild = pClone;
    }

    return ret;
  }

  lookup(mime: string): MIME | null {
    if (mime === this.mime) {
      return this;
    }
    if (this.aliases.includes(mime)) {
      return this;
    }

    for (const c of this.children) {
      const m = c.lookup(mime);
      if (m !== null) {
        return m;
      }
    }
    return null;
  }
}

export function newMIME(
  mime: string,
  extension: string,
  detector: Detector,
  ...children: MIME[]
): MIME {
  const m = new MIME(mime, extension, detector, children);

  for (const c of children) {
    c.parentNode = m;
  }

  return m;
}

const needsCharset = new Map<string, (b: Uint8Array) => string>([
  ["text/plain", fromPlain],
  ["text/html", fromHTML],
  ["text/xml", fromXML],
]);
