// Upstream: tools/filesystem/internal/fileblob/fileblob.go (a stripped down
// and adapted copy there of gocloud.dev/blob/fileblob, Apache License 2.0,
// Copyright 2018 The Go Cloud Development Kit Authors)
//
// The blob driver backed by a local directory. A blob is written to a
// temporary file and renamed to its path on Close, so a reader never sees
// a partial blob; its attributes go to a "<path>.attrs" sidecar
// (attrs.ts). Blob keys: ASCII characters 0-31 are escaped to
// "__0x<hex>__", and so are the "/" in "../", the second "/" in "//" and
// a trailing "/" (blob/hex.ts). Paths are the Linux ones (D24: the MVP
// targets linux-x64); the Windows escapes are not ported.
//
// The calls are synchronous (node:fs), see blob/driver.ts. Not ported: the
// MetadataDontWrite option and its plain writer (upstream's NewLocal
// always writes the sidecar), and contexts.

import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";

import { errNotExist, joinNotFound } from "@/tools/filesystem/blob/bucket";
import type {
  Attributes,
  Driver,
  DriverReader,
  DriverWriter,
  ListObject,
  ListOptions,
  ListPage,
  WriterOptions,
} from "@/tools/filesystem/blob/driver";
import { HexEscape, HexUnescape } from "@/tools/filesystem/blob/hex";
import {
  attrsExt,
  errAttrsExt,
  getAttrs,
  setAttrs,
  type xattrs,
} from "@/tools/filesystem/internal/fileblob/attrs";
import { goBase } from "@/tools/filesystem/file";
import { cleanSlashPath } from "@/server/mux";
import { compareUTF8 } from "@/tools/types/go-json";

const defaultPageSize = 1000;

// Options sets options for constructing a driver backed by fileblob.
export interface Options {
  // The FileMode to use when creating directories for the top-level
  // directory backing the bucket (when CreateDir is true), and for
  // subdirectories for keys. Defaults to 0777.
  dirFileMode?: number;
  // If true, create the directory backing the Bucket if it does not exist
  // (using os.MkdirAll).
  createDir?: boolean;
  // If true, don't use os.TempDir for temporary files, but instead place
  // them next to the actual files.
  noTempDir?: boolean;
}

// New creates a new instance of the fileblob driver backed by the
// filesystem and rooted at dir, which must exist.
export function New(dir: string, opts: Options = {}): Driver {
  const dirFileMode = opts.dirFileMode ?? 0o777;

  const absdir = cleanSlashPath(dir.startsWith("/") ? dir : process.cwd() + "/" + dir);

  // Optionally, create the directory if it does not already exist.
  let info;
  try {
    info = statSync(absdir);
  } catch (err) {
    if (!(opts.createDir === true && isNotExist(err))) {
      throw err;
    }
    try {
      mkdirSync(absdir, { recursive: true, mode: dirFileMode });
    } catch (mkErr) {
      throw new Error(`tried to create directory but failed: ${errorMessage(mkErr)}`, {
        cause: mkErr,
      });
    }
    info = statSync(absdir);
  }

  if (!info.isDirectory()) {
    throw new Error(`${absdir} is not a directory`);
  }

  return new driver(absdir, { ...opts, dirFileMode });
}

