// Upstream: core/field_password_test.go

import { describe, expect, test } from "bun:test";

import {
  InterceptorActionAfterCreate,
  InterceptorActionAfterUpdate,
  InterceptorActionCreate,
  type Field,
} from "@/fields/field";
import { FieldTypePassword, PasswordField, PasswordFieldValue } from "@/fields/password";
import { Cost, DefaultCost, ErrPasswordTooLong, MaxCost, MinCost } from "@/tools/crypto/bcrypt";
import { marshal, textToBytes } from "@/tools/types/go-json";
import { NewError } from "@/validation/error";

import {
  TestRecord,
  expectValidationErrors,
  newBaseCollection,
  noDBApp,
} from "@test/support/fields";
import {
  testDefaultFieldHelpValidation,
  testDefaultFieldIdValidation,
  testDefaultFieldNameValidation,
  testFieldBaseMethods,
} from "@test/fields/shared";

const bytes = (s: string) => textToBytes(s);

describe("TestPasswordFieldBaseMethods", () => {
  testFieldBaseMethods(FieldTypePassword);
});

test("TestPasswordFieldColumnType", () => {
  expect(new PasswordField().columnType(noDBApp())).toBe("TEXT DEFAULT '' NOT NULL");
});

describe("TestPasswordFieldPrepareValue", () => {
  const f = new PasswordField();
  const record = new TestRecord(newBaseCollection("test"));

  const scenarios: { raw: unknown; expected: string }[] = [
    { raw: "", expected: "" },
    { raw: "test", expected: "test" },
    { raw: false, expected: "false" },
    { raw: true, expected: "true" },
    { raw: 123.456, expected: "123.456" },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${String(s.raw)}`, () => {
      const [v, err] = f.prepareValue(record, s.raw);
      expect(err).toBeNull();
      expect(v).toBeInstanceOf(PasswordFieldValue);
      expect((v as PasswordFieldValue).hash).toBe(s.expected);
    });
  }
});

describe("TestPasswordFieldDriverValue", () => {
  const f = new PasswordField({ name: "test" });

  const err = new Error("example_err");

  const scenarios: { raw: unknown; expected: PasswordFieldValue }[] = [
    { raw: 123, expected: new PasswordFieldValue() },
    { raw: "abc", expected: new PasswordFieldValue() },
    { raw: "$2abc", expected: new PasswordFieldValue({ hash: "$2abc" }) },
    {
      raw: new PasswordFieldValue({ hash: "test", lastError: err }),
      expected: new PasswordFieldValue({ hash: "test", lastError: err }),
    },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${String(s.raw)}`, () => {
      const record = new TestRecord(newBaseCollection("test"));
      record.setRaw(f.getName(), s.raw);

      const [v, vErr] = f.driverValue(record);

      expect(typeof v).toBe("string");
      expect(vErr?.message ?? "").toBe(s.expected.lastError?.message ?? "");
      expect(v).toBe(s.expected.hash);
    });
  }
});

