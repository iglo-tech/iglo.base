// Upstream: the fs.FS views that apis/base.go Static and
// tools/router/event.go FileFS read: Go's os.DirFS (os/file.go, Go
// 1.27.2: dirFS.Stat, dirFS.Open, dirFS.join with filepathlite.Localize)
// for --publicDir, and the embedded dashboard build (embed.FS, see
// @/apis/ui-pack).
//
// As os.DirFS, a name must be a valid fs path (fs.ValidPath: no empty, "."
// or ".." elements, no leading or trailing slash) without NUL bytes, and is
// joined to the root as is. Symbolic links are followed, also when they
// point outside the root, as upstream's DirFS does (the links are the
// server owner's). A relative root is relative to the working directory.
// The file is streamed from disk when served, never read whole into
// memory; a multipart/byteranges body over serveContent's buffer limit is
// spooled to a temporary file in pb_data/.pb_temp_to_delete, as stored
// files are (@/tools/filesystem/filesystem).
//
// Unlike os.Open, a name that is neither a regular file nor a directory
// (a FIFO, a device) is not opened: it is not found.
//
// Bun.serve adds "Content-Disposition: filename=<base name>" to a response
// whose body is a file opened by path, unless its Content-Type is text/,
// image/, font/, audio/, video/, JSON or WASM; upstream sends no such
// header. A file of another type (by its name or its first bytes, as
// serveContent finds it) is therefore read into memory when it has at most
// maxBufferedRangesSize bytes. A larger one is still streamed, and gets
// Bun's header (listed in the PR as a difference for the lead).

import { closeSync, fstatSync, mkdirSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import type { StaticFS as EmbeddedFS } from "@/apis/ui-pack";
import {
  type HttpRange,
  maxBufferedRangesSize,
  type ServedFile,
  typeByExtension,
} from "@/server/serve-content";
import { detectContentType } from "@/server/sniff";

// core.LocalTempDirName
const localTempDirName = ".pb_temp_to_delete";

// the piece size of a spooled range
const spoolChunk = 256 << 10;

export interface StaticFile {
  content: Uint8Array | ServedFile;
  // modification time in Unix nanoseconds; 0 for none (embed.FS)
  modTime: bigint;
}

// The part of fs.FS that Static and FileFS use.
export interface StaticFileSystem {
  // fs.Stat: the kind of the named entry, undefined for any error
  stat(name: string): "file" | "dir" | undefined;
  // fsys.Open of a file, undefined for any error
  open(name: string): StaticFile | undefined;
}

// fs.ValidPath
export function validPath(name: string): boolean {
  if (name === ".") {
    return true;
  }
  return name.split("/").every((elem) => elem !== "" && elem !== "." && elem !== "..");
}

// The embedded dashboard build as an fs.FS.
export function embeddedFS(fsys: EmbeddedFS): StaticFileSystem {
  return {
    stat(name) {
      if (!validPath(name)) {
        return undefined;
      }
      if (fsys.isDir(name)) {
        return "dir";
      }
      return fsys.file(name) ? "file" : undefined;
    },
    open(name) {
      if (!validPath(name)) {
        return undefined;
      }
      const content = fsys.file(name);
      return content ? { content, modTime: 0n } : undefined;
    },
  };
}

// os.DirFS(root). tempRoot is the directory a large ranges body is spooled
// in (pb_data).
export function dirFS(root: string, tempRoot: string): StaticFileSystem {
  // dirFS.join
  const fullName = (name: string): string | undefined => {
    if (root === "" || !validPath(name) || name.includes("\0")) {
      return undefined;
    }
    return root.endsWith("/") ? root + name : `${root}/${name}`;
  };

  return {
    stat(name) {
      const path = fullName(name);
      if (path === undefined) {
        return undefined;
      }
      try {
        const st = statSync(path);
        return st.isDirectory() ? "dir" : st.isFile() ? "file" : undefined;
      } catch {
        return undefined;
      }
    },
    open(name) {
      const path = fullName(name);
      if (path === undefined) {
        return undefined;
      }
      let fd: number;
      try {
        fd = openSync(path, "r");
      } catch {
        return undefined;
      }
      let size: number;
      let modTime: bigint;
      try {
        const st = fstatSync(fd, { bigint: true });
        if (!st.isFile()) {
          return undefined;
        }
        size = Number(st.size);
        modTime = st.mtimeNs;
      } catch {
        return undefined;
      } finally {
        closeSync(fd);
      }
      const file = diskFile(path, size, tempRoot);
      if (size <= maxBufferedRangesSize && !bunSendsInline(contentType(name, file))) {
        return { content: file.read(0, size), modTime };
      }
      return { content: file, modTime };
    },
  };
}

// the Content-Type serveContent sets when the caller set none
function contentType(name: string, file: ServedFile): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  return typeByExtension(base) || detectContentType(file.read(0, 512));
}

// whether Bun.serve sends a path-opened file of this Content-Type without
// adding a Content-Disposition header (Bun 1.4.4, checked against every
// type of the system MIME database)
function bunSendsInline(ctype: string): boolean {
  return (
    /^(?:text|image|font|audio|video)\//.test(ctype) ||
    /^application\/(?:json|geo\+json|wasm)(?:;|$)/.test(ctype)
  );
}

function diskFile(path: string, size: number, tempRoot: string): ServedFile {
  const read = (start: number, length: number): Uint8Array => {
    const out = new Uint8Array(length);
    const fd = openSync(path, "r");
    try {
      let n = 0;
      while (n < length) {
        const m = readSync(fd, out, n, length - n, start + n);
        if (m === 0) {
          break;
        }
        n += m;
      }
      return out.subarray(0, n);
    } finally {
      closeSync(fd);
    }
  };

  return {
    // the size the file had when it was opened
    blob: Bun.file(path).slice(0, size),
    read,
    spool: (parts) => spool(path, tempRoot, parts),
  };
}

// Writes the parts of a large multipart/byteranges body (bytes, or ranges
// of the file) to a temporary file in pieces, and returns its Blob.
async function spool(
  path: string,
  tempRoot: string,
  parts: (Uint8Array | HttpRange)[],
): Promise<{ blob: Blob; remove: () => void }> {
  const tempDir = join(tempRoot, localTempDirName);
  mkdirSync(tempDir, { recursive: true });
  const out =
    tempDir + "/ranges_" + Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex");
  const remove = (): void => rmSync(out, { force: true });
  const dst = await open(out, "wx", 0o600);
  try {
    const src = await open(path, "r");
    try {
      const buf = new Uint8Array(spoolChunk);
      for (const part of parts) {
        if (part instanceof Uint8Array) {
          await dst.write(part);
          continue;
        }
        for (let pos = part.start, left = part.length; left > 0;) {
          const { bytesRead } = await src.read(buf, 0, Math.min(left, buf.length), pos);
          if (bytesRead === 0) {
            throw new Error("unexpected EOF");
          }
          await dst.write(buf.subarray(0, bytesRead));
          pos += bytesRead;
          left -= bytesRead;
        }
      }
    } finally {
      await src.close();
    }
  } catch (err) {
    await dst.close();
    remove();
    throw err;
  }
  await dst.close();
  return { blob: Bun.file(out), remove };
}
