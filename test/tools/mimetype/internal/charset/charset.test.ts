// Upstream: gabriel-vasile/mimetype v1.4.15 internal/charset/charset_test.go

import { describe, expect, test } from "bun:test";

import {
  extractCharsetFromMeta,
  fromHTMLMeta,
  fromPlain,
  fromXMLHeader,
} from "@/tools/mimetype/internal/charset/charset";
import { Bytes } from "@/tools/mimetype/internal/scan/bytes";
import { raw } from "@test/tools/mimetype/go-literal";

// string(x) in Go, for a possibly nil slice (nil is "").
const str = (b: Uint8Array | null | undefined): string =>
  b ? Buffer.from(b).toString("latin1") : "";

const extractCharsetFromMetaTestCases = [
  { in: "", out: "" },
  { in: "''", out: "" },
  { in: `""`, out: "" },
  { in: `charset`, out: "" },
  { in: `charset=`, out: "" },
  { in: `charset="`, out: "" },
  { in: `charset=""`, out: "" },
  { in: `charset="a"`, out: "a" },
  { in: `charset="'a'"`, out: "'a'" },
  { in: `charset = a`, out: "a" },
  { in: `charset = a;`, out: "a" },
];

const fromHTMLTestCases = [
  { in: "", out: "" },
  { in: "<!--> ", out: "" },
  { in: "<not-meta", out: "" },
  { in: "<meta", out: "" },
  { in: "<meta=", out: "" },
  { in: "<meta ", out: "" },
  { in: `<meta content="text/html; charset=iso-8859-15">`, out: "" },
  { in: `<meta http-equiv="content-type">`, out: "" },
  {
    in: `<meta content="text/html; charset=iso-8859-15" http-equiv="content-type" >`,
    out: "iso-8859-15",
  },
  { in: `<meta http-equiv="content-type" content="a/b; charset=щ">`, out: "щ" },
  { in: `<f 1=2 /><meta b="b" charset="щ">`, out: "щ" },
];

const fromXMLTestCases = [
  { in: "", out: "" },
  { in: "   not <?xml start ", out: "" },
  { in: "   not <?xml start ", out: "" },
  { in: "xml at end <?xml", out: "" },
  { in: "xml at end and encoding <?xml encoding", out: "" },
  { in: "xml at end and encoding= <?xml encoding=", out: "" },
  { in: "xml at end and encoding=c <?xml encoding=c ", out: "c" },
  { in: "xml is case sensitive <?XML encoding=c ", out: "" },
  { in: "encoding is case sensitive too <?xml Encoding=c ", out: "" },
  { in: `<?xml version="1.0" encoding=c ?>`, out: "c" },
  { in: `<?xml version="1.0" encoding="c"?>`, out: "c" },
  { in: `  <?xml   version  =  "1.0"  encoding  =  "c"?>`, out: "c" },
];

const fromPlainTestCases = [
  { raw: Uint8Array.of(0xe6, 0xf8, 0xe5, 0x85, 0x85), charset: "windows-1252" },
  { raw: Uint8Array.of(0xe6, 0xf8, 0xe5), charset: "iso-8859-1" },
  { raw: raw("æøå"), charset: "utf-8" },
  { raw: Uint8Array.of(), charset: "" },
];

describe("charset", () => {
  describe("TestExtractCharsetFromMeta", () => {
    for (const tc of extractCharsetFromMetaTestCases) {
      test(tc.in, () => {
        const got = extractCharsetFromMeta(new Bytes(raw(tc.in)));
        expect(str(got)).toBe(tc.out);
      });
    }
  });

  describe("TestFromHTML", () => {
    for (const tc of fromHTMLTestCases) {
      // Go's unexported fromHTML (without the BOM and FromPlain fallbacks)
      test(tc.in, () => {
        expect(fromHTMLMeta(new Bytes(raw(tc.in)))).toBe(tc.out);
      });
    }
  });

  describe("TestFromXML", () => {
    for (const tc of fromXMLTestCases) {
      // Go's unexported fromXML (without the BOM and FromPlain fallbacks)
      test(tc.in, () => {
        expect(fromXMLHeader(new Bytes(raw(tc.in)))).toBe(tc.out);
      });
    }
  });

  describe("TestFromPlain", () => {
    for (const tc of fromPlainTestCases) {
      test(`in: ${Array.from(tc.raw, (b) => `0x${b.toString(16)}`).join(",")}`, () => {
        expect(fromPlain(tc.raw)).toBe(tc.charset);
      });
    }
  });
});
