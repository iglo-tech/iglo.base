// Upstream: gabriel-vasile/mimetype v1.4.15 internal/markup/markup_test.go

import { describe, expect, test } from "bun:test";

import { getAnAttribute, getAValue, skipAComment } from "@/tools/mimetype/internal/markup/markup";
import { Bytes } from "@/tools/mimetype/internal/scan/bytes";
import { raw } from "@test/tools/mimetype/go-literal";

// string(x) in Go, for a possibly nil slice (nil is "").
const str = (b: Uint8Array | null | undefined): string =>
  b ? Buffer.from(b).toString("latin1") : "";

const getAnAttributeTestCases = [
  { in: "", name: "", value: "", hasMore: false },
  { in: "''", name: "", value: "", hasMore: false },
  { in: `""`, name: "", value: "", hasMore: false },
  { in: `"abc`, name: "", value: "", hasMore: false },
  { in: "1>", name: "1", value: "", hasMore: false },
  { in: "A>", name: "A", value: "", hasMore: false },
  { in: "a>", name: "a", value: "", hasMore: false },
  { in: "abc>", name: "abc", value: "", hasMore: false },
  { in: "'abc'", name: "", value: "", hasMore: false },
  { in: "'abc'>", name: "'abc'", value: "", hasMore: false },
  // > as attribute ender
  { in: "meta1=meta>", name: "meta1", value: "meta", hasMore: false },
  { in: "meta2=META>", name: "meta2", value: "META", hasMore: false },
  { in: `meta3="meta">`, name: "meta3", value: "meta", hasMore: false },
  { in: `meta4="'meta">`, name: "meta4", value: "'meta", hasMore: false },
  { in: " meta5 = meta >", name: "meta5", value: "meta", hasMore: true },
  { in: " meta6 =' meta '>", name: "meta6", value: " meta ", hasMore: false },
  { in: ` meta7 =' "meta '>`, name: "meta7", value: ` "meta `, hasMore: false },
  { in: ` mEtA7 =' "meta '>`, name: "mEtA7", value: ` "meta `, hasMore: false },
  // / as attribute ender
  // when the value is unquoted / right after is a parse warning
  { in: "meta1=meta/", name: "meta1", value: "", hasMore: false },
  { in: "meta2=META/", name: "meta2", value: "", hasMore: false },
  { in: "meta3=meta /", name: "meta3", value: "meta", hasMore: true },
  { in: "meta4=META /", name: "meta4", value: "META", hasMore: true },
  { in: `meta5="meta"/`, name: "meta5", value: "meta", hasMore: true },
  { in: `meta6="'meta"/`, name: "meta6", value: "'meta", hasMore: true },
  { in: " meta7 = meta /", name: "meta7", value: "meta", hasMore: true },
  { in: " meta8 =' meta '/", name: "meta8", value: " meta ", hasMore: true },
  { in: ` meta9  =' "meta '/`, name: "meta9", value: ` "meta `, hasMore: true },
  { in: `  meta0 /`, name: "meta0", value: ``, hasMore: true },
  { in: "; charset=UTF-8", name: ";", value: "", hasMore: true },
  {
    in: ` http-equiv="content-type" content="text/html; charset=iso-8859-15">`,
    name: "http-equiv",
    value: `content-type`,
    hasMore: true,
  },
];

const getAValueTestCases = [
  { in: "", out: "", hasMore: false },
  { in: "   ", out: "", hasMore: false },
  { in: "''", out: "", hasMore: false },
  { in: `""`, out: "", hasMore: false },
  { in: `"abc`, out: "", hasMore: false },
  { in: ">", out: "", hasMore: false },
  { in: "1>", out: "1", hasMore: false },
  { in: "A>", out: "A", hasMore: false },
  { in: "a>", out: "a", hasMore: false },
  { in: "abc>", out: "abc", hasMore: false },
  { in: "ABCXYZ>", out: "ABCXYZ", hasMore: false },
  { in: "'abc'", out: "abc", hasMore: false },
  { in: "'abc'>", out: "abc", hasMore: false },
  { in: "abc def=ghi", out: "abc", hasMore: true },
  { in: "abc >", out: "abc", hasMore: true },
  { in: "'abc' >", out: "abc", hasMore: true },
  { in: "'ABCXYZ' >", out: "ABCXYZ", hasMore: true },
  { in: `"abc" >`, out: "abc", hasMore: true },
];

