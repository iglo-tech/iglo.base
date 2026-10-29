// Upstream: Go's net/http fs.go (serveContent, checkPreconditions,
// parseRange, the multipart/byteranges response) and mime's built-in
// extension table, as tools/router/event.go FileFS calls them
// (http.ServeContent with the file name and modification time).
//
// The served files are in memory and have no modification time (as Go's
// embed.FS), so there is no Last-Modified header and the date
// preconditions (If-Modified-Since, If-Unmodified-Since, If-Range with a
// date) behave as Go's do for a zero time. There is no ETag either.
//
// Content-Type comes from the file name's extension: Go's built-in table,
// plus font/woff2, which upstream's binary gets from the system mime.types
// file. Go sniffs the content of other files (http.DetectContentType); here
// they are application/octet-stream. Every file the dashboard build has is
// in the table (test/ui checks it).

import type { HttpRequest } from "@/server/request";
import { httpError, type ResponseWriter } from "@/server/router";

const extensionTypes = new Map<string, string>([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".htm", "text/html; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
  [".xml", "text/xml; charset=utf-8"],
  [".woff2", "font/woff2"],
]);

// mime.TypeByExtension for the table above ("" when unknown).
export function typeByExtension(name: string): string {
  const slash = name.lastIndexOf("/");
  const dot = name.lastIndexOf(".");
  if (dot === -1 || dot < slash) {
    return "";
  }
  const ext = name.slice(dot);
  return extensionTypes.get(ext) ?? extensionTypes.get(ext.toLowerCase()) ?? "";
}

interface HttpRange {
  start: number;
  length: number;
}

class RangeError extends Error {}

const errNoOverlap = new RangeError("invalid range: failed to overlap");

// textproto.TrimString: trims ASCII spaces and tabs (and CR/LF).
function trimString(s: string): string {
  return s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
}

// strconv.ParseInt(s, 10, 64); undefined on error.
function parseInt64(s: string): number | undefined {
  if (!/^[+-]?[0-9]+$/.test(s)) {
    return undefined;
  }
  const n = BigInt(s);
  if (n > 9223372036854775807n || n < -9223372036854775808n) {
    return undefined;
  }
  return Number(n);
}

// parseRange parses a Range header string as per RFC 7233.
// errNoOverlap is thrown if none of the ranges overlap.
function parseRange(s: string, size: number): HttpRange[] {
  if (s === "") {
    return []; // header not present
  }
  const b = "bytes=";
  if (!s.startsWith(b)) {
    throw new RangeError("invalid range");
  }
  const ranges: HttpRange[] = [];
  let noOverlap = false;
  for (let ra of s.slice(b.length).split(",")) {
    ra = trimString(ra);
    if (ra === "") {
      continue;
    }
    const dash = ra.indexOf("-");
    if (dash === -1) {
      throw new RangeError("invalid range");
    }
    const start = trimString(ra.slice(0, dash));
    const end = trimString(ra.slice(dash + 1));
    const r: HttpRange = { start: 0, length: 0 };
    if (start === "") {
      // If no start is specified, end specifies the
      // range start relative to the end of the file,
      // and we are dealing with <suffix-length>
      // which has to be a non-negative integer as per
      // RFC 7233 Section 2.1 "Byte-Ranges".
      if (end === "" || end[0] === "-") {
        throw new RangeError("invalid range");
      }
      let i = parseInt64(end);
      if (i === undefined || i < 0) {
        throw new RangeError("invalid range");
      }
      if (i > size) {
        i = size;
      }
      r.start = size - i;
      r.length = size - r.start;
    } else {
      const i = parseInt64(start);
      if (i === undefined || i < 0) {
        throw new RangeError("invalid range");
      }
      if (i >= size) {
        // If the range begins after the size of the content,
        // then it does not overlap.
        noOverlap = true;
        continue;
      }
      r.start = i;
      if (end === "") {
        // If no end is specified, range extends to end of the file.
        r.length = size - r.start;
      } else {
        let e = parseInt64(end);
        if (e === undefined || r.start > e) {
          throw new RangeError("invalid range");
        }
        if (e >= size) {
          e = size - 1;
        }
        r.length = e - r.start + 1;
      }
    }
    ranges.push(r);
  }
  if (noOverlap && ranges.length === 0) {
    // The specified ranges did not overlap with the content.
    throw errNoOverlap;
  }
  return ranges;
}

