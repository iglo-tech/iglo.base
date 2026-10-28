// Upstream: tools/types/json_map_test.go
//
// A JSONMap is a plain object. Go's invalid UTF-8 byte "\xc3" is a lone
// surrogate in a JS string.

import { describe, expect, test } from "bun:test";

import { anyType, marshal } from "@/tools/types/go-json";
import {
  type JSONMap,
  jsonMapGet,
  jsonMapMarshalJSON,
  jsonMapSet,
  jsonMapString,
  jsonMapValue,
  scanJSONMap,
} from "@/tools/types/json-map";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("JSONMapMarshalJSON", () => {
  const scenarios: [JSONMap<unknown> | undefined, string][] = [
    [undefined, "{}"],
    [{}, `{}`],
    [{ test: [1, 2, 3] }, `{"test":[1,2,3]}`],
    [
      { test1: 123, test2: "lorem\ud800" /* invalid utf8 char to test mangling */ },
      `{"test1":123,"test2":"lorem\ufffd"}`,
    ],
  ];

  scenarios.forEach(([json, expected], i) => {
    test(`${i}_${expected}`, () => {
      expect(jsonMapMarshalJSON(json)).toBe(expected);
    });
  });
});

describe("JSONMapMarshalString", () => {
  const scenarios: [JSONMap<unknown> | undefined, string][] = [
    [undefined, "{}"],
    [{}, `{}`],
    [{ test1: 123, test2: "lorem" }, `{"test1":123,"test2":"lorem"}`],
    [{ test: [1, 2, 3] }, `{"test":[1,2,3]}`],
  ];

  scenarios.forEach(([json, expected], i) => {
    test(`${i}_${expected}`, () => {
      expect(jsonMapString(json)).toBe(expected);
    });
  });
});

describe("JSONMapGet", () => {
  // Go returns T's zero value (nil for any); here a missing key is undefined
  const scenarios: [JSONMap<unknown> | undefined, string, unknown][] = [
    [undefined, "test", undefined],
    [{ test: 123 }, "test", 123],
    [{ test: 123 }, "missing", undefined],
  ];

  scenarios.forEach(([json, key, expected], i) => {
    test(`${i}_${key}`, () => {
      expect(jsonMapGet(json, key)).toBe(expected);
    });
  });
});

describe("JSONMapSet", () => {
  const scenarios: [string, unknown][] = [
    ["a", null],
    ["a", 123],
    ["b", "test"],
    ["__proto__", "test"],
  ];

  scenarios.forEach(([key, value], i) => {
    test(`${i}_${key}`, () => {
      const j: JSONMap<unknown> = {};
      jsonMapSet(j, key, value);
      expect(Object.hasOwn(j, key)).toBe(true);
      expect(j[key]).toBe(value);
    });
  });
});

describe("JSONMapValue", () => {
  const scenarios: [JSONMap<unknown> | undefined, string][] = [
    [undefined, `{}`],
    [{}, `{}`],
    [{ test1: 123, test2: "lorem" }, `{"test1":123,"test2":"lorem"}`],
    [{ test: [1, 2, 3] }, `{"test":[1,2,3]}`],
  ];

  scenarios.forEach(([json, expected], i) => {
    test(`${i}_${expected}`, () => {
      expect(jsonMapValue(json)).toBe(expected);
    });
  });
});

describe("JSONArrayMapScan", () => {
  const scenarios: [unknown, boolean, string][] = [
    [``, false, `{}`],
    [null, false, `{}`],
    [new Uint8Array(), false, `{}`],
    [`{}`, false, `{}`],
    [123, true, `{}`],
    [`""`, true, `{}`],
    [`invalid_json`, true, `{}`],
    [`"test"`, true, `{}`],
    [`1,2,3`, true, `{}`],
    [`{"test": 1`, true, `{}`],
    [`{"test": 1}`, false, `{"test":1}`],
    [bytes(`{"test": 1}`), false, `{"test":1}`],
  ];

  scenarios.forEach(([value, expectError, expectJSON], i) => {
    test(`${i}_${String(value)}`, () => {
      let m: JSONMap<unknown> = {};
      let hasErr = false;
      try {
        m = scanJSONMap(value, anyType);
      } catch {
        hasErr = true; // Go resets the map to empty
      }
      expect(hasErr).toBe(expectError);
      expect(marshal(m)).toBe(expectJSON);
    });
  });
});

