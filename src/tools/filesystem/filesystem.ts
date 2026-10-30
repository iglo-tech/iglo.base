// Upstream: tools/filesystem/filesystem.go (the local storage parts:
// NewLocal, Close, Exists, Attributes, GetReader, GetReuploadableFile,
// Copy, List, Upload, UploadFile, NewWriter, Delete, DeletePrefix,
// IsEmptyDir; Serve, inlineServeContentTypes,
// manualExtensionContentTypes; ThumbSizeRegex, CreateThumb)
//
// System is the local file storage under pb_data/storage
// (internal/fileblob). Its calls are synchronous, so the file field can
// store and delete files from inside a write transaction as upstream does
// (D8). DeletePrefix can also run as a generator that yields after each
// page of deleted files (deletePrefixSteps), so a background delete of a
// large directory gives the event loop back between pages.
//
// Serve streams the stored file (a Blob of the local file) through Go's
// http.ServeContent rules (src/server/serve-content.ts). CreateThumb reads
// the original and stores the thumb here; the image work itself is
// passed in (the file API's worker pool, src/files/thumb-pool.ts), as it
// runs off the main thread.
//
// Not ported: NewS3 (M5.4), the deprecated GetFile, UploadMultipart (a multipart part is a File here and
// goes through UploadFile, with the same result), SetContext (no
// contexts), and the OnNewWriter and OnDelete hooks (D5). Go's
// filesystem.ErrNotFound is blob.ErrNotFound; callers check it with
// isNotFound (blob/bucket.ts).

import { mkdirSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  Bucket,
  type Reader,
  type Writer,
  type WriterOptions,
} from "@/tools/filesystem/blob/bucket";
import type { Attributes, ListObject } from "@/tools/filesystem/blob/driver";
import { New as newFileblob } from "@/tools/filesystem/internal/fileblob/fileblob";
import {
  File,
  type FileReader,
  normalizeName,
  readHead,
  type ReadCloser,
} from "@/tools/filesystem/file";
import { goQuote } from "@/fields/field";
import { checkSource } from "@/files/create-thumb";
import { gifFirstFrameLength, readerSource, webpCheckImageChunk } from "@/files/image-config";
import type { ThumbSize } from "@/files/imaging";
import type { HttpRequest } from "@/server/request";
import type { ResponseWriter } from "@/server/router";
import { serveContent } from "@/server/serve-content";
import { detect } from "@/tools/mimetype/mimetype";
import { mustCompile } from "@/tools/regexp/regexp";
import { bytesToText, textToBytes } from "@/tools/types/go-json";

export const ThumbSizeRegex = mustCompile(String.raw`^(\d+)x(\d+)(t|b|f)?$`);

const inlineServeContentTypes = [
  // image
  "image/png",
  "image/jpg",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/x-icon",
  "image/bmp",
  // video
  "video/webm",
  "video/mp4",
  "video/3gpp",
  "video/quicktime",
  "video/x-ms-wmv",
  // audio
  "audio/basic",
  "audio/aiff",
  "audio/mpeg",
  "audio/midi",
  "audio/mp3",
  "audio/wave",
  "audio/wav",
  "audio/x-wav",
  "audio/x-mpeg",
  "audio/x-m4a",
  "audio/aac",
  // document
  "application/pdf",
  "application/x-pdf",
];

// manualExtensionContentTypes is a map of file extensions to content types.
const manualExtensionContentTypes = new Map([
  // https://github.com/whatwg/mimesniff/issues/7
  [".svg", "image/svg+xml"],

  // https://github.com/gabriel-vasile/mimetype/pull/113
  [".css", "text/css"],

  // https://ganigeorgiev.com/pocketbase/discussions/6597
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],

  // https://ganigeorgiev.com/pocketbase/discussions/7467
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
]);

// forceAttachmentParam is the name of the request query parameter to
// force "Content-Disposition: attachment" header.
const forceAttachmentParam = "download";

// a rendered thumb (src/files/create-thumb.ts)
export interface ThumbImage {
  bytes: Uint8Array;
  contentType: string;
}

// makes the thumb of an original's bytes and stored content type
export interface ThumbRenderer {
  // PB_THUMBS_MAX_SOURCE_PIXELS, checked before the original is read whole
  maxSourcePixels(): number;
  render(input: Uint8Array, contentType: string, size: ThumbSize): Promise<ThumbImage>;
}

export const MetadataOriginalName = "original-filename";

