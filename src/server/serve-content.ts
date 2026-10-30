// Upstream: Go's net/http fs.go (serveContent, setLastModified,
// checkPreconditions with the date preconditions, parseRange, the
// multipart/byteranges response), http.ParseTime, and mime's built-in
// extension table, as tools/router/event.go FileFS and
// tools/filesystem/filesystem.go Serve call them (http.ServeContent with
// the file name and modification time).
//
// The content is either in memory (the dashboard files, as Go's embed.FS:
// no modification time, so no Last-Modified header and the date
// preconditions behave as Go's do for a zero time) or a Blob that is
// streamed to the client (a stored file, with its modification time). No
// ETag is set by either caller, so the ETag preconditions only match "*".
//
// Content-Type, when the caller did not set it, comes from the file name's
// extension: Go's built-in table, plus font/woff2, which upstream's binary
// gets from the system mime.types file. Go sniffs the content of other
// files (http.DetectContentType); here they are application/octet-stream.
// Every file the dashboard build has is in the table (test/ui checks it).

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

// Go's isZeroTime: the zero time or the Unix epoch (modtime is in Unix
// nanoseconds, 0 for none)
function isZeroTime(modtime: bigint): boolean {
  return modtime === 0n;
}

// modtime in whole Unix seconds (time.Truncate(time.Second), Unix()),
// rounding toward negative infinity as Go's do for times before 1970
function unixSeconds(modtime: bigint): bigint {
  const s = modtime / 1_000_000_000n;
  return modtime < 0n && modtime % 1_000_000_000n !== 0n ? s - 1n : s;
}

function checkIfUnmodifiedSince(r: HttpRequest, modtime: bigint): Cond {
  const ius = r.headers.get("If-Unmodified-Since") ?? "";
  if (ius === "" || isZeroTime(modtime)) {
    return "none";
  }
  const t = parseTime(ius);
  if (t === undefined) {
    return "none";
  }
  // The Last-Modified header truncates sub-second precision so
  // the modtime needs to be truncated too.
  if (compareTime(unixSeconds(modtime) * 1_000_000_000n, t) <= 0) {
    return "true";
  }
  return "false";
}

function checkIfModifiedSince(r: HttpRequest, modtime: bigint): Cond {
  if (r.method !== "GET" && r.method !== "HEAD") {
    return "none";
  }
  const ims = r.headers.get("If-Modified-Since") ?? "";
  if (ims === "" || isZeroTime(modtime)) {
    return "none";
  }
  const t = parseTime(ims);
  if (t === undefined) {
    return "none";
  }
  // The Last-Modified header truncates sub-second precision so
  // the modtime needs to be truncated too.
  if (compareTime(unixSeconds(modtime) * 1_000_000_000n, t) <= 0) {
    return "false";
  }
  return "true";
}

function checkIfRange(r: HttpRequest, modtime: bigint): Cond {
  if (r.method !== "GET" && r.method !== "HEAD") {
    return "none";
  }
  const ir = r.headers.get("If-Range") ?? "";
  if (ir === "") {
    return "none";
  }
  const [etag] = scanETag(ir);
  if (etag !== "") {
    // an ETag never matches the missing ETag
    return "false";
  }
  // The If-Range value is typically the ETag value, but it may also be
  // the modtime date. See golang.org/issue/8367.
  if (modtime === 0n) {
    return "false";
  }
  const t = parseTime(ir);
  if (t === undefined) {
    return "false";
  }
  if (unixSeconds(t) === unixSeconds(modtime)) {
    return "true";
  }
  return "false";
}

function compareTime(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const shortDays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const longDays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const shortMonths = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

// the fractional seconds time.Parse accepts after a layout's seconds
const fraction = String.raw`(?:[.,](\d+))?`;

// http.ParseTime's layouts: TimeFormat, time.RFC850 and time.ANSIC
const timeLayouts: { re: RegExp; parts: (m: RegExpExecArray) => TimeParts | undefined }[] = [
  {
    // Mon, 02 Jan 2006 15:04:05 GMT
    re: new RegExp(
      String.raw`^([A-Za-z]{3}), (\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{1,2}):(\d{2}):(\d{2})${fraction} GMT$`,
    ),
    parts: (m) =>
      shortDays.includes((m[1] as string).toLowerCase())
        ? timeParts(m[4], m[3], m[2], m[5], m[6], m[7], m[8])
        : undefined,
  },
  {
    // Monday, 02-Jan-06 15:04:05 MST
    re: new RegExp(
      String.raw`^([A-Za-z]+), (\d{2})-([A-Za-z]{3})-(\d{2}) (\d{1,2}):(\d{2}):(\d{2})${fraction} ([A-Z]{3,5}|[+-]\d+)$`,
    ),
    parts: (m) => {
      if (!longDays.includes((m[1] as string).toLowerCase())) {
        return undefined;
      }
      const yy = Number(m[4]);
      const year = String(yy >= 69 ? yy + 1900 : yy + 2000);
      return timeParts(year, m[3], m[2], m[5], m[6], m[7], m[8]);
    },
  },
  {
    // Mon Jan _2 15:04:05 2006
    re: new RegExp(
      String.raw`^([A-Za-z]{3}) ([A-Za-z]{3}) ( ?\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})${fraction} (\d{4})$`,
    ),
    parts: (m) =>
      shortDays.includes((m[1] as string).toLowerCase())
        ? timeParts(m[8], m[2], (m[3] as string).trim(), m[4], m[5], m[6], m[7])
        : undefined,
  },
];

interface TimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  nanos: number;
}

