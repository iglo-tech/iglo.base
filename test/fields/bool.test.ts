// Upstream: core/field_bool_test.go

import { describe, expect, test } from "bun:test";

import { BoolField, FieldTypeBool } from "@/fields/bool";

import { TestRecord, newBaseCollection, noDBApp } from "@test/support/fields";
import {
  testDefaultFieldHelpValidation,
  testDefaultFieldIdValidation,
  testDefaultFieldNameValidation,
  testFieldBaseMethods,
} from "@test/fields/shared";

describe("TestBoolFieldBaseMethods", () => {
  testFieldBaseMethods(FieldTypeBool);
});

test("TestBoolFieldColumnType", () => {
  const f = new BoolField();
  expect(f.columnType(noDBApp())).toBe("BOOLEAN DEFAULT FALSE NOT NULL");
});

describe("TestBoolFieldPrepareValue", () => {
  const f = new BoolField();
  const record = new TestRecord(newBaseCollection("test"));

  const scenarios: [unknown, boolean][] = [
    ["", false],
    ["f", false],
    ["t", true],
    [1, true],
    [0, false],
  ];

  for (const [i, [raw, expected]] of scenarios.entries()) {
    test(`${i}_${String(raw)}`, () => {
      const [v, err] = f.prepareValue(record, raw);
      expect(err).toBeNull();
      expect(v).toBe(expected);
    });
  }
});

describe("TestBoolFieldValidateValue", () => {
  const collection = newBaseCollection("test_collection");

  const withValue = (key: string, value: unknown) => () => {
    const record = new TestRecord(collection);
    record.setRaw(key, value);
    return record;
  };

  const scenarios: {
    name: string;
    field: BoolField;
    record: () => TestRecord;
    expectError: boolean;
  }[] = [
    {
      name: "invalid raw value",
      field: new BoolField({ name: "test" }),
      record: withValue("test", 123),
      expectError: true,
    },
    {
      name: "missing field value (non-required)",
      field: new BoolField({ name: "test" }),
      record: withValue("abc", true),
      expectError: true, // because of failed nil.(bool) cast
    },
    {
      name: "missing field value (required)",
      field: new BoolField({ name: "test", required: true }),
      record: withValue("abc", true),
      expectError: true,
    },
    {
      name: "false field value (non-required)",
      field: new BoolField({ name: "test" }),
      record: withValue("test", false),
      expectError: false,
    },
    {
      name: "false field value (required)",
      field: new BoolField({ name: "test", required: true }),
      record: withValue("test", false),
      expectError: true,
    },
    {
      name: "true field value (required)",
      field: new BoolField({ name: "test", required: true }),
      record: withValue("test", true),
      expectError: false,
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

describe("TestBoolFieldValidateSettings", () => {
  testDefaultFieldIdValidation(FieldTypeBool);
  testDefaultFieldNameValidation(FieldTypeBool);
  testDefaultFieldHelpValidation(FieldTypeBool);
});
