// Upstream: tools/filesystem/file_test.go
//
// TestNewFileFromURLTimeout is not ported: NewFileFromURL comes with M4.5.
// The cases after the ported ones check the name rules with an injected
// random source ("R" for every random character), so whole names can be
// compared.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  File,
  NewFileFromBytes,
  NewFileFromMultipart,
  NewFileFromPath,
  extractExtension,
  normalizeName,
  type RandomSource,
} from "@/tools/filesystem/file";
import { ThumbSizeRegex } from "@/tools/filesystem/filesystem";
import { textToBytes } from "@/tools/types/go-json";

const encoder = new TextEncoder();

// "R" repeated: an injected random source
const fixedRandom: RandomSource = (length) => "R".repeat(length);

// a 78-byte file starting with the PNG signature (upstream's test image is
// a 78-byte PNG)
const png = new Uint8Array(78);
png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let testDir: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "iglo-base-filesystem-"));
  writeFileSync(join(testDir, "image_!@ special"), png);
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

test("TestFileAsMap", async () => {
  const file = await NewFileFromBytes(encoder.encode("test"), "test123.txt");

  const result = file.asMap();

  expect(Object.keys(result).length).toBe(3);
  expect(result.size).toBe(4);
  expect(result.name).toStartWith("test123");
  expect(result.originalName).toBe("test123.txt");
});

test("TestNewFileFromPath", async () => {
  // missing file
  expect(NewFileFromPath("missing")).rejects.toThrow();

  // existing file
  const originalName = "image_!@ special";
  const f = await NewFileFromPath(join(testDir, originalName));
  expect(f.originalName).toBe(originalName);
  expect(f.name).toMatch(/^image_special_\w{10}\.png$/);
  expect(f.size).toBe(78);
  // the reader is the file at the path (PathReader)
  expect((f.reader as ReturnType<typeof Bun.file>).name).toBe(join(testDir, originalName));
});

test("TestNewFileFromBytes", async () => {
  // nil bytes
  expect(NewFileFromBytes(null, "photo.jpg")).rejects.toThrow("cannot create an empty file");

  // zero bytes
  expect(NewFileFromBytes(new Uint8Array(0), "photo.jpg")).rejects.toThrow(
    "cannot create an empty file",
  );

  const originalName = "image_!@ special";
  const f = await NewFileFromBytes(encoder.encode("text\n"), originalName);
  expect(f.size).toBe(5);
  expect(f.originalName).toBe(originalName);
  expect(f.name).toMatch(/^image_special_\w{10}\.txt$/);
  expect(await f.reader.text()).toBe("text\n");
});

test("TestNewFileFromMultipart", async () => {
  // tests.MockMultipartData: a "tmpfile-*.txt" file with "test"
  const form = new FormData();
  form.append("test", new globalThis.File(["test"], `${tmpdir()}/tmpfile-123456.txt`));
  const req = new Request("http://localhost/", { method: "POST", body: form });
  const part = (await req.formData()).get("test") as globalThis.File;

  const f = await NewFileFromMultipart(part);

  // the directory part is dropped, as Go's Part.FileName() does
  expect(f.originalName).toMatch(/^tmpfile-\w+\.txt$/);
  expect(f.name).toMatch(/^tmpfile_\w+_\w{10}\.txt$/);
  expect(f.size).toBe(4);
  expect(await f.reader.text()).toBe("test");
});

describe("TestFileNameNormalizations", () => {
  const scenarios: [string, RegExp][] = [
    ["", /^\w{10}_\w{10}\.txt$/],
    [".png", /^\w{10}_\w{10}\.png$/],
    [".tar.gz", /^\w{10}_\w{10}\.tar\.gz$/],
    ["a.tar.gz", /^a\w{10}_\w{10}\.tar\.gz$/],
    ["....abc", /^\w{10}_\w{10}\.abc$/],
    ["a.b.c.?.?.?.2", /^a_b_c_\w{10}\.2$/],
    ["a.b.c.d.tar.gz", /^a_b_c_d_\w{10}\.tar\.gz$/],
    ["abcd", /^abcd_\w{10}\.txt$/],
    [".abcd.123.", /^abcd_\w{10}\.123$/],
    ["a  b! c d  . 456", /^a_b_c_d_\w{10}\.456$/], // normalize spaces
    ["a".repeat(101) + "." + "b".repeat(21), /^a{100}_\w{10}\.b{20}$/], // name and extension length cut
    ["abc" + "d".repeat(290) + "." + "b".repeat(9), /^d{100}_\w{10}\.b{9}$/], // initial total length cut
  ];

  for (const [i, [name, pattern]] of scenarios.entries()) {
    test(`${i}_${name}`, async () => {
      const f = await NewFileFromBytes(encoder.encode("abc"), name);
      expect(f.name).toMatch(pattern);
    });
  }
});

