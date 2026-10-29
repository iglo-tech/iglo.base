// Upstream: tools/picker/pick_test.go (TestPickFields)
//
// "\xc3" (an invalid UTF-8 byte) is the lone surrogate U+DCC3 here, as
// bytesToText maps invalid bytes; jsontext.Value is a JSON marshaler.

import { expect, test } from "bun:test";

import { SearchResult } from "@/search/provider";
import { InvalidModifierDataError, pick } from "@/tools/picker/pick";
import { type ModifierFactoryFunc, Modifiers } from "@/tools/picker/modifiers";
import { marshal } from "@/tools/types/go-json";

// brokenModifier always fails (upstream registers it in init())
const modifiers = new Map<string, ModifierFactoryFunc>([
  ...Modifiers,
  [
    "broken",
    () => ({
      modify: () => {
        throw new Error("test_error");
      },
    }),
  ],
]);

const searchItems = (): unknown[] => [
  { a: 11, b: 11, c: "test1" },
  { a: 22, b: 22, c: "test2" },
];

test.each<[string, () => unknown, string, boolean, string]>([
  ["empty fields", () => ({ a: 1, b: 2, c: "test" }), "", false, `{"a":1,"b":2,"c":"test"}`],
  ["missing fields", () => ({ a: 1, b: 2, c: "test" }), "missing", false, `{}`],
  ["non map data", () => "test", "a,b,test", false, `"test"`],
  ["non slice of map data", () => ["a", "b", "test"], "a,test", false, `["a","b","test"]`],
  ["map with no matching field", () => ({ a: 1, b: 2, c: "test" }), "missing", false, `{}`],
  [
    "map with existing and missing fields",
    () => ({ a: 1, b: 2, c: "test" }),
    "a,  c  ,missing",
    false,
    `{"a":1,"c":"test"}`,
  ],
  [
    "slice of maps with existing and missing fields",
    () => [
      { a: 11, b: 11, c: "test1" },
      { a: 22, b: 22, c: "\udcc3" /* test invalid utf8 mangling */ },
    ],
    "a,  c  ,missing",
    false,
    `[{"a":11,"c":"test1"},{"a":22,"c":"�"}]`,
  ],
  [
    "nested fields with mixed map and any slices",
    () => ({
      a: 1,
      b: 2,
      c: "test",
      anySlice: [{ A: [1, 2, 3], B: ["1", "2", 3], C: "test", D: { DA: 1, DB: 2 } }, { A: "test" }],
      mapSlice: [
        { A: [1, 2, 3], B: ["1", "2", 3], C: "test", D: [{ DA: 1 }] },
        {
          B: ["1", "2", 3],
          D: [{ DA: 2 }, { DA: 3 }, { DB: 4 }], // will result to empty since there is no DA
        },
      ],
      fullMap: [
        { A: [1, 2, 3], B: ["1", "2", 3], C: "test" },
        {
          B: ["1", "2", 3],
          D: [{ DA: 2 }, { DA: 3 }], // will result to empty since there is no DA
        },
      ],
    }),
    "a, c, anySlice.A, mapSlice.C, mapSlice.D.DA, anySlice.D,fullMap",
    false,
    `{"a":1,"anySlice":[{"A":[1,2,3],"D":{"DA":1,"DB":2}},{"A":"test"}],"c":"test","fullMap":[{"A":[1,2,3],"B":["1","2",3],"C":"test"},{"B":["1","2",3],"D":[{"DA":2},{"DA":3}]}],"mapSlice":[{"C":"test","D":[{"DA":1}]},{"D":[{"DA":2},{"DA":3},{}]}]}`,
  ],
  [
    "SearchResult",
    () => new SearchResult(searchItems(), 1, 10, 20, 30),
    "a,c,missing",
    false,
    `{"items":[{"a":11,"c":"test1"},{"a":22,"c":"test2"}],"page":1,"perPage":10,"totalItems":20,"totalPages":30}`,
  ],
  [
    "*SearchResult",
    () => new SearchResult(searchItems(), 1, 10, 20, 30),
    "a,c",
    false,
    `{"items":[{"a":11,"c":"test1"},{"a":22,"c":"test2"}],"page":1,"perPage":10,"totalItems":20,"totalPages":30}`,
  ],
  [
    "root wildcard",
    () => new SearchResult(searchItems(), 1, 10, 20, 30),
    "*",
    false,
    `{"items":[{"a":11,"b":11,"c":"test1"},{"a":22,"b":22,"c":"test2"}],"page":1,"perPage":10,"totalItems":20,"totalPages":30}`,
  ],
  [
    "root wildcard with nested exception",
    () => ({ id: "123", title: "lorem", rel: { id: "456", title: "rel_title" } }),
    "*,rel.id",
    false,
    `{"id":"123","rel":{"id":"456"},"title":"lorem"}`,
  ],
  [
    "sub wildcard",
    () => ({
      id: "123",
      title: "lorem",
      rel: { id: "456", title: "rel_title", sub: { id: "789", title: "sub_title" } },
    }),
    "id,rel.*",
    false,
    `{"id":"123","rel":{"id":"456","sub":{"id":"789","title":"sub_title"},"title":"rel_title"}}`,
  ],
  [
    "sub wildcard with nested exception",
    () => ({
      id: "123",
      title: "lorem",
      rel: { id: "456", title: "rel_title", sub: { id: "789", title: "sub_title" } },
    }),
    "id,rel.*,rel.sub.id",
    false,
    `{"id":"123","rel":{"id":"456","sub":{"id":"789"},"title":"rel_title"}}`,
  ],
  ["with modifer.Modify error", () => ({ a: 1 }), "*:broken", true, `{"a":1}`],
  [
    "invalid excerpt modifier",
    () => ({ a: 1, b: 2, c: "test" }),
    "*:excerpt",
    true,
    `{"a":1,"b":2,"c":"test"}`,
  ],
  [
    "valid excerpt modifier",
    () => ({
      id: "123",
      title: "lorem",
      rel: { id: "456", title: "<p>rel_title</p>", sub: { id: "789", title: "sub_title" } },
    }),
    "*:excerpt(2),rel.title:excerpt(3, true)",
    false,
    `{"id":"12","rel":{"title":"rel..."},"title":"lo"}`,
  ],
  [
    "jsonv1 values",
    () => ({ a: "test\udcc3", b: { marshalJSON: () => `{"a":1,"a":2}` } }),
    "a, b",
    false,
    `{"a":"test�","b":{"a":2}}`,
  ],
])("%s", (_name, data, fields, expectError, expected) => {
  let result: unknown;
  let err: unknown;
  try {
    result = pick(data(), fields, modifiers);
  } catch (e) {
    err = e;
  }

  expect(err !== undefined).toBe(expectError);
  if (err !== undefined) {
    return;
  }

  expect(marshal(result, { allowInvalidUTF8: true, allowDuplicateNames: true })).toBe(expected);
});

test("a failing modifier is an InvalidModifierDataError", () => {
  expect(() => pick({ a: 1 }, "*:broken", modifiers)).toThrow(InvalidModifierDataError);
  expect(() => pick({ a: 1 }, "*:excerpt")).not.toThrow(InvalidModifierDataError);
  expect(() => pick({ a: 1 }, "*:excerpt")).toThrow("max argument is required");
  expect(() => pick({ a: 1 }, "*:unknown(1)")).toThrow(`missing or invalid modifier "unknown"`);
});
