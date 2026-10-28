// Upstream: core/field_number_test.go

import { describe, expect, test } from "bun:test";

import { FieldTypeNumber, NumberField } from "@/fields/number";

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

describe("TestNumberFieldBaseMethods", () => {
  testFieldBaseMethods(FieldTypeNumber);
});

test("TestNumberFieldColumnType", () => {
  const f = new NumberField();
  expect(f.columnType(noDBApp())).toBe("NUMERIC DEFAULT 0 NOT NULL");
});

describe("TestNumberFieldPrepareValue", () => {
  const f = new NumberField();
  const record = new TestRecord(newBaseCollection("test"));

  const scenarios: [unknown, number][] = [
    ["", 0],
    ["test", 0],
    [false, 0],
    [true, 1],
    [-2, -2],
    [123.456, 123.456],
  ];

  for (const [i, [raw, expected]] of scenarios.entries()) {
    test(`${i}_${String(raw)}`, () => {
      const [v, err] = f.prepareValue(record, raw);
      expect(err).toBeNull();
      expect(typeof v).toBe("number");
      expect(v).toBe(expected);
    });
  }
});

describe("TestNumberFieldValidateValue", () => {
  const collection = newBaseCollection("test_collection");

  const withValue = (value: unknown) => () => {
    const record = new TestRecord(collection);
    record.setRaw("test", value);
    return record;
  };

  const scenarios: {
    name: string;
    field: NumberField;
    record: () => TestRecord;
    expectError: boolean;
  }[] = [
    {
      name: "invalid raw value",
      field: new NumberField({ name: "test" }),
      record: withValue("123"),
      expectError: true,
    },
    {
      name: "zero field value (not required)",
      field: new NumberField({ name: "test" }),
      record: withValue(0.0),
      expectError: false,
    },
    {
      name: "zero field value (required)",
      field: new NumberField({ name: "test", required: true }),
      record: withValue(0.0),
      expectError: true,
    },
    {
      name: "non-zero field value (required)",
      field: new NumberField({ name: "test", required: true }),
      record: withValue(123.0),
      expectError: false,
    },
    {
      name: "decimal with onlyInt",
      field: new NumberField({ name: "test", onlyInt: true }),
      record: withValue(123.456),
      expectError: true,
    },
    {
      name: "int with onlyInt",
      field: new NumberField({ name: "test", onlyInt: true }),
      record: withValue(123.0),
      expectError: false,
    },
    {
      name: "< min",
      field: new NumberField({ name: "test", min: 2.0 }),
      record: withValue(1.0),
      expectError: true,
    },
    {
      name: ">= min",
      field: new NumberField({ name: "test", min: 2.0 }),
      record: withValue(2.0),
      expectError: false,
    },
    {
      name: "> max",
      field: new NumberField({ name: "test", max: 2.0 }),
      record: withValue(3.0),
      expectError: true,
    },
    {
      name: "<= max",
      field: new NumberField({ name: "test", max: 2.0 }),
      record: withValue(2.0),
      expectError: false,
    },
    {
      name: "infinity",
      field: new NumberField({ name: "test" }),
      record: () => {
        const record = new TestRecord(collection);
        record.set("test", "Inf");
        return record;
      },
      expectError: true,
    },
    {
      name: "NaN",
      field: new NumberField({ name: "test" }),
      record: () => {
        const record = new TestRecord(collection);
        record.set("test", "NaN");
        return record;
      },
      expectError: true,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const err = s.field.validateValue(noDBApp(), s.record());

      const hasErr = err !== null;
      expect(hasErr).toBe(s.expectError);
    });
  }
});

describe("TestNumberFieldValidateSettings", () => {
  testDefaultFieldIdValidation(FieldTypeNumber);
  testDefaultFieldNameValidation(FieldTypeNumber);
  testDefaultFieldHelpValidation(FieldTypeNumber);

  const app = noDBApp();
  const collection = newBaseCollection("test_collection");

  const scenarios: { name: string; field: () => NumberField; expectErrors: string[] }[] = [
    {
      name: "zero",
      field: () => new NumberField({ id: "test", name: "test" }),
      expectErrors: [],
    },
    {
      name: "decimal min",
      field: () => new NumberField({ id: "test", name: "test", min: 1.2 }),
      expectErrors: [],
    },
    {
      name: "decimal min (onlyInt)",
      field: () => new NumberField({ id: "test", name: "test", onlyInt: true, min: 1.2 }),
      expectErrors: ["min"],
    },
    {
      name: "int min (onlyInt)",
      field: () => new NumberField({ id: "test", name: "test", onlyInt: true, min: 1.0 }),
      expectErrors: [],
    },
    {
      name: "decimal max",
      field: () => new NumberField({ id: "test", name: "test", max: 1.2 }),
      expectErrors: [],
    },
    {
      name: "decimal max (onlyInt)",
      field: () => new NumberField({ id: "test", name: "test", onlyInt: true, max: 1.2 }),
      expectErrors: ["max"],
    },
    {
      name: "int max (onlyInt)",
      field: () => new NumberField({ id: "test", name: "test", onlyInt: true, max: 1.0 }),
      expectErrors: [],
    },
    {
      name: "min > max (0)",
      field: () => new NumberField({ id: "test", name: "test", min: 2.0, max: 0.0 }),
      expectErrors: ["max"],
    },
    {
      name: "min (0) > max",
      field: () => new NumberField({ id: "test", name: "test", min: 0.0, max: -1.0 }),
      expectErrors: ["max"],
    },
    {
      name: "min == max",
      field: () => new NumberField({ id: "test", name: "test", min: 2.0, max: 2.0 }),
      expectErrors: [],
    },
    {
      name: "min < max",
      field: () => new NumberField({ id: "test", name: "test", min: 2.0, max: 3.0 }),
      expectErrors: [],
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const errs = s.field().validateSettings(app, collection);

      expectValidationErrors(errs, s.expectErrors);
    });
  }
});

describe("TestNumberFieldFindSetter", () => {
  const field = new NumberField({ name: "test" });

  const collection = newBaseCollection("test_collection");
  collection.fields.add(field);

  test("no match", () => {
    const f = field.findSetter("abc");
    expect(f).toBeNull();
  });

  test("direct name match", () => {
    const f = field.findSetter("test");
    expect(f).not.toBeNull();
    if (f === null) {
      return;
    }

    const record = new TestRecord(collection);
    record.setRaw("test", 2.0);

    f(record, "123.456"); // should be casted

    expect(record.get("test")).toBe(123.456);
  });

  test("name+ match", () => {
    const f = field.findSetter("test+");
    expect(f).not.toBeNull();
    if (f === null) {
      return;
    }

    const record = new TestRecord(collection);
    record.setRaw("test", 2.0);

    f(record, "1.5"); // should be casted and appended to the existing value

    expect(record.get("test")).toBe(3.5);
  });

  test("name- match", () => {
    const f = field.findSetter("test-");
    expect(f).not.toBeNull();
    if (f === null) {
      return;
    }

    const record = new TestRecord(collection);
    record.setRaw("test", 2.0);

    f(record, "1.5"); // should be casted and subtracted from the existing value

    expect(record.get("test")).toBe(0.5);
  });
});