describe("name rules", () => {
  const text = encoder.encode("abc");
  const scenarios: [name: string, content: Uint8Array, expected: string][] = [
    ["test.txt", text, "test_RRRRRRRRRR.txt"],
    ["Test File.TXT", text, "test_file_RRRRRRRRRR.TXT"],
    ["myTestDB.json", text, "my_test_db_RRRRRRRRRR.json"],
    ["ab.txt", text, "abRRRRRRRRRR_RRRRRRRRRR.txt"],
    ["abc.txt", text, "abc_RRRRRRRRRR.txt"],
    ["a_b.txt", text, "a_b_RRRRRRRRRR.txt"],
    // double extensions
    ["archive.tar.gz", text, "archive_RRRRRRRRRR.tar.gz"],
    ["v1.2.3.zip", text, "v1_2_RRRRRRRRRR.3.zip"],
    ["a.b", text, "aRRRRRRRRRR_RRRRRRRRRR.b"],
    // the extension cleanup: only [\w.*\-+=#] stay, then dots are trimmed
    ["photo.j p g", text, "photo_RRRRRRRRRR.jpg"],
    ["photo.ż", text, "photo_RRRRRRRRRR.txt"], // nothing left: detected
    ["photo.c++", text, "photo_RRRRRRRRRR.c++"],
    ["x.a*b=c#d-e", text, "xRRRRRRRRRR_RRRRRRRRRR.a*b=c#d-e"],
    ["file.?", text, "file_RRRRRRRRRR.txt"],
    // a missing extension is detected from the content
    ["noext", text, "noext_RRRRRRRRRR.txt"],
    ["noext", png, "noext_RRRRRRRRRR.png"],
    ["noext", encoder.encode("%PDF-1.7\n"), "noext_RRRRRRRRRR.pdf"],
    ["noext", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), "noext_RRRRRRRRRR"],
    ["noext", new Uint8Array([0, 1, 2, 3]), "noext_RRRRRRRRRR"], // octet-stream: no extension
    ["noext.", text, "noext_RRRRRRRRRR.txt"],
    // unicode names: Snakecase keeps ASCII letters and digits only
    ["zażółć gęślą jaźń.txt", text, "za_g_l_ja_RRRRRRRRRR.txt"],
    ["日本語.txt", text, "RRRRRRRRRR_RRRRRRRRRR.txt"],
    ["😀 emoji 😀.png", text, "emoji_RRRRRRRRRR.png"],
    ["Ünïcödé Ñame.pdf", text, "n_c_d_ame_RRRRRRRRRR.pdf"],
    // the 20-character extension cut keeps the last 20 characters
    ["x." + "abcdefghij".repeat(3), text, "xRRRRRRRRRR_RRRRRRRRRR.abcdefghijabcdefghij"],
    ["name.a." + "b".repeat(25), text, "name_RRRRRRRRRR." + "b".repeat(20)],
    ["name.a." + "b".repeat(18), text, "name_RRRRRRRRRR.a." + "b".repeat(18)], // 21: cut to 20, then the dot back
    ["name." + "b".repeat(19) + ".c", text, "name_RRRRRRRRRR." + "b".repeat(18) + ".c"],
    // the 100-character name cut
    ["n".repeat(150) + ".txt", text, "n".repeat(100) + "_RRRRRRRRRR.txt"],
    [
      "AbCd".repeat(30) + ".txt",
      text,
      ("ab_cd_".repeat(17) + "ab").slice(0, 100) + "_RRRRRRRRRR.txt",
    ],
  ];

  for (const [i, [name, content, expected]] of scenarios.entries()) {
    test(`${i} ${JSON.stringify(name)}`, () => {
      expect(normalizeName(content, name, fixedRandom)).toBe(expected);
    });
  }

  test("the 300-byte cut counts UTF-8 bytes and may split a character", () => {
    // 2-byte characters: the cut starts in the middle of one
    const name = "ż".repeat(200) + "abc.txt"; // 400 + 7 bytes
    expect(textToBytes(name).length).toBe(407);
    expect(normalizeName(text, name, fixedRandom)).toBe("abc_RRRRRRRRRR.txt");

    // the cut drops the start of the name, leaving a short one
    const short = "a".repeat(296) + "b.c.d"; // 301 bytes: "a" is cut
    expect(normalizeName(text, short, fixedRandom)).toBe("a".repeat(100) + "_RRRRRRRRRR.c.d");
    const exact = "abc" + "d".repeat(290) + "." + "b".repeat(6); // 300 bytes: no cut
    expect(normalizeName(text, exact, fixedRandom)).toBe(
      ("abc" + "d".repeat(290)).slice(0, 100) + "_RRRRRRRRRR." + "b".repeat(6),
    );

    // the invalid byte left by the cut is not a word character, and the
    // extension cleanup removes the non-ASCII characters
    const split = "b" + "ą".repeat(150) + ".ąą"; // 306 bytes
    expect(textToBytes(split).length).toBe(306);
    expect(normalizeName(text, split, fixedRandom)).toBe("RRRRRRRRRR_RRRRRRRRRR.txt");
  });

  test("the random parts come from the source in order", () => {
    const calls: [number, string][] = [];
    let n = 0;
    const random: RandomSource = (length, alphabet) => {
      calls.push([length, alphabet]);
      n++;
      return String(n).repeat(length);
    };
    expect(normalizeName(text, "a.txt", random)).toBe("a1111111111_2222222222.txt");
    expect(calls).toEqual([
      [10, "abcdefghijklmnopqrstuvwxyz0123456789"],
      [10, "abcdefghijklmnopqrstuvwxyz0123456789"],
    ]);
  });

  test("the default source gives lowercase letters and digits", () => {
    for (let i = 0; i < 20; i++) {
      expect(normalizeName(text, "", undefined)).toMatch(/^[a-z0-9]{10}_[a-z0-9]{10}\.txt$/);
    }
  });

  test("a read error leaves the extension empty", () => {
    expect(normalizeName(new Error("read failed"), "noext", fixedRandom)).toBe("noext_RRRRRRRRRR");
  });
});