function contentRange(r: HttpRange, size: number): string {
  return `bytes ${r.start}-${r.start + r.length - 1}/${size}`;
}

type Cond = "none" | "true" | "false";

// scanETag determines if a syntactically valid ETag is present at s; it
// returns the ETag and the remaining text after consuming it, or "" and ""
// if no ETag is present.
function scanETag(s: string): [string, string] {
  s = trimString(s);
  let start = 0;
  if (s.startsWith("W/")) {
    start = 2;
  }
  if (s.length - start < 2 || s[start] !== '"') {
    return ["", ""];
  }
  // ETag is either W/"text" or "text".
  // See RFC 7232 2.3.
  for (let i = start + 1; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x21 || (c >= 0x23 && c <= 0x7e) || c >= 0x80) {
      // Character values allowed in ETags.
    } else if (c === 0x22) {
      return [s.slice(0, i + 1), s.slice(i + 1)];
    } else {
      return ["", ""];
    }
  }
  return ["", ""];
}

// The ETag of the served file is always empty: an If-Match or
// If-None-Match list matches only through "*".
function etagListMatchesStar(header: string, weak: boolean): Cond {
  let buf = header;
  for (;;) {
    buf = trimString(buf);
    if (buf.length === 0) {
      break;
    }
    if (buf[0] === ",") {
      buf = buf.slice(1);
      continue;
    }
    if (buf[0] === "*") {
      return weak ? "false" : "true";
    }
    const [etag, remain] = scanETag(buf);
    if (etag === "") {
      break;
    }
    buf = remain;
  }
  return weak ? "true" : "false";
}

function checkIfMatch(r: HttpRequest): Cond {
  const im = r.headers.get("If-Match") ?? "";
  if (im === "") {
    return "none";
  }
  return etagListMatchesStar(im, false);
}

function checkIfNoneMatch(r: HttpRequest): Cond {
  const inm = r.headers.get("If-None-Match") ?? "";
  if (inm === "") {
    return "none";
  }
  return etagListMatchesStar(inm, true);
}

function checkIfRange(r: HttpRequest): Cond {
  if (r.method !== "GET" && r.method !== "HEAD") {
    return "none";
  }
  const ir = r.headers.get("If-Range") ?? "";
  if (ir === "") {
    return "none";
  }
  // an ETag never matches the missing ETag, and a date never matches the
  // zero modification time
  return "false";
}

function writeNotModified(w: ResponseWriter): void {
  // RFC 7232 section 4.1:
  // a sender SHOULD NOT generate representation metadata other than the
  // above listed fields unless said metadata exists for the purpose of
  // guiding cache updates (e.g., Last-Modified might be useful if the
  // response does not have an ETag field).
  w.header.delete("Content-Type");
  w.header.delete("Content-Length");
  w.header.delete("Content-Encoding");
  w.writeHeader(304);
}

// checkPreconditions evaluates request preconditions and reports whether a
// precondition resulted in sending StatusNotModified or
// StatusPreconditionFailed, and the Range header to use.
function checkPreconditions(w: ResponseWriter, r: HttpRequest): [boolean, string] {
  // This function carefully follows RFC 7232 section 6.
  // If-Unmodified-Since and If-Modified-Since need a modification time.
  const ch = checkIfMatch(r);
  if (ch === "false") {
    w.writeHeader(412);
    return [true, ""];
  }
  if (checkIfNoneMatch(r) === "false") {
    if (r.method === "GET" || r.method === "HEAD") {
      writeNotModified(w);
      return [true, ""];
    }
    w.writeHeader(412);
    return [true, ""];
  }

  let rangeHeader = r.headers.get("Range") ?? "";
  if (rangeHeader !== "" && checkIfRange(r) === "false") {
    rangeHeader = "";
  }
  return [false, rangeHeader];
}

