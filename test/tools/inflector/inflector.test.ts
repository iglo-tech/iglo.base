// Upstream: tools/inflector/inflector_test.go

import { describe, expect, test } from "bun:test";

import {
  camelize,
  columnify,
  sanitize,
  sentenize,
  snakecase,
  ucFirst,
} from "@/tools/inflector/inflector";

describe("UcFirst", () => {
  const scenarios: [string, string][] = [
    ["", ""],
    [" ", " "],
    ["Test", "Test"],
    ["test", "Test"],
    ["test test2", "Test test2"],
  ];

  for (const [i, [val, expected]] of scenarios.entries()) {
    test(`${i}_${JSON.stringify(val)}`, () => {
      expect(ucFirst(val)).toBe(expected);
    });
  }
});

describe("Columnify", () => {
  const scenarios: [string, string][] = [
    ["", ""],
    ["   ", ""],
    ["123", "123"],
    ["Test.", "Test."],
    [" test ", "test"],
    ["test1.test2", "test1.test2"],
    ["@test!abc", "@testabc"],
    ["#test?abc", "#testabc"],
    ["123test(123)#", "123test123#"],
    ["test1--test2", "test1--test2"],
  ];

  for (const [i, [val, expected]] of scenarios.entries()) {
    test(`${i}_${JSON.stringify(val)}`, () => {
      expect(columnify(val)).toBe(expected);
    });
  }
});

describe("Sentenize", () => {
  const scenarios: [string, string][] = [
    ["", ""],
    ["   ", ""],
    [".", "."],
    ["?", "?"],
    ["!", "!"],
    ["Test", "Test."],
    [" test ", "Test."],
    ["hello world", "Hello world."],
    ["hello world.", "Hello world."],
    ["hello world!", "Hello world!"],
    ["hello world?", "Hello world?"],
  ];

  for (const [i, [val, expected]] of scenarios.entries()) {
    test(`${i}_${JSON.stringify(val)}`, () => {
      expect(sentenize(val)).toBe(expected);
    });
  }
});

describe("Sanitize", () => {
  // expectErr: sanitize throws on an invalid pattern (Go returns an error),
  // so the expected result is not checked then
  const scenarios: [string, string, string, boolean][] = [
    ["", ``, "", false],
    [" ", ``, " ", false],
    [" ", ` `, "", false],
    ["", `[A-Z]`, "", false],
    ["abcABC", `[A-Z]`, "abc", false],
    ["abcABC", `[A-Z`, "", true], // invalid pattern
  ];

  for (const [i, [val, pattern, expected, expectErr]] of scenarios.entries()) {
    test(`${i}_${JSON.stringify(val)}`, () => {
      if (expectErr) {
        expect(() => sanitize(val, pattern)).toThrow();
      } else {
        expect(sanitize(val, pattern)).toBe(expected);
      }
    });
  }
});

describe("Snakecase", () => {
  const scenarios: [string, string][] = [
    ["", ""],
    ["  ", ""],
    ["!@#$%^", ""],
    ["...", ""],
    ["_", ""],
    ["John Doe", "john_doe"],
    ["John_Doe", "john_doe"],
    [".a!b@c#d$e%123. ", "a_b_c_d_e_123"],
    ["HelloWorld", "hello_world"],
    ["HelloWorld1HelloWorld2", "hello_world1_hello_world2"],
    ["TEST", "test"],
    ["testABR", "test_abr"],
  ];

  for (const [i, [val, expected]] of scenarios.entries()) {
    test(`${i}_${JSON.stringify(val)}`, () => {
      expect(snakecase(val)).toBe(expected);
    });
  }
});

describe("Camelize", () => {
  const scenarios: [string, string][] = [
    ["", ""],
    [" ", ""],
    ["Test", "Test"],
    ["test", "Test"],
    ["testTest2", "TestTest2"],
    ["TestTest2", "TestTest2"],
    ["test test2", "TestTest2"],
    ["test-test2", "TestTest2"],
    ["test'test2", "TestTest2"],
    ["test1test2", "Test1test2"],
    ["1test-test2", "1testTest2"],
    ["123", "123"],
    ["123a", "123a"],
  ];

  for (const [i, [val, expected]] of scenarios.entries()) {
    test(`${i}_${JSON.stringify(val)}`, () => {
      expect(camelize(val)).toBe(expected);
    });
  }
});

// Not in upstream's tests: Go's unicode.ToUpper (simple case mapping),
// unicode.IsLetter/IsNumber and strings.TrimSpace.
describe("Unicode rules", () => {
  const ucFirstScenarios: [string, string][] = [
    ["ßa", "ßa"], // no simple uppercase mapping
    ["ﬀ", "ﬀ"],
    ["ǆ", "Ǆ"],
    ["ᾳx", "ᾼx"], // titlecase simple mapping
    ["ὐ", "ὐ"],
    ["éa", "Éa"],
    ["\u{10428}x", "\u{10400}x"], // a surrogate pair
  ];

  for (const [value, expected] of ucFirstScenarios) {
    test(`ucFirst ${JSON.stringify(value)}`, () => {
      expect(ucFirst(value)).toBe(expected);
    });
  }

  test("camelize keeps Unicode letters and numbers", () => {
    expect(camelize("żółw_ćma ²x")).toBe("ŻółwĆma²x");
  });

  test("sentenize trims Go's spaces only", () => {
    expect(sentenize("\u0085test\u00a0")).toBe("Test.");
    expect(sentenize("\ufefftest")).toBe("\ufefftest.");
  });

  test("snakecase splits at non-ASCII characters", () => {
    expect(snakecase("myTestDB żółw")).toBe("my_test_db_w");
  });

  test("columnify removes non-ASCII characters", () => {
    expect(columnify("a\u{1f600}b_ż")).toBe("ab_");
  });
});
