// Upstream: tools/filesystem/file.go
//
// A File's reader is Go's FileReader: Open() gives a synchronous reader of
// the content (PathReader for a local path, BytesReader for bytes,
// MultipartReader for a multipart form part, kept in memory or in a
// section of the form's temporary file, as Go's multipart.FileHeader).
// Reads are synchronous so that the blob store (filesystem.ts) can store a
// File from inside a write transaction, as upstream does (D8). `reader`
// also gives the content as a Blob (a Bun.file for a path or a temporary
// file section).
//
// Go's mimetype.DetectReader(reader) is called by the name normalization
// and by the upload MIME type check (src/validators/file.ts), and the
// field validation that runs that check is synchronous. The constructors
// read the first mimetype.defaultLimit bytes once, when the File is
// created (the same bytes DetectReader reads; a read error is kept and
// returned instead), and detect() runs the detection on them. Bytes and a
// multipart part do not change, so the result is the one a later read
// would give. A local path can change after the File is created, and Go's
// PathReader opens the path again on every read, so a path-backed File
// reads its first bytes again each time detect() is called.
//
// File names are Go strings: the name cut at 300 bytes and the extension
// and name rules work on UTF-8 bytes, with invalid bytes (a cut inside a
// multi-byte character) as lone surrogates U+DC80+n, as in
// src/tools/types/go-json.ts.
//
// The constructors are async (Go returns an error where they throw). Not
// ported: NewFileFromURL, which downloads the file and has no caller (OAuth2
// avatars use src/oauth2/safe-file.ts), and openFuncAsReader (GetReuploadableFile, filesystem.ts, uses
// a PathReader of the stored file).

import { closeSync, openSync, readSync } from "node:fs";
import { stat } from "node:fs/promises";

import type { MIME } from "@/tools/mimetype/mime";
import { defaultLimit, detect } from "@/tools/mimetype/mimetype";
import { errMIME } from "@/tools/mimetype/tree";
import { snakecase } from "@/tools/inflector/inflector";
import { mustCompile } from "@/tools/regexp/regexp";
import { randomStringWithAlphabet } from "@/tools/security/random";
import { bytesToText, textToBytes } from "@/tools/types/go-json";

// RandomSource returns a random string of length characters from alphabet
// (security.RandomStringWithAlphabet by default; tests inject their own).
export type RandomSource = (length: number, alphabet: string) => string;

export interface FileOptions {
  // the source of the random name parts
  random?: RandomSource;
}

// An open file content (Go's io.ReadSeekCloser, without Seek: a reader is
// opened again to read from the start).
export interface ReadCloser {
  // reads up to p.length bytes into p; 0 at the end of the content.
  // Throws a read error.
  read(p: Uint8Array): number;
  close(): void;
}

// FileReader defines an interface for a file resource reader.
export interface FileReader {
  // Open opens the content for reading. Throws the open error.
  open(): ReadCloser;
  // the content as a Blob
  blob(): Blob;
}

// PathReader is a FileReader of a local file path.
export class PathReader implements FileReader {
  constructor(readonly path: string) {}

  // Open implements the [FileReader] interface.
  open(): ReadCloser {
    return new fdReader(openSync(this.path, "r"), 0, Number.POSITIVE_INFINITY);
  }

  blob(): Blob {
    return Bun.file(this.path);
  }
}

// BytesReader is a FileReader of bytes.
export class BytesReader implements FileReader {
  #blob: Blob | undefined;

  constructor(readonly bytes: Uint8Array) {}

  // Open implements the [FileReader] interface.
  open(): ReadCloser {
    const bytes = this.bytes;
    let offset = 0;
    return {
      read(p: Uint8Array): number {
        const n = Math.min(p.length, bytes.length - offset);
        p.set(bytes.subarray(offset, offset + n));
        offset += n;
        return n;
      },
      close(): void {},
    };
  }

  blob(): Blob {
    this.#blob ??= new Blob([this.bytes as Uint8Array<ArrayBuffer>]);
    return this.#blob;
  }
}

// The multipart.FileHeader members a MultipartReader reads: the part's
// content in memory, or its section of the form's temporary file
// (src/server/multipart.ts).
export interface MultipartFileHeader {
  // Filename: the part's file name (Part.FileName())
  readonly filename: string;
  readonly size: number;
  // the content kept in memory, or null when it is in tmpfile
  readonly content: Uint8Array | null;
  readonly tmpfile: string;
  readonly tmpoff: number;
}

// MultipartReader is a FileReader of a multipart form file part.
export class MultipartReader implements FileReader {
  #bytes: BytesReader | undefined;

  constructor(readonly header: MultipartFileHeader) {
    if (header.content !== null) {
      this.#bytes = new BytesReader(header.content);
    }
  }

  // Open implements the [FileReader] interface.
  open(): ReadCloser {
    if (this.#bytes !== undefined) {
      return this.#bytes.open();
    }
    const h = this.header;
    return new fdReader(openSync(h.tmpfile, "r"), h.tmpoff, h.size);
  }

