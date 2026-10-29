// Upstream: tools/filesystem/blob/hex.go, blob/bucket.go and
// internal/fileblob (fileblob.go, attrs.go). Upstream has no tests of its
// own for these; the cases check the escaping, key, metadata and sidecar
// rules the ported code follows, through the blob and filesystem APIs.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatMediaType, isNotFound } from "@/tools/filesystem/blob/bucket";
import { HexEscape, HexUnescape } from "@/tools/filesystem/blob/hex";
import { NewFileFromBytes } from "@/tools/filesystem/file";
import { NewLocal } from "@/tools/filesystem/filesystem";
import {
  emptyAttrs,
  marshalAttrs,
  quote,
  unmarshalAttrs,
} from "@/tools/filesystem/internal/fileblob/attrs";
import { escapeKey, unescapeKey } from "@/tools/filesystem/internal/fileblob/fileblob";

const encoder = new TextEncoder();
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iglo-base-blob-"));
  roots.push(dir);
  return dir;
}

describe("HexEscape", () => {
  const all = (): boolean => true;
  const cases: [string, string][] = [
    ["", ""],
    ["a", "__0x61__"],
    [" ", "__0x20__"],
    ["é", "__0xe9__"],
    ["😀", "__0x1f600__"],
  ];
  for (const [s, want] of cases) {
    test(JSON.stringify(s), () => {
      expect(HexEscape(s, all)).toBe(want);
      expect(HexUnescape(want)).toBe(s);
    });
  }

  test("only the selected runes", () => {
    expect(HexEscape("a/b", (r, i) => r[i] === 0x2f)).toBe("a__0x2f__b");
  });

  test("unescape leaves malformed escapes", () => {
    for (const s of ["__0x__", "__0xzz__", "__0x61_", "_0x61__", "__0x1ffffffff__"]) {
      expect(HexUnescape(s)).toBe(s);
    }
    expect(HexUnescape("x__0x61__y__0x2f__")).toBe("xay/");
  });
});

describe("escapeKey", () => {
  const cases: [string, string][] = [
    ["a/b/c.txt", "a/b/c.txt"],
    ["a\x01b", "a__0x1__b"],
    ["../a", "..__0x2f__a"],
    ["a//b", "a/__0x2f__b"],
    ["a/", "a__0x2f__"],
    ["a b/é😀", "a b/é😀"],
  ];
  for (const [key, want] of cases) {
    test(JSON.stringify(key), () => {
      expect(escapeKey(key)).toBe(want);
      expect(unescapeKey(want)).toBe(key);
    });
  }
});

describe("keys", () => {
  test("a key escaping the bucket root or naming a sidecar is refused", () => {
    const dir = newDir();
    const fs = NewLocal(join(dir, "storage"));
    try {
      writeFileSync(join(dir, "outside.txt"), "x");
      expect(() => fs.upload(encoder.encode("x"), "../outside.txt")).not.toThrow(); // "../" is escaped
      expect(existsSync(join(dir, "storage", "..__0x2f__outside.txt"))).toBe(true);
      expect(readFileSync(join(dir, "outside.txt"), "utf8")).toBe("x");
      expect(() => fs.upload(encoder.encode("x"), "a/b.attrs")).toThrow(
        'file extension ".attrs" is reserved',
      );
      expect(() => fs.delete("")).toThrow("escapes bucket root");
    } finally {
      fs.close();
    }
  });

  test("a missing file is not found", () => {
    const fs = NewLocal(newDir());
    try {
      let err: unknown;
      try {
        fs.delete("missing/file.txt");
      } catch (e) {
        err = e;
      }
      expect(isNotFound(err)).toBe(true);
      expect(String((err as Error).message)).toStartWith("[key: missing/file.txt] ");
      expect(fs.exists("missing/file.txt")).toBe(false);
    } finally {
      fs.close();
    }
  });

  test("a directory is not a file", () => {
    const dir = newDir();
    mkdirSync(join(dir, "d"));
    const fs = NewLocal(dir);
    try {
      expect(fs.exists("d")).toBe(false);
    } finally {
      fs.close();
    }
  });

  test("closed", () => {
    const fs = NewLocal(newDir());
    fs.close();
    expect(() => fs.exists("a")).toThrow("bucket or blob is closed");
    expect(() => fs.close()).toThrow("bucket or blob is closed");
  });
});

