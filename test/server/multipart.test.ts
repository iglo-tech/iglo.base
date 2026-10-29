// Upstream: Go 1.27.2 mime/multipart multipart_test.go and formdata_test.go,
// ported against src/server/multipart.ts (with src/server/io.ts,
// bufio.ts and textproto.ts underneath).
//
// Go's Writer is not ported, so writeMultipart below emits the same bytes as
// go1.27.2 mime/multipart/writer.go (CreatePart, Close).
//
// Skipped tests (all other tests are ported, the table entries included):
// - TestReadForm_ManyFiles_Combined, TestReadForm_ManyFiles_Distinct: they
//   check temporary files on disk, the tempDir and GODEBUG=multipartfiles.
//   File parts are kept in memory here.
// - TestReadFormLimits rows with GODEBUG overrides (multipartmaxparts=100,
//   multipartmaxheaders=100): GODEBUG is not read, the limits are fixed at
//   the defaults. The default rows are ported.
// - BenchmarkReadForm: a benchmark, not a test.
//
// Assertions on disk files (fd.(*os.File), "file is on disk") are dropped
// from the ported tests: parts are never written to disk here.

import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BytesBuffer, copy, EOF, ErrUnexpectedEOF, type Reader as IoReader } from "@/server/io";
import {
  ErrMessageTooLarge,
  type FileHeader,
  Part,
  Reader as MultipartReader,
} from "@/server/multipart";
import { MultipartReader as MultipartFileReader } from "@/tools/filesystem/file";
import type { MIMEHeader } from "@/server/textproto";

// The byte string of a Go string literal (one character per byte).
function bytesOf(s: string): Uint8Array {
  return Buffer.from(s, "latin1");
}

// A Go-style reader over data: (n, nil) until the data is used up, then
// (0, EOF). maxChunk limits each Read (1 for the slow reader).
function reader(data: Uint8Array, maxChunk = Number.POSITIVE_INFINITY): IoReader {
  let off = 0;
  return {
    async read(p) {
      if (off >= data.length) {
        return [0, EOF];
      }
      const n = Math.min(p.length, data.length - off, maxChunk);
      p.set(data.subarray(off, off + n));
      off += n;
      return [n, undefined];
    },
  };
}

// io.MultiReader
function multiReader(...readers: IoReader[]): IoReader {
  const rs = [...readers];
  return {
    async read(p) {
      while (rs.length > 0) {
        const [n, err] = await (rs[0] as IoReader).read(p);
        if (err === EOF) {
          rs.shift();
          if (n > 0) {
            return [n, undefined];
          }
          continue;
        }
        return [n, err];
      }
      return [0, EOF];
    },
  };
}

// io.ReadAll as a latin1 byte string, with the error io.ReadAll returns.
async function readAll(r: IoReader): Promise<[string, unknown]> {
  const buf = new BytesBuffer();
  const [, err] = await copy(buf, r);
  return [Buffer.from(buf.bytes()).toString("latin1"), err];
}

function headerObject(h: MIMEHeader): Record<string, string[]> {
  return Object.fromEntries(h.entries());
}

function first<T>(xs: T[] | undefined): T {
  if (xs === undefined || xs.length === 0) {
    throw new Error("no value");
  }
  return xs[0] as T;
}

type WrittenPart = { header: Record<string, string[]>; body: string };

// The bytes mime/multipart's Writer produces for parts: CreatePart writes
// "--boundary" (or "\r\n--boundary" after a part), the header lines in key
// order and a blank line before the body; Close writes "\r\n--boundary--\r\n".
function writeMultipart(boundary: string, parts: WrittenPart[]): string {
  let out = "";
  parts.forEach((p, i) => {
    out += i === 0 ? `--${boundary}\r\n` : `\r\n--${boundary}\r\n`;
    for (const k of Object.keys(p.header).toSorted()) {
      for (const v of p.header[k] ?? []) {
        out += `${k}: ${v}\r\n`;
      }
    }
    out += `\r\n${p.body}`;
  });
  return `${out}\r\n--${boundary}--\r\n`;
}

// Writer.CreateFormField
function formField(name: string, value: string): WrittenPart {
  return { header: { "Content-Disposition": [`form-data; name="${name}"`] }, body: value };
}

// the MIME header of a Writer.CreatePart call (Set canonicalizes the keys)
function formData(key: string, value: string): { header: Record<string, string[]>; body: string } {
  return {
    header: {
      "Content-Type": ["text/plain; charset=ISO-8859-1"],
      "Content-Disposition": [`form-data; name=${key}`],
    },
    body: value,
  };
}

async function partsFromReader(mr: MultipartReader): Promise<WrittenPart[]> {
  const got: WrittenPart[] = [];
  for (;;) {
    const [p, err] = await mr.nextPart();
    if (err === EOF) {
      return got;
    }
    if (p === undefined) {
      throw new Error(`NextPart: ${String(err)}`);
    }
    const [body, rerr] = await readAll(p);
    if (rerr !== undefined) {
      throw new Error(`error reading part: ${String(rerr)}`);
    }
    got.push({ header: headerObject(p.header), body });
  }
}

// the first part of mr, which the test expects to exist
async function expectPart(mr: MultipartReader): Promise<Part> {
  const [part, err] = await mr.nextPart();
  if (part === undefined) {
    throw new Error(`NextPart: ${String(err)}`);
  }
  expect(err).toBeUndefined();
  return part;
}

test("TestBoundaryLine", async () => {
  // Go calls mr.isBoundaryDelimiterLine directly; that method is private
  // here, so each line is fed to NextPart instead. A delimiter line starts
  // a part; any other line is skipped before the first part, so the reader
  // reaches the final boundary and returns io.EOF.
  const cases: Array<[line: string, body: string, accepted: boolean]> = [
    ["--myBoundary\r\n", "--myBoundary\r\n\r\n--myBoundary--", true],
    ["--myBoundary \r\n", "--myBoundary \r\n\r\n--myBoundary--", true],
    ["--myBoundary \n", "--myBoundary \n\r\n--myBoundary--", true],
    ["--myBoundary bogus \n", "--myBoundary bogus \n\r\n--myBoundary--", false],
    ["--myBoundary bogus--", "--myBoundary bogus--", false],
  ];
  for (const [line, body, accepted] of cases) {
    const mr = new MultipartReader(reader(bytesOf(body)), "myBoundary");
    const [part] = await mr.nextPart();
    expect({ line, accepted: part !== undefined }).toEqual({ line, accepted });
  }
});

