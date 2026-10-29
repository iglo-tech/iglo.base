// The jsontext.AllowInvalidUTF8(true) unmarshal option (Go's
// encoding/json/v2), as upstream's json field uses it
// (core/field_json.go): invalid UTF-8 and lone surrogate escapes become
// U+FFFD, while duplicate member names still fail.

import { describe, expect, test } from "bun:test";

import { anyType, bytesToText, unmarshal } from "@/tools/types/go-json";

describe("unmarshal allowInvalidUTF8", () => {
  test("a lone surrogate escape", () => {
    expect(() => unmarshal(String.raw`["\ud800"]`, anyType)).toThrow();
    expect(unmarshal(String.raw`["\ud800"]`, anyType, { allowInvalidUTF8: true })).toEqual(["�"]);
  });

  test("an invalid UTF-8 byte", () => {
    const data = bytesToText(Uint8Array.of(0x22, 0x61, 0xff, 0x22)); // "a\xff"
    expect(() => unmarshal(data, anyType)).toThrow();
    expect(unmarshal(data, anyType, { allowInvalidUTF8: true })).toBe("a�");
  });

  test("duplicate names still fail", () => {
    expect(() => unmarshal(`{"a":1,"a":2}`, anyType, { allowInvalidUTF8: true })).toThrow(
      "duplicate object member name",
    );
  });
});

// jsontext.AllowDuplicateNames(true), as tools/picker's Pick decodes the
// marshaled response (old `json` field values may repeat a name)
describe("unmarshal allowDuplicateNames", () => {
  test("a repeated name is decoded again", () => {
    expect(() => unmarshal(`{"a":1,"a":2}`, anyType)).toThrow("duplicate object member name");
    expect(unmarshal(`{"a":1,"b":true,"a":2}`, anyType, { allowDuplicateNames: true })).toEqual({
      a: 2,
      b: true,
    });
  });
});
