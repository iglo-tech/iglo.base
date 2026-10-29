// Upstream: tools/filesystem/blob/bucket.go (adapted there from
// gocloud.dev/blob, Apache License 2.0, Copyright 2019 The Go Cloud
// Development Kit Authors), with the parts of blob/writer.go and
// blob/reader.go the local filesystem uses, and Go's mime.FormatMediaType
//
// Bucket provides an easy and portable way to interact with blobs within
// a "bucket": the key checks (valid UTF-8 keys and metadata), metadata
// key lower-casing, the content type normalization and the error wrapping
// ("[key: <key>] ..." and ErrNotFound) around a driver.
//
// Synchronous, as the driver (blob/driver.ts). Not ported: ListPage (the
// paged list API nothing in upstream calls), the sniffing writer
// (http.DetectContentType when no content type is given: every caller
// passes one) and WriterOptions.ContentMD5 (no caller sets it), the
// finalizer warnings for unclosed readers and writers, and the mutex
// (JavaScript runs one call at a time).

import { parseMediaType } from "@/server/request";
import type {
  Attributes,
  Driver,
  DriverReader,
  DriverWriter,
  ListObject,
  ListOptions,
  ListPage,
  ReaderAttributes,
} from "@/tools/filesystem/blob/driver";

// ErrNotFound: resource not found
export const ErrNotFound = new Error("resource not found");

// ErrClosed: bucket or blob is closed
export const ErrClosed = new Error("bucket or blob is closed");

// os.ErrNotExist
export const errNotExist = new Error("file does not exist");

// errors.Join(err, ErrNotFound)
export function joinNotFound(err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  return new AggregateError([e, ErrNotFound], `${e.message}\n${ErrNotFound.message}`);
}

// errors.Is(err, target): err, its causes and joined errors
export function errorsIs(err: unknown, target: unknown): boolean {
  if (err === target) {
    return true;
  }
  if (err instanceof AggregateError) {
    return err.errors.some((e) => errorsIs(e, target));
  }
  if (err instanceof Error && err.cause !== undefined) {
    return errorsIs(err.cause, target);
  }
  return false;
}

// errors.Is(err, ErrNotFound)
export function isNotFound(err: unknown): boolean {
  return errorsIs(err, ErrNotFound);
}

// utf8.ValidString for a Go string (an invalid byte is a lone surrogate)
export function validUTF8(s: string): boolean {
  return !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
}

// %q for the error texts
function q(s: string): string {
  return JSON.stringify(s);
}

// wrapError wraps err; a not found error is joined with ErrNotFound by
// the driver.
function wrapError(b: Driver, err: unknown, key: string): unknown {
  err = b.normalizeError(err);
  if (key !== "") {
    const e = err instanceof Error ? err : new Error(String(err));
    err = new Error(`[key: ${key}] ${e.message}`, { cause: e });
  }
  return err;
}

// ListIterator iterates over List results.
export class ListIterator {
  readonly #b: Bucket;
  readonly #opts: ListOptions;
  #page: ListPage | null = null;
  #nextIdx = 0;

  constructor(b: Bucket, opts: ListOptions) {
    this.#b = b;
    this.#opts = opts;
  }

  // Next returns a ListObject representing the next object, or null (Go's
  // io.EOF) if there are no more objects. Throws the list error.
  next(): ListObject | null {
    for (;;) {
      if (this.#page !== null) {
        // We've already got a page of results.
        if (this.#nextIdx < this.#page.objects.length) {
          // Next object is in the page; return it.
          const dobj = this.#page.objects[this.#nextIdx] as ListObject;
          this.#nextIdx++;
          return { ...dobj };
        }
        if (this.#page.nextPageToken === null || this.#page.nextPageToken === "") {
          // Done with current page, and there are no more; return io.EOF.
          return null;
        }
        // We need to load the next page.
        this.#opts.pageToken = this.#page.nextPageToken;
      }

      this.#b.checkOpen();

      // Loading a new page.
      try {
        this.#page = this.#b.drv.listPaged(this.#opts);
      } catch (err) {
        throw wrapError(this.#b.drv, err, "");
      }
      this.#nextIdx = 0;
    }
  }
}

// WriterOptions sets options for NewWriter.
export interface WriterOptions {
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  // ContentType specifies the MIME type of the blob being written (it
  // must be set: the sniffing writer is not ported).
  contentType: string;
  // Metadata holds key/value strings to be associated with the blob, or
  // null.
  metadata?: Map<string, string> | null;
}

// Writer writes bytes to a blob (Go's blob.Writer).
export interface Writer {
  write(p: Uint8Array): void;
  // completes the write; throws the write error
  close(): void;
  // abandons the write
  cancel(): void;
}

// Reader reads bytes from a blob (Go's blob.Reader).
export interface Reader {
  // reads up to p.length bytes into p; 0 at the end
  read(p: Uint8Array): number;
  close(): void;
  readonly contentType: string;
  readonly modTime: bigint;
  readonly size: number;
}

// Bucket provides an easy and portable way to interact with blobs within
// a "bucket", including read, write, and list operations.
export class Bucket {
  readonly drv: Driver;
  #closed = false;