// os.IsNotExist
export function isNotExist(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return err === errNotExist || e?.code === "ENOENT" || e?.cause?.code === "ENOENT";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class driver implements Driver {
  readonly dir: string;
  readonly opts: Options & { dirFileMode: number };

  constructor(dir: string, opts: Options & { dirFileMode: number }) {
    this.dir = dir;
    this.opts = opts;
  }

  // Close implements [blob/Driver.Close].
  close(): void {}

  // NormalizeError implements [blob/Driver.NormalizeError].
  normalizeError(err: unknown): unknown {
    if (isNotExist(err)) {
      return joinNotFound(err);
    }

    return err;
  }

  // isEscapingPath checks if path escapes the configured bucket dir.
  // (https://github.com/google/go-cloud/pull/3794)
  isEscapingPath(path: string, isKey: boolean): boolean {
    const cleanedPath = cleanSlashPath(path) + "/";
    const bucketRootPath = this.dir + "/"; // drv.dir is already Cleaned via Abs in the constructor
    if (isKey && cleanedPath === bucketRootPath) {
      // a key shouldn't point to the bucket itself
      return true;
    }
    return this.dir !== "/" && !cleanedPath.startsWith(bucketRootPath);
  }

  // path returns the full path for a key.
  path(key: string): string {
    const path = join(this.dir, escapeKey(key));

    // ensure that the key hasn't escaped the bucket root
    if (this.isEscapingPath(path, true)) {
      throw new Error(`fileblob: key ${goQuote(key)} escapes bucket root`);
    }

    if (path.endsWith(attrsExt)) {
      throw errAttrsExt;
    }

    return path;
  }

  // forKey returns the full path, the stat result and attributes for key.
  forKey(key: string): { path: string; size: number; modTime: bigint; xa: xattrs } {
    const path = this.path(key);

    const info = statSync(path, { bigint: true });

    if (info.isDirectory()) {
      throw errNotExist;
    }

    const xa = getAttrs(path);

    return { path, size: Number(info.size), modTime: info.mtimeNs, xa };
  }

  // ListPaged implements [blob/Driver.ListPaged].
  listPaged(opts: ListOptions): ListPage {
    const pageToken = opts.pageToken ?? "";

    let pageSize = opts.pageSize;
    if (pageSize === 0) {
      pageSize = defaultPageSize;
    }

    // If opts.Delimiter != "", lastPrefix contains the last "directory" key
    // we added. It is used to avoid adding it again; all files in this
    // "directory" are collapsed to the single directory entry.
    let lastPrefix = "";
    let lastKeyAdded = "";

    // If the Prefix contains a "/", we can set the root of the Walk to the
    // path specified by the Prefix as any files below the path will not
    // match the Prefix.
    let root = this.dir;
    const i = opts.prefix.lastIndexOf("/");
    if (i > -1) {
      root = join(root, opts.prefix.slice(0, i));
    }

    // ensure that the Prefix hasn't escaped the bucket root
    if (this.isEscapingPath(root, false)) {
      throw new Error(`fileblob: ${goQuote(opts.prefix)} prefix escapes bucket root`);
    }

    const result: ListPage = { objects: [], nextPageToken: null };

    // Do a full recursive scan of the root directory.
    walkDir(root, (path, info, err) => {
      if (err !== undefined || info === null) {
        // Couldn't read this file/directory for some reason; just skip it.
        return undefined;
      }

      // Skip the self-generated attribute files.
      if (path.endsWith(attrsExt)) {
        return undefined;
      }

      // os.Walk returns the root directory; skip it.
      if (path === this.dir) {
        return undefined;
      }

      // Strip the <drv.dir> prefix from path.
      let prefixLen = this.dir.length;
      // Include the separator for non-root.
      if (this.dir !== "/") {
        prefixLen++;
      }
      const absPath = path;
      path = path.slice(prefixLen);

      // Unescape the path to get the key.
      let key = unescapeKey(path);

      // Skip all directories. If opts.Delimiter is set, we'll create
      // pseudo-directories later.
      // Note that returning nil means that we'll still recurse into it;
      // we're just not adding a result for the directory itself.
      if (info.isDir) {
        key += "/";
        // Avoid recursing into subdirectories if the directory name
        // already doesn't match the prefix; any files in it are
        // guaranteed not to match.
        if (key.length > opts.prefix.length && !key.startsWith(opts.prefix)) {
          return skipDir;
        }
        // Similarly, avoid recursing into subdirectories if we're making
        // "directories" and all of the files in this subdirectory are
        // guaranteed to collapse to a "directory" that we've already
        // added.
        if (lastPrefix !== "" && key.startsWith(lastPrefix)) {
          return skipDir;
        }
        return undefined;
      }

      // Skip files/directories that don't match the Prefix.
      if (!key.startsWith(opts.prefix)) {
        return undefined;
      }

      let md5: Uint8Array | null = null;
      try {
        // Note: we only have the MD5 hash for blobs that we wrote.
        // For other blobs, md5 will remain nil.
        md5 = getAttrs(absPath).md5;
      } catch {
        // no MD5
      }

      const fi = lstatSync(absPath, { bigint: true });

      let obj: ListObject = {
        key,
        modTime: fi.mtimeNs,
        size: Number(fi.size),
        md5,
        isDir: false,
      };

      // If using Delimiter, collapse "directories".
      if (opts.delimiter !== "") {
        // Strip the prefix, which may contain Delimiter.
        const keyWithoutPrefix = key.slice(opts.prefix.length);
        // See if the key still contains Delimiter.
        // If no, it's a file and we just include it.
        // If yes, it's a file in a "sub-directory" and we want to collapse
        // all files in that "sub-directory" into a single "directory"
        // result.
        const idx = keyWithoutPrefix.indexOf(opts.delimiter);
        if (idx !== -1) {
          const prefix = opts.prefix + keyWithoutPrefix.slice(0, idx + opts.delimiter.length);
          // We've already included this "directory"; don't add it.
          if (prefix === lastPrefix) {
            return undefined;
          }
          // Update the object to be a "directory".
          obj = { key: prefix, modTime: 0n, size: 0, md5: null, isDir: true };
          lastPrefix = prefix;
        }
      }

      // If there's a pageToken, skip anything before it.
      if (pageToken !== "" && compareUTF8(obj.key, pageToken) <= 0) {
        return undefined;
      }

      // If we've already got a full page of results, set NextPageToken and
      // stop. Unless the current object is a directory, in which case there
      // may still be objects coming that are alphabetically before it
      // (since we appended the delimiter). In that case, keep going; we'll
      // trim the extra entries (if any) before returning.
      if (result.objects.length === pageSize && !obj.isDir) {
        result.nextPageToken = (result.objects[pageSize - 1] as ListObject).key;
        return stopWalk;
      }

      result.objects.push(obj);

      // Normally, objects are added in the correct order (by Key).
      // However, sometimes adding the file delimiter messes that up (e.g.,
      // if the file delimiter is later in the alphabet than the last
      // character of a key). Detect if this happens and swap if needed.
      if (result.objects.length > 1 && compareUTF8(obj.key, lastKeyAdded) < 0) {
        const j = result.objects.length - 1;
        const prev = result.objects[j - 1] as ListObject;
        result.objects[j - 1] = result.objects[j] as ListObject;
        result.objects[j] = prev;
        lastKeyAdded = prev.key;
      } else {
        lastKeyAdded = obj.key;
      }

      return undefined;
    });

    if (result.objects.length > pageSize) {
      result.objects = result.objects.slice(0, pageSize);
      result.nextPageToken = (result.objects[pageSize - 1] as ListObject).key;
    }

    return result;
  }

  // Attributes implements [blob/Driver.Attributes].
  attributes(key: string): Attributes {
    const { size, modTime, xa } = this.forKey(key);

    return {
      cacheControl: xa.cacheControl,
      contentDisposition: xa.contentDisposition,
      contentEncoding: xa.contentEncoding,
      contentLanguage: xa.contentLanguage,
      contentType: xa.contentType,
      metadata: xa.metadata,
      // CreateTime left as the zero time.
      modTime,
      size,
      md5: xa.md5,
      etag: `"${modTime.toString(16)}-${size.toString(16)}"`,
    };
  }

  // NewRangeReader implements [blob/Driver.NewRangeReader].
  newRangeReader(key: string, offset: number, length: number): DriverReader {
    const { path, size, modTime, xa } = this.forKey(key);

    const fd = openSync(path, "r");
    let position = Math.max(offset, 0);
    let remaining = length >= 0 ? length : Number.POSITIVE_INFINITY;
    let closed = false;

    return {
      read(p: Uint8Array): number {
        if (closed) {
          throw new Error("read: file already closed");
        }
        const want = Math.min(p.length, remaining);
        if (want <= 0) {
          return 0;
        }
        const n = readSync(fd, p, 0, want, position);
        position += n;
        remaining -= n;
        return n;
      },
      close(): void {
        if (!closed) {
          closed = true;
          closeSync(fd);
        }
      },
      attributes: () => ({ contentType: xa.contentType, modTime, size }),
    };
  }

  // NewTypedWriter implements [blob/Driver.NewTypedWriter].
  newTypedWriter(key: string, contentType: string, opts: WriterOptions): DriverWriter {
    const path = this.path(key);

    mkdirSync(dirname(path), { recursive: true, mode: this.opts.dirFileMode });

    const f = createTemp(path, this.opts.noTempDir === true);

    let metadata: Map<string, string> | null = null;
    if (opts.metadata !== undefined && opts.metadata !== null && opts.metadata.size > 0) {
      metadata = opts.metadata;
    }

    return new writerWithSidecar(f.fd, f.name, path, {
      cacheControl: opts.cacheControl ?? "",
      contentDisposition: opts.contentDisposition ?? "",
      contentEncoding: opts.contentEncoding ?? "",
      contentLanguage: opts.contentLanguage ?? "",
      contentType,
      metadata,
      md5: null,
    });
  }

  // Copy implements [blob/Driver.Copy].
  copy(dstKey: string, srcKey: string): void {
    // Note: we could use NewRangeReader here, but since we need to copy
    // all of the metadata (from xa), it's more efficient to do it
    // directly.
    const { path: srcPath, xa } = this.forKey(srcKey);

    const fd = openSync(srcPath, "r");
    try {
      // We'll write the copy using Writer, to avoid re-implementing making
      // of a temp file, cleaning up after partial failures, etc.
      const w = this.newTypedWriter(dstKey, xa.contentType, {
        cacheControl: xa.cacheControl,
        contentDisposition: xa.contentDisposition,
        contentEncoding: xa.contentEncoding,
        contentLanguage: xa.contentLanguage,
        metadata: xa.metadata,
      });

      try {
        const buf = new Uint8Array(copyBufferSize);
        let position = 0;
        for (;;) {
          const n = readSync(fd, buf, 0, buf.length, position);
          if (n === 0) {
            break;
          }
          position += n;
          w.write(buf.subarray(0, n));
        }
      } catch (err) {
        w.cancel(); // cancel before Close cancels the write
        throw err;
      }

      w.close();
    } finally {
      closeSync(fd);
    }
  }

  // Delete implements [blob/Driver.Delete].
  delete(key: string): void {
    const path = this.path(key);

    goRemove(path);

    try {
      goRemove(path + attrsExt);
    } catch (err) {
      if (!isNotExist(err)) {
        throw err;
      }
    }
  }
}

// io.Copy's buffer size
const copyBufferSize = 32 * 1024;

// os.Remove: removes the file or the empty directory at path. The error is
// unlink's, unless rmdir failed for another reason than "not a
// directory".
export function goRemove(path: string): void {
  let e: unknown;
  try {
    unlinkSync(path);
    return;
  } catch (err) {
    e = err;
  }
  try {
    rmdirSync(path);
    return;
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOTDIR") {
      e = err;
    }
  }
  // the text of Go's *PathError
  const description = /^[A-Z0-9]+: (.*?), \w+ '/.exec((e as Error).message)?.[1];
  throw description === undefined ? e : new Error(`remove ${path}: ${description}`, { cause: e });
}

