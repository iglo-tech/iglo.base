// Upstream: ozzo-validation v4.4.1 struct_test.go
//
// Dropped: TestFindStructField and Test_getErrorFieldName
// (reflection, struct tags), the ErrStructPointer rows (a struct is passed as
// its fields here, there is no struct pointer), the ErrFieldPointer and
// ErrFieldNotFound rows, the NotNil rows (NotNil is not ported), the struct
// tag row t5.1, and TestValidateStructWithContext (context variants).

import { describe, expect, test } from "bun:test";

import { Embedded, Field, ValidateStruct, type FieldRules } from "@/validation/struct";
import { Length } from "@/validation/length";
import { Required } from "@/validation/required";
import { Each } from "@/validation/each";
import { NewInternalError } from "@/validation/error";
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

// Model1 is a struct without a Validate method: a plain object
interface Model1 {
  A: string;
  B: string;
  c: string;
  D: string | null;
  E: String123 | null;
  F: String123 | null;
  G: string;
  H: string[];
  I: Record<string, string>;
}

function newModel1(init: Partial<Model1> = {}): Model1 {
  return {
    A: "",
    B: "",
    c: "",
    D: null,
    E: null,
    F: null,
    G: "",
    H: [],
    I: {},
    ...init,
  };
}

// Model3 has a Validate method
class Model3 implements Validatable {
  constructor(readonly A = "") {}

  validate(): globalThis.Error | null {
    return ValidateStruct(Field("A", this.A, new validateAbc()));
  }
}

// Model2 embeds Model3 (its Validate is promoted), and has M3 and B
class Model2 implements Validatable {
  readonly Model3: Model3;
  readonly M3: Model3;
  readonly B: string;

  constructor(embedded = new Model3(), m3 = new Model3(), b = "") {
    this.Model3 = embedded;
    this.M3 = m3;
    this.B = b;
  }

  validate(): globalThis.Error | null {
    return this.Model3.validate();
  }
}

function assertError(expected: string, err: globalThis.Error | null, tag: string): void {
  if (expected === "") {
    expect(err, tag).toBeNull();
  } else {
    expect(err?.message, tag).toBe(expected);
  }
}

describe("struct", () => {
  const m1 = newModel1({
    A: "abc",
    B: "xyz",
    c: "abc",
    G: "xyz",
    H: ["abc", "abc"],
    I: { foo: "abc" },
  });
  const m2 = newModel1({ E: new String123("xyz") });
  const m3 = new Model2();
  const m4 = new Model2(new Model3("abc"), new Model3("abc"), "");
  const m5 = new Model2(new Model3("internal"));

  const rowsValidate: { tag: string; model: unknown; rules: FieldRules[]; err: string }[] = [
    // empty rules
    { tag: "t1.1", model: m1, rules: [], err: "" },
    { tag: "t1.2", model: m1, rules: [Field("A", m1.A), Field("B", m1.B)], err: "" },
    // normal rules
    {
      tag: "t2.1",
      model: m1,
      rules: [Field("A", m1.A, new validateAbc()), Field("B", m1.B, new validateXyz())],
      err: "",
    },
    {
      tag: "t2.2",
      model: m1,
      rules: [Field("A", m1.A, new validateXyz()), Field("B", m1.B, new validateAbc())],
      err: "A: error xyz; B: error abc.",
    },
    {
      tag: "t2.3",
      model: m1,
      rules: [Field("A", m1.A, new validateXyz()), Field("c", m1.c, new validateXyz())],
      err: "A: error xyz; c: error xyz.",
    },
    { tag: "t2.4", model: m1, rules: [Field("D", m1.D, Length(0, 5))], err: "" },
    { tag: "t2.5", model: m1, rules: [Field("F", m1.F, Length(0, 5))], err: "" },
    {
      tag: "t2.6",
      model: m1,
      rules: [Field("H", m1.H, Each(new validateAbc())), Field("I", m1.I, Each(new validateAbc()))],
      err: "",
    },
    {
      tag: "t2.7",
      model: m1,
      rules: [Field("H", m1.H, Each(new validateXyz())), Field("I", m1.I, Each(new validateXyz()))],
      err: "H: (0: error xyz; 1: error xyz.); I: (foo: error xyz.).",
    },
    // validatable field
    { tag: "t6.1", model: m2, rules: [Field("E", m2.E)], err: "E: error 123." },
    { tag: "t6.2", model: m2, rules: [Field("E", m2.E, Skip)], err: "" },
    { tag: "t6.3", model: m2, rules: [Field("E", m2.E, Skip.when(true))], err: "" },
    { tag: "t6.4", model: m2, rules: [Field("E", m2.E, Skip.when(false))], err: "E: error 123." },
    // Required
    { tag: "t7.1", model: m2, rules: [Field("F", m2.F, Required)], err: "F: cannot be blank." },
    { tag: "t7.3", model: m2, rules: [Field("F", m2.F, Skip, Required)], err: "" },
    { tag: "t7.5", model: m2, rules: [Field("F", m2.F, Skip.when(true), Required)], err: "" },
    {
      tag: "t7.7",
      model: m2,
      rules: [Field("F", m2.F, Skip.when(false), Required)],
      err: "F: cannot be blank.",
    },
    // embedded structs
    { tag: "t8.1", model: m3, rules: [Field("M3", m3.M3, Skip)], err: "" },
    { tag: "t8.2", model: m3, rules: [Field("M3", m3.M3)], err: "M3: (A: error abc.)." },
    { tag: "t8.3", model: m3, rules: [Embedded("Model3", m3.Model3, Skip)], err: "" },
    { tag: "t8.4", model: m3, rules: [Embedded("Model3", m3.Model3)], err: "A: error abc." },
    { tag: "t8.5", model: m4, rules: [Field("M3", m4.M3)], err: "" },
    { tag: "t8.6", model: m4, rules: [Embedded("Model3", m4.Model3)], err: "" },
    {
      tag: "t8.7",
      model: m3,
      rules: [Field("A", m3.Model3.A, Required), Field("B", m3.B, Required)],
      err: "A: cannot be blank; B: cannot be blank.",
    },
    // internal error
    {
      tag: "t9.1",
      model: m5,
      rules: [
        Field("A", m5.Model3.A, new validateAbc()),
        Field("B", m5.B, Required),
        Field("A", m5.Model3.A, new validateInternalError()),
      ],
      err: "error internal",
    },
  ];

  test.each(rowsValidate)("TestValidateStruct $tag", ({ rules, err }) => {
    assertError(err, ValidateStruct(...rules), "ValidateStruct");
  });

  test("TestValidateStruct embedded struct", () => {
    // Model2 promotes Model3's Validate
    const err = Validate(m3);
    expect(err?.message).toBe("A: error abc.");

    const a = { Name: "name", Value: "demo" };
    const err2 = ValidateStruct(
      Field("Name", a.Name, Required),
      Field("Value", a.Value, Required, Length(5, 10)),
    );
    expect(err2?.message).toBe("Value: the length must be between 5 and 10.");
  });
});
