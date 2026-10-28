// Upstream: ozzo-validation v4.4.1 map_test.go
//
// Dropped: TestMapWithContext (context variants), the
// NotNil rows (NotNil is not ported), and the &m1 and &m0 pointer rows (they
// are the same JS values as the rows kept).
//
// t3.2 differs: Go's untyped nil is not a map, but null is a typed nil map
// here (valid); upstream only passes typed values.

import { describe, expect, test } from "bun:test";

import { Each } from "@/validation/each";
import { Length } from "@/validation/length";
import { Required } from "@/validation/required";
import { Map, Key, type KeyRules } from "@/validation/map";
import { NewInternalError } from "@/validation/error";
import { ValidateStruct, Field } from "@/validation/struct";
import { Skip, Validate, type Rule, type Validatable } from "@/validation/validation";

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

// a validatable struct
class Model3 implements Validatable {
  constructor(readonly A = "") {}

  validate(): globalThis.Error | null {
    return ValidateStruct(Field("A", this.A, new validateAbc()));
  }
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

class validateInternalError implements Rule {
  validate(obj: unknown): globalThis.Error | null {
    if (String(obj).includes("internal")) {
      return NewInternalError(new Error("error internal"));
    }
    return null;
  }
}

function assertError(expected: string, err: globalThis.Error | null, tag: string): void {
  if (expected === "") {
    expect(err, tag).toBeNull();
  } else {
    expect(err?.message, tag).toBe(expected);
  }
}

describe("map", () => {
  const m1 = {
    A: "abc",
    B: "xyz",
    c: "abc",
    D: null as string | null,
    F: null as String123 | null,
    H: ["abc", "abc"],
    I: { foo: "abc" },
  };
  const m2 = { E: new String123("xyz") as String123 | null, F: null as String123 | null };
  const m3 = { M3: new Model3() };
  const m4 = { M3: new Model3("abc") };
  const m5 = { A: "internal", B: "" };
  const m6 = new globalThis.Map<number, string>([
    [11, "abc"],
    [22, "xyz"],
  ]);
  const m0: Record<string, unknown> | null = null;

  const rows: { tag: string; model: unknown; rules: KeyRules[]; err: string }[] = [
    // empty rules
    { tag: "t1.1", model: m1, rules: [], err: "" },
    { tag: "t1.2", model: m1, rules: [Key("A"), Key("B")], err: "" },
    // normal rules
    {
      tag: "t2.1",
      model: m1,
      rules: [Key("A", new validateAbc()), Key("B", new validateXyz())],
      err: "",
    },
    {
      tag: "t2.2",
      model: m1,
      rules: [Key("A", new validateXyz()), Key("B", new validateAbc())],
      err: "A: error xyz; B: error abc.",
    },
    {
      tag: "t2.3",
      model: m1,
      rules: [Key("A", new validateXyz()), Key("c", new validateXyz())],
      err: "A: error xyz; c: error xyz.",
    },
    { tag: "t2.4", model: m1, rules: [Key("D", Length(0, 5))], err: "" },
    { tag: "t2.5", model: m1, rules: [Key("F", Length(0, 5))], err: "" },
    {
      tag: "t2.6",
      model: m1,
      rules: [Key("H", Each(new validateAbc())), Key("I", Each(new validateAbc()))],
      err: "",
    },
    {
      tag: "t2.7",
      model: m1,
      rules: [Key("H", Each(new validateXyz())), Key("I", Each(new validateXyz()))],
      err: "H: (0: error xyz; 1: error xyz.); I: (foo: error xyz.).",
    },
    { tag: "t2.8", model: m1, rules: [Key("I", Map(Key("foo", new validateAbc())))], err: "" },
    {
      tag: "t2.9",
      model: m1,
      rules: [Key("I", Map(Key("foo", new validateXyz())))],
      err: "I: (foo: error xyz.).",
    },
    // non-map value
    { tag: "t3.2", model: null, rules: [], err: "" },
    { tag: "t3.3", model: m0, rules: [], err: "" },
    { tag: "t3.5", model: 123, rules: [], err: "only a map can be validated" },
    // invalid key spec
    { tag: "t4.1", model: m1, rules: [Key(123)], err: "123: key not the correct type." },
    { tag: "t4.2", model: m1, rules: [Key("X")], err: "X: required key is missing." },
    { tag: "t4.3", model: m1, rules: [Key("X").optional()], err: "" },
    // non-string keys
    {
      tag: "t5.1",
      model: m6,
      rules: [Key(11, new validateAbc()), Key(22, new validateXyz())],
      err: "",
    },
    {
      tag: "t5.2",
      model: m6,
      rules: [Key(11, new validateXyz()), Key(22, new validateAbc())],
      err: "11: error xyz; 22: error abc.",
    },
    // validatable value
    { tag: "t6.1", model: m2, rules: [Key("E")], err: "E: error 123." },
    { tag: "t6.2", model: m2, rules: [Key("E", Skip)], err: "" },
    { tag: "t6.3", model: m2, rules: [Key("E", Skip.when(true))], err: "" },
    { tag: "t6.4", model: m2, rules: [Key("E", Skip.when(false))], err: "E: error 123." },
    // Required
    { tag: "t7.1", model: m2, rules: [Key("F", Required)], err: "F: cannot be blank." },
    { tag: "t7.3", model: m2, rules: [Key("F", Skip, Required)], err: "" },
    { tag: "t7.5", model: m2, rules: [Key("F", Skip.when(true), Required)], err: "" },
    {
      tag: "t7.7",
      model: m2,
      rules: [Key("F", Skip.when(false), Required)],
      err: "F: cannot be blank.",
    },
    // validatable structs
    { tag: "t8.1", model: m3, rules: [Key("M3", Skip)], err: "" },
    { tag: "t8.2", model: m3, rules: [Key("M3")], err: "M3: (A: error abc.)." },
    { tag: "t8.3", model: m4, rules: [Key("M3")], err: "" },
    // internal error
    {
      tag: "t9.1",
      model: m5,
      rules: [
        Key("A", new validateAbc()),
        Key("B", Required),
        Key("A", new validateInternalError()),
      ],
      err: "error internal",
    },
  ];

  test.each(rows)("TestMap $tag", ({ model, rules, err }) => {
    assertError(err, Validate(model, Map(...rules).allowExtraKeys()), "Validate");
  });

  test("TestMap extra keys", () => {
    const a = { Name: "name", Value: "demo", Extra: true };
    const err = Validate(a, Map(Key("Name", Required), Key("Value", Required, Length(5, 10))));
    expect(err?.message).toBe(
      "Extra: key not expected; Value: the length must be between 5 and 10.",
    );
  });
});