// pb_data's temp directory (core.LocalTempDirName in src/app/bootstrap.ts,
// which imports this module), beside the storage directory
const localTempDirName = ".pb_temp_to_delete";

// the pieces a spooled multipart/byteranges body is copied in
const spoolChunk = 1 << 20;

// the size of the blocks UploadFile copies
const uploadBufferSize = 1 << 20;

// the number of objects DeletePrefix deletes between two yields (the
// driver's list page size)
const deletePageSize = 1000;

export class System {
  readonly #bucket: Bucket;
  // the directory of a local storage, for Blob views of its files
  readonly #localDir: string;

  constructor(bucket: Bucket, localDir: string) {
    this.#bucket = bucket;
    this.#localDir = localDir;
  }

  // Close releases any resources used for the related filesystem.
  close(): void {
    this.#bucket.close();
  }

  // Exists checks if file with fileKey path exists or not.
  exists(fileKey: string): boolean {
    return this.#bucket.exists(fileKey);
  }

  // Attributes returns the attributes for the file with fileKey path.
  //
  // If the file doesn't exist it throws an error for which isNotFound is
  // true.
  attributes(fileKey: string): Attributes {
    return this.#bucket.attributes(fileKey);
  }

  // GetReader returns a file content reader for the given fileKey.
  //
  // NB! Make sure to call close() on the reader after you are done working
  // with it.
  //
  // If the file doesn't exist it throws an error for which isNotFound is
  // true.
  getReader(fileKey: string): Reader {
    return this.#bucket.newReader(fileKey);
  }

  // GetReuploadableFile constructs a new reuploadable File value from the
  // associated fileKey blob.Reader.
  //
  // If preserveName is false then the returned File.Name will have a new
  // randomly generated suffix, otherwise it will reuse the original one.
  //
  // This method could be useful in case you want to clone an existing
  // Record file and assign it to a new Record (e.g. in a Record duplicate
  // action).
  //
  // If you simply want to copy an existing file to a new location you
  // could check the Copy(srcKey, dstKey) method.
  getReuploadableFile(fileKey: string, preserveName: boolean): File {
    const attrs = this.attributes(fileKey);

    const name = pathBase(fileKey);
    let originalName = attrs.metadata?.get(MetadataOriginalName) ?? "";
    if (originalName === "") {
      originalName = name;
    }

    const reader: FileReader = {
      open: (): ReadCloser => this.getReader(fileKey),
      blob: (): Blob => this.#blob(fileKey),
    };
    const head = readHead(reader);

    return new File(
      reader,
      head,
      preserveName ? name : normalizeName(head, originalName),
      originalName,
      attrs.size,
    );
  }

  // Copy copies the file stored at srcKey to dstKey.
  //
  // If srcKey file doesn't exist, it throws an error for which isNotFound
  // is true.
  //
  // If dstKey file already exists, it is overwritten.
  copy(srcKey: string, dstKey: string): void {
    this.#bucket.copy(dstKey, srcKey);
  }

  // List returns a flat list with info for all files under the specified
  // prefix.
  list(prefix: string): ListObject[] {
    const files: ListObject[] = [];

    const iter = this.#bucket.list({ prefix });

    for (;;) {
      const obj = iter.next();
      if (obj === null) {
        break;
      }
      files.push(obj);
    }

    return files;
  }

  // Upload writes content into the fileKey location.
  upload(content: Uint8Array, fileKey: string): void {
    const w = this.newWriter(fileKey, { contentType: detect(content).string() });

    try {
      w.write(content);
    } catch (err) {
      w.cancel();
      throw err;
    }

    w.close();
  }

  // UploadFile uploads the provided File to the fileKey location.
  uploadFile(file: File, fileKey: string): void {
    // mimetype.DetectReader of the content's first bytes
    const [mt, detectErr] = file.detect();
    if (detectErr !== null) {
      throw detectErr;
    }

    let originalName = file.originalName;
    const originalBytes = textToBytes(originalName);
    if (originalBytes.length > 255) {
      // keep only the first 255 chars as a very rudimentary measure to
      // prevent the metadata to grow too big in size
      originalName = bytesToText(originalBytes.subarray(0, 255));
    }

    const f = file.open();
    try {
      const w = this.newWriter(fileKey, {
        contentType: mt.string(),
        metadata: new Map([[MetadataOriginalName, originalName]]),
      });

      try {
        const buf = new Uint8Array(Math.min(uploadBufferSize, Math.max(file.size, 1)));
        for (;;) {
          const n = f.read(buf);
          if (n === 0) {
            break;
          }
          w.write(buf.subarray(0, n));
        }
      } catch (err) {
        w.cancel();
        throw err;
      }

      w.close();
    } finally {
      f.close();
    }
  }

