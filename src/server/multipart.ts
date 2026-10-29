// Upstream: Go's mime/multipart (go1.27.2): multipart.go (Reader, Part,
// NextPart with the quoted-printable decoding, FormName, FileName, the
// boundary scanning), formdata.go (ReadForm with its limits, Form) and
// readmimeheader.go (the link to net/textproto's readMIMEHeader).
//
// MIME multipart parsing as defined in RFC 2046, for multipart/form-data
// request bodies (net/http's ParseMultipartForm). The limits are Go's
// defaults: 10000 headers per part and in all file parts together
// (GODEBUG multipartmaxheaders), 1000 parts per form (GODEBUG
// multipartmaxparts), and maxMemory plus 10 MB for the values, names and
// headers.
//
// File parts: as Go, the file data of a form is kept in memory up to
// maxMemory bytes; a part that does not fit is written (all of it) to
// the form's one temporary file, created as os.CreateTemp("",
// "multipart-") does (in os.TempDir: $TMPDIR, else /tmp), each such part
// a section of it (Go's default combined "multipartfiles" mode).
// Form.removeAll deletes the temporary file; the router calls it when the
// request ends, as net/http does after the handler (D27). A failed
// ReadForm removes it at once.

import {
  copyBufferSize,
  ErrUnexpectedEOF,
  EOF,
  BytesBuffer,
  copy,
  copyN,
  type Reader as IoReader,
} from "@/server/io";
import { Reader as BufReader } from "@/server/bufio";
import { Reader as QPReader } from "@/server/quotedprintable";
import { parseMediaType } from "@/server/request";
import {
  goQuote,
  headerText,
  MIMEHeader,
  readMIMEHeader,
  Reader as TextprotoReader,
} from "@/server/textproto";
import { closeSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { goBase, type MultipartFileHeader } from "@/tools/filesystem/file";

// ErrMessageTooLarge is returned by ReadForm if the message form data is
// too large to be processed.
export const ErrMessageTooLarge = new Error("multipart: message too large");

// This constant needs to be at least 76 for this package to work
// correctly. This is because \r\n--separator_of_len_70- would fill the
// buffer and it wouldn't be safe to consume a single byte from it.
const peekBufferSize = 4096;

// maxMIMEHeaderSize is the maximum size of a MIME header we will parse,
// including header keys, values, and map overhead.
const maxMIMEHeaderSize = 10 << 20;

// the GODEBUG multipartmaxheaders default: the maximum number of header
// entries NextPart will return, as well as the maximum combined total of
// header entries Reader.ReadForm will return in FileHeaders
const maxMIMEHeaders = 10000;

// the GODEBUG multipartmaxparts default: the maximum number of parts in a
// form
const maxFormParts = 1000;

const encoder = new TextEncoder();

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A Part represents a single part in a multipart body.
export class Part implements IoReader {
  // The headers of the body, if any, with the keys canonicalized in the
  // same fashion that the Go http.Request headers are.
  header = new MIMEHeader();

  readonly mr: Reader;

  #disposition = "";
  #dispositionParams: Map<string, string> | undefined;

  // r is either a reader directly reading from mr, or it's a wrapper
  // around such a reader, decoding the Content-Transfer-Encoding
  r: IoReader;

  n = 0; // known data bytes waiting in mr.bufReader
  total = 0; // total data bytes read already
  err: unknown = undefined; // error to return when n == 0
  readErr: unknown = undefined; // read error observed from mr.bufReader

  constructor(mr: Reader) {
    this.mr = mr;
    this.r = partReader(this);
  }

  // FormName returns the name parameter if p has a Content-Disposition of
  // type "form-data". Otherwise it returns the empty string.
  formName(): string {
    // See https://tools.ietf.org/html/rfc2183 section 2 for EBNF
    // of Content-Disposition value format.
    const params = this.#parseContentDisposition();
    if (this.#disposition !== "form-data") {
      return "";
    }
    return params.get("name") ?? "";
  }

  // FileName returns the filename parameter of the Part's
  // Content-Disposition header. If not empty, the filename is passed
  // through filepath.Base before being returned.
  fileName(): string {
    const filename = this.#parseContentDisposition().get("filename") ?? "";
    if (filename === "") {
      return "";
    }
    // RFC 7578, Section 4.2 requires that if a filename is provided, the
    // directory path information must not be used.
    return goBase(filename);
  }

  #parseContentDisposition(): Map<string, string> {
    if (this.#dispositionParams === undefined) {
      const v = headerText(this.header.get("Content-Disposition"));
      const parsed = parseMediaType(v);
      if ("err" in parsed) {
        this.#disposition = "";
        this.#dispositionParams = new Map();
      } else {
        this.#disposition = parsed.mediaType;
        this.#dispositionParams = parsed.params;
      }
    }
    return this.#dispositionParams;
  }

  async populateHeaders(headerSizeLimit: number, headerLimit: number): Promise<unknown> {
    const r = new TextprotoReader(this.mr.bufReader);
    let [header, err] = await readMIMEHeader(r, headerSizeLimit, headerLimit);
    if (err === undefined) {
      this.header = header as MIMEHeader;
    }
    // TODO: Add a distinguishable error to net/textproto.
    if (err !== undefined && errorText(err) === "message too large") {
      err = ErrMessageTooLarge;
    }
    return err;
  }

  // Read reads the body of a part, after its headers and before the next
  // part (if any) begins.
  read(d: Uint8Array): Promise<[number, unknown]> {
    return this.r.read(d);
  }

  async close(): Promise<void> {
    await copy(undefined, this, Number.POSITIVE_INFINITY, this.mr.copyBuf);
  }
}

