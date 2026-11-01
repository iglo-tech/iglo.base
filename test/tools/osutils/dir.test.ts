// Upstream: tools/osutils/dir_test.go

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { moveDirContent } from "@/tools/osutils/dir";

import { tempDir } from "@test/support/executable";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

function createTestDir(): string {
  const dir = tempDir();
  dirs.push(dir);
  mkdirSync(join(dir, "a/b/c"), { recursive: true });
  for (const name of ["test1", "test2", "a/a1", "a/a2", "a/b/b1"]) {
    writeFileSync(join(dir, name), "");
  }
  return dir;
}

describe("moveDirContent", () => {
  test("missing src", () => {
    const parent = tempDir();
    dirs.push(parent);
    expect(() => moveDirContent(join(parent, "missing"), join(parent, "dest"))).toThrow();
    expect(existsSync(join(parent, "dest"))).toBe(false);
  });

  test("moves all but the excluded root entries, into a new dest", () => {
    const src = createTestDir();
    const dest = join(tempDir(), "dest");
    dirs.push(dest);

    moveDirContent(src, dest, "test1", "b1");

    // the exclude list is for root entries only
    expect(readdirSync(src)).toEqual(["test1"]);
    expect(readdirSync(dest).toSorted()).toEqual(["a", "test2"]);
    expect(readdirSync(join(dest, "a/b")).toSorted()).toEqual(["b1", "c"]);
  });

  test("into an existing dest", () => {
    const src = createTestDir();
    const dest = tempDir();
    dirs.push(dest);
    writeFileSync(join(dest, "kept"), "");

    moveDirContent(src, dest);

    expect(readdirSync(src)).toEqual([]);
    expect(readdirSync(dest).toSorted()).toEqual(["a", "kept", "test1", "test2"]);
  });

  test("a failed move rolls back and removes the created dest", () => {
    const src = createTestDir();
    const parent = tempDir();
    dirs.push(parent);
    // renaming a directory into itself fails after "a" has moved? a dest
    // whose entry "test2" is a non-empty directory fails for that entry
    const dest = join(parent, "dest");
    mkdirSync(join(dest, "test2", "x"), { recursive: true });

    expect(() => moveDirContent(src, dest)).toThrow();

    expect(readdirSync(src).toSorted()).toEqual(["a", "test1", "test2"]);
    expect(readdirSync(dest)).toEqual(["test2"]);
  });
});
