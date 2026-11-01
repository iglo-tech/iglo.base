// Upstream: tools/archive/create_test.go, tools/archive/extract_test.go, and
// what the backups rely on: Zip Slip, irregular entries, bad archives,
// Zip64. Hand-written archives are built here byte by byte.

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import { create } from "@/tools/archive/create";
import { extract } from "@/tools/archive/extract";
import { ZipReader } from "@/tools/archive/zip-reader";
import { ZipWriter } from "@/tools/archive/zip-writer";

import { tempDir } from "@test/support/executable";
import { centralEntries } from "@test/tools/archive/central-directory";

let dirs: string[] = [];

function newDir(): string {
  const dir = tempDir();
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

function createTestDir(): string {
  const dir = newDir();
  mkdirSync(join(dir, "a/b/c"), { recursive: true });
  for (const name of ["test", "test2", "a/test", "a/b/sub1", "a/b/c/sub2"]) {
    writeFileSync(join(dir, name), "");
  }
  // symbolic links and other irregular files are left out by Extract
  symlinkSync(join(dir, "test"), join(dir, "symlink"));
  return dir;
}

function filesIn(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => statSync(join(dir, name)).isFile())
    .toSorted();
}

interface RawEntry {
  name: string;
  content?: Uint8Array;
  // the stored bytes, when they are not the content
  stored?: Uint8Array;
  method?: number;
  crc32?: number;
  size?: number;
  // the version-made-by field and the external attributes
  creator?: number;
  attrs?: number;
}

// a zip from raw entries, with data and comment around it
function rawZip(entries: RawEntry[], prefix = new Uint8Array(0)): Uint8Array {
  const parts: Uint8Array[] = [prefix];
  const directory: Uint8Array[] = [];
  let offset = 0;
  const push = (p: Uint8Array): void => {
    parts.push(p);
    offset += p.length;
  };
  for (const e of entries) {
    const name = new TextEncoder().encode(e.name);
    const content = e.content ?? new Uint8Array(0);
    const stored = e.stored ?? content;
    const crc32 = e.crc32 ?? Bun.hash.crc32(content);
    const size = e.size ?? content.length;
    const method = e.method ?? 0;

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc32, true);
    lv.setUint32(18, stored.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, e.creator ?? 0x0314, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc32, true);
    cv.setUint32(20, stored.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, e.attrs ?? 0o100644 * 65536, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    push(local);
    push(stored);
    directory.push(central);
  }
  const start = offset;
  for (const c of directory) {
    push(c);
  }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, offset - start, true);
  ev.setUint32(16, start, true);
  push(end);
  return Buffer.concat(parts);
}

function writeZip(bytes: Uint8Array): string {
  const path = join(newDir(), "test.zip");
  writeFileSync(path, bytes);
  return path;
}

describe("create", () => {
  test("TestCreateFailure", () => {
    const zipPath = join(newDir(), "pb_test.zip");
    expect(() => create(join(newDir(), "missing"), zipPath)).toThrow();
    expect(existsSync(zipPath)).toBe(false);
  });

  test("TestCreateSuccess", () => {
    const testDir = createTestDir();
    const zipPath = join(newDir(), "pb_test.zip");
    create(testDir, zipPath, "a/b/c", "test");

    expect(centralEntries(readFileSync(zipPath)).map((e) => e.name)).toEqual([
      "a/b/sub1",
      "a/test",
      "symlink",
      "test2",
    ]);
  });
});