test.each([
  ['form-data; name="foo"', "foo", ""],
  ["form-data ; name=foo", "foo", ""],
  ['FORM-DATA;name="foo"', "foo", ""],
  [' FORM-DATA ; name="foo"', "foo", ""],
  [' FORM-DATA ; name="foo"', "foo", ""],
  [" FORM-DATA ; name=foo", "foo", ""],
  [' FORM-DATA ; filename="foo.txt"; name=foo; baz=quux', "foo", "foo.txt"],
  [' not-form-data ; filename="bar.txt"; name=foo; baz=quux', "", "bar.txt"],
])("TestNameAccessors: %s", (disposition, name, filename) => {
  const p = new Part(new MultipartReader(reader(new Uint8Array(0)), "b"));
  p.header.set("Content-Disposition", [disposition]);
  expect(p.formName()).toBe(name);
  expect(p.fileName()).toBe(filename);
});

const longLine = "\n\n\r\r\r\n\r\0".repeat((1 << 20) / 8);

function testMultipartBody(sep: string): string {
  let testBody = `
This is a multi-part message.  This line is ignored.
--MyBoundary
Header1: value1
HEADER2: value2
foo-bar: baz

My value
The end.
--MyBoundary
name: bigsection

[longline]
--MyBoundary
Header1: value1b
HEADER2: value2b
foo-bar: bazb

Line 1
Line 2
Line 3 ends in a newline, but just one.

--MyBoundary

never read data
--MyBoundary--


useless trailer
`;
  testBody = testBody.replaceAll("\n", sep);
  return testBody.replace("[longline]", () => longLine);
}

async function testMultipart(r: IoReader, onlyNewlines: boolean): Promise<void> {
  const mr = new MultipartReader(r, "MyBoundary");
  const adjustNewlines = (s: string) => (onlyNewlines ? s.replaceAll("\r\n", "\n") : s);

  // Part1
  let part = await expectPart(mr);
  expect(part.header.get("Header1")).toBe("value1");
  expect(part.header.get("foo-bar")).toBe("baz");
  expect(part.header.get("Foo-Bar")).toBe("baz");
  let [s, err] = await readAll(part);
  expect(err).toBeUndefined();
  expect(s).toBe(adjustNewlines("My value\r\nThe end."));

  // Part2
  part = await expectPart(mr);
  expect(part.header.get("name")).toBe("bigsection");
  [s, err] = await readAll(part);
  expect(err).toBeUndefined();
  expect(s.length).toBe(longLine.length);
  expect(s === longLine).toBe(true);

  // Part3
  part = await expectPart(mr);
  expect(part.header.get("foo-bar")).toBe("bazb");
  [s, err] = await readAll(part);
  expect(err).toBeUndefined();
  expect(s).toBe(adjustNewlines("Line 1\r\nLine 2\r\nLine 3 ends in a newline, but just one.\r\n"));

  // Part4
  await expectPart(mr);

  // Non-existent part5
  const [part5, err5] = await mr.nextPart();
  expect(part5).toBeUndefined();
  expect(err5).toBe(EOF);
}

test("TestMultipart", async () => {
  await testMultipart(reader(bytesOf(testMultipartBody("\r\n"))), false);
}, 30_000);

test("TestMultipartOnlyNewlines", async () => {
  await testMultipart(reader(bytesOf(testMultipartBody("\n"))), true);
}, 30_000);

test("TestMultipartSlowInput", async () => {
  await testMultipart(reader(bytesOf(testMultipartBody("\r\n")), 1), false);
}, 120_000);

test.each([
  "Foo\nBar",
  "Foo\nBar\n",
  "Foo\r\nBar",
  "Foo\r\nBar\r\n",
  "Foo\rBar",
  "Foo\rBar\r",
  "\x00\x01\x02\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10",
])("TestVariousTextLineEndings: text %#", async (expectedBody) => {
  const body =
    "--BOUNDARY\r\n" +
    'Content-Disposition: form-data; name="value"\r\n' +
    "\r\n" +
    expectedBody +
    "\r\n--BOUNDARY--\r\n";
  const mr = new MultipartReader(reader(bytesOf(body)), "BOUNDARY");
  const part = await expectPart(mr);
  const [s, err] = await readAll(part);
  expect(s).toBe(expectedBody);
  expect(err).toBeUndefined();

  const [next, nextErr] = await mr.nextPart();
  expect(next).toBeUndefined();
  expect(nextErr).toBe(EOF);
});

test("TestLineLimit", async () => {
  // Go's maliciousReader fails the test if more than maxReadThreshold bytes
  // are read. Here the flag is checked after the call instead. The data is
  // zeros, so there is never a newline.
  const maxReadThreshold = 1 << 20;
  let n = 0;
  let tooMuch = false;
  const mr: IoReader = {
    async read(p) {
      n += p.length;
      if (n >= maxReadThreshold) {
        tooMuch = true;
        return [0, EOF];
      }
      p.fill(0);
      return [p.length, undefined];
    },
  };
  const r = new MultipartReader(mr, "fooBoundary");
  const [part, err] = await r.nextPart();
  expect(part).toBeUndefined();
  expect(err).toBeDefined();
  expect(tooMuch).toBe(false);
  expect(n).toBeLessThan(maxReadThreshold);
});

test.each([
  `
This is a multi-part message.  This line is ignored.
--MyBoundary
foo-bar: baz

Oh no, premature EOF!
`,
  `
This is a multi-part message.  This line is ignored.
--MyBoundary
foo-bar: baz

Oh no, premature EOF!
--MyBoundary-`,
])("TestMultipartTruncated: body %#", async (rawBody) => {
  const body = rawBody.replaceAll("\n", "\r\n");
  const r = new MultipartReader(reader(bytesOf(body)), "MyBoundary");
  const part = await expectPart(r);
  const [, err] = await readAll(part);
  expect(err).toBe(ErrUnexpectedEOF);
});