  // NewWriter returns a new blob.Writer instance allowing direct file
  // create.
  //
  // If a file with the specified fileKey already exists, it will be
  // replaced.
  //
  // NB! Make sure to call close() (or cancel()) on the resulting writer
  // after you are done working with it.
  newWriter(fileKey: string, opts: WriterOptions): Writer {
    return this.#bucket.newWriter(fileKey, opts);
  }

  // Delete deletes stored file at fileKey location.
  //
  // If the file doesn't exist it throws an error for which isNotFound is
  // true.
  delete(fileKey: string): void {
    this.#bucket.delete(fileKey);
  }

  // DeletePrefix deletes everything starting with the specified prefix.
  //
  // The prefix could be subpath (ex. "/a/b/") or filename prefix (ex.
  // "/a/b/file_").
  deletePrefix(prefix: string): unknown[] {
    const steps = this.deletePrefixSteps(prefix);
    for (;;) {
      const r = steps.next();
      if (r.done === true) {
        return r.value;
      }
    }
  }

  // DeletePrefix as a generator: it yields after each page of deleted
  // files and returns the failures.
  *deletePrefixSteps(prefix: string): Generator<void, unknown[], void> {
    const failed: unknown[] = [];

    if (prefix === "") {
      failed.push(new Error("prefix mustn't be empty"));
      return failed;
    }

    const dirsMap = new Set<string>();

    let isPrefixDir = false;

    // treat the prefix as directory only if it ends with trailing slash
    if (prefix.endsWith("/")) {
      isPrefixDir = true;
      dirsMap.add(prefix.replace(/\/+$/, ""));
    }

    // delete all files with the prefix
    // ---
    const iter = this.#bucket.list({ prefix });
    let deleted = 0;
    for (;;) {
      let obj: ListObject | null;
      try {
        obj = iter.next();
      } catch (err) {
        failed.push(err);
        break;
      }
      if (obj === null) {
        break;
      }

      try {
        this.delete(obj.key);
        if (isPrefixDir) {
          const slashIdx = obj.key.lastIndexOf("/");
          if (slashIdx > -1) {
            dirsMap.add(obj.key.slice(0, slashIdx));
          }
        }
      } catch (err) {
        failed.push(err);
      }

      if (++deleted % deletePageSize === 0) {
        yield;
      }
    }
    // ---

    // try to delete the empty remaining dir objects
    // (this operation usually is optional and there is no need to strictly
    // check the result)
    // ---
    // sort the child dirs first, aka. ["a/b/c", "a/b", "a"] (a stable sort)
    const dirs = [...dirsMap].toSorted((a, b) => b.split("/").length - a.split("/").length);

    // delete dirs
    for (const d of dirs) {
      if (d !== "") {
        try {
          this.delete(d);
        } catch {
          // optional
        }
      }
    }
    // ---

    return failed;
  }