async function newPart(
  mr: Reader,
  rawPart: boolean,
  headerSizeLimit: number,
  headerLimit: number,
): Promise<[Part | undefined, unknown]> {
  const bp = new Part(mr);
  const err = await bp.populateHeaders(headerSizeLimit, headerLimit);
  if (err !== undefined) {
    return [undefined, err];
  }

  // rawPart is used to switch between Part.NextPart and Part.NextRawPart.
  if (!rawPart) {
    const cte = "Content-Transfer-Encoding";
    if (asciiEqualFold(bp.header.get(cte), "quoted-printable")) {
      bp.header.del(cte);
      bp.r = new QPReader(bp.r);
    }
  }
  return [bp, undefined];
}

// strings.EqualFold against an ASCII string: only ASCII letters fold to
// the letters of "quoted-printable"
function asciiEqualFold(s: string, ascii: string): boolean {
  return s.length === ascii.length && s.replace(/[A-Z]/g, (c) => c.toLowerCase()) === ascii;
}

// partReader implements io.Reader by reading raw bytes directly from the
// wrapped Part, without doing any Transfer-Encoding decoding.
function partReader(p: Part): IoReader {
  return {
    async read(d) {
      const br = p.mr.bufReader;

      // Read into buffer until we identify some data to return,
      // or we find a reason to stop (boundary or read error).
      while (p.n === 0 && p.err === undefined) {
        const [peek] = await br.peek(br.buffered());
        [p.n, p.err] = scanUntilBoundary(
          peek,
          p.mr.dashBoundary,
          p.mr.nlDashBoundary,
          p.total,
          p.readErr,
        );
        if (p.n === 0 && p.err === undefined) {
          // Force buffered I/O to read more into buffer.
          [, p.readErr] = await br.peek(peek.length + 1);
          if (p.readErr === EOF) {
            p.readErr = ErrUnexpectedEOF;
          }
        }
      }

      // Read out from "data to return" part of buffer.
      if (p.n === 0) {
        return [0, p.err];
      }
      let n = Math.min(d.length, p.n);
      [n] = await br.read(d.subarray(0, n));
      p.total += n;
      p.n -= n;
      if (p.n === 0) {
        return [n, p.err];
      }
      return [n, undefined];
    },
  };
}

