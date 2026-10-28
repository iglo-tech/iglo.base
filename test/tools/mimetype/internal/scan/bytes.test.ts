// Upstream: gabriel-vasile/mimetype v1.4.15 internal/scan/bytes_test.go

import { describe, expect, test } from "bun:test";

import { Bytes, CompactWS, FullWord, IgnoreCase } from "@/tools/mimetype/internal/scan/bytes";
import { g, raw } from "@test/tools/mimetype/go-literal";

// string(b) in Go, as a byte-exact string for comparisons (nil is "").
const str = (b: Uint8Array | null | undefined): string =>
  b ? Buffer.from(b).toString("latin1") : "";

// Byte value of a one-character Go rune literal such as '1'.
const ch = (c: string): number => c.charCodeAt(0);

describe("scan.Bytes", () => {
  describe("TestPeek", () => {
    const tcases = [
      { name: "empty", in: raw(""), peeked: 0 },
      { name: "123", in: raw("123"), peeked: ch("1") },
    ];

    for (const tc of tcases) {
      test(tc.name, () => {
        const b = new Bytes(tc.in);
        const peeked = b.peek();
        expect(str(b.b)).toBe(str(tc.in));
        expect(peeked).toBe(tc.peeked);
      });
    }
  });

  describe("TestPop", () => {
    const tcases = [
      { name: "empty", in: raw(""), popped: 0, left: raw("") },
      { name: "123", in: raw("123"), popped: ch("1"), left: raw("23") },
    ];

    for (const tc of tcases) {
      test(tc.name, () => {
        const b = new Bytes(tc.in);
        const popped = b.pop();
        expect(str(b.b)).toBe(str(tc.left));
        expect(popped).toBe(tc.popped);
      });
    }
  });

  describe("TestPopN", () => {
    const tcases = [
      { name: "empty", in: raw(""), n: 0, popped: raw(""), left: raw("") },
      { name: "1,0", in: raw("1"), n: 0, popped: raw(""), left: raw("1") },
      { name: "12,0", in: raw("12"), n: 0, popped: raw(""), left: raw("12") },
      { name: "1,1", in: raw("1"), n: 1, popped: raw("1"), left: raw("") },
      { name: "12,1", in: raw("12"), n: 1, popped: raw("1"), left: raw("2") },
      { name: "123,1", in: raw("123"), n: 1, popped: raw("1"), left: raw("23") },
      { name: "123,2", in: raw("123"), n: 2, popped: raw("12"), left: raw("3") },
      { name: "123,3", in: raw("123"), n: 3, popped: raw("123"), left: raw("") },
      // Go returns nil when there are not enough bytes; str(null) is "".
      { name: "123,4", in: raw("123"), n: 4, popped: raw(""), left: raw("123") },
    ];

    for (const tc of tcases) {
      test(tc.name, () => {
        const b = new Bytes(tc.in);
        const popped = b.popN(tc.n);
        expect(str(b.b)).toBe(str(tc.left));
        expect(str(popped)).toBe(str(tc.popped));
      });
    }
  });

  describe("TestTrim", () => {
    const tcases = [
      { name: "empty", in: raw(""), left: raw(""), right: raw("") },
      { name: "one space", in: raw(" "), left: raw(""), right: raw("") },
      {
        name: "all spaces",
        in: g` \r\n\t\x0c`,
        left: raw(""),
        right: raw(""),
      },
      {
        name: "one char and spaces",
        in: g` \r\n\t\x0ca \r\n\t\x0c`,
        left: g`a \r\n\t\x0c`,
        right: g` \r\n\t\x0ca`,
      },
      { name: "one char", in: raw("a"), left: raw("a"), right: raw("a") },
      // Unicode Ogham space mark
      {
        name: "unicode space ogham",
        in: g` `,
        left: g` `,
        right: g` `,
      },
      // Unicode Em space mark
      {
        name: "unicode em space",
        in: g` `,
        left: g` `,
        right: g` `,
      },
    ];

    for (const tc of tcases) {
      test(tc.name, () => {
        const b = new Bytes(tc.in);
        b.trimLWS();
        expect(str(b.b)).toBe(str(tc.left));

        const b2 = new Bytes(tc.in);
        b2.trimRWS();
        expect(str(b2.b)).toBe(str(tc.right));
      });
    }
  });

  describe("TestFirstNonWS", () => {
    const tcases = [
      { name: "empty", in: raw(""), c: 0x00 },
      { name: "all ws", in: raw("   "), c: 0x00 },
      { name: "first char", in: raw("a"), c: ch("a") },
      { name: "second char", in: raw(" a"), c: ch("a") },
      { name: "space then nil", in: g` \x00`, c: 0x00 },
    ];

    for (const tc of tcases) {
      test(tc.name, () => {
        const b = new Bytes(tc.in);
        expect(b.firstNonWS()).toBe(tc.c);
      });
    }
  });

  describe("TestAdvance", () => {
    const tcases = [
      { name: "empty 0", in: raw(""), advance: 0, want: raw(""), shouldDo: true },
      { name: "empty 1", in: raw(""), advance: 1, want: raw(""), shouldDo: false },
      { name: "empty -1", in: raw(""), advance: -1, want: raw(""), shouldDo: false },
      { name: "123 0", in: raw("123"), advance: 0, want: raw("123"), shouldDo: true },
      { name: "123 -1", in: raw("123"), advance: -1, want: raw("123"), shouldDo: false },
      { name: "123 1", in: raw("123"), advance: 1, want: raw("23"), shouldDo: true },
      { name: "123 4", in: raw("123"), advance: 4, want: raw("123"), shouldDo: false },
    ];

    for (const tc of tcases) {
      test(tc.name, () => {
        const b = new Bytes(tc.in);
        const did = b.advance(tc.advance);
        expect(did).toBe(tc.shouldDo);
        expect(str(b.b)).toBe(str(tc.want));
      });
    }
  });

  describe("TestLine", () => {
    // scanText is what bufio.Scanner.Text() returns for the same input, as
    // printed by Go 1.27.2 (the test compares Bytes.Line against it).
    const tcases = [
      { name: "empty", in: raw(""), line: raw(""), leftover: raw(""), scanText: "" },
      { name: "one line", in: raw("abc"), line: raw("abc"), leftover: raw(""), scanText: "abc" },
      { name: "just a \\n", in: g`\n`, line: raw(""), leftover: raw(""), scanText: "" },
      { name: "just two \\n", in: g`\n\n`, line: raw(""), leftover: g`\n`, scanText: "" },
      {
        name: "one line with \\n",
        in: g`abc\n`,
        line: raw("abc"),
        leftover: raw(""),
        scanText: "abc",
      },
      {
        name: "two lines",
        in: raw("abc\ndef"),
        line: raw("abc"),
        leftover: raw("def"),
        scanText: "abc",
      },
      {
        name: "two lines with \\n",
        in: g`abc\ndef\n`,
        line: raw("abc"),
        leftover: g`def\n`,
        scanText: "abc",
      },
      {
        name: "drops final cr",
        in: g`abc\r`,
        line: raw("abc"),
        leftover: raw(""),
        scanText: "abc",
      },
      {
        name: "cr inside line",
        in: g`abc\rdef`,
        line: g`abc\rdef`,
        leftover: raw(""),
        scanText: "abc\rdef",
      },
      { name: "nl and cr", in: g`\n\r`, line: raw(""), leftover: g`\r`, scanText: "" },
    ];

    for (const tc of tcases) {
      test(tc.name, () => {
        const b = new Bytes(tc.in);
        const line = b.line();
        expect(str(line.b)).toBe(str(tc.line));
        expect(str(b.b)).toBe(str(tc.leftover));

        // Test if it behaves like bufio.Scanner as well.
        expect(str(line.b)).toBe(tc.scanText);
      });
    }
  });

  describe("TestPopUntil", () => {
    const tcases = [
      { name: "empty", in: raw(""), untilAny: raw(""), popped: raw(""), leftover: raw("") },
      {
        name: "empty with until",
        in: raw(""),
        untilAny: raw("123"),
        popped: raw(""),
        leftover: raw(""),
      },
      {
        name: "until empty",
        in: raw("123"),
        untilAny: raw(""),
        popped: raw("123"),
        leftover: raw(""),
      },
      {
        name: "until 1",
        in: raw("123"),
        untilAny: raw("1"),
        popped: raw(""),
        leftover: raw("123"),
      },
      {
        name: "until 2",
        in: raw("123"),
        untilAny: raw("2"),
        popped: raw("1"),
        leftover: raw("23"),
      },
      {
        name: "until 3",
        in: raw("123"),
        untilAny: raw("3"),
        popped: raw("12"),
        leftover: raw("3"),
      },
      {
        name: "until 4",
        in: raw("123"),
        untilAny: raw("4"),
        popped: raw("123"),
        leftover: raw(""),
      },
      {
        name: "multiple untilAny",
        in: raw("123"),
        untilAny: raw("32"),
        popped: raw("1"),
        leftover: raw("23"),
      },
    ];

    for (const tc of tcases) {
      test(tc.name, () => {
        const b = new Bytes(tc.in);
        const popped = b.popUntil(...tc.untilAny);
        expect(str(popped.b)).toBe(str(tc.popped));
        expect(str(b.b)).toBe(str(tc.leftover));
      });
    }
  });

  describe("TestReadSlice", () => {
    const tcases = [
      { name: "both empty", in: raw(""), stopAt: 0, popped: raw(""), leftover: raw("") },
      {
        name: "stop at not found",
        in: raw("abc"),
        stopAt: ch("d"),
        popped: raw("abc"),
        leftover: raw(""),
      },
      {
        name: "stop at the end",
        in: raw("abc"),
        stopAt: ch("c"),
        popped: raw("abc"),
        leftover: raw(""),
      },
      {
        name: "stop at in the middle",
        in: raw("abcdef"),
        stopAt: ch("c"),
        popped: raw("abc"),
        leftover: raw("def"),
      },
      {
        name: "stop at the beginning",
        in: raw("abcdef"),
        stopAt: ch("a"),
        popped: raw("a"),
        leftover: raw("bcdef"),
      },
      { name: "just one char", in: raw("a"), stopAt: ch("a"), popped: raw("a"), leftover: raw("") },
      {
        name: "same char twice",
        in: raw("aa"),
        stopAt: ch("a"),
        popped: raw("a"),
        leftover: raw("a"),
      },
    ];

    for (const tc of tcases) {
      test(tc.name, () => {
        const b = new Bytes(tc.in);
        const got = b.readSlice(tc.stopAt);
        expect(str(got.b)).toBe(str(tc.popped));
        expect(str(b.b)).toBe(str(tc.leftover));
      });
    }
  });

  describe("TestUint16", () => {
    const tcases = [
      { name: "empty", in: Uint8Array.of(), res: 0, ok: false },
      { name: "too short", in: Uint8Array.of(0), res: 0, ok: false },
      { name: "just enough", in: Uint8Array.of(1, 0), res: 1, ok: true },
      { name: "longer", in: Uint8Array.of(1, 0, 2), res: 1, ok: true },
    ];

    for (const tc of tcases) {
      test(tc.name, () => {
        const b = new Bytes(tc.in);
        const [res, ok] = b.uint16();
        expect(res).toBe(tc.res);
        expect(ok).toBe(tc.ok);
      });
    }
  });

  describe("Search", () => {
    const searchTestcases = [
      { name: "empty", haystack: "", needle: "", flags: 0, expectIdx: 0, expectLen: 0 },
      { name: "empty cws", haystack: "", needle: "", flags: CompactWS, expectIdx: 0, expectLen: 0 },
      { name: "empty ic", haystack: "", needle: "", flags: IgnoreCase, expectIdx: 0, expectLen: 0 },
      { name: "just haystack", haystack: "abc", needle: "", flags: 0, expectIdx: 0, expectLen: 0 },
      {
        name: "just haystack cws",
        haystack: "abc",
        needle: "",
        flags: CompactWS,
        expectIdx: 0,
        expectLen: 0,
      },
      {
        name: "just haystack ic",
        haystack: "abc",
        needle: "",
        flags: IgnoreCase,
        expectIdx: 0,
        expectLen: 0,
      },
      { name: "just needle", haystack: "", needle: "abc", flags: 0, expectIdx: -1, expectLen: 0 },
      {
        name: "just needle cws",
        haystack: "",
        needle: "abc",
        flags: CompactWS,
        expectIdx: -1,
        expectLen: 0,
      },
      {
        name: "just needle ic",
        haystack: "",
        needle: "abc",
        flags: IgnoreCase,
        expectIdx: -1,
        expectLen: 0,
      },
      { name: "simple", haystack: "abc", needle: "abc", flags: 0, expectIdx: 0, expectLen: 3 },
      { name: "not found", haystack: "abc", needle: "def", flags: 0, expectIdx: -1, expectLen: 0 },
      {
        name: "simple cws",
        haystack: "abc",
        needle: "abc",
        flags: CompactWS,
        expectIdx: 0,
        expectLen: 3,
      },
      {
        name: "simple ic",
        haystack: "abc",
        needle: "abc",
        flags: IgnoreCase,
        expectIdx: 0,
        expectLen: 3,
      },
      {
        name: "ic 1 upper",
        haystack: "aBc",
        needle: "ABC",
        flags: IgnoreCase,
        expectIdx: 0,
        expectLen: 3,
      },
      {
        name: "ic prefixed",
        haystack: "aaBcß",
        needle: "ABC",
        flags: IgnoreCase,
        expectIdx: 1,
        expectLen: 3,
      },
      // 2 because ß is 2 bytes long
      {
        name: "ic prefixed utf8",
        haystack: "ßaBcß",
        needle: "ABC",
        flags: IgnoreCase,
        expectIdx: 2,
        expectLen: 3,
      },
      {
        name: "simple cws|ic",
        haystack: "  a",
        needle: " A",
        flags: CompactWS | IgnoreCase,
        expectIdx: 0,
        expectLen: 3,
      },
      {
        name: "simple cws|ic with suffix and prefix",
        haystack: "a  ab",
        needle: " A",
        flags: CompactWS | IgnoreCase,
        expectIdx: 1,
        expectLen: 3,
      },
      {
        name: "trailing space in input",
        haystack: "a  a ",
        needle: " A",
        flags: CompactWS | IgnoreCase,
        expectIdx: 1,
        expectLen: 3,
      },
      {
        name: "empty haystack with needle cws|ic",
        haystack: "",
        needle: "abc",
        flags: CompactWS | IgnoreCase,
        expectIdx: -1,
        expectLen: 0,
      },
      {
        name: "empty haystack with needle cws",
        haystack: "",
        needle: "abc",
        flags: CompactWS,
        expectIdx: -1,
        expectLen: 0,
      },
    ];

    for (const tc of searchTestcases) {
      test(tc.name, () => {
        const b = new Bytes(raw(tc.haystack));
        const [i, l] = b.search(raw(tc.needle), tc.flags);
        expect([i, l]).toEqual([tc.expectIdx, tc.expectLen]);
      });
    }
  });

  describe("Match", () => {
    const matchTestcases = [
      { name: "empty", b: "", p: "", flags: 0, expectLen: 0 },
      { name: "empty compact ws", b: "", p: "", flags: CompactWS, expectLen: 0 },
      { name: "empty ic", b: "", p: "", flags: IgnoreCase, expectLen: 0 },
      { name: "empty cws|ic", b: "", p: "", flags: CompactWS | IgnoreCase, expectLen: 0 },
      { name: "simple", b: "abc", p: "abc", flags: 0, expectLen: 3 },
      { name: "simple cws|ic", b: "abc", p: "abc", flags: CompactWS | IgnoreCase, expectLen: 3 },
      { name: "not found", b: "abc", p: "def", flags: 0, expectLen: -1 },
      { name: "simple cws", b: "abc", p: "abc", flags: CompactWS, expectLen: 3 },
      { name: "simple ic", b: "abc", p: "abc", flags: IgnoreCase, expectLen: 3 },
      { name: "ic 1 upper", b: "aBc", p: "ABC", flags: IgnoreCase, expectLen: 3 },
      { name: "ic prefixed", b: "aaBcß", p: "ABC", flags: IgnoreCase, expectLen: -1 },
      { name: "ic prefixed utf8", b: "ßaBcß", p: "ABC", flags: IgnoreCase, expectLen: -1 },
      {
        name: "simple cws|ic with space",
        b: "  a",
        p: " A",
        flags: CompactWS | IgnoreCase,
        expectLen: 3,
      },
      {
        name: "trailing space in input",
        b: "a  a ",
        p: " A",
        flags: CompactWS | IgnoreCase,
        expectLen: -1,
      },
      { name: "empty b with p", b: "", p: "/bin/bash", flags: CompactWS, expectLen: -1 },
      { name: "failing", b: "asd", p: "asdf", flags: IgnoreCase, expectLen: -1 },
      { name: "exact fw", b: "abc", p: "abc", flags: FullWord, expectLen: 3 },
      { name: "success fw", b: "abc ", p: "abc", flags: FullWord, expectLen: 3 },
      { name: "fail fw", b: "abcd", p: "abc", flags: FullWord, expectLen: -1 },
      // #762
      { name: "fw+ic", b: "abc ", p: "ABC", flags: FullWord | IgnoreCase, expectLen: 3 },
      { name: "fw+cws", b: "a  bc d", p: "a bc", flags: FullWord | CompactWS, expectLen: 5 },
      {
        name: "fw+ic+cws",
        b: "a  bc d",
        p: "A BC",
        flags: FullWord | IgnoreCase | CompactWS,
        expectLen: 5,
      },
      // Pattern ending in whitespace used to panic with CompactWS.
      { name: "cws trailing ws in pattern", b: "a  ", p: "a ", flags: CompactWS, expectLen: 2 },
    ];

    for (const tc of matchTestcases) {
      test(tc.name, () => {
        const b = new Bytes(raw(tc.b));
        const l = b.match(raw(tc.p), tc.flags);
        expect(l).toBe(tc.expectLen);
      });
    }
  });
});