test("TestLineContinuation", async () => {
  // This body, extracted from an email, contains headers that span multiple
  // lines.

  // TODO: The original mail ended with a double-newline before the
  // final delimiter; this was manually edited to use a CRLF.
  const testBody =
    "\n--Apple-Mail-2-292336769\nContent-Transfer-Encoding: 7bit\nContent-Type: text/plain;\n\tcharset=US-ASCII;\n\tdelsp=yes;\n\tformat=flowed\n\nI'm finding the same thing happening on my system (10.4.1).\n\n\n--Apple-Mail-2-292336769\nContent-Transfer-Encoding: quoted-printable\nContent-Type: text/html;\n\tcharset=ISO-8859-1\n\n<HTML><BODY>I'm finding the same thing =\nhappening on my system (10.4.1).=A0 But I built it with XCode =\n2.0.</BODY></=\nHTML>=\n\r\n--Apple-Mail-2-292336769--\n";

  const r = new MultipartReader(reader(bytesOf(testBody)), "Apple-Mail-2-292336769");
  for (let i = 0; i < 2; i++) {
    const part = await expectPart(r);
    const [s, err] = await readAll(part);
    expect(err).toBeUndefined();
    expect(s.length).toBeGreaterThan(0);
  }
});

test.each(["quoted-printable", "Quoted-PRINTABLE"])(
  "TestQuotedPrintableEncoding: %s",
  async (cte) => {
    // From https://golang.org/issue/4411
    const body =
      "--0016e68ee29c5d515f04cedf6733\r\nContent-Type: text/plain; charset=ISO-8859-1\r\nContent-Disposition: form-data; name=text\r\nContent-Transfer-Encoding: " +
      cte +
      "\r\n\r\nwords words words words words words words words words words words words wor=\r\nds words words words words words words words words words words words words =\r\nwords words words words words words words words words words words words wor=\r\nds words words words words words words words words words words words words =\r\nwords words words words words words words words words\r\n--0016e68ee29c5d515f04cedf6733\r\nContent-Type: text/plain; charset=ISO-8859-1\r\nContent-Disposition: form-data; name=submit\r\n\r\nSubmit\r\n--0016e68ee29c5d515f04cedf6733--";
    const r = new MultipartReader(reader(bytesOf(body)), "0016e68ee29c5d515f04cedf6733");
    const part = await expectPart(r);
    expect(part.header.values("Content-Transfer-Encoding")).toBeUndefined();
    const [got, err] = await readAll(part);
    expect(err).toBeUndefined();
    const want =
      "words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words";
    expect(got).toBe(want);
  },
);

test("TestRawPart", async () => {
  // https://github.com/golang/go/issues/29090

  const body = `--0016e68ee29c5d515f04cedf6733
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: quoted-printable

<div dir=3D"ltr">Hello World.</div>
--0016e68ee29c5d515f04cedf6733
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: quoted-printable

<div dir=3D"ltr">Hello World.</div>
--0016e68ee29c5d515f04cedf6733--`.replaceAll("\n", "\r\n");

  const r = new MultipartReader(reader(bytesOf(body)), "0016e68ee29c5d515f04cedf6733");

  // This part is expected to be raw, bypassing the automatic handling
  // of quoted-printable.
  let [part] = await r.nextRawPart();
  if (part === undefined) {
    throw new Error("NextRawPart: no part");
  }
  expect(part.header.values("Content-Transfer-Encoding")).toBeDefined();
  let [got, err] = await readAll(part);
  expect(err).toBeUndefined();
  // Data is still quoted-printable.
  expect(got).toBe('<div dir=3D"ltr">Hello World.</div>');

  // This part is expected to have automatic decoding of quoted-printable.
  part = await expectPart(r);
  expect(part.header.values("Content-Transfer-Encoding")).toBeUndefined();
  [got, err] = await readAll(part);
  expect(err).toBeUndefined();
  // QP data has been decoded.
  expect(got).toBe('<div dir="ltr">Hello World.</div>');
});

// testdata/nested-mime of the Go tree (CRLF line endings).
const nestedMime = [
  "--e89a8ff1c1e83553e304be640612",
  "Content-Type: multipart/alternative; boundary=e89a8ff1c1e83553e004be640610",
  "",
  "--e89a8ff1c1e83553e004be640610",
  "Content-Type: text/plain; charset=UTF-8",
  "",
  "*body*",
  "",
  "--e89a8ff1c1e83553e004be640610",
  "Content-Type: text/html; charset=UTF-8",
  "",
  "<b>body</b>",
  "",
  "--e89a8ff1c1e83553e004be640610--",
  "--e89a8ff1c1e83553e304be640612",
  'Content-Type: image/png; name="x.png"',
  "Content-Disposition: attachment; ",
  '\tfilename="x.png"',
  "Content-Transfer-Encoding: base64",
  "X-Attachment-Id: f_h1edgigu0",
  "",
  "iVBORw0KGgoAAAANSUhEUgAAAagAAADrCAIAAACza5XhAAAKMWlDQ1BJQ0MgUHJvZmlsZQAASImd",
  "lndUU9kWh8+9N71QkhCKlNBraFICSA29SJEuKjEJEErAkAAiNkRUcERRkaYIMijggKNDkbEiioUB",
  "8b2kqeGaj4aTNftesu5mob4pr07ecMywRwLBvDCJOksqlUyldAZD7g9fxIZRWWPMvXRNJROJRBIG",
  "Y7Vx0mva1HAwYqibdKONXye3dW4iUonhWFJnqK7OaanU1gGkErFYEgaj0cg8wK+zVPh2ziwnHy07",
  "U8lYTNapezSzOuevRwLB7CFkqQQCwaJDiBQIBIJFhwh8AoFg0SHUqQUCASRJKkwkhMy/JfODWPEJ",
  "BIJFhwh8AoFg0TFnQqQ55GtPFopcJsN97e1nYtNuIBYeGBgYCmYrmE3jZ05iaGAoMX0xzxkWz6Hv",
  "yO7WvrlwzA0uLzrD+VkKqViwl9IfTBVNFMyc/x9alloiPPlqhQAAAABJRU5ErkJggg==",
  "--e89a8ff1c1e83553e304be640612--",
  "",
].join("\r\n");

test("TestNested", async () => {
  // nested-mime is the body part of a multipart/mixed email
  // with boundary e89a8ff1c1e83553e304be640612
  const mr = new MultipartReader(reader(bytesOf(nestedMime)), "e89a8ff1c1e83553e304be640612");
  let p = await expectPart(mr);

  // Read the inner text/plain and text/html sections of the multipart/alternative.
  const mr2 = new MultipartReader(p, "e89a8ff1c1e83553e004be640610");
  p = await expectPart(mr2);
  expect(await readAll(p)).toEqual(["*body*\r\n", undefined]);
  p = await expectPart(mr2);
  expect(await readAll(p)).toEqual(["<b>body</b>\r\n", undefined]);

  const [, err] = await mr2.nextPart();
  expect(err).toBe(EOF);

  // Back to the outer multipart/mixed, reading the image attachment.
  await expectPart(mr);

  const [, outerErr] = await mr.nextPart();
  expect(outerErr).toBe(EOF);
});

