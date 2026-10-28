// The jsontext.AllowDuplicateNames(true) marshal option (Go's
// encoding/json/v2), as upstream's Record.MarshalJSON uses it
// (core/record_model.go): a marshaler's output with duplicate member names
// is written as it is instead of failing.

import { describe, expect, test } from "bun:test";

import { marshal } from "@/tools/types/go-json";
import { JSONRaw } from "@/tools/types/json-raw";

describe("marshal allowDuplicateNames", () => {
  test("duplicate names in a marshaler's output", () => {
    const value = { a: new JSONRaw(`{"x":1, "x":2}`) };
    expect(() => marshal(value)).toThrow("duplicate object member name");
    expect(marshal(value, { allowDuplicateNames: true })).toBe(`{"a":{"x":1,"x":2}}`);
  });

  test("names equal after invalid UTF-8 is replaced", () => {
    const value = { "a\udc80": 1, "a\udc81": 2 };
    expect(() => marshal(value, { allowInvalidUTF8: true })).toThrow(
      "duplicate object member name",
    );
    expect(marshal(value, { allowInvalidUTF8: true, allowDuplicateNames: true })).toBe(
      `{"a�":1,"a�":2}`,
    );
  });
});