describe("extract", () => {
  test("TestExtractFailure", async () => {
    const extractedPath = join(newDir(), "pb_zip_extract");
    await expect(extract(join(newDir(), "missing.zip"), extractedPath)).rejects.toThrow();
    expect(existsSync(extractedPath)).toBe(false);
  });

  test("TestExtractSuccess", async () => {
    const testDir = createTestDir();
    const zipPath = join(newDir(), "pb_test.zip");
    const extractedPath = join(newDir(), "pb_zip_extract");

    create(testDir, zipPath, "a/b/c", "test2", "sub2");
    await extract(zipPath, extractedPath);

    // note: symbolic links and other irregular files should be missing
    expect(filesIn(extractedPath)).toEqual(["a/b/sub1", "a/test", "test"]);
  });

  test("keeps the content across compression blocks, and the mode", async () => {
    const dir = newDir();
    const content = new Uint8Array(3 * (1 << 20) + 17).map((_, i) => (i * 31) ^ (i >> 8));
    writeFileSync(join(dir, "big.bin"), content);
    writeFileSync(join(dir, "empty"), "");
    writeFileSync(join(dir, "private"), "x");
    chmodSync(join(dir, "private"), 0o600);

    const zipPath = join(newDir(), "pb_test.zip");
    const extractedPath = join(newDir(), "out");
    create(dir, zipPath);
    await extract(zipPath, extractedPath);

    expect(Bun.hash(readFileSync(join(extractedPath, "big.bin")))).toBe(Bun.hash(content));
    expect(statSync(join(extractedPath, "empty")).size).toBe(0);
    expect(statSync(join(extractedPath, "private")).mode & 0o777).toBe(0o600);
  });

  test("a stored and a deflated entry, a directory entry, data before the archive", async () => {
    const out = join(newDir(), "out");
    const content = new TextEncoder().encode("hello hello hello");
    const zip = rawZip(
      [
        { name: "dir/", attrs: 0o040755 * 65536 },
        { name: "dir/stored.txt", content },
        { name: "deflated.txt", content, stored: deflateRawSync(content), method: 8 },
      ],
      new TextEncoder().encode("#!/bin/sh prefix\n"),
    );

    await extract(writeZip(zip), out);

    expect(filesIn(out)).toEqual(["deflated.txt", "dir/stored.txt"]);
    expect(readFileSync(join(out, "deflated.txt"), "utf8")).toBe("hello hello hello");
  });

  test("Zip Slip is refused", async () => {
    const parent = newDir();
    const out = join(parent, "out");
    await expect(
      extract(writeZip(rawZip([{ name: "../evil.txt", content: new Uint8Array(1) }])), out),
    ).rejects.toThrow(`invalid file path: ${join(parent, "evil.txt")}`);
    expect(existsSync(join(parent, "evil.txt"))).toBe(false);

    // a sibling with the same name start
    await expect(
      extract(writeZip(rawZip([{ name: "../out-2/x", content: new Uint8Array(1) }])), out),
    ).rejects.toThrow("invalid file path");
    expect(existsSync(join(parent, "out-2"))).toBe(false);
  });

  test("an absolute name stays inside", async () => {
    const out = join(newDir(), "out");
    await extract(writeZip(rawZip([{ name: "/abs/x", content: new Uint8Array(1) }])), out);
    expect(filesIn(out)).toEqual(["abs/x"]);
  });

  test("symlinks and irregular entries are skipped", async () => {
    const out = join(newDir(), "out");
    const target = new TextEncoder().encode("/etc/passwd");
    await extract(
      writeZip(
        rawZip([
          { name: "link", content: target, attrs: 0o120777 * 65536 },
          { name: "fifo", attrs: 0o010644 * 65536 },
          { name: "socket", attrs: 0o140644 * 65536 },
          { name: "device", attrs: 0o020644 * 65536 },
          { name: "regular", content: target },
        ]),
      ),
      out,
    );
    expect(readdirSync(out)).toEqual(["regular"]);
  });

  test("MS-DOS attributes", async () => {
    const out = join(newDir(), "out");
    await extract(
      writeZip(
        rawZip([
          { name: "folder", creator: 0x0014, attrs: 0x10 },
          { name: "read-only", creator: 0x0a14, attrs: 0x01, content: new Uint8Array(1) },
        ]),
      ),
      out,
    );
    expect(statSync(join(out, "folder")).isDirectory()).toBe(true);
  });

  const content = new TextEncoder().encode("content");
  const bad: [string, () => Uint8Array, string][] = [
    ["not a zip", () => new Uint8Array(500), "zip: not a valid zip file"],
    ["empty file", () => new Uint8Array(0), "zip: not a valid zip file"],
    ["a wrong checksum", () => rawZip([{ name: "a", content, crc32: 1 }]), "zip: checksum error"],
    ["a short entry", () => rawZip([{ name: "a", content, size: 100 }]), "unexpected EOF"],
    [
      "more data than the entry's size",
      () => rawZip([{ name: "a", content, stored: deflateRawSync(content), method: 8, size: 2 }]),
      "unexpected EOF",
    ],
    [
      "a broken Deflate stream",
      () => rawZip([{ name: "a", content, stored: new Uint8Array([0xff, 0xff, 0xff]), method: 8 }]),
      "",
    ],
    [
      "an unsupported method",
      () => rawZip([{ name: "a", content, method: 14 }]),
      "zip: unsupported compression algorithm",
    ],
  ];
  for (const [name, zip, message] of bad) {
    test(`${name} fails`, async () => {
      await expect(extract(writeZip(zip()), join(newDir(), "out"))).rejects.toThrow(message);
    });
  }

  test("a cut archive fails", async () => {
    const dir = createTestDir();
    const zipPath = join(newDir(), "pb_test.zip");
    create(dir, zipPath);
    truncateSync(zipPath, statSync(zipPath).size - 30);
    await expect(extract(zipPath, join(newDir(), "out"))).rejects.toThrow(
      "zip: not a valid zip file",
    );
  });
});