const parseTestBoundaryRoundTrip = "round-trip-boundary";

const roundTripWant = [
  formData("empty", ""),
  formData("lf", "\n"),
  formData("cr", "\r"),
  formData("crlf", "\r\n"),
  formData("foo", "bar"),
];

const peekBufferSize = 4096; // multipart's peekBufferSize (not exported)

const parseTests: Array<{
  name: string;
  in: string;
  sep: string;
  want: WrittenPart[];
}> = [
  // Actual body from App Engine on a blob upload. The final part (the
  // Content-Type: message/external-body) is what App Engine replaces
  // the uploaded file with. The other form fields (prefixed with
  // "other" in their form-data name) are unchanged. A bug was
  // reported with blob uploads failing when the other fields were
  // empty. This was the MIME POST body that previously failed.
  {
    name: "App Engine post",
    sep: "00151757727e9583fd04bfbca4c6",
    in: '--00151757727e9583fd04bfbca4c6\r\nContent-Type: text/plain; charset=ISO-8859-1\r\nContent-Disposition: form-data; name=otherEmpty1\r\n\r\n--00151757727e9583fd04bfbca4c6\r\nContent-Type: text/plain; charset=ISO-8859-1\r\nContent-Disposition: form-data; name=otherFoo1\r\n\r\nfoo\r\n--00151757727e9583fd04bfbca4c6\r\nContent-Type: text/plain; charset=ISO-8859-1\r\nContent-Disposition: form-data; name=otherFoo2\r\n\r\nfoo\r\n--00151757727e9583fd04bfbca4c6\r\nContent-Type: text/plain; charset=ISO-8859-1\r\nContent-Disposition: form-data; name=otherEmpty2\r\n\r\n--00151757727e9583fd04bfbca4c6\r\nContent-Type: text/plain; charset=ISO-8859-1\r\nContent-Disposition: form-data; name=otherRepeatFoo\r\n\r\nfoo\r\n--00151757727e9583fd04bfbca4c6\r\nContent-Type: text/plain; charset=ISO-8859-1\r\nContent-Disposition: form-data; name=otherRepeatFoo\r\n\r\nfoo\r\n--00151757727e9583fd04bfbca4c6\r\nContent-Type: text/plain; charset=ISO-8859-1\r\nContent-Disposition: form-data; name=otherRepeatEmpty\r\n\r\n--00151757727e9583fd04bfbca4c6\r\nContent-Type: text/plain; charset=ISO-8859-1\r\nContent-Disposition: form-data; name=otherRepeatEmpty\r\n\r\n--00151757727e9583fd04bfbca4c6\r\nContent-Type: text/plain; charset=ISO-8859-1\r\nContent-Disposition: form-data; name=submit\r\n\r\nSubmit\r\n--00151757727e9583fd04bfbca4c6\r\nContent-Type: message/external-body; charset=ISO-8859-1; blob-key=AHAZQqG84qllx7HUqO_oou5EvdYQNS3Mbbkb0RjjBoM_Kc1UqEN2ygDxWiyCPulIhpHRPx-VbpB6RX4MrsqhWAi_ZxJ48O9P2cTIACbvATHvg7IgbvZytyGMpL7xO1tlIvgwcM47JNfv_tGhy1XwyEUO8oldjPqg5Q\r\nContent-Disposition: form-data; name=file; filename="fall.png"\r\n\r\nContent-Type: image/png\r\nContent-Length: 232303\r\nX-AppEngine-Upload-Creation: 2012-05-10 23:14:02.715173\r\nContent-MD5: MzRjODU1ZDZhZGU1NmRlOWEwZmMwMDdlODBmZTA0NzA=\r\nContent-Disposition: form-data; name=file; filename="fall.png"\r\n\r\n\r\n--00151757727e9583fd04bfbca4c6--',
    want: [
      formData("otherEmpty1", ""),
      formData("otherFoo1", "foo"),
      formData("otherFoo2", "foo"),
      formData("otherEmpty2", ""),
      formData("otherRepeatFoo", "foo"),
      formData("otherRepeatFoo", "foo"),
      formData("otherRepeatEmpty", ""),
      formData("otherRepeatEmpty", ""),
      formData("submit", "Submit"),
      {
        header: {
          "Content-Type": [
            "message/external-body; charset=ISO-8859-1; blob-key=AHAZQqG84qllx7HUqO_oou5EvdYQNS3Mbbkb0RjjBoM_Kc1UqEN2ygDxWiyCPulIhpHRPx-VbpB6RX4MrsqhWAi_ZxJ48O9P2cTIACbvATHvg7IgbvZytyGMpL7xO1tlIvgwcM47JNfv_tGhy1XwyEUO8oldjPqg5Q",
          ],
          "Content-Disposition": ['form-data; name=file; filename="fall.png"'],
        },
        body: 'Content-Type: image/png\r\nContent-Length: 232303\r\nX-AppEngine-Upload-Creation: 2012-05-10 23:14:02.715173\r\nContent-MD5: MzRjODU1ZDZhZGU1NmRlOWEwZmMwMDdlODBmZTA0NzA=\r\nContent-Disposition: form-data; name=file; filename="fall.png"\r\n\r\n',
      },
    ],
  },

  // Single empty part, ended with --boundary immediately after headers.
  {
    name: "single empty part, --boundary",
    sep: "abc",
    in: "--abc\r\nFoo: bar\r\n\r\n--abc--",
    want: [{ header: { Foo: ["bar"] }, body: "" }],
  },

  // Single empty part, ended with \r\n--boundary immediately after headers.
  {
    name: "single empty part, \r\n--boundary",
    sep: "abc",
    in: "--abc\r\nFoo: bar\r\n\r\n\r\n--abc--",
    want: [{ header: { Foo: ["bar"] }, body: "" }],
  },

  // Final part empty.
  {
    name: "final part empty",
    sep: "abc",
    in: "--abc\r\nFoo: bar\r\n\r\n--abc\r\nFoo2: bar2\r\n\r\n--abc--",
    want: [
      { header: { Foo: ["bar"] }, body: "" },
      { header: { Foo2: ["bar2"] }, body: "" },
    ],
  },

  // Final part empty with newlines after final separator.
  {
    name: "final part empty then crlf",
    sep: "abc",
    in: "--abc\r\nFoo: bar\r\n\r\n--abc--\r\n",
    want: [{ header: { Foo: ["bar"] }, body: "" }],
  },

  // Final part empty with lwsp-chars after final separator.
  {
    name: "final part empty then lwsp",
    sep: "abc",
    in: "--abc\r\nFoo: bar\r\n\r\n--abc-- \t",
    want: [{ header: { Foo: ["bar"] }, body: "" }],
  },

  // No parts (empty form as submitted by Chrome)
  {
    name: "no parts",
    sep: "----WebKitFormBoundaryQfEAfzFOiSemeHfA",
    in: "------WebKitFormBoundaryQfEAfzFOiSemeHfA--\r\n",
    want: [],
  },

  // Part containing data starting with the boundary, but with additional suffix.
  {
    name: "fake separator as data",
    sep: "sep",
    in: "--sep\r\nFoo: bar\r\n\r\n--sepFAKE\r\n--sep--",
    want: [{ header: { Foo: ["bar"] }, body: "--sepFAKE" }],
  },

  // Part containing a boundary with whitespace following it.
  {
    name: "boundary with whitespace",
    sep: "sep",
    in: "--sep \r\nFoo: bar\r\n\r\ntext\r\n--sep--",
    want: [{ header: { Foo: ["bar"] }, body: "text" }],
  },

  // With ignored leading line.
  {
    name: "leading line",
    sep: "MyBoundary",
    in: `This is a multi-part message.  This line is ignored.
--MyBoundary
foo: bar


--MyBoundary--`.replaceAll("\n", "\r\n"),
    want: [{ header: { Foo: ["bar"] }, body: "" }],
  },

  // Issue 10616; minimal
  {
    name: "issue 10616 minimal",
    sep: "sep",
    in: "--sep \r\nFoo: bar\r\n\r\na\r\n--sep_alt\r\nb\r\n\r\n--sep--",
    want: [{ header: { Foo: ["bar"] }, body: "a\r\n--sep_alt\r\nb\r\n" }],
  },

  // Issue 10616; full example from bug.
  {
    name: "nested separator prefix is outer separator",
    sep: "----=_NextPart_4c2fbafd7ec4c8bf08034fe724b608d9",
    in: `------=_NextPart_4c2fbafd7ec4c8bf08034fe724b608d9
Content-Type: multipart/alternative; boundary="----=_NextPart_4c2fbafd7ec4c8bf08034fe724b608d9_alt"

------=_NextPart_4c2fbafd7ec4c8bf08034fe724b608d9_alt
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: 8bit

This is a multi-part message in MIME format.

------=_NextPart_4c2fbafd7ec4c8bf08034fe724b608d9_alt
Content-Type: text/html; charset="utf-8"
Content-Transfer-Encoding: 8bit

html things
------=_NextPart_4c2fbafd7ec4c8bf08034fe724b608d9_alt--
------=_NextPart_4c2fbafd7ec4c8bf08034fe724b608d9--`.replaceAll("\n", "\r\n"),
    want: [
      {
        header: {
          "Content-Type": [
            'multipart/alternative; boundary="----=_NextPart_4c2fbafd7ec4c8bf08034fe724b608d9_alt"',
          ],
        },
        body: `------=_NextPart_4c2fbafd7ec4c8bf08034fe724b608d9_alt
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: 8bit

This is a multi-part message in MIME format.

------=_NextPart_4c2fbafd7ec4c8bf08034fe724b608d9_alt
Content-Type: text/html; charset="utf-8"
Content-Transfer-Encoding: 8bit

html things
------=_NextPart_4c2fbafd7ec4c8bf08034fe724b608d9_alt--`.replaceAll("\n", "\r\n"),
      },
    ],
  },

  // Issue 12662: Check that we don't consume the leading \r if the peekBuffer
  // ends in '\r\n--separator-'
  {
    name: "peek buffer boundary condition",
    sep: "00ffded004d4dd0fdf945fbdef9d9050cfd6a13a821846299b27fc71b9db",
    in: `--00ffded004d4dd0fdf945fbdef9d9050cfd6a13a821846299b27fc71b9db
Content-Disposition: form-data; name="block"; filename="block"
Content-Type: application/octet-stream

${"A".repeat(peekBufferSize - 65)}
--00ffded004d4dd0fdf945fbdef9d9050cfd6a13a821846299b27fc71b9db--`.replaceAll("\n", "\r\n"),
    want: [
      {
        header: {
          "Content-Type": ["application/octet-stream"],
          "Content-Disposition": ['form-data; name="block"; filename="block"'],
        },
        body: "A".repeat(peekBufferSize - 65),
      },
    ],
  },

  // Issue 12662: Same test as above with \r\n at the end
  {
    name: "peek buffer boundary condition (crlf at end)",
    sep: "00ffded004d4dd0fdf945fbdef9d9050cfd6a13a821846299b27fc71b9db",
    in: `--00ffded004d4dd0fdf945fbdef9d9050cfd6a13a821846299b27fc71b9db
Content-Disposition: form-data; name="block"; filename="block"
Content-Type: application/octet-stream

${"A".repeat(peekBufferSize - 65)}
--00ffded004d4dd0fdf945fbdef9d9050cfd6a13a821846299b27fc71b9db--
`.replaceAll("\n", "\r\n"),
    want: [
      {
        header: {
          "Content-Type": ["application/octet-stream"],
          "Content-Disposition": ['form-data; name="block"; filename="block"'],
        },
        body: "A".repeat(peekBufferSize - 65),
      },
    ],
  },

  // Issue 12662v2: We want to make sure that for short buffers that end with
  // '\r\n--separator-' we always consume at least one (valid) symbol from the
  // peekBuffer
  {
    name: "peek buffer boundary condition (short buffer)",
    sep: "aaaaaaaaaa00ffded004d4dd0fdf945fbdef9d9050cfd6a13a821846299b27fc71b9db",
    in: `--aaaaaaaaaa00ffded004d4dd0fdf945fbdef9d9050cfd6a13a821846299b27fc71b9db
Content-Disposition: form-data; name="block"; filename="block"
Content-Type: application/octet-stream

${"A".repeat(peekBufferSize)}
--aaaaaaaaaa00ffded004d4dd0fdf945fbdef9d9050cfd6a13a821846299b27fc71b9db--`.replaceAll(
      "\n",
      "\r\n",
    ),
    want: [
      {
        header: {
          "Content-Type": ["application/octet-stream"],
          "Content-Disposition": ['form-data; name="block"; filename="block"'],
        },
        body: "A".repeat(peekBufferSize),
      },
    ],
  },

  // Context: https://github.com/camlistore/camlistore/issues/642
  // If the file contents in the form happens to have a size such as:
  // size = peekBufferSize - (len("\n--") + len(boundary) + len("\r") + 1), (modulo peekBufferSize)
  // then peekBufferSeparatorIndex was wrongly returning (-1, false), which was leading to an nCopy
  // cut such as:
  // "somedata\r| |\n--Boundary\r" (instead of "somedata| |\r\n--Boundary\r"), which was making the
  // subsequent Read miss the boundary.
  {
    name: "safeCount off by one",
    sep: "08b84578eabc563dcba967a945cdf0d9f613864a8f4a716f0e81caa71a74",
    in:
      `--08b84578eabc563dcba967a945cdf0d9f613864a8f4a716f0e81caa71a74
Content-Disposition: form-data; name="myfile"; filename="my-file.txt"
Content-Type: application/octet-stream

`.replaceAll("\n", "\r\n") +
      "A".repeat(
        peekBufferSize -
          ("\n--".length +
            "08b84578eabc563dcba967a945cdf0d9f613864a8f4a716f0e81caa71a74".length +
            "\r".length +
            1),
      ) +
      `
--08b84578eabc563dcba967a945cdf0d9f613864a8f4a716f0e81caa71a74
Content-Disposition: form-data; name="key"

val
--08b84578eabc563dcba967a945cdf0d9f613864a8f4a716f0e81caa71a74--
`.replaceAll("\n", "\r\n"),
    want: [
      {
        header: {
          "Content-Type": ["application/octet-stream"],
          "Content-Disposition": ['form-data; name="myfile"; filename="my-file.txt"'],
        },
        body: "A".repeat(
          peekBufferSize -
            ("\n--".length +
              "08b84578eabc563dcba967a945cdf0d9f613864a8f4a716f0e81caa71a74".length +
              "\r".length +
              1),
        ),
      },
      {
        header: { "Content-Disposition": ['form-data; name="key"'] },
        body: "val",
      },
    ],
  },

  // Issue 46042; a nested multipart uses the outer separator followed by
  // a dash.
  {
    name: "nested separator prefix is outer separator followed by a dash",
    sep: "foo",
    in: `--foo
Content-Type: multipart/alternative; boundary="foo-bar"

--foo-bar

Body
--foo-bar

Body2
--foo-bar--
--foo--`.replaceAll("\n", "\r\n"),
    want: [
      {
        header: { "Content-Type": ['multipart/alternative; boundary="foo-bar"'] },
        body: `--foo-bar

Body
--foo-bar

Body2
--foo-bar--`.replaceAll("\n", "\r\n"),
      },
    ],
  },

  // A nested boundary cannot be the outer separator followed by double dash.
  {
    name: "nested separator prefix is outer separator followed by double dash",
    sep: "foo",
    in: `--foo
Content-Type: multipart/alternative; boundary="foo--"

--foo--

Body

--foo--`.replaceAll("\n", "\r\n"),
    want: [{ header: { "Content-Type": ['multipart/alternative; boundary="foo--"'] }, body: "" }],
  },

  // round trip: the bytes of a multipart.Writer with these parts
  {
    name: "round trip",
    sep: parseTestBoundaryRoundTrip,
    in: writeMultipart(parseTestBoundaryRoundTrip, roundTripWant),
    want: roundTripWant,
  },
];