// Not in upstream's tests: the bytes Go's json v2 (Deterministic) gives.
describe("JSONMap Go bytes", () => {
  const scenarios: [string, JSONMap<unknown>, string][] = [
    [
      "keys sorted by UTF-8 bytes",
      { b: 1, a: 2, "10": 3, "9": 4, é: 5, "\u{1f600}": 6, "￿": 7 },
      `{"10":3,"9":4,"a":2,"b":1,"é":5,"￿":7,"\u{1f600}":6}`,
    ],
    [
      "nested maps sorted",
      { z: { y: 1, x: 2 }, a: [{ d: 1, c: 2 }] },
      `{"a":[{"c":2,"d":1}],"z":{"x":2,"y":1}}`,
    ],
    [
      "no HTML or JS escaping",
      { s: "<a href='x'>&</a>\u2028\u2029" },
      `{"s":"<a href='x'>&</a>\u2028\u2029"}`,
    ],
    [
      "control characters",
      { s: '\b\f\n\r\t\u0000\u001f\u007f"\\/' },
      `{"s":"\\b\\f\\n\\r\\t\\u0000\\u001f\u007f\\"\\\\/"}`,
    ],
    [
      "number text",
      { a: 1e21, b: 1e20, c: 1e-7, d: 0.000001, e: 1.5, f: -0, g: 123456789.123 },
      `{"a":1e+21,"b":100000000000000000000,"c":1e-7,"d":0.000001,"e":1.5,"f":-0,"g":123456789.123}`,
    ],
    ["null and bool", { a: null, b: true, c: false }, `{"a":null,"b":true,"c":false}`],
    ["__proto__ is a key", JSON.parse(`{"__proto__":1}`) as JSONMap<unknown>, `{"__proto__":1}`],
  ];

  for (const [name, m, expected] of scenarios) {
    test(name, () => {
      expect(jsonMapMarshalJSON(m)).toBe(expected);
    });
  }

  test("NaN cannot be marshaled", () => {
    expect(() => jsonMapMarshalJSON({ a: Number.NaN })).toThrow();
    expect(jsonMapString({ a: Number.NaN })).toBe("");
  });

  test("raw values from marshalJSON are compacted and canonicalized", () => {
    const raw = { marshalJSON: () => ` { "b" : "\\u0041\\/" , "a" : [ 1.0 , 2 ] } ` };
    expect(jsonMapMarshalJSON({ k: raw })).toBe(`{"k":{"b":"A/","a":[1.0,2]}}`);
  });

  test("invalid raw values fail", () => {
    expect(() => jsonMapMarshalJSON({ k: { marshalJSON: () => `{"a":1,"a":2}` } })).toThrow();
    expect(() => jsonMapMarshalJSON({ k: { marshalJSON: () => `test` } })).toThrow();
  });
});

describe("JSONMapScan Go decoding", () => {
  test("numbers are float64 and keys keep their own properties", () => {
    const m = scanJSONMap(`{"__proto__":{"a":1},"n":9007199254740993}`);
    expect(Object.hasOwn(m, "__proto__")).toBe(true);
    expect(m["n"]).toBe(9007199254740992);
  });

  test("merges into an existing map", () => {
    const into: JSONMap<unknown> = { a: 1, c: { x: 1 } };
    const m = scanJSONMap(`{"b":2,"c":{"y":2}}`, anyType, into);
    expect(m).toEqual({ a: 1, b: 2, c: { x: 1, y: 2 } });
  });

  test("an existing value keeps its Go type", () => {
    expect(() => scanJSONMap(`{"a":"x"}`, anyType, { a: 1 } as JSONMap<unknown>)).toThrow();
    expect(scanJSONMap(`{"a":null}`, anyType, { a: 1 } as JSONMap<unknown>)).toEqual({ a: null });
  });

  test("duplicate names fail", () => {
    expect(() => scanJSONMap(`{"a":1,"a":2}`)).toThrow();
  });

  test("null is an empty map", () => {
    expect(scanJSONMap(`null`)).toEqual({});
  });
});
