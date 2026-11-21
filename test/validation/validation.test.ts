// Upstream: ozzo-validation v4.4.1 validation_test.go
//
// Dropped: the context variants (TestValidate's
// errWithContext column, TestByWithContext), the &slice and &mp pointer rows
// (they are the same JS values as the rows kept), and the Go-typed rows JS
// cannot express (String123 and friends are classes with a validate method).

import { describe, expect, test } from "bun:test";

import { By, Skip, Validate } from "@/validation/validation";
import type { Rule, Validatable } from "@/validation/validation";

// a Go string type with a Validate method
class String123 implements Validatable {
  constructor(readonly value: string) {}

  validate(): globalThis.Error | null {
    if (!this.value.includes("123")) {
      return new Error("error 123");
    }
    return null;
  }
}

// a Go type whose Validate returns a fixed error
class StringValidate implements Validatable {
  validate(): globalThis.Error | null {
    return new Error("called validate");
  }
}

// a Go type whose Validate checks for "abc" (its context variant is not ported)
class StringValidateContext implements Validatable {
  constructor(readonly value: string) {}

  validate(): globalThis.Error | null {
    if (this.value !== "abc") {
      return new Error("must be abc");
    }
    return null;
  }
}

// a Go struct with only a ValidateWithContext method: not Validatable here
class Model4 {
  constructor(readonly A: string) {}
}

class validateAbc implements Rule {
  validate(obj: unknown): globalThis.Error | null {
    if (!String(obj).includes("abc")) {
      return new Error("error abc");
    }
    return null;
  }
}

class validateXyz implements Rule {
  validate(obj: unknown): globalThis.Error | null {
    if (!String(obj).includes("xyz")) {
      return new Error("error xyz");
    }
    return null;
  }
}

function stringEqual(str: string): (value: unknown) => globalThis.Error | null {
  return (value) => {
    const s = typeof value === "string" ? value : "";
    if (s !== str) {
      return new Error("unexpected string");
    }
    return null;
  };
}

function assertError(expected: string, err: globalThis.Error | null, tag: string): void {
  if (expected === "") {
    expect(err, tag).toBeNull();
  } else {
    expect(err?.message, tag).toBe(expected);
  }
}

describe("validation", () => {
  test.each([
    { tag: "t1", value: 123, err: "" },
    { tag: "t2", value: new String123("123"), err: "" },
    { tag: "t3", value: new String123("abc"), err: "error 123" },
    { tag: "t4", value: [], err: "" },
    {
      tag: "t5",
      value: [new String123("abc"), new String123("123"), new String123("xyz")],
      err: "0: error 123; 2: error 123.",
    },
    { tag: "t7", value: [new Model4("abc"), new Model4("def")], err: "" },
    {
      tag: "t8",
      // map[string]String123: a Map (a plain object is a map[string]any)
      value: new Map([
        ["c", new String123("abc")],
        ["b", new String123("123")],
        ["a", new String123("xyz")],
      ]),
      err: "a: error 123; c: error 123.",
    },
    {
      tag: "t8.1",
      // map[string]StringValidateContext: a Map (a plain object is a map[string]any)
      value: new Map([
        ["c", new StringValidateContext("abc")],
        ["b", new StringValidateContext("123")],
        ["a", new StringValidateContext("xyz")],
      ]),
      err: "a: must be abc; b: must be abc.",
    },
    { tag: "t10", value: new Map(), err: "" },
    { tag: "t11", value: null, err: "" },
    { tag: "t12", value: new StringValidate(), err: "called validate" },
    { tag: "t13", value: new StringValidateContext("xyz"), err: "must be abc" },
  ])("TestValidate $tag", ({ value, err }) => {
    assertError(err, Validate(value), "Validate");
  });

  test("TestValidate with rules", () => {
    let err = Validate("123", new validateAbc(), new validateXyz());
    expect(err?.message).toBe("error abc");
    err = Validate("abc", new validateAbc(), new validateXyz());
    expect(err?.message).toBe("error xyz");
    err = Validate("abcxyz", new validateAbc(), new validateXyz());
    expect(err).toBeNull();

    err = Validate("123", new validateAbc(), Skip, new validateXyz());
    expect(err?.message).toBe("error abc");
    err = Validate("abc", new validateAbc(), Skip, new validateXyz());
    expect(err).toBeNull();

    err = Validate("123", new validateAbc(), Skip.when(true), new validateXyz());
    expect(err?.message).toBe("error abc");
    err = Validate("abc", new validateAbc(), Skip.when(true), new validateXyz());
    expect(err).toBeNull();

    err = Validate("123", new validateAbc(), Skip.when(false), new validateXyz());
    expect(err?.message).toBe("error abc");
    err = Validate("abc", new validateAbc(), Skip.when(false), new validateXyz());
    expect(err?.message).toBe("error xyz");
  });

  test("TestBy", () => {
    const abcRule = By((value) => {
      const s = typeof value === "string" ? value : "";
      if (s !== "abc") {
        return new Error("must be abc");
      }
      return null;
    });
    expect(Validate("abc", abcRule)).toBeNull();
    const err = Validate("xyz", abcRule);
    expect(err?.message).toBe("must be abc");

    const xyzRule = By(stringEqual("xyz"));
    expect(Validate("xyz", xyzRule)).toBeNull();
    expect(Validate("abc", xyzRule)).not.toBeNull();
  });

  test("Test_skipRule_Validate", () => {
    const rule: Rule = Skip;
    expect(rule.validate(100)).toBeNull();
  });
});