function hasPrefix(s: Uint8Array, prefix: Uint8Array): boolean {
  if (s.length < prefix.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i++) {
    if (s[i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && hasPrefix(a, b);
}

// bytes.Index
function indexBytes(s: Uint8Array, sep: Uint8Array): number {
  return Buffer.from(s.buffer, s.byteOffset, s.length).indexOf(
    Buffer.from(sep.buffer, sep.byteOffset, sep.length),
  );
}

// scanUntilBoundary scans buf to identify how much of it can be safely
// returned as part of the Part body.
// dashBoundary is "--boundary".
// nlDashBoundary is "\r\n--boundary" or "\n--boundary", depending on what
// mode we are in. The comments below (and the name) assume
// "\n--boundary", but either is accepted.
// total is the number of bytes read out so far. If total == 0, then a
// leading "--boundary" is recognized.
// readErr is the read error, if any, that followed reading the bytes in
// buf.
// scanUntilBoundary returns the number of data bytes from buf that can be
// returned as part of the Part body and also the error to return (if any)
// once those data bytes are done.
export function scanUntilBoundary(
  buf: Uint8Array,
  dashBoundary: Uint8Array,
  nlDashBoundary: Uint8Array,
  total: number,
  readErr: unknown,
): [number, unknown] {
  if (total === 0) {
    // At beginning of body, allow dashBoundary.
    if (hasPrefix(buf, dashBoundary)) {
      switch (matchAfterPrefix(buf, dashBoundary, readErr)) {
        case -1:
          return [dashBoundary.length, undefined];
        case 0:
          return [0, undefined];
        case +1:
          return [0, EOF];
      }
    }
    if (hasPrefix(dashBoundary, buf)) {
      return [0, readErr];
    }
  }

  // Search for "\n--boundary".
  const i = indexBytes(buf, nlDashBoundary);
  if (i >= 0) {
    switch (matchAfterPrefix(buf.subarray(i), nlDashBoundary, readErr)) {
      case -1:
        return [i + nlDashBoundary.length, undefined];
      case 0:
        return [i, undefined];
      case +1:
        return [i, EOF];
    }
  }
  if (hasPrefix(nlDashBoundary, buf)) {
    return [0, readErr];
  }

  // Otherwise, anything up to the final \n is not part of the boundary
  // and so must be part of the body.
  // Also if the section from the final \n onward is not a prefix of the
  // boundary, it too must be part of the body.
  const last = buf.lastIndexOf(nlDashBoundary[0] as number);
  if (last >= 0 && hasPrefix(nlDashBoundary, buf.subarray(last))) {
    return [last, undefined];
  }
  return [buf.length, readErr];
}

// matchAfterPrefix checks whether buf should be considered to match the
// boundary. The prefix is "--boundary" or "\r\n--boundary" or
// "\n--boundary", and the caller has verified already that
// bytes.HasPrefix(buf, prefix) is true.
//
// matchAfterPrefix returns +1 if the buffer does match the boundary,
// meaning the prefix is followed by a double dash, space, tab, cr, nl, or
// end of input. It returns -1 if the buffer definitely does NOT match the
// boundary, meaning the prefix is followed by some other character. For
// example, "--foobar" does not match "--foo". It returns 0 more input
// needs to be read to make the decision, meaning that len(buf) ==
// len(prefix) and readErr == nil.
export function matchAfterPrefix(buf: Uint8Array, prefix: Uint8Array, readErr: unknown): number {
  if (buf.length === prefix.length) {
    if (readErr !== undefined) {
      return +1;
    }
    return 0;
  }
  const c = buf[prefix.length] as number;

  if (c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a) {
    return +1;
  }

  // Try to detect boundaryDash
  if (c === 0x2d) {
    if (buf.length === prefix.length + 1) {
      if (readErr !== undefined) {
        // Prefix + "-" does not match
        return -1;
      }
      return 0;
    }
    if (buf[prefix.length + 1] === 0x2d) {
      return +1;
    }
  }

  return -1;
}

// stickyErrorReader is an io.Reader which never calls Read on its
// underlying Reader once an error has been seen. (the io.Reader
// interface's contract promises nothing about the return values of Read
// calls after an error, yet this package does do multiple Reads after
// error)
function stickyErrorReader(r: IoReader): IoReader {
  let stickyErr: unknown = undefined;
  return {
    async read(p) {
      if (stickyErr !== undefined) {
        return [0, stickyErr];
      }
      const [n, err] = await r.read(p);
      stickyErr = err;
      return [n, err];
    },
  };
}

// Form is a parsed multipart form. Its File parts are Web Files named by
// the part's FileName(); its Value parts are stored as strings. Both are
// keyed by field name.
export class Form {
  value = new Map<string, string[]>();
  file = new Map<string, FileHeader[]>();

  // RemoveAll removes any temporary files associated with a Form. Errors
  // other than a missing file are thrown (the first one).
  removeAll(): void {
    let first: unknown;
    for (const fhs of this.file.values()) {
      for (const fh of fhs) {
        if (fh.tmpfile !== "") {
          try {
            rmSync(fh.tmpfile);
          } catch (err) {
            if ((err as { code?: string }).code !== "ENOENT" && first === undefined) {
              first = err;
            }
          }
        }
      }
    }
    if (first !== undefined) {
      throw first;
    }
  }
}

// A FileHeader describes a file part of a multipart request.
export class FileHeader implements MultipartFileHeader {
  readonly filename: string;
  readonly header: MIMEHeader;
  size = 0;

  content: Uint8Array | null = null;
  tmpfile = "";
  tmpoff = 0;

  constructor(filename: string, header: MIMEHeader) {
    this.filename = filename;
    this.header = header;
  }
}

// os.CreateTemp(os.TempDir(), "multipart-"): a new file opened for
// writing (0600), named by the prefix and a random number
function createTemp(): { fd: number; name: string } {
  const dir = tmpdir();
  for (let tries = 0; ; tries++) {
    const name = join(dir, "multipart-" + String(crypto.getRandomValues(new Uint32Array(1))[0]));
    try {
      return { fd: openSync(name, "wx+", 0o600), name };
    } catch (err) {
      if ((err as { code?: string }).code === "EEXIST" && tries < 10000) {
        continue;
      }
      throw err;
    }
  }
}

// the size of the blocks a spilled file part is written in
const spillBlockSize = 256 << 10;

function writeAll(fd: number, p: Uint8Array): void {
  let off = 0;
  while (off < p.length) {
    off += writeSync(fd, p, off, p.length - off);
  }
}

// Reader is an iterator over parts in a MIME multipart body. Reader's
// underlying parser consumes its input as needed. Seeking isn't
// supported.
export class Reader {
  readonly bufReader: BufReader;
  // the buffer parts are copied and discarded through
  readonly copyBuf = new Uint8Array(copyBufferSize);

  #currentPart: Part | undefined;
  #partsRead = 0;

  nl: Uint8Array; // "\r\n" or "\n" (set after seeing first boundary line)
  nlDashBoundary: Uint8Array; // nl + "--boundary"
  readonly dashBoundaryDash: Uint8Array; // "--boundary--"
  readonly dashBoundary: Uint8Array; // "--boundary"

  // NewReader creates a new multipart Reader reading from r using the
  // given MIME boundary.
  constructor(r: IoReader, boundary: string) {
    const b = encoder.encode(`\r\n--${boundary}--`);
    this.bufReader = new BufReader(stickyErrorReader(r), peekBufferSize);
    this.nl = b.subarray(0, 2);
    this.nlDashBoundary = b.subarray(0, b.length - 2);
    this.dashBoundaryDash = b.subarray(2);
    this.dashBoundary = b.subarray(2, b.length - 2);
  }

  // NextPart returns the next part in the multipart or an error. When
  // there are no more parts, the error io.EOF is returned.
  //
  // As a special case, if the "Content-Transfer-Encoding" header has a
  // value of "quoted-printable", that header is instead hidden and the
  // body is transparently decoded during Read calls.
  nextPart(): Promise<[Part | undefined, unknown]> {
    return this.#nextPart(false, maxMIMEHeaderSize, maxMIMEHeaders);
  }

  // NextRawPart returns the next part in the multipart or an error. When
  // there are no more parts, the error io.EOF is returned.
  //
  // Unlike NextPart, it does not have special handling for
  // "Content-Transfer-Encoding: quoted-printable".
  nextRawPart(): Promise<[Part | undefined, unknown]> {
    return this.#nextPart(true, maxMIMEHeaderSize, maxMIMEHeaders);
  }

  async #nextPart(
    rawPart: boolean,
    headerSizeLimit: number,
    headerLimit: number,
  ): Promise<[Part | undefined, unknown]> {
    if (this.#currentPart !== undefined) {
      await this.#currentPart.close();
    }
    if (this.dashBoundary.length === 2) {
      return [undefined, new Error("multipart: boundary is empty")];
    }
    let expectNewPart = false;
    for (;;) {
      const [line, err] = await this.bufReader.readSlice(0x0a);

      if (err === EOF && this.#isFinalBoundary(line)) {
        // If the buffer ends in "--boundary--" without the
        // trailing "\r\n", ReadSlice will return an error
        // (since it's missing the '\n'), but this is a valid
        // multipart EOF so we need to return io.EOF instead of
        // a fmt-wrapped one.
        return [undefined, EOF];
      }
      if (err !== undefined) {
        return [undefined, new Error(`multipart: NextPart: ${errorText(err)}`, { cause: err })];
      }

      if (this.#isBoundaryDelimiterLine(line)) {
        this.#partsRead++;
        const [bp, partErr] = await newPart(this, rawPart, headerSizeLimit, headerLimit);
        if (partErr !== undefined) {
          return [undefined, partErr];
        }
        this.#currentPart = bp;
        return [bp, undefined];
      }

      if (this.#isFinalBoundary(line)) {
        // Expected EOF
        return [undefined, EOF];
      }

      if (expectNewPart) {
        return [undefined, new Error(`multipart: expecting a new Part; got line ${goQuote(line)}`)];
      }

      if (this.#partsRead === 0) {
        // skip line
        continue;
      }

      // Consume the "\n" or "\r\n" separator between the
      // body of the previous part and the boundary line we
      // now expect will follow. (either a new part or the
      // end boundary)
      if (bytesEqual(line, this.nl)) {
        expectNewPart = true;
        continue;
      }

      return [undefined, new Error(`multipart: unexpected line in Next(): ${goQuote(line)}`)];
    }
  }

  // isFinalBoundary reports whether line is the final boundary line
  // indicating that all parts are over.
  // It matches `^--boundary--[ \t]*(\r\n)?$`
  #isFinalBoundary(line: Uint8Array): boolean {
    if (!hasPrefix(line, this.dashBoundaryDash)) {
      return false;
    }
    const rest = skipLWSPChar(line.subarray(this.dashBoundaryDash.length));
    return rest.length === 0 || bytesEqual(rest, this.nl);
  }

  #isBoundaryDelimiterLine(line: Uint8Array): boolean {
    // https://tools.ietf.org/html/rfc2046#section-5.1
    //   The boundary delimiter line is then defined as a line
    //   consisting entirely of two hyphen characters ("-",
    //   decimal value 45) followed by the boundary parameter
    //   value from the Content-Type header field, optional linear
    //   whitespace, and a terminating CRLF.
    if (!hasPrefix(line, this.dashBoundary)) {
      return false;
    }
    const rest = skipLWSPChar(line.subarray(this.dashBoundary.length));

    // On the first part, see our lines are ending in \n instead of \r\n
    // and switch into that mode if so. This is a violation of the spec,
    // but occurs in practice.
    if (this.#partsRead === 0 && rest.length === 1 && rest[0] === 0x0a) {
      this.nl = this.nl.subarray(1);
      this.nlDashBoundary = this.nlDashBoundary.subarray(1);
    }
    return bytesEqual(rest, this.nl);
  }

  // ReadForm parses an entire multipart message whose parts have a
  // Content-Disposition of "form-data". It returns ErrMessageTooLarge if
  // all non-file parts can't be stored in maxMemory bytes + 10MB.
  async readForm(maxMemory: number): Promise<[Form | undefined, unknown]> {
    const form = new Form();
    let file: { fd: number; name: string } | undefined;
    let fileOff = 0;
    let result: [Form | undefined, unknown];
    try {
      result = await this.#readForm(
        form,
        maxMemory,
        () => {
          file ??= createTemp();
          return file;
        },
        (n) => {
          const off = fileOff;
          fileOff += n;
          return off;
        },
      );
    } catch (err) {
      result = [undefined, err];
    }
    if (file !== undefined) {
      try {
        closeSync(file.fd);
      } catch (err) {
        if (result[1] === undefined) {
          result = [undefined, err];
        }
      }
    }
    if (result[1] !== undefined) {
      try {
        form.removeAll();
      } catch {
        // the read error is the one returned
      }
      if (file !== undefined) {
        rmSync(file.name, { force: true });
      }
    }
    return result;
  }

  async #readForm(
    form: Form,
    maxMemory: number,
    tempFile: () => { fd: number; name: string },
    reserve: (n: number) => number,
  ): Promise<[Form | undefined, unknown]> {
    let maxParts = maxFormParts;
    let maxHeaders = maxMIMEHeaders;

    // maxFileMemoryBytes is the maximum bytes of file data we will store
    // in memory. Data past this limit is written to disk.
    //
    // maxMemoryBytes is the maximum bytes we will store in memory,
    // including file content, non-file part values, metadata, and map
    // entry overhead.
    //
    // We reserve an additional 10 MB in maxMemoryBytes for non-file data.
    if (maxMemory < 0) {
      maxMemory = 0;
    }
    let maxFileMemoryBytes = maxMemory;
    let maxMemoryBytes = maxMemory + (10 << 20);
    for (;;) {
      const [p, err] = await this.#nextPart(false, maxMemoryBytes, maxHeaders);
      if (err === EOF) {
        break;
      }
      if (err !== undefined) {
        return [undefined, err];
      }
      const part = p as Part;
      if (maxParts <= 0) {
        return [undefined, ErrMessageTooLarge];
      }
      maxParts--;

      const name = part.formName();
      if (name === "") {
        continue;
      }
      const filename = part.fileName();

      // Multiple values for the same key (one map entry, longer slice) are
      // cheaper than the same number of values for different keys (many
      // map entries), but using a consistent per-value cost for overhead
      // is simpler.
      const mapEntryOverhead = 200;
      maxMemoryBytes -= encoder.encode(name).length;
      maxMemoryBytes -= mapEntryOverhead;
      if (maxMemoryBytes < 0) {
        // We can't actually take this path, since nextPart would already
        // have rejected the MIME headers for being too large. Check
        // anyway.
        return [undefined, ErrMessageTooLarge];
      }

      const b = new BytesBuffer();

      if (filename === "") {
        // value, store as string in memory
        const [n, copyErr] = await copyN(b, part, maxMemoryBytes + 1, this.copyBuf);
        if (copyErr !== undefined && copyErr !== EOF) {
          return [undefined, copyErr];
        }
        maxMemoryBytes -= n;
        if (maxMemoryBytes < 0) {
          return [undefined, ErrMessageTooLarge];
        }
        appendValue(form.value, name, new TextDecoder().decode(b.bytes()));
        continue;
      }

      // file, store in memory or on disk
      const fileHeaderSize = 100;
      maxMemoryBytes -= mimeHeaderSize(part.header);
      maxMemoryBytes -= mapEntryOverhead;
      maxMemoryBytes -= fileHeaderSize;
      if (maxMemoryBytes < 0) {
        return [undefined, ErrMessageTooLarge];
      }
      for (const [, v] of part.header.entries()) {
        maxHeaders -= v.length;
      }
      const fh = new FileHeader(filename, part.header);
      const [n, copyErr] = await copyN(b, part, maxFileMemoryBytes + 1, this.copyBuf);
      if (copyErr !== undefined && copyErr !== EOF) {
        return [undefined, copyErr];
      }
      if (n > maxFileMemoryBytes) {
        const file = tempFile();
        for (const chunk of b.chunks) {
          writeAll(file.fd, chunk);
        }
        b.chunks.length = 0;
        // the part gives at most its peek buffer per read; the bytes are
        // written in larger blocks
        const block = new Uint8Array(spillBlockSize);
        let blockLen = 0;
        let remainingSize = 0;
        for (;;) {
          const [nr, er] = await part.read(block.subarray(blockLen));
          blockLen += nr;
          remainingSize += nr;
          if (blockLen === block.length || (er !== undefined && blockLen > 0)) {
            writeAll(file.fd, block.subarray(0, blockLen));
            blockLen = 0;
          }
          if (er !== undefined) {
            if (er !== EOF) {
              return [undefined, er];
            }
            break;
          }
        }
        fh.tmpfile = file.name;
        fh.size = n + remainingSize;
        fh.tmpoff = reserve(fh.size);
      } else {
        fh.content = b.bytes();
        fh.size = fh.content.length;
        maxFileMemoryBytes -= n;
        maxMemoryBytes -= n;
      }
      const files = form.file.get(name) ?? [];
      files.push(fh);
      form.file.set(name, files);
    }

    return [form, undefined];
  }
}

function appendValue(values: Map<string, string[]>, key: string, value: string): void {
  const list = values.get(key);
  if (list) {
    list.push(value);
  } else {
    values.set(key, [value]);
  }
}

function mimeHeaderSize(h: MIMEHeader): number {
  let size = 400;
  for (const [k, vs] of h.entries()) {
    size += k.length;
    size += 200; // map entry overhead
    for (const v of vs) {
      size += v.length;
    }
  }
  return size;
}

// skipLWSPChar returns b with leading spaces and tabs removed.
// RFC 822 defines:
//
//	LWSP-char = SPACE / HTAB
function skipLWSPChar(b: Uint8Array): Uint8Array {
  let i = 0;
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09)) {
    i++;
  }
  return b.subarray(i);
}
