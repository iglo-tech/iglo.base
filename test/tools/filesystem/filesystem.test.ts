// Upstream: tools/filesystem/filesystem_test.go
//
// Ported: the local filesystem tests (Exists, Attributes, NewWriter, Delete,
// DeletePrefix with and without a trailing slash, IsEmptyDir, UploadFile,
// Upload, GetReader, GetReuploadableFile, Copy, List, Close) and the
// createTestDir helper.
//
// Not ported: TestFilesystemServe* and TestFilesystemCreateThumb* (serving
// and thumbnails come with M5.2), TestFilesystemUploadMultipart
// (UploadMultipart is not ported: a multipart part is a File and goes
// through UploadFile), and every hook expectation (bindHooks, checkHooks,
// OnDelete and OnNewWriter counts): there are no hooks (D5). The listener
// part of TestFilesystemClose is dropped with them, so that test only checks
// that Close succeeds.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isNotFound, type Reader } from "@/tools/filesystem/blob/bucket";
import { NewLocal, type System } from "@/tools/filesystem/filesystem";
import { NewFileFromPath } from "@/tools/filesystem/file";
import { detect } from "@/tools/mimetype/mimetype";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Tiny valid images standing in for Go's image/png and image/jpeg encoders
// output for a 5x5 image. The PNG is 16-bit RGBA, so its size differs from
// the 78 bytes Go's encoder wrote.
const imagePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFEAYAAADd//qmAAAADElEQVR42mNgGEYAAADNAAGFTMC1AAAAAElFTkSuQmCC",
  "base64",
);
const imageJpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYxLjE5LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAFAAUDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLAFF/f//Z",
  "base64",
);
// a WebP file (a 1x1 lossy image)
const imageWebp = new Uint8Array([
  82, 73, 70, 70, 36, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32, 24, 0, 0, 0, 48, 1, 0, 157, 1, 42, 1,
  0, 1, 0, 2, 0, 52, 37, 164, 0, 3, 112, 0, 254, 251, 253, 80, 0,
]);

// the attributes sidecar Go's createTestDir writes next to an image
function attrsJSON(contentType: string): string {
  return `{"user.cache_control":"","user.content_disposition":"","user.content_encoding":"","user.content_language":"","user.content_type":"${contentType}","user.metadata":null}`;
}

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// createTestDir creates a directory with the test files (Go's
// createTestDir(t)). The caller removes it.
function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pb_test"));
  tempDirs.push(dir);

  mkdirSync(join(dir, "empty"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "test/sub1.txt"), "sub1");
  writeFileSync(join(dir, "test/sub2.txt"), "sub2");

  writeFileSync(join(dir, "image.png"), imagePng);
  writeFileSync(join(dir, "image.png.attrs"), attrsJSON("image/png"));

  writeFileSync(join(dir, "image.jpg"), imageJpeg);
  writeFileSync(join(dir, "image.jpg.attrs"), attrsJSON("image/jpeg"));

  // svg, css, js, mjs, docx, xlsx and pptx are empty: the tests only use
  // their names and extensions
  for (const name of [
    "image.svg",
    "style.css",
    "main.js",
    "main.mjs",
    "dummy.docx",
    "dummy.xlsx",
    "dummy.pptx",
  ]) {
    writeFileSync(join(dir, name), "");
  }

  writeFileSync(join(dir, "image.webp"), imageWebp);

  writeFileSync(join(dir, "image_!@ special"), imagePng);

  writeFileSync(join(dir, "image_noext"), imageJpeg);
  writeFileSync(join(dir, "image_noext.attrs"), attrsJSON("image/jpeg"));

  return dir;
}

// useTestFs gives the tests of one Go test function a shared fixture: a
// createTestDir directory with a local system on it, created before the
// first test and closed and removed after the last one.
function useTestFs(): () => { readonly dir: string; readonly fsys: System } {
  let state: { dir: string; fsys: System } | undefined;

  beforeAll(() => {
    const dir = createTestDir();
    state = { dir, fsys: NewLocal(dir) };
  });

  afterAll(() => {
    if (state !== undefined) {
      state.fsys.close();
      rmSync(state.dir, { recursive: true, force: true });
      state = undefined;
    }
  });

  return () => {
    if (state === undefined) {
      throw new Error("the test filesystem is not set up");
    }
    return state;
  };
}

// thrownBy returns the error fn throws (Go's err != nil)
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

