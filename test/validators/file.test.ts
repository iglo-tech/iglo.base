// Upstream: core/validators/file_test.go
//
// The cases after the ported tables check the error codes, messages and
// params.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, test } from "bun:test";

import { File, NewFileFromBytes, NewFileFromPath } from "@/tools/filesystem/file";
import { marshal } from "@/tools/types/go-json";
import type { Error as ValidationError } from "@/validation/error";
import { UploadedFileMimeType, UploadedFileSize } from "@/validators/file";
import { ErrUnsupportedValueType } from "@/validators/validators";

const encoder = new TextEncoder();

// code, message and params of a validation error
function errorParts(err: Error | null): unknown {
  if (err === null) {
    return null;
  }
  const v = err as ValidationError;
  return { code: v.code(), message: v.message, params: marshal(v.params()) };
}

describe("TestUploadedFileSize", () => {
  let file: File;
  beforeAll(async () => {
    file = await NewFileFromBytes(encoder.encode("test"), "test.txt");
  });

  const scenarios: [maxBytes: number, withFile: boolean, expectError: boolean][] = [
    [0, false, false],
    [4, false, false],
    [3, true, true], // all test files have "test" as content
    [4, true, false],
    [5, true, false],
  ];

  for (const [maxBytes, withFile, expectError] of scenarios) {
    test(`${maxBytes}`, () => {
      const err = UploadedFileSize(maxBytes)(withFile ? file : null);
      expect(err !== null).toBe(expectError);
    });
  }
});

describe("TestUploadedFileMimeType", () => {
  let file: File;
  beforeAll(async () => {
    file = await NewFileFromBytes(encoder.encode("test"), "test.png"); // the extension shouldn't matter
  });

  const scenarios: [types: string[] | null, withFile: boolean, expectError: boolean][] = [
    [null, false, false],
    [["image/jpeg"], false, false],
    [[], true, true],
    [["image/jpeg"], true, true],
    // test files are detected as "text/plain; charset=utf-8" content type
    [["image/jpeg", "text/plain; charset=utf-8"], true, false],
  ];

  for (const [i, [types, withFile, expectError]] of scenarios.entries()) {
    test(`${i}_${(types ?? []).join(";")}`, () => {
      const err = UploadedFileMimeType(types)(withFile ? file : null);
      expect(err !== null).toBe(expectError);
    });
  }
});

describe("errors", () => {
  test("unsupported values", () => {
    for (const v of [undefined, "test.txt", {}, new Blob(["x"])]) {
      expect(UploadedFileSize(1)(v)).toBe(ErrUnsupportedValueType);
      expect(UploadedFileMimeType(["text/plain"])(v)).toBe(ErrUnsupportedValueType);
    }
  });

  test("size limit", async () => {
    const file = await NewFileFromBytes(encoder.encode("hello"), "héllo wörld.txt");
    expect(errorParts(UploadedFileSize(4)(file))).toEqual({
      code: "validation_file_size_limit",
      message: "Failed to upload héllo wörld.txt - the maximum allowed file size is 4 bytes.",
      params: `{"file":"héllo wörld.txt","maxSize":4}`,
    });
    expect(UploadedFileSize(5)(file)).toBeNull();
    // int64 limits
    expect(UploadedFileSize(2n ** 62n)(file)).toBeNull();
    expect(errorParts(UploadedFileSize(-(2n ** 63n))(file))).toEqual({
      code: "validation_file_size_limit",
      message:
        "Failed to upload héllo wörld.txt - the maximum allowed file size is -9223372036854775808 bytes.",
      params: `{"file":"héllo wörld.txt","maxSize":-9223372036854775808}`,
    });
  });

  test("the original name is cut at 300 bytes", async () => {
    // 2-byte characters: the cut at 300 bytes ends inside the 150th
    const name = "x" + "ż".repeat(200);
    const file = await NewFileFromBytes(encoder.encode("hello"), name);
    // the first byte of the 150th "ż" (0xc5) is the lone surrogate U+DCC5
    const cut = "x" + "ż".repeat(149) + "\udcc5...";
    const err = UploadedFileSize(1)(file) as ValidationError;
    expect(err.params()).toEqual({ file: cut, maxSize: 1 });

    const mimeErr = UploadedFileMimeType([])(file) as ValidationError;
    expect(mimeErr.message).toBe(
      `Failed to upload "x${"ż".repeat(149)}\\xc5..." due to unsupported file type.`,
    );
  });

  test("mime type messages", async () => {
    const file = await NewFileFromBytes(encoder.encode("test"), 'my "quoted"\tname.txt', {
      random: (n) => "r".repeat(n),
    });
    expect(file.name).toBe("my_quoted_name_rrrrrrrrrr.txt");

    expect(errorParts(UploadedFileMimeType([])(file))).toEqual({
      code: "validation_invalid_mime_type",
      message: `Failed to upload "my \\"quoted\\"\\tname.txt" due to unsupported file type.`,
      params: "{}",
    });
    expect(errorParts(UploadedFileMimeType(["image/png", "image/jpeg", "{{.x}}"])(file))).toEqual({
      code: "validation_invalid_mime_type",
      message: `"my_quoted_name_rrrrrrrrrr.txt" mime type must be one of: image/png, image/jpeg, {{.x}}.`,
      params: "{}",
    });
    // Is compares the type and subtype, ignoring the parameters and case
    expect(UploadedFileMimeType(["TEXT/PLAIN"])(file)).toBeNull();
    expect(UploadedFileMimeType(["text/plain; charset=latin1"])(file)).toBeNull();
    expect(UploadedFileMimeType(["application/octet-stream"])(file)).not.toBeNull(); // parents do not match
    expect(UploadedFileMimeType(["text/*"])(file)).not.toBeNull();
  });

  test("a read error is the base error", () => {
    const file = new File(new Blob(["x"]), new Error("read failed"), "a.txt", "a.txt", 1);
    expect(errorParts(UploadedFileMimeType(["text/plain"])(file))).toEqual({
      code: "validation_invalid_mime_type",
      message: `Failed to upload "a.txt" due to unsupported file type.`,
      params: "{}",
    });
  });
});

// Not in upstream's tests (council round 1): Go's PathReader opens the path
// again for each check, so a path-backed File is checked against the
// content the path has when the rule runs, not when the File was created.
test("UploadedFileMimeType reads a path-backed file again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iglo-base-file-validator-"));
  try {
    const path = join(dir, "sample.png");
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(path, png);
    const file = await NewFileFromPath(path);
    expect(UploadedFileMimeType(["image/png"])(file)).toBeNull();

    writeFileSync(path, "<html><body>changed</body></html>");
    expect(errorParts(UploadedFileMimeType(["image/png"])(file))).toEqual({
      code: "validation_invalid_mime_type",
      message: `"${file.name}" mime type must be one of: image/png.`,
      params: "{}",
    });

    rmSync(path);
    expect(errorParts(UploadedFileMimeType(["image/png"])(file))).toEqual({
      code: "validation_invalid_mime_type",
      message: `Failed to upload "sample.png" due to unsupported file type.`,
      params: "{}",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