  // Serve serves the file at fileKey location to an HTTP response.
  //
  // If the `download` query parameter is used the file will be always
  // served for download no matter of its type (aka. with
  // "Content-Disposition: attachment").
  //
  // Internally this method uses http.ServeContent's rules, so Range
  // requests, If-Match, If-Unmodified-Since, etc. headers are handled
  // transparently. The file is streamed, not read into memory.
  //
  // If the file doesn't exist it throws an error for which isNotFound is
  // true.
  serve(res: ResponseWriter, req: HttpRequest, fileKey: string, name: string): void {
    const br = this.getReader(fileKey);
    let realContentType: string;
    let modTime: bigint;
    try {
      realContentType = br.contentType;
      modTime = br.modTime;
    } finally {
      br.close();
    }

    let forceAttachment = false;
    const raw = req.query().get(forceAttachmentParam)?.[0] ?? "";
    if (raw !== "") {
      forceAttachment = parseBool(raw);
    }

    let disposition = "attachment";
    if (!forceAttachment && inlineServeContentTypes.includes(realContentType)) {
      disposition = "inline";
    }

    // make an exception for specific content types and force a custom
    // content type to send in the response so that it can be loaded properly
    let extContentType = realContentType;
    const ct = manualExtensionContentTypes.get(filepathExt(fileKey));
    if (ct !== undefined) {
      extContentType = ct;
    }

    setHeaderIfMissing(res, "Content-Disposition", disposition + "; filename=" + goQuote(name));
    setHeaderIfMissing(res, "Content-Type", extContentType);
    setHeaderIfMissing(
      res,
      "Content-Security-Policy",
      "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    );

    // set a default cache-control header
    // (valid for 30 days but the cache is allowed to reuse the file for any requests
    // that are made in the last day while revalidating the res in the background)
    setHeaderIfMissing(res, "Cache-Control", "max-age=2592000, stale-while-revalidate=86400");

    serveContent(
      res,
      req,
      name,
      {
        blob: this.#blob(fileKey),
        read: (start, length) => {
          const rr = this.#bucket.newRangeReader(fileKey, start, length);
          try {
            const out = new Uint8Array(length);
            let n = 0;
            while (n < length) {
              const m = rr.read(out.subarray(n));
              if (m === 0) {
                break;
              }
              n += m;
            }
            return out.subarray(0, n);
          } finally {
            rr.close();
          }
        },
        spool: (parts) => this.#spool(fileKey, parts),
      },
      modTime,
    );
  }

  // Writes the parts of a large multipart/byteranges body (bytes, or
  // ranges of the stored file) to a file in pb_data's temp directory, which
  // the app clears at start (core.LocalTempDirName, beside the storage
  // directory), reading the ranges in pieces of spoolChunk bytes.
  async #spool(
    fileKey: string,
    parts: (Uint8Array | { start: number; length: number })[],
  ): Promise<{ blob: Blob; remove: () => void }> {
    const tempDir = join(dirname(this.#localDir), localTempDirName);
    mkdirSync(tempDir, { recursive: true });
    const path =
      tempDir +
      "/ranges_" +
      Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex");
    const remove = (): void => rmSync(path, { force: true });
    const out = await open(path, "wx", 0o600);
    try {
      const src = await open(this.#localDir + "/" + fileKey, "r");
      try {
        const buf = new Uint8Array(spoolChunk);
        for (const part of parts) {
          if (part instanceof Uint8Array) {
            await out.write(part);
            continue;
          }
          for (let pos = part.start, left = part.length; left > 0;) {
            const { bytesRead } = await src.read(buf, 0, Math.min(left, buf.length), pos);
            if (bytesRead === 0) {
              throw new Error("unexpected EOF");
            }
            await out.write(buf.subarray(0, bytesRead));
            pos += bytesRead;
            left -= bytesRead;
          }
        }
      } finally {
        await src.close();
      }
    } catch (err) {
      await out.close();
      remove();
      throw err;
    }
    await out.close();
    return { blob: Bun.file(path), remove };
  }

  // CreateThumb creates a new thumb image for the file at originalKey
  // location. The new thumb file is stored at thumbKey location.
  //
  // thumbSize is in the format:
  // - 0xH  (eg. 0x100)    - resize to H height preserving the aspect ratio
  // - Wx0  (eg. 300x0)    - resize to W width preserving the aspect ratio
  // - WxH  (eg. 300x100)  - resize and crop to WxH viewbox (from center)
  // - WxHt (eg. 300x100t) - resize and crop to WxH viewbox (from top)
  // - WxHb (eg. 300x100b) - resize and crop to WxH viewbox (from bottom)
  // - WxHf (eg. 300x100f) - fit inside a WxH viewbox (without cropping)
  //
  // render gives PB_THUMBS_MAX_SOURCE_PIXELS, checked on the original's
  // header before the original is read, and makes the thumb from the
  // original's bytes and content type (src/files/create-thumb.ts in a
  // worker); its errors are CreateThumb's.
  async createThumb(
    originalKey: string,
    thumbKey: string,
    thumbSize: string,
    render: ThumbRenderer,
  ): Promise<void> {
    const sizeParts = ThumbSizeRegex.findStringSubmatch(thumbSize);
    if (sizeParts === null || sizeParts.length !== 4) {
      throw new Error("thumb size must be in WxH, WxHt, WxHb or WxHf format");
    }

    const width = goAtoi(sizeParts[1] as string);
    const height = goAtoi(sizeParts[2] as string);
    const resizeType = (sizeParts[3] ?? "") as ThumbSize["mode"];

    if (width === 0 && height === 0) {
      throw new Error("thumb width and height cannot be zero at the same time");
    }

    // fetch the original
    const r = this.getReader(originalKey);
    let originalContentType: string;
    let isGif: boolean;
    let isWebp: boolean;
    try {
      originalContentType = r.contentType;
      // check image dimensions to minimize excessive memory usage (the
      // header is read in bounded pieces; the original is read only after
      // it passes)
      const src = readerSource(r, r.size);
      const magic = src.peek(12);
      isGif = magic[0] === 0x47;
      isWebp = String.fromCharCode(...magic.subarray(8, 12)) === "WEBP";
      checkSource(src, render.maxSourcePixels());
    } finally {
      r.close();
    }
    let original: Uint8Array;
    if (isGif) {
      // only the first frame is decoded: read up to its end and close the
      // stream with a trailer, so an animated original is not read whole
      const g = this.getReader(originalKey);
      let end: number;
      try {
        end = gifFirstFrameLength(readerSource(g, g.size));
      } finally {
        g.close();
      }
      original = new Uint8Array(end + 1);
      original.set(await this.#blob(originalKey).slice(0, end).bytes());
      original[end] = 0x3b;
    } else {
      if (isWebp) {
        // an original without a VP8 or VP8L chunk (an animated WebP) fails
        // as upstream's decode does, before it is read whole
        const w = this.getReader(originalKey);
        try {
          webpCheckImageChunk(readerSource(w, w.size));
        } finally {
          w.close();
        }
      }
      original = await this.#blob(originalKey).bytes();
    }

    const thumb = await render.render(original, originalContentType, {
      width,
      height,
      mode: resizeType,
    });

    // open a thumb storage writer (aka. prepare for upload)
    const w = this.newWriter(thumbKey, { contentType: thumb.contentType });

    // thumb encode (aka. upload)
    try {
      w.write(thumb.bytes);
    } catch (err) {
      w.cancel();
      throw err;
    }

    // check for close errors to ensure that the thumb was really saved
    w.close();
  }

  // a Blob view of a stored file (read lazily)
  #blob(fileKey: string): Blob {
    return Bun.file(this.#localDir + "/" + fileKey);
  }

  // Checks if the provided dir prefix doesn't have any files.
  //
  // A trailing slash will be appended to a non-empty dir string argument to
  // ensure that the checked prefix is a "directory".
  //
  // Returns "false" in case it has at least one file, otherwise - "true".
  isEmptyDir(dir: string): boolean {
    if (dir !== "" && !dir.endsWith("/")) {
      dir += "/";
    }

    const iter = this.#bucket.list({ prefix: dir });

    try {
      return iter.next() === null;
    } catch {
      return false;
    }
  }
}

// NewLocal initializes a new local filesystem instance.
//
// NB! Make sure to call close() after you are done working with it.
export function NewLocal(dirPath: string): System {
  // makes sure that the directory exist
  mkdirSync(dirPath, { recursive: true, mode: 0o777 });

  const drv = newFileblob(dirPath, { noTempDir: true });

  return new System(new Bucket(drv), dirPath);
}

// path.Base
function pathBase(p: string): string {
  if (p === "") {
    return ".";
  }
  p = p.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  if (i >= 0) {
    p = p.slice(i + 1);
  }
  return p === "" ? "/" : p;
}

// note: expects key to be in a canonical form (eg. "accept-encoding" should
// be "Accept-Encoding"). The value's UTF-8 bytes are sent as they are, as
// Go writes them.
function setHeaderIfMissing(res: ResponseWriter, key: string, value: string): void {
  if (!res.header.has(key)) {
    res.header.set(key, Buffer.from(value, "utf8").toString("latin1"));
  }
}

// filepath.Ext
function filepathExt(p: string): string {
  for (let i = p.length - 1; i >= 0 && p[i] !== "/"; i--) {
    if (p[i] === ".") {
      return p.slice(i);
    }
  }
  return "";
}

// strconv.ParseBool, false on a syntax error (as the ignored error leaves it)
function parseBool(str: string): boolean {
  switch (str) {
    case "1":
    case "t":
    case "T":
    case "true":
    case "TRUE":
    case "True":
      return true;
    default:
      return false;
  }
}

// strconv.Atoi of ThumbSizeRegex's digits: an out-of-range value is
// clamped to the int64 range, as Atoi returns it with its (ignored) error
function goAtoi(digits: string): number {
  const n = BigInt(digits);
  return n > 9223372036854775807n ? Number(9223372036854775807n) : Number(n);
}