const getAllAttributesTestCases: { in: string; expected: [string, string][] }[] = [
  { in: "", expected: [] },
  // doesn't have ending >
  { in: "a", expected: [] },
  // doesn't have ending >
  { in: "abc", expected: [] },
  {
    in: "a b c",
    expected: [
      ["a", ""],
      ["b", ""],
    ],
  },
  {
    in: "abc abc abc",
    expected: [
      ["abc", ""],
      ["abc", ""],
    ],
  },
  {
    in: "a=1 b=2 c=3",
    expected: [
      ["a", "1"],
      ["b", "2"],
      ["c", ""],
    ],
  },
  {
    in: "a=1 b c=3",
    expected: [
      ["a", "1"],
      ["b", ""],
      ["c", ""],
    ],
  },
  {
    in: "a b=2 c",
    expected: [
      ["a", ""],
      ["b", "2"],
    ],
  },
  { in: ">", expected: [] },
  { in: "a>", expected: [["a", ""]] },
  { in: "abc>", expected: [["abc", ""]] },
  {
    in: "a b c>",
    expected: [
      ["a", ""],
      ["b", ""],
      ["c", ""],
    ],
  },
  {
    in: "a b/ c>",
    expected: [
      ["a", ""],
      ["b", ""],
      ["c", ""],
    ],
  },
  {
    in: "/a b/ c>",
    expected: [
      ["a", ""],
      ["b", ""],
      ["c", ""],
    ],
  },
  {
    in: "a b abc/>",
    expected: [
      ["a", ""],
      ["b", ""],
      ["abc", ""],
    ],
  },
];

const skipACommentTestCases = [
  { in: "", out: "", skipped: false },
  { in: "abc", out: "abc", skipped: false },
  // not ending comment
  { in: "<!--", out: "<!--", skipped: false },
  // regular comment
  { in: "<!-- abc -->", out: "", skipped: true },
  // the beginning and ending -- are the same chars
  { in: "<!-->", out: "", skipped: true },
];

// getAll is the Go test's helper: read attributes until one has no name.
const getAll = (input: string): [string, string][] => {
  const s = new Bytes(raw(input));
  const ret: [string, string][] = [];
  for (;;) {
    const [name, value] = getAnAttribute(s);
    if (name === null || name.length === 0) {
      return ret;
    }
    ret.push([str(name), str(value)]);
  }
};

describe("markup", () => {
  describe("TestGetAnAttribute", () => {
    for (const tc of getAnAttributeTestCases) {
      test(tc.in, () => {
        const s = new Bytes(raw(tc.in));
        const [name, value, hasMore] = getAnAttribute(s);
        expect(str(name)).toBe(tc.name);
        expect(str(value)).toBe(tc.value);
        expect(hasMore).toBe(tc.hasMore);
      });
    }
  });

  describe("TestGetAValue", () => {
    for (const tc of getAValueTestCases) {
      test(tc.in, () => {
        const s = new Bytes(raw(tc.in));
        const [got, hasMore] = getAValue(s);
        expect(str(got)).toBe(tc.out);
        expect(hasMore).toBe(tc.hasMore);
      });
    }
  });

  describe("TestGetAllAttributes", () => {
    for (const tc of getAllAttributesTestCases) {
      test(tc.in, () => {
        expect(getAll(tc.in)).toEqual(tc.expected);
      });
    }
  });

  describe("TestSkipAComment", () => {
    for (const tc of skipACommentTestCases) {
      test(tc.in, () => {
        const s = new Bytes(raw(tc.in));
        const skipped = skipAComment(s);
        expect(skipped).toBe(tc.skipped);
        expect(str(s.b)).toBe(tc.out);
      });
    }
  });
});