test.each(parseTests)("TestParse: $name", async (tt) => {
  const r = new MultipartReader(reader(bytesOf(tt.in)), tt.sep);
  expect(await partsFromReader(r)).toEqual(tt.want);
});

test("TestParseAllSizes", async () => {
  const maxSize = 5 << 10;
  const body = "a".repeat(maxSize);
  const boundary = "allsizes-boundary";
  for (let size = 0; size < maxSize; size++) {
    const data = writeMultipart(boundary, [
      formField("f", body.slice(0, size)),
      formField("key", "val"),
    ]);
    const r = new MultipartReader(reader(bytesOf(data)), boundary);
    const got = await partsFromReader(r);
    expect(got.length).toBe(2);
    expect(got[0]?.body).toBe(body.slice(0, size));
  }
}, 300_000);

test("TestNoBoundary", async () => {
  const mr = new MultipartReader(reader(new Uint8Array(0)), "");
  const [, err] = await mr.nextPart();
  expect((err as Error).message).toBe("multipart: boundary is empty");
});

// TestReadForm: formdata_test.go

const fileaContents = "This is a test file.";
const filebContents = "Another test file.";
const textaValue = "foo";
const textbValue = "bar";
const boundary = "MyBoundary";

const messageWithFileWithoutName = `
--MyBoundary
Content-Disposition: form-data; name="hiddenfile"; filename=""
Content-Type: text/plain

${filebContents}
--MyBoundary--
`;