// serveError serves an error from ServeFile, ServeFileFS, and ServeContent:
// the headers that describe the file are removed first.
function serveError(w: ResponseWriter, text: string, code: number): void {
  for (const k of ["Cache-Control", "Content-Encoding", "Etag", "Last-Modified"]) {
    w.header.delete(k);
  }
  httpError(w, text, code);
}

// mime/multipart's randomBoundary: 30 random bytes, hex.
function randomBoundary(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(30))).toString("hex");
}

// http.ServeContent for an in-memory file.
export function serveContent(
  w: ResponseWriter,
  r: HttpRequest,
  name: string,
  content: Uint8Array,
): void {
  const [done, rangeReq] = checkPreconditions(w, r);
  if (done) {
    return;
  }

  let code = 200;

  // If Content-Type isn't set, use the file's extension to find it.
  let ctype = w.header.get("Content-Type");
  if (ctype === null) {
    ctype = typeByExtension(name) || "application/octet-stream";
    w.header.set("Content-Type", ctype);
  }

  const size = content.length;

  // handle Content-Range header.
  let sendSize = size;
  let sendContent: Uint8Array = content;
  let ranges: HttpRange[];
  try {
    ranges = parseRange(rangeReq, size);
  } catch (err) {
    if (err === errNoOverlap && size === 0) {
      // Some clients add a Range header to all requests to
      // limit the size of the response. If the file is empty,
      // ignore the range header and respond with a 200 rather
      // than a 416.
      ranges = [];
    } else {
      if (err === errNoOverlap) {
        w.header.set("Content-Range", `bytes */${size}`);
      }
      serveError(w, (err as Error).message, 416);
      return;
    }
  }

  if (ranges.reduce((sum, ra) => sum + ra.length, 0) > size) {
    // The total number of bytes in all the ranges
    // is larger than the size of the file by
    // itself, so this is probably an attack, or a
    // dumb client. Ignore the range request.
    ranges = [];
  }

  const [first] = ranges;
  if (ranges.length === 1 && first) {
    // RFC 7233, Section 4.1:
    // "If a single part is being transferred, the server
    // generating the 206 response MUST generate a
    // Content-Range header field describing what range
    // of the selected representation is enclosed, and a
    // payload whose Content-Type is the same as the
    // representation's."
    sendSize = first.length;
    code = 206;
    sendContent = content.subarray(first.start, first.start + first.length);
    w.header.set("Content-Range", contentRange(first, size));
  } else if (ranges.length > 1) {
    const boundary = randomBoundary();
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];
    ranges.forEach((ra, i) => {
      parts.push(
        encoder.encode(
          `${i === 0 ? "" : "\r\n"}--${boundary}\r\nContent-Range: ${contentRange(ra, size)}\r\nContent-Type: ${ctype}\r\n\r\n`,
        ),
        content.subarray(ra.start, ra.start + ra.length),
      );
    });
    parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));
    sendContent = new Uint8Array(Buffer.concat(parts));
    sendSize = sendContent.length;
    code = 206;
    w.header.set("Content-Type", `multipart/byteranges; boundary=${boundary}`);
  }

  w.header.set("Accept-Ranges", "bytes");

  // We should be able to unconditionally set the Content-Length here.
  //
  // However, there is a pattern observed in the wild that this breaks:
  // The user wraps the ResponseWriter in one which gzips data written to it,
  // and sets "Content-Encoding: gzip".
  if ((w.header.get("Content-Encoding") ?? "") === "") {
    w.header.set("Content-Length", String(sendSize));
  }

  w.writeHeader(code);

  if (r.method !== "HEAD") {
    w.write(sendContent);
  }
}