// io.ReadAll for a blob reader or an open file content
function readAll(r: { read(p: Uint8Array): number }): string {
  const chunks: Uint8Array[] = [];
  const buf = new Uint8Array(1024);
  for (;;) {
    const n = r.read(buf);
    if (n === 0) {
      break;
    }
    chunks.push(buf.slice(0, n));
  }
  return decoder.decode(Buffer.concat(chunks));
}

// the content of a File, read through its open reader (Go's f.Reader.Open())
function fileContent(file: { open(): { read(p: Uint8Array): number; close(): void } }): string {
  const r = file.open();
  try {
    return readAll(r);
  } finally {
    r.close();
  }
}

// readerContent reads the content of the blob at key and closes the reader
function readerContent(reader: Reader): string {
  try {
    return readAll(reader);
  } finally {
    reader.close();
  }
}

describe("TestFilesystemExists", () => {
  const fs = useTestFs();

  const scenarios = [
    { file: "sub1.txt", exists: false },
    { file: "test/sub1.txt", exists: true },
    { file: "test/sub2.txt", exists: true },
    { file: "image.png", exists: true },
  ];

  for (const s of scenarios) {
    test(s.file, () => {
      expect(fs().fsys.exists(s.file)).toBe(s.exists);
    });
  }
});

describe("TestFilesystemAttributes", () => {
  const fs = useTestFs();

  const scenarios = [
    { file: "sub1.txt", expectError: true, expectContentType: "" },
    { file: "test/sub1.txt", expectError: false, expectContentType: "application/octet-stream" },
    { file: "test/sub2.txt", expectError: false, expectContentType: "application/octet-stream" },
    { file: "image.png", expectError: false, expectContentType: "image/png" },
  ];

  for (const s of scenarios) {
    test(s.file, () => {
      if (s.expectError) {
        expect(isNotFound(thrownBy(() => fs().fsys.attributes(s.file)))).toBe(true);
        return;
      }

      expect(fs().fsys.attributes(s.file).contentType).toBe(s.expectContentType);
    });
  }
});