const messageWithFileName = `
--MyBoundary
Content-Disposition: form-data; name="filea"; filename="filea.txt"
Content-Type: text/plain

${fileaContents}
--MyBoundary--
`;

const messageWithTextContentType = `
--MyBoundary
Content-Disposition: form-data; name="texta"
Content-Type: text/plain

${textaValue}
--MyBoundary
`;

const message = `
--MyBoundary
Content-Disposition: form-data; name="filea"; filename="filea.txt"
Content-Type: text/plain

${fileaContents}
--MyBoundary
Content-Disposition: form-data; name="fileb"; filename="fileb.txt"
Content-Type: text/plain

${filebContents}
--MyBoundary
Content-Disposition: form-data; name="texta"

${textaValue}
--MyBoundary
Content-Disposition: form-data; name="textb"

${textbValue}
--MyBoundary--
`;

// testFile: the name, the size and the content of a file part (Go's
// fh.Open() reads are the Web File's text here)
async function testFile(fh: FileHeader, efn: string, econtent: string): Promise<void> {
  expect(fh.filename).toBe(efn);
  expect(fh.size).toBe(econtent.length);
  expect(await new MultipartFileReader(fh).blob().text()).toBe(econtent);
  // Open
  const r = new MultipartFileReader(fh).open();
  const buf = new Uint8Array(econtent.length + 10);
  let n = 0;
  for (;;) {
    const read = r.read(buf.subarray(n));
    if (read === 0) {
      break;
    }
    n += read;
  }
  r.close();
  expect(new TextDecoder().decode(buf.subarray(0, n))).toBe(econtent);
}