describe("TestPasswordFieldValidateValue", () => {
  const app = noDBApp();
  const collection = newBaseCollection("test_collection");

  const withValue = (value: unknown) => () => {
    const record = new TestRecord(collection);
    record.setRaw("test", value);
    return record;
  };

  const scenarios: {
    name: string;
    field: PasswordField;
    record: () => TestRecord;
    expectError: boolean;
  }[] = [
    {
      name: "invalid raw value",
      field: new PasswordField({ name: "test" }),
      record: withValue("123"),
      expectError: true,
    },
    {
      name: "zero field value (not required)",
      field: new PasswordField({ name: "test" }),
      record: withValue(new PasswordFieldValue()),
      expectError: false,
    },
    {
      name: "zero field value (required)",
      field: new PasswordField({ name: "test", required: true }),
      record: withValue(new PasswordFieldValue()),
      expectError: true,
    },
    {
      name: "empty hash but non-empty plain password (required)",
      field: new PasswordField({ name: "test", required: true }),
      record: withValue(new PasswordFieldValue({ plain: "test" })),
      expectError: true,
    },
    {
      name: "non-empty hash (required)",
      field: new PasswordField({ name: "test", required: true }),
      record: withValue(new PasswordFieldValue({ hash: "test" })),
      expectError: false,
    },
    {
      name: "with LastError",
      field: new PasswordField({ name: "test" }),
      record: withValue(new PasswordFieldValue({ lastError: new Error("test") })),
      expectError: true,
    },
    {
      name: "< Min",
      field: new PasswordField({ name: "test", min: 3 }),
      record: withValue(new PasswordFieldValue({ plain: "аб" })), // multi-byte chars test
      expectError: true,
    },
    {
      name: ">= Min",
      field: new PasswordField({ name: "test", min: 3 }),
      record: withValue(new PasswordFieldValue({ plain: "абв" })), // multi-byte chars test
      expectError: false,
    },
    {
      name: "> default Max",
      field: new PasswordField({ name: "test" }),
      record: withValue(new PasswordFieldValue({ plain: "a".repeat(72) })),
      expectError: true,
    },
    {
      name: "<= default Max",
      field: new PasswordField({ name: "test" }),
      record: withValue(new PasswordFieldValue({ plain: "a".repeat(71) })),
      expectError: false,
    },
    {
      name: "> Max",
      field: new PasswordField({ name: "test", max: 2 }),
      record: withValue(new PasswordFieldValue({ plain: "абв" })), // multi-byte chars test
      expectError: true,
    },
    {
      name: "<= Max",
      field: new PasswordField({ name: "test", max: 2 }),
      record: withValue(new PasswordFieldValue({ plain: "аб" })), // multi-byte chars test
      expectError: false,
    },
    {
      name: "non-matching pattern",
      field: new PasswordField({ name: "test", pattern: String.raw`\d+` }),
      record: withValue(new PasswordFieldValue({ plain: "abc" })),
      expectError: true,
    },
    {
      name: "matching pattern",
      field: new PasswordField({ name: "test", pattern: String.raw`\d+` }),
      record: withValue(new PasswordFieldValue({ plain: "123" })),
      expectError: false,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const err = s.field.validateValue(app, s.record());
      expect({ hasErr: err !== null, err: String(err) }).toMatchObject({ hasErr: s.expectError });
    });
  }
});