  // NewBucket is intended for use by drivers only.
  constructor(drv: Driver) {
    this.drv = drv;
  }

  checkOpen(): void {
    if (this.#closed) {
      throw ErrClosed;
    }
  }

  // List returns a ListIterator that can be used to iterate over blobs in
  // a bucket, in lexicographical order of UTF-8 encoded keys.
  list(opts: { prefix?: string; delimiter?: string } = {}): ListIterator {
    return new ListIterator(this, {
      prefix: opts.prefix ?? "",
      delimiter: opts.delimiter ?? "",
      pageSize: 0,
      pageToken: null,
    });
  }

  // Attributes returns attributes for the blob stored at key.
  //
  // If the blob does not exist, Attributes returns an error for which
  // isNotFound returns true.
  attributes(key: string): Attributes {
    if (!validUTF8(key)) {
      throw new Error(`Attributes key must be a valid UTF-8 string: ${q(key)}`);
    }

    this.checkOpen();

    let a: Attributes;
    try {
      a = this.drv.attributes(key);
    } catch (err) {
      throw wrapError(this.drv, err, key);
    }

    let md: Map<string, string> | null = null;
    if (a.metadata !== null && a.metadata.size > 0) {
      md = new Map();
      for (const [k, v] of a.metadata) {
        md.set(k.toLowerCase(), v);
      }
    }

    return { ...a, metadata: md };
  }

  // Exists returns true if a blob exists at key, false if it does not
  // exist. Throws any other error.
  exists(key: string): boolean {
    try {
      this.attributes(key);
      return true;
    } catch (err) {
      if (isNotFound(err)) {
        return false;
      }
      throw err;
    }
  }

  // NewReader is a shortcut for NewRangeReader with offset=0 and
  // length=-1.
  newReader(key: string): Reader {
    return this.newRangeReader(key, 0, -1);
  }

  // NewRangeReader returns a Reader to read content from the blob stored
  // at key. It reads at most length bytes starting at offset (>= 0). If
  // length is negative, it will read till the end of the blob.
  newRangeReader(key: string, offset: number, length: number): Reader {
    this.checkOpen();

    if (offset < 0) {
      throw new Error(`NewRangeReader offset must be non-negative (${offset})`);
    }
    if (!validUTF8(key)) {
      throw new Error(`NewRangeReader key must be a valid UTF-8 string: ${q(key)}`);
    }

    let dr: DriverReader;
    try {
      dr = this.drv.newRangeReader(key, offset, length);
    } catch (err) {
      throw wrapError(this.drv, err, key);
    }

    const attrs: ReaderAttributes = dr.attributes();
    const drv = this.drv;
    return {
      read(p: Uint8Array): number {
        try {
          return dr.read(p);
        } catch (err) {
          throw wrapError(drv, err, key);
        }
      },
      close(): void {
        dr.close();
      },
      contentType: attrs.contentType,
      modTime: attrs.modTime,
      size: attrs.size,
    };
  }

  // NewWriter returns a Writer that writes to the blob stored at key. A
  // blob stored at key will be replaced after the Writer is closed.
  newWriter(key: string, opts: WriterOptions): Writer {
    if (!validUTF8(key)) {
      throw new Error(`NewWriter key must be a valid UTF-8 string: ${q(key)}`);
    }

    let md: Map<string, string> | null = null;
    if (opts.metadata !== undefined && opts.metadata !== null && opts.metadata.size > 0) {
      md = new Map();
      for (const [k, v] of opts.metadata) {
        if (k === "") {
          throw new Error("WriterOptions.Metadata keys may not be empty strings");
        }
        if (!validUTF8(k)) {
          throw new Error(`WriterOptions.Metadata keys must be valid UTF-8 strings: ${q(k)}`);
        }
        if (!validUTF8(v)) {
          throw new Error(`WriterOptions.Metadata values must be valid UTF-8 strings: ${q(v)}`);
        }
        const lowerK = k.toLowerCase();
        if (md.has(lowerK)) {
          throw new Error(
            `WriterOptions.Metadata has a duplicate case-insensitive metadata key: ${q(lowerK)}`,
          );
        }
        md.set(lowerK, v);
      }
    }

    this.checkOpen();

    if (opts.contentType === "") {
      throw new Error("blob: a content type is required (content type sniffing is not ported)");
    }
    const parsed = parseMediaType(opts.contentType);
    if ("err" in parsed) {
      throw parsed.err;
    }
    const ct = formatMediaType(parsed.mediaType, parsed.params);

    let dw: DriverWriter;
    try {
      dw = this.drv.newTypedWriter(key, ct, {
        cacheControl: opts.cacheControl ?? "",
        contentDisposition: opts.contentDisposition ?? "",
        contentEncoding: opts.contentEncoding ?? "",
        contentLanguage: opts.contentLanguage ?? "",
        metadata: md,
      });
    } catch (err) {
      throw wrapError(this.drv, err, key);
    }

    const drv = this.drv;
    return {
      write(p: Uint8Array): void {
        try {
          dw.write(p);
        } catch (err) {
          throw wrapError(drv, err, key);
        }
      },
      close(): void {
        try {
          dw.close();
        } catch (err) {
          throw wrapError(drv, err, key);
        }
      },
      cancel(): void {
        dw.cancel();
      },
    };
  }