test("TestReadForm", async () => {
  const b = reader(bytesOf(message.replaceAll("\n", "\r\n")));
  const r = new MultipartReader(b, boundary);
  const [f, err] = await r.readForm(25);
  expect(err).toBeUndefined();
  if (f === undefined) {
    throw new Error("ReadForm: no form");
  }
  expect(first(f.value.get("texta"))).toBe(textaValue);
  expect(first(f.value.get("textb"))).toBe(textbValue);
  try {
    const fa = first(f.file.get("filea"));
    await testFile(fa, "filea.txt", fileaContents);
    expect(fa.content).not.toBeNull();
    const fb = first(f.file.get("fileb"));
    await testFile(fb, "fileb.txt", filebContents);
    // written to disk past maxMemory (Go's *os.File)
    expect(fb.content).toBeNull();
    expect(fb.tmpfile).toStartWith(join(tmpdir(), "multipart-"));
    expect(existsSync(fb.tmpfile)).toBe(true);
  } finally {
    const tmp = first(f.file.get("fileb")).tmpfile;
    f.removeAll();
    expect(existsSync(tmp)).toBe(false);
  }
});

// the spilled parts share one temporary file, each a section of it
// (Go's default combined multipartfiles mode)
test("ReadForm spills file parts past maxMemory into one temporary file", async () => {
  const parts = [
    ["a", "a.txt", "x".repeat(10)],
    ["b", "b.txt", "y".repeat(300_000)],
    ["c", "c.txt", "z".repeat(5)],
    ["d", "d.txt", "w".repeat(70_000)],
  ];
  let body = "";
  for (const [name, filename, content] of parts) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n\r\n${content}\r\n`;
  }
  body += `--${boundary}--\r\n`;
  const r = new MultipartReader(reader(bytesOf(body)), boundary);
  const [f, err] = await r.readForm(20);
  expect(err).toBeUndefined();
  if (f === undefined) {
    throw new Error("ReadForm: no form");
  }
  const [a, b, c, d] = ["a", "b", "c", "d"].map((k) => first(f.file.get(k)));
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    throw new Error("missing parts");
  }
  for (const [i, fh] of [a, b, c, d].entries()) {
    await testFile(fh, parts[i]?.[1] as string, parts[i]?.[2] as string);
  }
  expect(a.content).not.toBeNull();
  expect(c.content).not.toBeNull();
  expect(b.tmpfile).not.toBe("");
  expect(d.tmpfile).toBe(b.tmpfile);
  expect(b.tmpoff).toBe(0);
  expect(d.tmpoff).toBe(300_000);
  f.removeAll();
  expect(existsSync(b.tmpfile)).toBe(false);
});

// a ReadForm that fails after a part was spilled removes the temporary file
test("ReadForm removes the temporary file on error", async () => {
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="b"; filename="b.txt"\r\n\r\n${"y".repeat(100_000)}`;
  const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("multipart-")));
  const r = new MultipartReader(reader(bytesOf(body)), boundary);
  const [f, err] = await r.readForm(20);
  expect(f).toBeUndefined();
  expect(err).toBeDefined();
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith("multipart-") && !before.has(n));
  expect(after).toEqual([]);
});

test("TestReadFormWithNamelessFile", async () => {
  const b = reader(bytesOf(messageWithFileWithoutName.replaceAll("\n", "\r\n")));
  const r = new MultipartReader(b, boundary);
  const [f, err] = await r.readForm(25);
  expect(err).toBeUndefined();
  if (f === undefined) {
    throw new Error("ReadForm: no form");
  }
  expect(first(f.value.get("hiddenfile"))).toBe(filebContents);
});

// Issue 58384: Handle ReadForm(math.MaxInt64). A JS number cannot hold
// MaxInt64; the largest safe integer stands in for it.
test("TestReadFormWitFileNameMaxMemoryOverflow", async () => {
  const b = reader(bytesOf(messageWithFileName.replaceAll("\n", "\r\n")));
  const r = new MultipartReader(b, boundary);
  const [f, err] = await r.readForm(Number.MAX_SAFE_INTEGER);
  expect(err).toBeUndefined();
  if (f === undefined) {
    throw new Error("ReadForm(max): no form");
  }
  await testFile(first(f.file.get("filea")), "filea.txt", fileaContents);
});

// Issue 40430: Handle ReadForm(math.MaxInt64)
test("TestReadFormMaxMemoryOverflow", async () => {
  const b = reader(bytesOf(messageWithTextContentType.replaceAll("\n", "\r\n")));
  const r = new MultipartReader(b, boundary);
  const [f, err] = await r.readForm(Number.MAX_SAFE_INTEGER);
  expect(err).toBeUndefined();
  if (f === undefined) {
    throw new Error("ReadForm(max): missing form");
  }
  expect(first(f.value.get("texta"))).toBe(textaValue);
});

test("TestReadFormWithTextContentType", async () => {
  // From https://github.com/golang/go/issues/24041
  const b = reader(bytesOf(messageWithTextContentType.replaceAll("\n", "\r\n")));
  const r = new MultipartReader(b, boundary);
  const [f, err] = await r.readForm(25);
  expect(err).toBeUndefined();
  if (f === undefined) {
    throw new Error("ReadForm: no form");
  }
  expect(first(f.value.get("texta"))).toBe(textaValue);
});

test("TestReadForm_NoReadAfterEOF", async () => {
  const maxMemory = 32 << 20;
  const nonStandardBoundary = "---------------------------8d345eef0d38dc9";
  const body = `
-----------------------------8d345eef0d38dc9
Content-Disposition: form-data; name="version"

171
-----------------------------8d345eef0d38dc9--`;

  // failOnReadAfterErrorReader: a Read after a Read that returned an error
  // fails (the Go test calls t.Fatalf).
  const inner = reader(bytesOf(body));
  let sawErr: unknown = undefined;
  const failOnReadAfterError: IoReader = {
    async read(p) {
      if (sawErr !== undefined) {
        throw new Error(
          `unexpected Read on Reader after previous read saw error ${String(sawErr)}`,
        );
      }
      const [n, err] = await inner.read(p);
      sawErr = err;
      return [n, err];
    },
  };

  const mr = new MultipartReader(failOnReadAfterError, nonStandardBoundary);
  const [f, err] = await mr.readForm(maxMemory);
  expect(err).toBeUndefined();
  expect(f).toBeDefined();
});