describe(".attrs", () => {
  test("json/v2 string escaping", () => {
    expect(quote('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(quote("\b\t\n\f\r\x01\x1f")).toBe('"\\b\\t\\n\\f\\r\\u0001\\u001f"');
    expect(quote("<>&  \x7f é😀")).toBe('"<>&  \x7f é😀"');
    expect(() => quote("a\udcc3")).toThrow("invalid UTF-8");
  });

  test("the sidecar of a stored file", async () => {
    const dir = newDir();
    const fs = NewLocal(dir);
    try {
      const file = await NewFileFromBytes(encoder.encode("hello"), 'q"<>& é😀.txt');
      fs.uploadFile(file, "c/r/" + file.name);
      expect(readFileSync(join(dir, "c", "r", file.name + ".attrs"), "utf8")).toBe(
        '{"user.cache_control":"","user.content_disposition":"","user.content_encoding":"","user.content_language":"","user.content_type":"text/plain; charset=utf-8","user.metadata":{"original-filename":"q\\"<>& é😀.txt"},"md5":"XUFAKrxLKna5cZ2REBfFkg=="}',
      );
      const attrs = fs.attributes("c/r/" + file.name);
      expect(attrs.contentType).toBe("text/plain; charset=utf-8");
      expect(attrs.metadata?.get("original-filename")).toBe('q"<>& é😀.txt');
      expect(attrs.size).toBe(5);
      expect(Buffer.from(attrs.md5 ?? []).toString("base64")).toBe("XUFAKrxLKna5cZ2REBfFkg==");
      expect(fs.list("c/")[0]?.md5).toEqual(attrs.md5);
    } finally {
      fs.close();
    }
  });

  test("without metadata (Upload): an empty object, as json/v2 writes a nil map", () => {
    const dir = newDir();
    const fs = NewLocal(dir);
    try {
      fs.upload(encoder.encode("hello"), "a.txt");
      expect(readFileSync(join(dir, "a.txt.attrs"), "utf8")).toBe(
        '{"user.cache_control":"","user.content_disposition":"","user.content_encoding":"","user.content_language":"","user.content_type":"text/plain; charset=utf-8","user.metadata":{},"md5":"XUFAKrxLKna5cZ2REBfFkg=="}',
      );
    } finally {
      fs.close();
    }
  });

  test("read back: null, unknown names and old sidecars without md5", () => {
    const xa = unmarshalAttrs(
      encoder.encode(
        '{"user.content_type":"image/png","user.metadata":null,"other":1,"user.cache_control":null}',
      ),
    );
    expect(xa).toEqual({ ...emptyAttrs(), contentType: "image/png" });
    expect(() => unmarshalAttrs(encoder.encode('{"md5":"!!"}'))).toThrow();
    expect(() => unmarshalAttrs(encoder.encode('{"user.content_type":1}'))).toThrow();
    expect(() => unmarshalAttrs(Uint8Array.of(0x7b, 0xff, 0x7d))).toThrow();
    expect(new TextDecoder().decode(marshalAttrs(xa))).toContain('"user.metadata":{},"md5":""');
  });

  test("a missing sidecar is application/octet-stream", () => {
    const dir = newDir();
    writeFileSync(join(dir, "plain.bin"), "x");
    const fs = NewLocal(dir);
    try {
      expect(fs.attributes("plain.bin").contentType).toBe("application/octet-stream");
    } finally {
      fs.close();
    }
  });
});

describe("UploadFile", () => {
  test("the original name is cut at 255 bytes", async () => {
    const dir = newDir();
    const fs = NewLocal(dir);
    try {
      const name = "é".repeat(127) + "x" + "é".repeat(20) + ".txt";
      const file = await NewFileFromBytes(encoder.encode("x"), name);
      fs.uploadFile(file, "k/" + file.name);
      expect(fs.attributes("k/" + file.name).metadata?.get("original-filename")).toBe(
        "é".repeat(127) + "x",
      );
    } finally {
      fs.close();
    }
  });

  test("a cut inside a character fails and writes nothing", async () => {
    const dir = newDir();
    const fs = NewLocal(dir);
    try {
      const file = await NewFileFromBytes(encoder.encode("x"), "xx" + "é".repeat(140) + ".txt");
      expect(() => fs.uploadFile(file, "k/" + file.name)).toThrow(
        "WriterOptions.Metadata values must be valid UTF-8 strings",
      );
      expect(fs.list("")).toEqual([]);
    } finally {
      fs.close();
    }
  });

  test("a failed write leaves no temporary file", async () => {
    const dir = newDir();
    const fs = NewLocal(dir);
    try {
      const file = await NewFileFromBytes(encoder.encode("x"), "a.txt");
      // the target exists as a non-empty directory: the rename fails
      mkdirSync(join(dir, "k", "a.txt", "sub"), { recursive: true });
      expect(() => fs.uploadFile(file, "k/a.txt")).toThrow();
      expect(fs.list("k/").map((o) => o.key)).toEqual([]);
    } finally {
      fs.close();
    }
  });
});

describe("List and DeletePrefix over several pages", () => {
  test("1,005 files", () => {
    const dir = newDir();
    for (let i = 0; i < 1005; i++) {
      const sub = join(dir, "c", `r${i % 3}`);
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, `f${String(i).padStart(4, "0")}.txt`), "x");
    }
    const fs = NewLocal(dir);
    try {
      expect(fs.list("c/").length).toBe(1005);
      expect(fs.isEmptyDir("c/r1")).toBe(false);
      expect(fs.deletePrefix("c/")).toEqual([]);
      expect(fs.list("").length).toBe(0);
      expect(existsSync(join(dir, "c"))).toBe(false);
      expect(fs.isEmptyDir("c")).toBe(true);
    } finally {
      fs.close();
    }
  });
});

describe("formatMediaType", () => {
  const cases: [string, Map<string, string>, string][] = [
    ["text/plain", new Map([["charset", "utf-8"]]), "text/plain; charset=utf-8"],
    ["Image/PNG", new Map(), "image/png"],
    [
      "text/plain",
      new Map([
        ["b", "x y"],
        ["A", "1"],
      ]),
      'text/plain; a=1; b="x y"',
    ],
    ["text/plain", new Map([["name", "é"]]), "text/plain; name*=utf-8''%C3%A9"],
    ["bad type", new Map(), ""],
  ];
  for (const [t, params, want] of cases) {
    test(`${t} ${JSON.stringify([...params])}`, () => {
      expect(formatMediaType(t, params)).toBe(want);
    });
  }
});
