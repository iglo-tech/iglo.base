// Upstream: ozzo-validation v4.4.1 each_test.go
//
// Dropped: TestEachWithContext (context variants), and
// the t14 row (channels and funcs are not ported).
//
// t1 differs: Go's untyped nil is not an iterable, but null is a typed nil
// slice or map here (no elements, valid); upstream only passes typed
// fields.

import { describe, expect, test } from "bun:test";

import { Each } from "@/validation/each";
import { Required } from "@/validation/required";

// a Go struct value (not a map, not a slice)
class Struct {
  constructor(readonly foo: string) {}
}

function assertError(expected: string, err: globalThis.Error | null, tag: string): void {
  if (expected === "") {
    expect(err, tag).toBeNull();
  } else {
    expect(err?.message, tag).toBe(expected);
  }
}

describe("each", () => {
  test.each([
    { tag: "t1", value: null as unknown, err: "" },
    { tag: "t2", value: {} as unknown, err: "" },
    { tag: "t3", value: { key1: "value1", key2: "value2" } as unknown, err: "" },
    {
      tag: "t4",
      value: { key1: "", key2: "value2", key3: "" } as unknown,
      err: "key1: cannot be blank; key3: cannot be blank.",
    },
    {
      tag: "t5",
      value: { key1: { "key1.1": "value1" }, key2: { "key2.1": "value1" } } as unknown,
      err: "",
    },
    // a Go nil key is not expressible in an object; the empty string key is
    { tag: "t6", value: { "": null } as unknown, err: ": cannot be blank." },
    { tag: "t7", value: {} as unknown, err: "" },
    { tag: "t8", value: { key1: new Struct("foo") } as unknown, err: "" },
    {
      tag: "t9",
      value: { "": "", key1: null } as unknown,
      err: ": cannot be blank; key1: cannot be blank.",
    },
    { tag: "t10", value: ["value1", "value2", "value3"] as unknown, err: "" },
    {
      tag: "t11",
      value: ["", "value2", ""] as unknown,
      err: "0: cannot be blank; 2: cannot be blank.",
    },
    { tag: "t12", value: [new Struct("foo")] as unknown, err: "" },
    { tag: "t13", value: [null, null] as unknown, err: "0: cannot be blank; 1: cannot be blank." },
  ])("TestEach $tag", ({ value, err }) => {
    assertError(err, Each(Required).validate(value), "Each");
  });
});