// the temporary file of a blob being written
function createTemp(path: string, noTempDir: boolean): { fd: number; name: string } {
  // Use a custom createTemp function rather than os.CreateTemp() as
  // os.CreateTemp() sets the permissions of the tempfile to 0600, rather
  // than 0666, making it inconsistent with the directories and attribute
  // files.
  let tries = 0;
  for (;;) {
    // Append the current time with nanosecond precision and .tmp to the
    // base path. If the file already exists try again.
    let name = noTempDir ? path : join(tmpdir(), goBase(path));
    name += "." + unixNano().toString(16) + ".tmp";

    try {
      return { fd: openSync(name, "wx+", 0o666), name };
    } catch (err) {
      if ((err as { code?: string }).code === "EEXIST") {
        if (++tries < 10000) {
          continue;
        }
        throw new Error(`createtemp ${path}.*.tmp: file already exists`, { cause: err });
      }
      throw err;
    }
  }
}

// time.Now().UnixNano(): the wall clock in nanoseconds (sub-millisecond
// digits from the monotonic clock)
function unixNano(): bigint {
  return BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);
}

// writerWithSidecar implements the strategy of storing metadata in a
// distinct file.
class writerWithSidecar implements DriverWriter {
  readonly #md5hash = new Bun.CryptoHasher("md5");
  #fd: number | null;
  readonly #tempName: string;
  readonly #path: string;
  readonly #attrs: xattrs;

