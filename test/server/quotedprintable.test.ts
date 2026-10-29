// Upstream: Go 1.27.2 mime/quotedprintable reader_test.go, ported against
// src/server/quotedprintable.ts.
//
// Skipped: none. TestExhaustive runs its -qprint comparison only when the
// qprint flag is set; that flag and the external qprint program are not
// ported, so the decoder-only checks run.

import { expect, test } from "bun:test";
import { BytesBuffer, copy, EOF, type Reader as IoReader } from "@/server/io";
import { Reader as QPReader } from "@/server/quotedprintable";

// The byte string of a Go string literal (one character per byte).
function bytesOf(s: string): Uint8Array {
  return Buffer.from(s, "latin1");
}

// A Go-style reader over data: (n, nil) until the data is used up, then
// (0, EOF).
function reader(data: Uint8Array): IoReader {
  let off = 0;
  return {
    async read(p) {
      if (off >= data.length) {
        return [0, EOF];
      }
      const n = Math.min(p.length, data.length - off);
      p.set(data.subarray(off, off + n));
      off += n;
      return [n, undefined];
    },
  };
}

// io.Copy(&buf, NewReader(strings.NewReader(in))) as a latin1 byte string,
// with the error io.Copy returns.
async function decode(input: string): Promise<[string, unknown]> {
  const buf = new BytesBuffer();
  const [, err] = await copy(buf, new QPReader(reader(bytesOf(input))));
  return [Buffer.from(buf.bytes()).toString("latin1"), err];
}

// Go string literals with bytes above 0x7f are written as \x escapes here, so
// the test input is the same byte string Go uses.
test.each([
  { in: "", want: "" },
  { in: "foo bar", want: "foo bar" },
  { in: "foo bar=3D", want: "foo bar=" },
  { in: "foo bar=3d", want: "foo bar=" }, // lax.
  { in: "foo bar=\n", want: "foo bar" },
  { in: "foo bar\n", want: "foo bar\n" }, // somewhat lax.
  { in: "foo bar=0", want: "foo bar=0" }, // lax
  { in: "foo bar=0D=0A", want: "foo bar\r\n" },
  { in: " A B        \r\n C ", want: " A B\r\n C" },
  { in: " A B =\r\n C ", want: " A B  C" },
  { in: " A B =\n C ", want: " A B  C" }, // lax. treating LF as CRLF
  { in: "foo=\nbar", want: "foobar" },
  {
    in: "foo\x00bar",
    want: "foo",
    err: "quotedprintable: invalid unescaped byte 0x00 in body",
  },
  { in: "foo bar\xff", want: "foo bar\xff" },

  // Equal sign.
  { in: "=3D30\n", want: "=30\n" },
  { in: "=00=FF0=\n", want: "\x00\xff0" },

  // Trailing whitespace
  { in: "foo  \n", want: "foo\n" },
  { in: "foo  \n\nfoo =\n\nfoo=20\n\n", want: "foo\n\nfoo \nfoo \n\n" },

  // Tests that we allow bare \n and \r through, despite it being strictly
  // not permitted per RFC 2045, Section 6.7 Page 22 bullet (4).
  { in: "foo\nbar", want: "foo\nbar" },
  { in: "foo\rbar", want: "foo\rbar" },
  { in: "foo\r\nbar", want: "foo\r\nbar" },

  // Different types of soft line-breaks.
  { in: "foo=\r\nbar", want: "foobar" },
  { in: "foo=\nbar", want: "foobar" },
  { in: "foo=\rbar", want: "foo", err: "quotedprintable: invalid hex byte 0x0d" },
  {
    in: "foo=\r\r\r \nbar",
    want: "foo",
    err: String.raw`quotedprintable: invalid bytes after =: "\r\r\r \n"`,
  },
  // Issue 15486, accept trailing soft line-break at end of input.
  { in: "foo=", want: "foo" },
  { in: "=", want: "", err: 'quotedprintable: invalid bytes after =: ""' },

  // Example from RFC 2045:
  {
    in: "Now's the time =\nfor all folk to come=\n to the aid of their country.",
    want: "Now's the time for all folk to come to the aid of their country.",
  },
  {
    in: "accept UTF-8 right quotation mark: \xe2\x80\x99",
    want: "accept UTF-8 right quotation mark: \xe2\x80\x99",
  },

  // Transport padding
  { in: "foo= \r\nbar", want: "foobar" },
  { in: "foo=\t \r\nbar", want: "foobar" },
])("TestReader: $in", async ({ in: input, want, err }) => {
  const [got, gotErr] = await decode(input);
  expect(got).toBe(want);
  if (err === undefined) {
    expect(gotErr).toBeUndefined();
  } else {
    expect((gotErr as Error).message).toBe(err);
  }
});

function everySequence(base: string, alpha: string, length: number, fn: (s: string) => void): void {
  if (base.length === length) {
    fn(base);
    return;
  }
  for (let i = 0; i < alpha.length; i++) {
    everySequence(base + alpha[i], alpha, length, fn);
  }
}

const badSoftRx = /=([^\r\n]+?\n)|([^\r\n]+$)|(\r$)|(\r[^\n]+\n)|( \r\n)/;

test("TestExhaustive", async () => {
  const sequences: string[] = [];
  everySequence("", "0A \r\n=", 6, (s) => sequences.push(s));

  const res = new Map<string, number>();
  const unexpected: string[] = [];
  for (const s of sequences) {
    if (s.endsWith("=") || s.includes("==")) {
      continue;
    }
    const [, err] = await decode(s);
    if (err === undefined) {
      res.set("OK", (res.get("OK") ?? 0) + 1);
      continue;
    }
    let errStr = (err as Error).message;
    if (errStr.includes("invalid bytes after =:")) {
      errStr = "invalid bytes after =";
    }
    res.set(errStr, (res.get(errStr) ?? 0) + 1);
    if (errStr.includes("invalid hex byte ")) {
      if (errStr.endsWith("0x20") && (s.includes("=0 ") || s.includes("=A ") || s.includes("= "))) {
        continue;
      }
      if (errStr.endsWith("0x3d") && (s.includes("=0=") || s.includes("=A="))) {
        continue;
      }
      if (errStr.endsWith("0x0a") || errStr.endsWith("0x0d")) {
        // bunch of cases; since whitespace at the end of a line before \n is removed.
        continue;
      }
    }
    if (errStr.includes("unexpected EOF")) {
      continue;
    }
    if (errStr === "invalid bytes after =" && badSoftRx.test(s)) {
      continue;
    }
    unexpected.push(`decode(${JSON.stringify(s)}) = ${errStr}`);
  }

  expect(unexpected).toEqual([]);
  const outcomes = [...res].map(([k, v]) => `${k}: ${v}`).toSorted();
  expect(outcomes.join("\n")).toBe(
    [
      "OK: 30638",
      "invalid bytes after =: 2243",
      "quotedprintable: invalid hex byte 0x0d: 2050",
      "unexpected EOF: 194",
    ].join("\n"),
  );
}, 300_000);