test("TestFilesystemNewWriter", () => {
  const dir = createTestDir();
  const fsys = NewLocal(dir);

  try {
    const testKey = "test_writer";
    const expectedContent = "test_content";
    const expectedBytes = encoder.encode(expectedContent);

    // Go sniffs the content type when none is given (http.DetectContentType);
    // detect is the same check here
    const w = fsys.newWriter(testKey, {
      contentType: detect(expectedBytes).string(),
      metadata: new Map([["test", "abc"]]),
    });
    w.write(expectedBytes);
    w.close();

    // verify that the file attributes and content were properly saved
    const attrs = fsys.attributes(testKey);
    expect(attrs.metadata?.get("test")).toBe("abc");

    expect(readerContent(fsys.getReader(testKey))).toBe(expectedContent);
  } finally {
    fsys.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TestFilesystemDelete", () => {
  const dir = createTestDir();
  const fsys = NewLocal(dir);

  try {
    expect(isNotFound(thrownBy(() => fsys.delete("missing.txt")))).toBe(true);

    expect(() => fsys.delete("image.png")).not.toThrow();
  } finally {
    fsys.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TestFilesystemDeletePrefixWithoutTrailingSlash", () => {
  const dir = createTestDir();
  const fsys = NewLocal(dir);

  try {
    expect(fsys.deletePrefix("").length).not.toBe(0);

    expect(fsys.deletePrefix("missing")).toEqual([]);

    expect(fsys.deletePrefix("test")).toEqual([]);

    // ensure that the test/* files are deleted
    expect(fsys.exists("test/sub1.txt")).toBe(false);
    expect(fsys.exists("test/sub2.txt")).toBe(false);

    // the test directory should remain since the prefix didn't have trailing slash
    expect(existsSync(join(dir, "test"))).toBe(true);
  } finally {
    fsys.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TestFilesystemDeletePrefixWithTrailingSlash", () => {
  const dir = createTestDir();
  const fsys = NewLocal(dir);

  try {
    expect(fsys.deletePrefix("missing/")).toEqual([]);

    expect(fsys.deletePrefix("test/")).toEqual([]);

    // ensure that the test/* files are deleted
    expect(fsys.exists("test/sub1.txt")).toBe(false);
    expect(fsys.exists("test/sub2.txt")).toBe(false);

    // the test directory should be also deleted since the prefix has trailing slash
    expect(existsSync(join(dir, "test"))).toBe(false);
  } finally {
    fsys.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("TestFilesystemIsEmptyDir", () => {
  const fs = useTestFs();

  const scenarios = [
    // special case that shouldn't be suffixed with delimiter to search for any files within the bucket
    { dir: "", expected: false },
    { dir: "/", expected: true },
    { dir: "missing", expected: true },
    { dir: "missing/", expected: true },
    { dir: "test", expected: false },
    { dir: "test/", expected: false },
    { dir: "empty", expected: true },
    { dir: "empty/", expected: true },
  ];

  for (const s of scenarios) {
    test(s.dir, () => {
      expect(fs().fsys.isEmptyDir(s.dir)).toBe(s.expected);
    });
  }
});

test("TestFilesystemUploadFile", async () => {
  const dir = createTestDir();
  const fsys = NewLocal(dir);

  try {
    const fileKey = "newdir/newkey.txt";

    const file = await NewFileFromPath(join(dir, "image.svg"));

    file.originalName = "test.txt";

    fsys.uploadFile(file, fileKey);

    expect(fsys.exists(fileKey)).toBe(true);

    const attrs = fsys.attributes(fileKey);
    expect(attrs.metadata?.get("original-filename")).toBe(file.originalName);
  } finally {
    fsys.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TestFilesystemUpload", () => {
  const dir = createTestDir();
  const fsys = NewLocal(dir);

  try {
    const fileKey = "newdir/newkey.txt";

    fsys.upload(encoder.encode("demo"), fileKey);

    expect(fsys.exists(fileKey)).toBe(true);
  } finally {
    fsys.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("TestFilesystemGetReader", () => {
  const fs = useTestFs();

  const scenarios = [
    { file: "test/missing.txt", expectError: true, expectedContent: "" },
    { file: "test/sub1.txt", expectError: false, expectedContent: "sub1" },
  ];

  for (const s of scenarios) {
    test(s.file, () => {
      if (s.expectError) {
        expect(isNotFound(thrownBy(() => fs().fsys.getReader(s.file)))).toBe(true);
        return;
      }

      expect(readerContent(fs().fsys.getReader(s.file))).toBe(s.expectedContent);
    });
  }
});

describe("TestFilesystemGetReuploadableFile", () => {
  const fs = useTestFs();

  test("missing.txt", () => {
    expect(() => fs().fsys.getReuploadableFile("missing.txt", false)).toThrow();
  });

  test("existing (preserve name)", () => {
    const file = fs().fsys.getReuploadableFile("test/sub1.txt", true);

    expect(file.originalName).toBe("sub1.txt");
    expect(file.size).toBe(4);
    expect(file.name).toBe("sub1.txt");

    expect(fileContent(file)).toBe("sub1");
  });

  test("existing (new random suffix name)", () => {
    const file = fs().fsys.getReuploadableFile("test/sub1.txt", false);

    expect(file.originalName).toBe("sub1.txt");
    expect(file.size).toBe(4);
    // a new random suffix: the name is not the original one and is longer
    // than "sub1.txt.png"
    expect(file.name).not.toBe("sub1.txt");
    expect(file.name.length).toBeGreaterThan("sub1.txt.png".length);

    expect(fileContent(file)).toBe("sub1");
  });
});

test("TestFilesystemCopy", () => {
  const dir = createTestDir();
  const fsys = NewLocal(dir);

  try {
    const src = "image.png";
    const dst = "image.png_copy";

    // copy missing file
    expect(() => fsys.copy(dst, src)).toThrow();

    // copy existing file
    expect(() => fsys.copy(src, dst)).not.toThrow();

    const r = fsys.getReader(dst);
    try {
      // Go's encoder wrote 78 bytes for this image; the embedded PNG is smaller
      expect(r.size).toBe(imagePng.length);
    } finally {
      r.close();
    }
  } finally {
    fsys.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("TestFilesystemList", () => {
  const fs = useTestFs();

  const scenarios = [
    {
      prefix: "",
      expected: [
        "image.png",
        "image.jpg",
        "image.svg",
        "image.webp",
        "image_!@ special",
        "image_noext",
        "style.css",
        "main.js",
        "main.mjs",
        "dummy.xlsx",
        "dummy.docx",
        "dummy.pptx",
        "test/sub1.txt",
        "test/sub2.txt",
      ],
    },
    {
      prefix: "test",
      expected: ["test/sub1.txt", "test/sub2.txt"],
    },
    {
      prefix: "missing",
      expected: [] as string[],
    },
  ];

  for (const s of scenarios) {
    test("prefix_" + s.prefix, () => {
      const objs = fs().fsys.list(s.prefix);

      expect(objs.map((obj) => obj.key).toSorted()).toEqual(s.expected.toSorted());
    });
  }
});

test("TestFilesystemClose", () => {
  const dir = createTestDir();
  const fsys = NewLocal(dir);

  try {
    expect(() => fsys.close()).not.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
