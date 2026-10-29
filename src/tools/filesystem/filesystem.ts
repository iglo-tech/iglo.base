// Upstream: tools/filesystem/filesystem.go (the local storage parts:
// NewLocal, Close, Exists, Attributes, GetReader, GetReuploadableFile,
// Copy, List, Upload, UploadFile, NewWriter, Delete, DeletePrefix,
// IsEmptyDir; ThumbSizeRegex)
//
// System is the local file storage under pb_data/storage
// (internal/fileblob). Its calls are synchronous, so the file field can
// store and delete files from inside a write transaction as upstream does
// (D8). DeletePrefix can also run as a generator that yields after each
// page of deleted files (deletePrefixSteps), so a background delete of a
// large directory gives the event loop back between pages.
//
// Not ported: NewS3 (M5.4), Serve and the thumbnails (M5.2), the
// deprecated GetFile, UploadMultipart (a multipart part is a File here and
// goes through UploadFile, with the same result), SetContext (no
// contexts), and the OnNewWriter and OnDelete hooks (D5). Go's
// filesystem.ErrNotFound is blob.ErrNotFound; callers check it with
// isNotFound (blob/bucket.ts).

import { mkdirSync } from "node:fs";

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
import { detect } from "@/tools/mimetype/mimetype";
import { mustCompile } from "@/tools/regexp/regexp";
import { bytesToText, textToBytes } from "@/tools/types/go-json";

export const ThumbSizeRegex = mustCompile(String.raw`^(\d+)x(\d+)(t|b|f)?$`);

export const MetadataOriginalName = "original-filename";

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
      blob: (): Blob => Bun.file(this.#localDir + "/" + fileKey),
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