// the exact errors of the cases above (codes, messages, params), from
// field_password.go
describe("PasswordField.validateValue errors", () => {
  const app = noDBApp();
  const collection = newBaseCollection("test_collection");

  const scenarios: { field: PasswordField; value: unknown; expected: Error }[] = [
    {
      field: new PasswordField({ name: "test" }),
      value: "123",
      expected: NewError("validation_unsupported_value_type", "Invalid or unsupported value type."),
    },
    {
      field: new PasswordField({ name: "test", required: true }),
      value: new PasswordFieldValue({ plain: "test" }),
      expected: NewError("validation_required", "Cannot be blank."),
    },
    {
      field: new PasswordField({ name: "test", min: 3 }),
      value: new PasswordFieldValue({ plain: "аб" }),
      expected: NewError("validation_min_text_constraint", "Must be at least 3 character(s)"),
    },
    {
      field: new PasswordField({ name: "test" }),
      value: new PasswordFieldValue({ plain: "a".repeat(72) }),
      expected: NewError("validation_max_text_constraint", "Must be less than 71 character(s)"),
    },
    {
      field: new PasswordField({ name: "test", max: 2 }),
      value: new PasswordFieldValue({ plain: "абв" }),
      expected: NewError("validation_max_text_constraint", "Must be less than 2 character(s)"),
    },
    {
      field: new PasswordField({ name: "test", pattern: String.raw`\d+` }),
      value: new PasswordFieldValue({ plain: "abc" }),
      expected: NewError("validation_invalid_format", "Invalid value format"),
    },
    {
      // an invalid pattern never matches (regexp.MatchString's error)
      field: new PasswordField({ name: "test", pattern: "(invalid" }),
      value: new PasswordFieldValue({ plain: "abc" }),
      expected: NewError("validation_invalid_format", "Invalid value format"),
    },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i} ${s.expected.message}`, () => {
      const record = new TestRecord(collection);
      record.setRaw("test", s.value);
      expect(marshal(s.field.validateValue(app, record))).toBe(marshal(s.expected));
    });
  }

  test("a set password over 72 bytes keeps bcrypt's error", () => {
    const field = new PasswordField({ name: "test", cost: MinCost });
    const record = new TestRecord(newBaseCollection("test_collection"));
    record.setRaw("test", new PasswordFieldValue());
    field.findSetter("test")?.(record, "ж".repeat(40)); // 40 runes, 80 bytes
    expect(field.validateValue(app, record)).toBe(ErrPasswordTooLong);
    expect(field.driverValue(record)).toEqual(["", ErrPasswordTooLong]);
  });
});

describe("TestPasswordFieldValidateSettings", () => {
  testDefaultFieldIdValidation(FieldTypePassword);
  testDefaultFieldNameValidation(FieldTypePassword);
  testDefaultFieldHelpValidation(FieldTypePassword);

  const app = noDBApp();

  const scenarios: { name: string; field: () => PasswordField; expectErrors: string[] }[] = [
    {
      name: "zero minimal",
      field: () => new PasswordField({ id: "test", name: "test" }),
      expectErrors: [],
    },
    {
      name: "invalid pattern",
      field: () => new PasswordField({ id: "test", name: "test", pattern: "(invalid" }),
      expectErrors: ["pattern"],
    },
    {
      name: "valid pattern",
      field: () => new PasswordField({ id: "test", name: "test", pattern: String.raw`\d+` }),
      expectErrors: [],
    },
    {
      name: "Min < 0",
      field: () => new PasswordField({ id: "test", name: "test", min: -1 }),
      expectErrors: ["min"],
    },
    {
      name: "Min > 71",
      field: () => new PasswordField({ id: "test", name: "test", min: 72 }),
      expectErrors: ["min"],
    },
    {
      name: "valid Min",
      field: () => new PasswordField({ id: "test", name: "test", min: 5 }),
      expectErrors: [],
    },
    {
      name: "Max < Min",
      field: () => new PasswordField({ id: "test", name: "test", min: 2, max: 1 }),
      expectErrors: ["max"],
    },
    {
      name: "Min > Min",
      field: () => new PasswordField({ id: "test", name: "test", min: 2, max: 3 }),
      expectErrors: [],
    },
    {
      name: "Max > 71",
      field: () => new PasswordField({ id: "test", name: "test", max: 72 }),
      expectErrors: ["max"],
    },
    {
      name: "cost < bcrypt.MinCost",
      field: () => new PasswordField({ id: "test", name: "test", cost: MinCost - 1 }),
      expectErrors: ["cost"],
    },
    {
      name: "cost > bcrypt.MaxCost",
      field: () => new PasswordField({ id: "test", name: "test", cost: MaxCost + 1 }),
      expectErrors: ["cost"],
    },
    {
      name: "valid cost",
      field: () => new PasswordField({ id: "test", name: "test", cost: 12 }),
      expectErrors: [],
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const collection = newBaseCollection("test_collection");
      (collection.fields.getByName("id") as Field).setId("test"); // set a dummy known id so that it can be replaced

      const field = s.field();

      collection.fields.add(field);

      expectValidationErrors(field.validateSettings(app, collection), s.expectErrors);
    });
  }
});

describe("TestPasswordFieldFindSetter", () => {
  const scenarios: {
    name: string;
    key: string;
    value: unknown;
    field: PasswordField;
    hasSetter: boolean;
    expected: string;
  }[] = [
    {
      name: "no match",
      key: "example",
      value: "abc",
      field: new PasswordField({ name: "test" }),
      hasSetter: false,
      expected: "",
    },
    {
      name: "exact match",
      key: "test",
      value: "abc",
      field: new PasswordField({ name: "test" }),
      hasSetter: true,
      expected: `"abc"`,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const collection = newBaseCollection("test_collection");
      collection.fields.add(s.field);

      const setter = s.field.findSetter(s.key);

      expect(setter !== null).toBe(s.hasSetter);
      if (setter === null) {
        return;
      }

      const record = new TestRecord(collection);
      record.setRaw(s.field.getName(), ["c", "d"]);

      setter(record, s.value);

      expect(marshal(record.get(s.field.getName()))).toBe(s.expected);
    });
  }
});

describe("TestPasswordFieldFindGetter", () => {
  const scenarios: {
    name: string;
    key: string;
    field: PasswordField;
    hasGetter: boolean;
    expected: string;
  }[] = [
    {
      name: "no match",
      key: "example",
      field: new PasswordField({ name: "test" }),
      hasGetter: false,
      expected: "",
    },
    {
      name: "field name match",
      key: "test",
      field: new PasswordField({ name: "test" }),
      hasGetter: true,
      expected: "test_plain",
    },
    {
      name: "field name hash modifier",
      key: "test:hash",
      field: new PasswordField({ name: "test" }),
      hasGetter: true,
      expected: "test_hash",
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const collection = newBaseCollection("test_collection");
      collection.fields.add(s.field);

      const getter = s.field.findGetter(s.key);

      expect(getter !== null).toBe(s.hasGetter);
      if (getter === null) {
        return;
      }

      const record = new TestRecord(collection);
      record.setRaw(
        s.field.getName(),
        new PasswordFieldValue({ hash: "test_hash", plain: "test_plain" }),
      );

      expect(getter(record)).toBe(s.expected);
    });
  }
});

// not in upstream's tests: the setter's hash, the interceptor and
// PasswordFieldValue.Validate

describe("PasswordField setter", () => {
  test("hashes in Go's $2a$ form with the field's cost", () => {
    for (const [fieldCost, expected] of [
      [0, DefaultCost],
      [MinCost, MinCost],
      [5, 5],
    ] as const) {
      const field = new PasswordField({ name: "test", cost: fieldCost });
      const collection = newBaseCollection("test_collection");
      collection.fields.add(field);
      const record = new TestRecord(collection);
      record.set("test", "secret");
      const hash = record.getString("test:hash");
      expect(hash).toMatch(/^\$2a\$\d\d\$[./A-Za-z0-9]{53}$/);
      expect(Cost(bytes(hash))).toBe(expected);
      expect(record.getString("test")).toBe("secret");
      expect((record.getRaw("test") as PasswordFieldValue).validate("secret")).toBe(true);
    }
  });

  test("an empty value is not hashed", () => {
    const field = new PasswordField({ name: "test" });
    const record = new TestRecord(newBaseCollection("test_collection"));
    field.findSetter("test")?.(record, "");
    expect(record.getRaw("test")).toEqual(new PasswordFieldValue());
  });

  test("an out of range cost keeps bcrypt's error", () => {
    const field = new PasswordField({ name: "test", cost: MaxCost + 1 });
    const record = new TestRecord(newBaseCollection("test_collection"));
    field.findSetter("test")?.(record, "secret");
    const fv = record.getRaw("test") as PasswordFieldValue;
    expect(fv.hash).toBe("");
    expect(fv.lastError?.message).toBe(
      "crypto/bcrypt: cost 32 is outside allowed inclusive range 4..31",
    );
  });
});

describe("PasswordField.intercept", () => {
  for (const action of [InterceptorActionAfterCreate, InterceptorActionAfterUpdate]) {
    test(`${action} unsets the plain value`, async () => {
      const field = new PasswordField({ name: "test" });
      const record = new TestRecord(newBaseCollection("test_collection"));
      const fv = new PasswordFieldValue({ hash: "h", plain: "p" });
      record.setRaw("test", fv);
      let called = 0;
      await field.intercept(noDBApp(), record, action, async () => {
        called++;
      });
      expect(called).toBe(1);
      expect(fv).toEqual(new PasswordFieldValue({ hash: "h" }));
    });
  }

  test("other actions keep it and the action's error", async () => {
    const field = new PasswordField({ name: "test" });
    const record = new TestRecord(newBaseCollection("test_collection"));
    const fv = new PasswordFieldValue({ hash: "h", plain: "p" });
    record.setRaw("test", fv);
    const err = new Error("action");
    expect(
      field.intercept(noDBApp(), record, InterceptorActionCreate, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(fv.plain).toBe("p");
  });
});

describe("PasswordFieldValue.validate", () => {
  const hash = "$2a$10$XajjQvNhvvRt5GSeFk1xFeyqRrsxkhBkUiQeg0dt.wU1qD4aFDcga"; // "allmine"

  test("matching and not", () => {
    expect(new PasswordFieldValue({ hash }).validate("allmine")).toBe(true);
    expect(new PasswordFieldValue({ hash }).validate("allmine2")).toBe(false);
    expect(new PasswordFieldValue({ hash }).validate("")).toBe(false);
  });

  test("no hash or a LastError", () => {
    expect(new PasswordFieldValue().validate("")).toBe(false);
    expect(new PasswordFieldValue({ hash, lastError: new Error("x") }).validate("allmine")).toBe(
      false,
    );
  });
});