  blob(): Blob {
    if (this.#bytes !== undefined) {
      return this.#bytes.blob();
    }
    const h = this.header;
    return Bun.file(h.tmpfile).slice(h.tmpoff, h.tmpoff + h.size);
  }
}

// a file descriptor read from offset, at most limit bytes
class fdReader implements ReadCloser {
  #fd: number | null;
  #position: number;
  #remaining: number;

  constructor(fd: number, offset: number, limit: number) {
    this.#fd = fd;
    this.#position = offset;
    this.#remaining = limit;
  }

  read(p: Uint8Array): number {
    if (this.#fd === null) {
      throw new Error("read: file already closed");
    }
    const want = Math.min(p.length, this.#remaining);
    if (want <= 0) {
      return 0;
    }
    const n = readSync(this.#fd, p, 0, want, this.#position);
    this.#position += n;
    this.#remaining -= n;
    return n;
  }

  close(): void {
    if (this.#fd !== null) {
      const fd = this.#fd;
      this.#fd = null;
      closeSync(fd);
    }
  }
}

// a Blob reader for the Files tests build directly: its content can only
// be read asynchronously, so Open fails
class blobReader implements FileReader {
  constructor(readonly content: Blob) {}

  open(): ReadCloser {
    throw new Error("the content of a Blob cannot be read synchronously");
  }

  blob(): Blob {
    return this.content;
  }
}

// File defines a single file resource.
//
// The file could be from a local path, multipart/form-data header, etc.
//
// JSON: {"name","originalName","size"}, as Go's struct tags (the reader
// is `json:"-"`); the members are the File's only enumerable properties,
// and their sorted order is the struct order.
export class File {
  readonly #reader: FileReader;
  readonly #head: Uint8Array | Error;

  name: string;
  originalName: string;
  size: number;

  constructor(
    reader: FileReader | Blob,
    head: Uint8Array | Error,
    name: string,
    originalName: string,
    size: number,
  ) {
    this.#reader = reader instanceof Blob ? new blobReader(reader) : reader;
    this.#head = head;
    this.name = name;
    this.originalName = originalName;
    this.size = size;
  }

  // Reader: the content as a Blob.
  get reader(): Blob {
    return this.#reader.blob();
  }

  // Reader.Open(): the content, read synchronously. Throws the open error.
  open(): ReadCloser {
    return this.#reader.open();
  }

  // mimetype.DetectReader(reader): the MIME type of the content, from the
  // bytes read when the File was created, and the read error (with
  // application/octet-stream) if that read failed.
  detect(): [MIME, Error | null] {
    const head = this.#reader instanceof PathReader ? readHead(this.#reader) : this.#head;
    if (head instanceof Error) {
      return [errMIME, head];
    }
    return [detect(head), null];
  }

  // AsMap implements [core.mapExtractor] and returns a value suitable to be
  // used in an API rule expression.
  asMap(): Record<string, unknown> {
    return {
      name: this.name,
      originalName: this.originalName,
      size: this.size,
    };
  }
}

// readHead opens reader and reads the first bytes DetectReader reads (Go's
// io.ReadFull of them), or returns the open or read error.
export function readHead(reader: FileReader): Uint8Array | Error {
  let r: ReadCloser;
  try {
    r = reader.open();
  } catch (err) {
    return toError(err);
  }
  try {
    const buf = new Uint8Array(defaultLimit);
    let n = 0;
    while (n < buf.length) {
      const read = r.read(buf.subarray(n));
      if (read === 0) {
        break;
      }
      n += read;
    }
    return buf.subarray(0, n);
  } catch (err) {
    return toError(err);
  } finally {
    try {
      r.close();
    } catch {
      // the read result stands
    }
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// newFile builds a File of reader (head: its first bytes, read now unless
// given)
export function newFile(
  reader: FileReader,
  originalName: string,
  size: number,
  opts: FileOptions,
  head: Uint8Array | Error = readHead(reader),
): File {
  const name = normalizeName(head, originalName, opts.random ?? randomStringWithAlphabet);
  return new File(reader, head, name, originalName, size);
}

// NewFileFromPath creates a new File instance from the provided local file
// path. Throws when the file cannot be stat-ed (os.Stat's error).
export async function NewFileFromPath(path: string, opts: FileOptions = {}): Promise<File> {
  const info = await stat(path);
  return newFile(new PathReader(path), goBase(path), Number(info.size), opts);
}

// NewFileFromBytes creates a new File instance from the provided byte
// slice. Throws for empty bytes.
export async function NewFileFromBytes(
  b: Uint8Array | null,
  name: string,
  opts: FileOptions = {},
): Promise<File> {
  const size = b?.length ?? 0;
  if (b === null || size === 0) {
    throw new Error("cannot create an empty file");
  }

  return newFile(new BytesReader(b), name, size, opts);
}

// NewFileFromMultipart creates a new File from the provided multipart
// header: a form file part of src/server/multipart.ts (Go's
// multipart.FileHeader), or a Web File (from Bun's formData(), read into
// memory here).
//
// Go's FileHeader.Filename is Part.FileName(): the directory parts of the
// submitted file name are dropped (filepath.Base, RFC 7578 section 4.2).
// A Web File keeps them, so they are dropped here (the multipart reader's
// files are already named by FileName()).
export async function NewFileFromMultipart(
  mh: MultipartFileHeader | globalThis.File,
  opts: FileOptions = {},
): Promise<File> {
  if (mh instanceof globalThis.File) {
    const filename = mh.name === "" ? "" : goBase(mh.name);
    const content = new Uint8Array(await mh.arrayBuffer());
    return newFile(new BytesReader(content), filename, mh.size, opts);
  }
  return newFile(new MultipartReader(mh), mh.filename, mh.size, opts);
}

// path/filepath.Base on Unix: the last element of path, after trailing
// slashes are removed ("." for "", "/" for only slashes).
export function goBase(path: string): string {
  if (path === "") {
    return ".";
  }
  // strip trailing slashes
  while (path.length > 0 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  // find the last element
  const i = path.lastIndexOf("/");
  if (i >= 0) {
    path = path.slice(i + 1);
  }
  // if empty now, it had only slashes
  if (path === "") {
    return "/";
  }
  return path;
}

// -------------------------------------------------------------------

const extInvalidCharsRegex = mustCompile(String.raw`[^\w\.\*\-\+\=\#]+`);

const randomAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789";

// normalizeName returns the stored name of an uploaded file: the cleaned
// base name, "_", 10 random characters and the cleaned extension.
// Exported for the tests of the name rules.
export function normalizeName(
  head: Uint8Array | Error,
  name: string,
  random: RandomSource = randomStringWithAlphabet,
): string {
  // cut the name even if it is not multibyte safe to avoid operating on too large strings
  // ---
  const nameBytes = textToBytes(name);
  const originalLength = nameBytes.length;
  if (originalLength > 300) {
    name = bytesToText(nameBytes.subarray(originalLength - 300));
  }

  // extension
  // ---
  const originalExt = extractExtension(name);
  let cleanExt = "." + trimDots(extInvalidCharsRegex.replaceAllString(originalExt, ""));
  if (cleanExt === ".") {
    // try to detect the extension from the file content
    cleanExt = detectExtension(head);
  }
  // the extension is ASCII here (the regex removed everything else, and
  // the detected extensions are ASCII), so its length is its byte length
  const extLength = cleanExt.length;
  if (extLength > 20) {
    // keep only the last 20 characters (it is multibyte safe after the regex replace)
    cleanExt = "." + trimDots(cleanExt.slice(extLength - 20));
  }

  // name
  //
  // note: leading dot is trimmed to prevent various subtle issues with files
  // sync programs as they sometimes have special handling for "invisible" files
  // ---
  // (originalExt is always a suffix of name: strings.TrimSuffix)
  let cleanName = snakecase(trimDots(name.slice(0, name.length - originalExt.length)));
  // Snakecase keeps only ASCII letters, digits and "_"
  const length = cleanName.length;
  if (length < 3) {
    // the name is too short so we concatenate an additional random part
    cleanName += random(10, randomAlphabet);
  } else if (length > 100) {
    // keep only the first 100 characters (it is multibyte safe after Snakecase)
    cleanName = cleanName.slice(0, 100);
  }

  return (
    cleanName +
    "_" +
    random(10, randomAlphabet) + // ensure that there is always a random part
    cleanExt
  );
}

// strings.Trim(s, ".")
function trimDots(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === ".") {
    start++;
  }
  while (end > start && s[end - 1] === ".") {
    end--;
  }
  return s.slice(start, end);
}

// extractExtension extracts the extension (with leading dot) from name.
//
// This differ from filepath.Ext() by supporting double extensions (eg.
// ".tar.gz").
//
// Returns an empty string if no match is found.
//
// Example:
// extractExtension("test.txt")      // .txt
// extractExtension("test.tar.gz")   // .tar.gz
// extractExtension("test.a.tar.gz") // .tar.gz
export function extractExtension(name: string): string {
  const primaryDot = name.lastIndexOf(".");

  if (primaryDot === -1) {
    return "";
  }

  // look for secondary extension
  const secondaryDot = name.lastIndexOf(".", primaryDot - 1);
  if (primaryDot > 0 && secondaryDot >= 0) {
    return name.slice(secondaryDot);
  }

  return name.slice(primaryDot);
}

// detectExtension tries to detect the extension from file mime type ("" when
// the content could not be read).
function detectExtension(head: Uint8Array | Error): string {
  if (head instanceof Error) {
    return "";
  }

  return detect(head).extension();
}