test("extractExtension", () => {
  expect(extractExtension("test.txt")).toBe(".txt");
  expect(extractExtension("test.tar.gz")).toBe(".tar.gz");
  expect(extractExtension("test.a.tar.gz")).toBe(".tar.gz");
  expect(extractExtension("test")).toBe("");
  expect(extractExtension(".txt")).toBe(".txt");
  expect(extractExtension(".a.txt")).toBe(".a.txt");
  expect(extractExtension("a..txt")).toBe("..txt");
  expect(extractExtension("a.")).toBe(".");
  expect(extractExtension("")).toBe("");
});

test("NewFileFromMultipart drops the directory parts as filepath.Base", async () => {
  const cases: [string, string][] = [
    ["dir/sub/a.txt", "a.txt"],
    ["/abs/b.txt", "b.txt"],
    ["c.txt/", "c.txt"],
    ["/", "/"],
    ["//", "/"],
    ["a\\b.txt", "a\\b.txt"], // not a separator on Unix
    ["", ""],
  ];
  for (const [name, original] of cases) {
    const f = await NewFileFromMultipart(new globalThis.File(["abc"], name), {
      random: fixedRandom,
    });
    expect({ name, original: f.originalName }).toEqual({ name, original });
  }
  const f = await NewFileFromMultipart(new globalThis.File(["abc"], "dir/my file.txt"), {
    random: fixedRandom,
  });
  expect(f.name).toBe("my_file_RRRRRRRRRR.txt");
});

test("detect uses the first 4096 bytes read when the File was created", async () => {
  const f = await NewFileFromBytes(png, "image.png");
  const [mt, err] = f.detect();
  expect(err).toBeNull();
  expect(mt.string()).toBe("image/png");

  const failing = new File(new Blob(["x"]), new Error("read failed"), "a.txt", "a.txt", 1);
  const [mt2, err2] = failing.detect();
  expect(err2?.message).toBe("read failed");
  expect(mt2.string()).toBe("application/octet-stream");
});

test("JSON members", async () => {
  const f = await NewFileFromBytes(encoder.encode("test"), "test.txt", { random: fixedRandom });
  expect(Object.keys(f).toSorted()).toEqual(["name", "originalName", "size"]);
});

test("ThumbSizeRegex", () => {
  for (const s of ["100x200", "0x0", "100x200t", "100x200b", "100x200f", "1x0", "007x8"]) {
    expect({ s, match: ThumbSizeRegex.matchString(s) }).toEqual({ s, match: true });
  }
  for (const s of ["100x", "x100", "100x200a", "100X200", "100x200tt", " 100x200", "１x2"]) {
    expect({ s, match: ThumbSizeRegex.matchString(s) }).toEqual({ s, match: false });
  }
});