// TestReadForm_NonFileMaxMemory asserts that the ReadForm maxMemory limit is applied
// while processing non-file form data as well as file form data.
test("TestReadForm_NonFileMaxMemory", async () => {
  const n = 10 << 20;
  const largeTextValue = "1".repeat(n);
  const formBody = `--MyBoundary
Content-Disposition: form-data; name="largetext"

${largeTextValue}
--MyBoundary--
`;
  const testBody = formBody.replaceAll("\n", "\r\n");
  // Try parsing the form with increasing maxMemory values.
  // Changes in how we account for non-file form data may cause the exact point
  // where we change from rejecting the form as too large to accepting it to vary,
  // but we should see both successes and failures.
  const failWhenMaxMemoryLessThan = 128;
  for (let maxMemory = 0; maxMemory < failWhenMaxMemoryLessThan * 2; maxMemory += 16) {
    const r = new MultipartReader(reader(bytesOf(testBody)), boundary);
    const [f, err] = await r.readForm(maxMemory);
    if (err !== undefined || f === undefined) {
      continue;
    }
    expect(first(f.value.get("largetext")) === largeTextValue).toBe(true);
    expect(maxMemory).toBeGreaterThanOrEqual(failWhenMaxMemoryLessThan);
    return;
  }
  throw new Error("ReadForm(x) failed for x < 256, expect success");
}, 120_000);

// TestReadForm_MetadataTooLarge verifies that we account for the size of field names,
// MIME headers, and map entry overhead while limiting the memory consumption of parsed forms.
test.each([
  {
    name: "large name",
    body: () => writeMultipart(boundary, [formField("a".repeat(10 << 20), "value")]),
  },
  {
    name: "large MIME header",
    body: () =>
      writeMultipart(boundary, [
        {
          header: {
            "Content-Disposition": ['form-data; name="a"'],
            "X-Foo": ["a".repeat(10 << 20)],
          },
          body: "value",
        },
      ]),
  },
  {
    name: "many parts",
    body: () =>
      writeMultipart(
        boundary,
        Array.from({ length: 110000 }, () => formField("f", "v")),
      ),
  },
])(
  "TestReadForm_MetadataTooLarge: $name",
  async ({ body }) => {
    const fr = new MultipartReader(reader(bytesOf(body())), boundary);
    const [, err] = await fr.readForm(0);
    expect(err).toBe(ErrMessageTooLarge);
  },
  60_000,
);

// TestReadForm_ManyFiles_Combined and TestReadForm_ManyFiles_Distinct are
// skipped (see the header comment).

// TestReadFormLimits, with the GODEBUG rows left out (see the header comment).
test.each([
  { values: 1000, files: 0, extraKeysPerFile: 0, wantErr: undefined },
  { values: 1001, files: 0, extraKeysPerFile: 0, wantErr: ErrMessageTooLarge },
  { values: 500, files: 500, extraKeysPerFile: 0, wantErr: undefined },
  { values: 501, files: 500, extraKeysPerFile: 0, wantErr: ErrMessageTooLarge },
  { values: 0, files: 1000, extraKeysPerFile: 0, wantErr: undefined },
  { values: 0, files: 1001, extraKeysPerFile: 0, wantErr: ErrMessageTooLarge },
  // plus Content-Disposition and Content-Type
  { values: 0, files: 1, extraKeysPerFile: 9998, wantErr: undefined },
  { values: 0, files: 1, extraKeysPerFile: 10000, wantErr: ErrMessageTooLarge },
])(
  "TestReadFormLimits: values=$values/files=$files/extraKeysPerFile=$extraKeysPerFile",
  async ({ values, files, extraKeysPerFile, wantErr }) => {
    const parts: WrittenPart[] = [];
    for (let i = 0; i < values; i++) {
      parts.push(formField(`field${i}`, `value ${i}`));
    }
    for (let i = 0; i < files; i++) {
      const header: Record<string, string[]> = {
        "Content-Disposition": [`form-data; name="file${i}"; filename="file${i}"`],
        "Content-Type": ["application/octet-stream"],
      };
      // Go's h.Set canonicalizes "k%v" to "K%v"
      for (let j = 0; j < extraKeysPerFile; j++) {
        header[`K${j}`] = ["v"];
      }
      parts.push({ header, body: `value ${i}` });
    }
    const fr = new MultipartReader(reader(bytesOf(writeMultipart(boundary, parts))), boundary);
    const [, err] = await fr.readForm(1 << 10);
    expect(err).toBe(wantErr);
  },
  60_000,
);

test.each([
  { name: "name", prefix: "X-" },
  { name: "value", prefix: "X-Header: " },
  { name: "continuation", prefix: "X-Header: foo\r\n  " },
])(
  "TestReadFormEndlessHeaderLine: $name",
  async ({ prefix }) => {
    const eol = "\r\n";
    let s = `--boundary${eol}`;
    s += `Content-Disposition: form-data; name="a"${eol}`;
    s += `Content-Type: text/plain${eol}`;
    s += prefix;
    const neverending: IoReader = {
      async read(p) {
        p.fill("X".charCodeAt(0));
        return [p.length, undefined];
      },
    };
    const r = new MultipartReader(multiReader(reader(bytesOf(s)), neverending), "boundary");
    const [, err] = await r.readForm(1 << 20);
    expect(err).toBe(ErrMessageTooLarge);
  },
  60_000,
);

test("TestMultipartStreamReadahead", async () => {
  // TestMultipartStreamReadahead tests that PartReader does not block
  // on reading past the end of a part, ensuring that it can be used on
  // a stream like multipart/x-mixed-replace. See golang.org/issue/15431
  const testBody1 = `
This is a multi-part message.  This line is ignored.
--MyBoundary
foo-bar: baz

Body
--MyBoundary
`;
  const testBody2 = `foo-bar: bop

Body 2
--MyBoundary--
`;
  // the sentinel reader: its Read is the point the Go test watches (done1)
  let sentinelRead = false;
  const sentinel: IoReader = {
    async read() {
      sentinelRead = true;
      return [0, EOF];
    },
  };
  const r = new MultipartReader(
    multiReader(reader(bytesOf(testBody1)), sentinel, reader(bytesOf(testBody2))),
    "MyBoundary",
  );

  const readPart = async (header: Record<string, string[]>, body: string) => {
    const part = await expectPart(r);
    expect(headerObject(part.header)).toEqual(header);
    const [data, err] = await readAll(part);
    expect(data).toBe(body);
    expect(err).toBeUndefined();
  };

  await readPart({ "Foo-Bar": ["baz"] }, "Body");

  expect(sentinelRead).toBe(false);

  await readPart({ "Foo-Bar": ["bop"] }, "Body 2");
});
