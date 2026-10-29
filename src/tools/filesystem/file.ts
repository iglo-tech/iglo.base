// Upstream: tools/filesystem/file.go
//
// A File's reader (Go's FileReader with its PathReader, MultipartReader and
// BytesReader) is a Blob: a Bun.file for a local path, the File of a
// multipart form part, or a Blob of the bytes. The storage side (upload,
// delete, thumbnails) comes with M3.2.
//
// Go's mimetype.DetectReader(reader) is called by the name normalization
// and by the upload MIME type check (src/validators/file.ts), and the
// field validation that runs that check is synchronous. A Blob can only be
// read asynchronously, so the constructors read the first
// mimetype.defaultLimit bytes once, when the File is created (the same
// bytes DetectReader reads; a read error is kept and returned instead),
// and detect() runs the detection on them. A multipart part or a Blob of
// bytes does not change, so the result is the one a later read would give.
// A local path can change after the File is created, and Go's PathReader
// opens the path again on every read, so a path-backed File reads its
// first bytes again, synchronously, each time detect() is called.
//
// File names are Go strings: the name cut at 300 bytes and the extension
// and name rules work on UTF-8 bytes, with invalid bytes (a cut inside a
// multi-byte character) as lone surrogates U+DC80+n, as in
// src/tools/types/go-json.ts.
//
// The constructors are async (they read the head of the content) and
// throw where Go returns an error. Not ported: NewFileFromURL, which
// downloads the file (M4.5, for OAuth2 avatars), and openFuncAsReader.

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

// File defines a single file resource.
//
// The file could be from a local path, multipart/form-data header, etc.
//
// JSON: {"name","originalName","size"}, as Go's struct tags (the reader
// is `json:"-"`); the members are the File's only enumerable properties,
// and their sorted order is the struct order.
export class File {
  readonly #reader: Blob;
  readonly #head: Uint8Array | Error;
  // the local path of a path-backed File (Go's PathReader), read again on
  // every detect()
  readonly #path: string | null;

  name: string;
  originalName: string;
  size: number;

  constructor(
    reader: Blob,
    head: Uint8Array | Error,
    name: string,
    originalName: string,
    size: number,
    path: string | null = null,
  ) {
    this.#reader = reader;
    this.#head = head;
    this.#path = path;
    this.name = name;
    this.originalName = originalName;
    this.size = size;
  }

  // Reader: the file content.
  get reader(): Blob {
    return this.#reader;
  }

  // mimetype.DetectReader(reader): the MIME type of the content, from the
  // bytes read when the File was created, and the read error (with
  // application/octet-stream) if that read failed.
  detect(): [MIME, Error | null] {
    const head = this.#path === null ? this.#head : readPathHead(this.#path);
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

// the first bytes DetectReader reads, or the read error
async function readHead(reader: Blob): Promise<Uint8Array | Error> {
  try {
    return new Uint8Array(await reader.slice(0, defaultLimit).arrayBuffer());
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

// os.Open(path) and io.ReadFull of the first DetectReader bytes, or the
// open or read error
function readPathHead(path: string): Uint8Array | Error {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  try {
    const buf = new Uint8Array(defaultLimit);
    let n = 0;
    while (n < buf.length) {
      const read = readSync(fd, buf, n, buf.length - n, n);
      if (read === 0) {
        break;
      }
      n += read;
    }
    return buf.subarray(0, n);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  } finally {
    closeSync(fd);
  }
}

async function newFile(
  reader: Blob,
  originalName: string,
  size: number,
  opts: FileOptions,
  path: string | null = null,
): Promise<File> {
  const head = path === null ? await readHead(reader) : readPathHead(path);
  const name = normalizeName(head, originalName, opts.random ?? randomStringWithAlphabet);
  return new File(reader, head, name, originalName, size, path);
}

// NewFileFromPath creates a new File instance from the provided local file
// path. Throws when the file cannot be stat-ed (os.Stat's error).
export async function NewFileFromPath(path: string, opts: FileOptions = {}): Promise<File> {
  const info = await stat(path);
  return newFile(Bun.file(path), goBase(path), Number(info.size), opts, path);
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

  return newFile(new Blob([b]), name, size, opts);
}

// NewFileFromMultipart creates a new File from the provided multipart
// part (Go's multipart.FileHeader).
//
// Go's FileHeader.Filename is Part.FileName(): the directory parts of the
// submitted file name are dropped (filepath.Base, RFC 7578 section 4.2).
// A Web File from Bun's formData() keeps them, so they are dropped here
// (the multipart reader's files are already named by FileName()).
export async function NewFileFromMultipart(
  part: globalThis.File,
  opts: FileOptions = {},
): Promise<File> {
  const filename = part.name === "" ? "" : goBase(part.name);
  return newFile(part, filename, part.size, opts);
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