  // Copy the blob stored at srcKey to dstKey. A nonexistent source object
  // fails with an error for which isNotFound returns true. If the
  // destination blob already exists, it is overwritten.
  copy(dstKey: string, srcKey: string): void {
    if (!validUTF8(srcKey)) {
      throw new Error(`Copy srcKey must be a valid UTF-8 string: ${q(srcKey)}`);
    }
    if (!validUTF8(dstKey)) {
      throw new Error(`Copy dstKey must be a valid UTF-8 string: ${q(dstKey)}`);
    }

    this.checkOpen();

    try {
      this.drv.copy(dstKey, srcKey);
    } catch (err) {
      throw wrapError(this.drv, err, `${srcKey} -> ${dstKey}`);
    }
  }

  // Delete deletes the blob stored at key. A nonexistent blob fails with
  // an error for which isNotFound returns true.
  delete(key: string): void {
    if (!validUTF8(key)) {
      throw new Error(`Delete key must be a valid UTF-8 string: ${q(key)}`);
    }

    this.checkOpen();

    try {
      this.drv.delete(key);
    } catch (err) {
      throw wrapError(this.drv, err, key);
    }
  }

  // Close releases any resources used for the bucket.
  close(): void {
    const prev = this.#closed;
    this.#closed = true;
    if (prev) {
      throw ErrClosed;
    }
    this.drv.close();
  }
}

// -------------------------------------------------------------------
// mime.FormatMediaType

// tspecials: the characters that need quoting in parameter values
const tspecials = '()<>@,;:\\"/[]?=';

function isTokenChar(c: number): boolean {
  return c > 0x20 && c < 0x7f && !tspecials.includes(String.fromCharCode(c));
}

function isToken(s: string): boolean {
  if (s === "") {
    return false;
  }
  for (let i = 0; i < s.length; i++) {
    if (!isTokenChar(s.charCodeAt(i))) {
      return false;
    }
  }
  return true;
}

// needsEncoding reports whether value contains bytes outside the
// printable ASCII range (tab allowed).
function needsEncoding(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 || c > 0x7e) && c !== 0x09) {
      return true;
    }
  }
  return false;
}

// FormatMediaType serializes mediatype t and the parameters param as a
// media type conforming to RFC 2045 and RFC 2616. The type and parameter
// names are written in lower-case. When any of the arguments result in a
// standard violation then FormatMediaType returns the empty string.
export function formatMediaType(t: string, param: Map<string, string>): string {
  let b = "";
  const slash = t.indexOf("/");
  if (slash === -1) {
    if (!isToken(t)) {
      return "";
    }
    b += t.toLowerCase();
  } else {
    const major = t.slice(0, slash);
    const sub = t.slice(slash + 1);
    if (!isToken(major) || !isToken(sub)) {
      return "";
    }
    b += major.toLowerCase() + "/" + sub.toLowerCase();
  }

  const attrs = [...param.keys()].toSorted((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  for (const attribute of attrs) {
    const value = param.get(attribute) ?? "";
    b += "; ";
    if (!isToken(attribute)) {
      return "";
    }
    b += attribute.toLowerCase();

    const needEnc = needsEncoding(value);
    if (needEnc) {
      // RFC 2231 section 4
      b += "*";
    }
    b += "=";

    if (needEnc) {
      b += "utf-8''";
      for (const ch of new TextEncoder().encode(value)) {
        if (
          ch <= 0x20 ||
          ch >= 0x7f ||
          ch === 0x2a ||
          ch === 0x27 ||
          ch === 0x25 ||
          tspecials.includes(String.fromCharCode(ch))
        ) {
          b += "%" + ch.toString(16).toUpperCase().padStart(2, "0");
        } else {
          b += String.fromCharCode(ch);
        }
      }
      continue;
    }

    if (isToken(value)) {
      b += value;
      continue;
    }

    b += '"';
    for (const ch of value) {
      if (ch === '"' || ch === "\\") {
        b += "\\";
      }
      b += ch;
    }
    b += '"';
  }
  return b;
}
