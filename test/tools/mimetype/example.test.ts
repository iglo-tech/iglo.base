// Upstream: gabriel-vasile/mimetype v1.4.15 example_mimetype_test.go and
// example_reader_test.go, with each example's Output as assertions.
//
// Left out: Example_extend (Extend is not ported) and the DetectFile part of
// Example_detect. Example_detectReader keeps the input for reuse with
// io.TeeReader and io.MultiReader; a Blob is not consumed by detectReader,
// so the same Blob is read again.

import { expect, test } from "bun:test";

import type { MIME } from "@/tools/mimetype/mime";
import { detect, detectReader, equalsAny } from "@/tools/mimetype/mimetype";

import { raw } from "@test/tools/mimetype/go-literal";

const testBytes = raw("This random text has a MIME type of text/plain; charset=utf-8.");

test("Example_detect", async () => {
  let mtype = detect(testBytes);
  expect([mtype.is("text/plain"), mtype.string(), mtype.extension()]).toEqual([
    true,
    "text/plain; charset=utf-8",
    ".txt",
  ]);

  let err: Error | null;
  [mtype, err] = await detectReader(new Blob([testBytes]));
  expect([mtype.is("text/plain"), mtype.string(), mtype.extension(), err]).toEqual([
    true,
    "text/plain; charset=utf-8",
    ".txt",
    null,
  ]);
});

// Considering the definition of a binary file as "a computer file that is not
// a text file", they can differentiated by searching for the text/plain MIME
// in their MIME hierarchy.
test("Example_textVsBinary", () => {
  const detectedMIME = detect(testBytes);

  let isBinary = true;
  for (let mtype: MIME | null = detectedMIME; mtype !== null; mtype = mtype.parent()) {
    if (mtype.is("text/plain")) {
      isBinary = false;
    }
  }

  expect([isBinary, detectedMIME.string()]).toEqual([false, "text/plain; charset=utf-8"]);
});

test("Example_whitelist", () => {
  const allowed = ["text/plain", "application/zip", "application/pdf"];
  const mtype = detect(testBytes);

  expect(equalsAny(mtype.string(), ...allowed)).toBe(true);
  expect(`${mtype.string()} is allowed`).toBe("text/plain; charset=utf-8 is allowed");
});

test("Example_detectReader", async () => {
  const input = new Blob([testBytes]);

  const [mtype, err] = await detectReader(input);

  // Verify input still contains the original input.
  const text = new Uint8Array(await input.arrayBuffer());
  expect([mtype.string(), Buffer.from(text).equals(testBytes), err]).toEqual([
    "text/plain; charset=utf-8",
    true,
    null,
  ]);
});
