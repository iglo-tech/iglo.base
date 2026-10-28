// How a JS string maps to the bytes Go matches (src/tools/regexp/regexp.ts):
// indexes are byte offsets of the UTF-8 encoding; the lone surrogate
// U+DC80+n is the invalid byte 0x80+n, read as Go reads it (one U+FFFD of
// width 1); any other lone surrogate is U+FFFD (three bytes). Expected
// values follow Go's semantics for the same bytes.

import { describe, expect, test } from "bun:test";

import { compile } from "@/tools/regexp/regexp";

describe("UTF-8", () => {
  test("indexes are byte offsets", () => {
    expect(compile("b").findStringIndex("ąb")).toEqual([2, 3]);
    expect(compile("b").findStringIndex("日b")).toEqual([3, 4]);
    expect(compile("b").findStringIndex("😀b")).toEqual([4, 5]);
    expect(compile("(.)(.)").findStringSubmatchIndex("a😀")).toEqual([0, 5, 0, 1, 1, 5]);
  });

  test("astral characters are one rune", () => {
    expect(compile("^.$").matchString("😀")).toBe(true);
    expect(compile("^..$").matchString("😀")).toBe(false);
    expect(compile("^[😀-😂]+$").matchString("😁😂")).toBe(true);
    expect(compile(String.raw`^\x{1F600}$`).matchString("😀")).toBe(true);
    expect(compile(".").findAllString("a😀b", -1)).toEqual(["a", "😀", "b"]);
  });

  test("an invalid byte is one U+FFFD step of width 1", () => {
    // "\udcff" is the byte 0xff
    expect(compile("^.$").matchString("\udcff")).toBe(true);
    expect(compile(String.raw`^\x{fffd}$`).matchString("\udcff")).toBe(true);
    expect(compile("^...$").matchString("a\udcc3b")).toBe(true);
    expect(compile("b").findStringIndex("\udce2\udc82b")).toEqual([2, 3]);
    expect(compile(".").findAllString("a\udcffb", -1)).toEqual(["a", "\udcff", "b"]);
    expect(compile(".").findAllStringIndex("\udce2\udc82", -1)).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  test("bytes given to match", () => {
    expect(compile("^.$").match(Uint8Array.of(0xff))).toBe(true);
    expect(compile("^..$").match(Uint8Array.of(0xc3, 0x28))).toBe(true); // invalid, then "("
    expect(compile("^.$").match(Uint8Array.of(0xc4, 0x85))).toBe(true); // "ą"
    expect(compile("^.$").match(Uint8Array.of(0xed, 0xa0, 0x80))).toBe(false); // a surrogate is 3 invalid bytes
  });

  test("another lone surrogate is U+FFFD", () => {
    expect(compile("^.$").matchString("\ud800")).toBe(true);
    expect(compile(String.raw`^\x{fffd}$`).matchString("\ud83d")).toBe(true);
    expect(compile(".$").findStringIndex("x\ud800")).toEqual([1, 4]);
    expect(compile(".$").findString("x\ude00")).toBe("�");
  });

  test("matches are returned in the same form", () => {
    expect(compile("a(.)b").findStringSubmatch("xa\udcffbx")).toEqual(["a\udcffb", "\udcff"]);
    expect(compile("x").replaceAllString("x\udcffx", "<$0>")).toBe("<x>\udcff<x>");
    expect(compile(",").split("a,\udcc3,😀", -1)).toEqual(["a", "\udcc3", "😀"]);
  });
  test("literal and callback replacements are normalized before joining", () => {
    // a lone high surrogate in the replacement is U+FFFD (EF BF BD) and must
    // not pair with the invalid byte 0x80 (U+DC80) after it
    expect(compile("x").replaceAllLiteralString("x\uDC80", "\uD800")).toBe("\uFFFD\uDC80");
    expect(compile("x").replaceAllStringFunc("x\uDC80", () => "\uD800")).toBe("\uFFFD\uDC80");
    expect(compile("x").replaceAllString("x\uDC80", "\uD800")).toBe("\uFFFD\uDC80");
  });
  test("invalid bytes joined by a replacement are decoded again", () => {
    // bytes C3 78 A9: deleting x joins C3 A9 into "é", as Go's byte append does
    expect(compile("x").replaceAllString("\uDCC3x\uDCA9", "")).toBe("é");
    expect(compile("x").replaceAllLiteralString("\uDCC3x\uDCA9", "")).toBe("é");
    expect(compile("x").replaceAllStringFunc("\uDCC3x\uDCA9", () => "")).toBe("é");
    // a replacement ending in an invalid byte joins with the next piece
    expect(compile("x").replaceAllString("x\uDCA9", "\uDCC3")).toBe("é");
    expect(compile("(x)").replaceAllString("\uDCC3x\uDCA9", "${1}")).toBe("\uDCC3x\uDCA9");
  });
});