  constructor(fd: number, tempName: string, path: string, attrs: xattrs) {
    this.#fd = fd;
    this.#tempName = tempName;
    this.#path = path;
    this.#attrs = attrs;
  }

  write(p: Uint8Array): void {
    if (this.#fd === null) {
      throw new Error(`write ${this.#tempName}: file already closed`);
    }
    let off = 0;
    try {
      while (off < p.length) {
        off += writeSync(this.#fd, p, off, p.length - off);
      }
    } finally {
      // Don't hash the unwritten tail twice when writing is resumed.
      this.#md5hash.update(p.subarray(0, off));
    }
  }

  close(): void {
    this.#closeFile();

    // Always delete the temp file. On success, it will have been renamed
    // so the Remove will fail.
    try {
      this.#attrs.md5 = new Uint8Array(this.#md5hash.digest());

      // Write the attributes file.
      setAttrs(this.#path, this.#attrs);

      // Rename the temp file to path.
      try {
        renameSync(this.#tempName, this.#path);
      } catch (err) {
        rmSync(this.#path + attrsExt, { force: true });
        throw err;
      }
    } finally {
      rmSync(this.#tempName, { force: true });
    }
  }

  cancel(): void {
    try {
      this.#closeFile();
    } finally {
      rmSync(this.#tempName, { force: true });
    }
  }

  #closeFile(): void {
    if (this.#fd === null) {
      throw new Error(`close ${this.#tempName}: file already closed`);
    }
    const fd = this.#fd;
    this.#fd = null;
    closeSync(fd);
  }
}

// -------------------------------------------------------------------

// escapeKey does all required escaping for UTF-8 strings to work the
// filesystem.
export function escapeKey(s: string): string {
  const slash = 0x2f;
  const dot = 0x2e;
  return HexEscape(s, (r, i) => {
    const c = r[i] as number;
    if (c < 32) {
      return true;
    }
    // For "../", escape the trailing slash.
    if (i > 1 && c === slash && r[i - 1] === dot && r[i - 2] === dot) {
      return true;
    }
    // For "//", escape the trailing slash.
    if (i > 0 && c === slash && r[i - 1] === slash) {
      return true;
    }
    // Escape the trailing slash in a key.
    if (c === slash && i === r.length - 1) {
      return true;
    }
    return false;
  });
}

// unescapeKey reverses escapeKey.
export function unescapeKey(s: string): string {
  return HexUnescape(s);
}

// -------------------------------------------------------------------
// path/filepath on Unix

// filepath.Join(dir, elem): the joined path, cleaned; an empty element is
// ignored
function join(dir: string, elem: string): string {
  if (elem === "") {
    return dir === "" ? "" : cleanSlashPath(dir);
  }
  if (dir === "") {
    return cleanSlashPath(elem);
  }
  return cleanSlashPath(dir + "/" + elem);
}

// filepath.Dir
function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return cleanSlashPath(path.slice(0, i + 1));
}

// strconv.Quote for the error texts
function goQuote(s: string): string {
  return JSON.stringify(s);
}

// a directory entry of the walk
interface dirEntry {
  isDir: boolean;
}

const skipDir = Symbol("SkipDir");
const stopWalk = Symbol("io.EOF");

type walkResult = typeof skipDir | typeof stopWalk | undefined;

type walkDirFunc = (path: string, d: dirEntry | null, err: unknown) => walkResult;

// filepath.WalkDir: walks the file tree rooted at root, calling fn for
// each file or directory in the tree, including root, in lexical order.
// Symbolic links are not followed. A walk stopped with stopWalk (Go's
// io.EOF from the callback) ends early.
function walkDir(root: string, fn: walkDirFunc): void {
  let info;
  try {
    info = lstatSync(root);
  } catch (err) {
    fn(root, null, err);
    return;
  }
  walkDirRec(root, { isDir: info.isDirectory() }, fn);
}

function walkDirRec(path: string, d: dirEntry, fn: walkDirFunc): walkResult {
  const r = fn(path, d, undefined);
  if (r !== undefined || !d.isDir) {
    if (r === skipDir && d.isDir) {
      // Successfully skipped directory.
      return undefined;
    }
    return r;
  }

  let entries: { name: string; isDir: boolean }[] = [];
  try {
    // os.ReadDir: the entries sorted by file name
    entries = readdirSync(path, { withFileTypes: true })
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
      .toSorted((a, b) => compareUTF8(a.name, b.name));
  } catch (err) {
    // Second call, to report ReadDir error.
    const r2 = fn(path, d, err);
    if (r2 !== undefined) {
      return r2 === skipDir && d.isDir ? undefined : r2;
    }
  }

  for (const e of entries) {
    const name1 = join(path, e.name);
    const r3 = walkDirRec(name1, { isDir: e.isDir }, fn);
    if (r3 !== undefined) {
      if (r3 === skipDir) {
        break;
      }
      return r3;
    }
  }
  return undefined;
}
