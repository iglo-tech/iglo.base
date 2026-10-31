// Upstream: tools/archive/extract.go

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

import { entryMode, ZipReader, type ZipEntry } from "@/tools/archive/zip-reader";

// Extract extracts the zip archive at "src" to "dest".
//
// Note that only dirs and regular files will be extracted.
// Symbolic links, named pipes, sockets, or any other irregular files
// are skipped because they come with too many edge cases and ambiguities.
export async function extract(src: string, dest: string): Promise<void> {
  const zr = new ZipReader(src);

  try {
    // normalize dest path to check later for Zip Slip
    const base = normalize(dest + "/");

    for (const f of zr.files) {
      await extractFile(zr, f, base);
    }
  } finally {
    zr.close();
  }
}

// extractFile extracts the provided zipFile into "basePath/zipFileName" path,
// creating all the necessary path directories.
async function extractFile(zr: ZipReader, zipFile: ZipEntry, basePath: string): Promise<void> {
  const path = join(basePath, zipFile.name).replace(/(?<=.)\/+$/, "");

  // check for Zip Slip
  if (!path.startsWith(basePath)) {
    throw new Error(`invalid file path: ${path}`);
  }

  zr.dataOffset(zipFile);

  const mode = entryMode(zipFile);

  // allow only dirs or regular files
  if (mode.isDir) {
    mkdirSync(path, { recursive: true, mode: 0o777 });
  } else if (mode.isRegular) {
    // ensure that the file path directories are created
    mkdirSync(dirname(path), { recursive: true, mode: 0o777 });

    const fd = openSync(path, "w", mode.perm);
    try {
      await zr.copyTo(zipFile, (chunk) => {
        for (let off = 0; off < chunk.length;) {
          off += writeSync(fd, chunk, off, chunk.length - off);
        }
      });
    } finally {
      closeSync(fd);
    }
  }
}
