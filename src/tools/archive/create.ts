// Upstream: tools/archive/create.go

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

import { ZipWriter } from "@/tools/archive/zip-writer";

// Create creates a new zip archive from src dir content and saves it in dest path.
//
// You can specify skipPaths to skip/ignore certain directories and files (relative to src)
// preventing adding them in the final archive.
export function create(src: string, dest: string, ...skipPaths: string[]): void {
  mkdirSync(dirname(dest), { recursive: true, mode: 0o777 });

  const zw = new ZipWriter(dest);

  try {
    zipAddDir(zw, src, "", skipPaths);
  } catch (err) {
    // try to cleanup at least the created zip file
    zw.abort();
    rmSync(dest, { force: true });
    throw err;
  }

  zw.close();
}

function clean(path: string): string {
  return normalize(path).replace(/\/+$/, "");
}

function zipAddDir(zw: ZipWriter, root: string, dir: string, skipPaths: string[]): void {
  const entries = readdirSync(join(root, dir), { withFileTypes: true }).toSorted((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );

  for (const entry of entries) {
    const name = dir === "" ? entry.name : `${dir}/${entry.name}`;

    if (entry.isDirectory()) {
      zipAddDir(zw, root, name, skipPaths);
      continue;
    }

    // skip
    if (skipPaths.some((skip) => skip === name || `${name}/`.startsWith(`${clean(skip)}/`))) {
      continue;
    }

    zw.addFile(join(root, name), name);
  }
}
