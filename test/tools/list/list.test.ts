// Upstream: tools/list/list_test.go

import { describe, expect, test } from "bun:test";

import {
  existInSlice,
  existInSliceWithRegex,
  nonzeroUniques,
  subtractSlice,
  toChunks,
  toInterfaceSlice,
  toUniqueStringSlice,
} from "@/tools/list/list";

describe("SubtractSliceString", () => {
  const scenarios: [string[], string[], string][] = [
    [[], [], `[]`],
    [[], ["1", "2", "3", "4"], `[]`],
    [["1", "2", "3", "4"], [], `["1","2","3","4"]`],
    [["1", "2", "3", "4"], ["1", "2", "3", "4"], `[]`],
    [["1", "2", "3", "4", "7"], ["2", "4", "5", "6"], `["1","3","7"]`],
  ];

  for (const [i, [base, subtract, expected]] of scenarios.entries()) {
    test(`${i}_${expected}`, () => {
      const result = subtractSlice(base, subtract);

      expect(JSON.stringify(result)).toBe(expected);
    });
  }
});

describe("SubtractSliceInt", () => {
  const scenarios: [number[], number[], string][] = [
    [[], [], `[]`],
    [[], [1, 2, 3, 4], `[]`],
    [[1, 2, 3, 4], [], `[1,2,3,4]`],
    [[1, 2, 3, 4], [1, 2, 3, 4], `[]`],
    [[1, 2, 3, 4, 7], [2, 4, 5, 6], `[1,3,7]`],
  ];

  for (const [i, [base, subtract, expected]] of scenarios.entries()) {
    test(`${i}_${expected}`, () => {
      const result = subtractSlice(base, subtract);

      expect(JSON.stringify(result)).toBe(expected);
    });
  }
});

describe("ExistInSliceString", () => {
  const scenarios: [string, string[], boolean][] = [
    ["", [""], true],
    ["", ["1", "2", "test 123"], false],
    ["test", [], false],
    ["test", ["TEST"], false],
    ["test", ["1", "2", "test 123"], false],
    ["test", ["1", "2", "test"], true],
  ];

  for (const [i, [item, list, expected]] of scenarios.entries()) {
    test(`${i}_${JSON.stringify(item)}`, () => {
      expect(existInSlice(item, list)).toBe(expected);
    });
  }
});

describe("ExistInSliceInt", () => {
  const scenarios: [number, number[], boolean][] = [
    [0, [], false],
    [0, [0], true],
    [4, [1, 2, 3], false],
    [1, [1, 2, 3], true],
    [-1, [0, 1, 2, 3], false],
    [-1, [0, -1, -2, -3, -4], true],
  ];

  for (const [i, [item, list, expected]] of scenarios.entries()) {
    test(`${i}_${JSON.stringify(item)}`, () => {
      expect(existInSlice(item, list)).toBe(expected);
    });
  }
});

describe("ExistInSliceWithRegex", () => {
  const scenarios: [string, string[], boolean][] = [
    ["", [``], true],
    ["", [String.raw`^\W+$`], false],
    [" ", [String.raw`^\W+$`], true],
    ["test", [String.raw`^\invalid[+$`], false], // invalid regex
    ["test", [String.raw`^\W+$`, "test"], true],
    [String.raw`^\W+$`, [String.raw`^\W+$`, "test"], false], // direct match shouldn't work for this case
    [String.raw`\W+$`, [String.raw`\W+$`, "test"], true], // direct match should work for this case because it is not an actual supported pattern format
    ["!?@", [String.raw`\W+$`, "test"], false], // the method requires the pattern elems to start with '^'
    ["!?@", [String.raw`^\W+`, "test"], false], // the method requires the pattern elems to end with '$'
    ["!?@", [String.raw`^\W+$`, "test"], true],
    ["!?@test", [String.raw`^\W+$`, "test"], false],
  ];

  for (const [i, [item, list, expected]] of scenarios.entries()) {
    test(`${i}_${JSON.stringify(item)}`, () => {
      expect(existInSliceWithRegex(item, list)).toBe(expected);
    });
  }
});

describe("ToInterfaceSlice", () => {
  const scenarios: string[][] = [[], [""], ["1", "test"], ["test1", "test1", "test2", "test3"]];

  for (const [i, items] of scenarios.entries()) {
    test(`${i}_${JSON.stringify(items)}`, () => {
      const result = toInterfaceSlice(items);

      expect(result).toHaveLength(items.length);

      for (const [j, v] of result.entries()) {
        expect(v).toBe(items[j]);
      }
    });
  }
});