function timeParts(
  year: string | undefined,
  month: string | undefined,
  day: string | undefined,
  hour: string | undefined,
  minute: string | undefined,
  second: string | undefined,
  frac: string | undefined,
): TimeParts | undefined {
  const mi = shortMonths.indexOf((month ?? "").toLowerCase());
  if (mi === -1) {
    return undefined;
  }
  const parts: TimeParts = {
    year: Number(year),
    month: mi + 1,
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    nanos: frac === undefined ? 0 : Number((frac + "000000000").slice(0, 9)),
  };
  const daysIn = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
  if (
    parts.day < 1 ||
    parts.day > daysIn ||
    parts.hour > 23 ||
    parts.minute > 59 ||
    parts.second > 59
  ) {
    return undefined;
  }
  return parts;
}

// http.ParseTime: the time in Unix nanoseconds, or undefined. The zone of
// the RFC 850 layout is read as UTC, as time.Parse does for an
// abbreviation it does not know.
export function parseTime(text: string): bigint | undefined {
  for (const layout of timeLayouts) {
    const m = layout.re.exec(text);
    if (m === null) {
      continue;
    }
    const p = layout.parts(m);
    if (p === undefined) {
      continue;
    }
    const d = new Date(0);
    d.setUTCFullYear(p.year, p.month - 1, p.day);
    d.setUTCHours(p.hour, p.minute, p.second, 0);
    return BigInt(d.getTime()) * 1_000_000n + BigInt(p.nanos);
  }
  return undefined;
}

// time.Time.UTC().Format(http.TimeFormat) of a modification time
function formatHttpTime(modtime: bigint): string {
  return new Date(Number(unixSeconds(modtime) * 1000n)).toUTCString();
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
function checkPreconditions(w: ResponseWriter, r: HttpRequest, modtime: bigint): [boolean, string] {
  // This function carefully follows RFC 7232 section 6.
  let ch = checkIfMatch(r);
  if (ch === "none") {
    ch = checkIfUnmodifiedSince(r, modtime);
  }
  if (ch === "false") {
    w.writeHeader(412);
    return [true, ""];
  }
  switch (checkIfNoneMatch(r)) {
    case "false":
      if (r.method === "GET" || r.method === "HEAD") {
        writeNotModified(w);
        return [true, ""];
      }
      w.writeHeader(412);
      return [true, ""];
    case "none":
      if (checkIfModifiedSince(r, modtime) === "false") {
        writeNotModified(w);
        return [true, ""];
      }
      break;
    case "true":
      break;
  }

  let rangeHeader = r.headers.get("Range") ?? "";
  if (rangeHeader !== "" && checkIfRange(r, modtime) === "false") {
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

// http.ServeContent. content is the whole file, in memory or as a Blob
// (streamed, never read into memory here); modtime is its modification
// time in Unix nanoseconds, 0 for none.
export function serveContent(
  w: ResponseWriter,
  r: HttpRequest,
  name: string,
  content: Uint8Array | Blob,
  modtime = 0n,
): void {
  // setLastModified
  if (!isZeroTime(modtime)) {
    w.header.set("Last-Modified", formatHttpTime(modtime));
  }

  const [done, rangeReq] = checkPreconditions(w, r, modtime);
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

  const size = content instanceof Blob ? content.size : content.length;

  // handle Content-Range header.
  let sendSize = size;
  let sendContent: Uint8Array | Blob | ReadableStream<Uint8Array> = content;
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
    sendContent = content.slice(first.start, first.start + first.length);
    w.header.set("Content-Range", contentRange(first, size));
  } else if (ranges.length > 1) {
    const boundary = randomBoundary();
    const encoder = new TextEncoder();
    const parts: (Uint8Array | Blob)[] = [];
    ranges.forEach((ra, i) => {
      parts.push(
        encoder.encode(
          `${i === 0 ? "" : "\r\n"}--${boundary}\r\nContent-Range: ${contentRange(ra, size)}\r\nContent-Type: ${ctype}\r\n\r\n`,
        ),
        content.slice(ra.start, ra.start + ra.length),
      );
    });
    parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));
    sendSize = parts.reduce((n, p) => n + (p instanceof Blob ? p.size : p.length), 0);
    sendContent =
      content instanceof Blob
        ? partsStream(parts)
        : new Uint8Array(Buffer.concat(parts as Uint8Array[]));
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
    if (sendContent instanceof Uint8Array) {
      w.write(sendContent);
    } else {
      w.writeBody(sendContent);
    }
  }
}

// The parts of a multipart/byteranges body one after the other, each Blob
// read as the client takes the data (a Blob built from file-backed Blobs
// would not stream them).
function partsStream(parts: (Uint8Array | Blob)[]): ReadableStream<Uint8Array> {
  let i = 0;
  let reader: {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(): Promise<void>;
  } | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (reader !== null) {
          const { done, value } = await reader.read();
          if (!done && value !== undefined) {
            controller.enqueue(value);
            return;
          }
          reader = null;
        }
        const part = parts[i++];
        if (part === undefined) {
          controller.close();
          return;
        }
        if (part instanceof Blob) {
          reader = part.stream().getReader();
        } else {
          controller.enqueue(part);
          return;
        }
      }
    },
    cancel() {
      void reader?.cancel();
    },
  });
}