describe("zip format", () => {
  test("Deflate, forward slashes, the mode and mod time", () => {
    const dir = newDir();
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub/ż.txt"), "x", { mode: 0o640 });
    const zipPath = join(newDir(), "t.zip");
    create(dir, zipPath);

    const [entry] = centralEntries(readFileSync(zipPath));
    expect(entry).toEqual({
      name: "sub/ż.txt",
      method: 8,
      flags: 0x808,
      mode: 0o100640,
      modTime: Math.trunc(statSync(join(dir, "sub/ż.txt")).mtimeMs / 1000),
    });
  });

  test("Zip64 records above 65,535 entries", async () => {
    const dir = newDir();
    writeFileSync(join(dir, "f"), "x");
    const zipPath = join(newDir(), "t.zip");

    const zw = new ZipWriter(zipPath);
    const total = 65_536;
    for (let i = 0; i < total; i++) {
      zw.addFile(join(dir, "f"), `f${i}`);
    }
    zw.close();

    const zr = new ZipReader(zipPath);
    expect(zr.files.length).toBe(total);
    expect(zr.files[total - 1]?.name).toBe(`f${total - 1}`);
    zr.close();

    // the regular end record only points to the Zip64 one
    const bytes = readFileSync(zipPath);
    const end = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 22);
    expect(end.getUint16(10, true)).toBe(0xffff);
    expect(end.getUint32(16, true)).toBe(0xffffffff);
    expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true);
  }, 30_000);

  test("a named pipe is left out", () => {
    const dir = newDir();
    Bun.spawnSync(["mkfifo", join(dir, "pipe")]);
    const zipPath = join(newDir(), "t.zip");
    create(dir, zipPath);
    expect(centralEntries(readFileSync(zipPath))).toEqual([]);
  });

  test("a symlink keeps its mode and has its target's content", () => {
    const dir = newDir();
    writeFileSync(join(dir, "target"), "content");
    symlinkSync(join(dir, "target"), join(dir, "link"));
    const zipPath = join(newDir(), "t.zip");
    create(dir, zipPath);
    const [link] = centralEntries(readFileSync(zipPath));
    expect(link?.name).toBe("link");
    expect((link?.mode ?? 0) & 0o170000).toBe(0o120000);
  });

  test("a symlink to a directory fails, as Go's read does", () => {
    const dir = newDir();
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "link"));
    expect(() => create(dir, join(newDir(), "t.zip"))).toThrow("is a directory");
  });
});