describe("NonzeroUniquesString", () => {
  const scenarios: [string[], string[]][] = [
    [[], []],
    [[""], []],
    [
      ["1", "test"],
      ["1", "test"],
    ],
    [
      ["test1", "", "test2", "Test2", "test1", "test3"],
      ["test1", "test2", "Test2", "test3"],
    ],
  ];

  for (const [i, [items, expected]] of scenarios.entries()) {
    test(`${i}_${JSON.stringify(items)}`, () => {
      const result = nonzeroUniques(items);

      expect(result).toHaveLength(expected.length);

      expect(result).toEqual(expected);
    });
  }
});

describe("ToUniqueStringSlice", () => {
  // A Go JSONArray is a plain array in iglo.base
  const scenarios: [unknown, string[]][] = [
    [null, []], // Go nil
    ["", []],
    [[], []],
    [[], []],
    ["test", ["test"]],
    [
      [1, 2, 3],
      ["1", "2", "3"],
    ],
    [
      [0, 1, "test", ""],
      ["0", "1", "test"],
    ],
    [
      ["test1", "test2", "test1"],
      ["test1", "test2"],
    ],
    [`["test1", "test2", "test2"]`, ["test1", "test2"]],
    [
      ["test1", "test2", "test1"],
      ["test1", "test2"],
    ], // Go types.JSONArray[string]
  ];

  for (const [i, [value, expected]] of scenarios.entries()) {
    test(`${i}_${JSON.stringify(value)}`, () => {
      const result = toUniqueStringSlice(value);

      expect(result).toHaveLength(expected.length);

      expect(result).toEqual(expected);
    });
  }
});

describe("ToChunks", () => {
  const scenarios: [number[], number, string][] = [
    [[], 2, "[]"], // Go nil
    [[], 2, "[]"],
    [[1, 2, 3, 4], -1, "[[1],[2],[3],[4]]"],
    [[1, 2, 3, 4], 0, "[[1],[2],[3],[4]]"],
    [[1, 2, 3, 4], 2, "[[1,2],[3,4]]"],
    [[1, 2, 3, 4, 5], 2, "[[1,2],[3,4],[5]]"],
    [[1, 2, 3, 4, 5], 10, "[[1,2,3,4,5]]"],
  ];

  for (const [i, [items, chunkSize, expected]] of scenarios.entries()) {
    test(`${i}_${JSON.stringify(items)}`, () => {
      const result = toChunks(items, chunkSize);

      expect(JSON.stringify(result)).toBe(expected);
    });
  }
});

// Not in upstream's tests: Go json v2 decoding of a string holding a JSON
// array (decoding stops at the first error and keeps what came before; the
// string itself is added on any error).
describe("ToUniqueStringSlice JSON strings", () => {
  const scenarios: [string, string, string[]][] = [
    ["non-string element stops decoding", `["a", 1, "b"]`, ["a", `["a", 1, "b"]`]],
    ["null element is dropped", `["a", null]`, ["a"]],
    ["syntax error keeps earlier elements", `["a", "b"`, ["a", "b", `["a", "b"`]],
    ["trailing data", `["a"] x`, ["a", `["a"] x`]],
    ["bracket inside text", `hello [world]`, [`hello [world]`]],
    ["json string containing a bracket", `"[x]"`, [`"[x]"`]],
    ["duplicate names inside are an error", `["a", {"x":1,"x":2}]`, ["a", `["a", {"x":1,"x":2}]`]],
  ];

  for (const [name, value, expected] of scenarios) {
    test(name, () => {
      expect(toUniqueStringSlice(value)).toEqual(expected);
    });
  }

  test("bytes are a slice of uint8 values for cast", () => {
    expect(toUniqueStringSlice(new Uint8Array([104, 105, 0]))).toEqual(["104", "105", "0"]);
  });

  test("a marshaler's JSON is decoded", () => {
    expect(toUniqueStringSlice({ marshalJSON: () => `["x","y","x"]` })).toEqual(["x", "y"]);
  });

  test("an array with a value cast cannot convert is empty", () => {
    expect(toUniqueStringSlice(["a", { b: 1 }])).toEqual([]);
  });
});
