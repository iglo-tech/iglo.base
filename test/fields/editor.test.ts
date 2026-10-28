// Upstream: core/field_editor_test.go

import { describe, expect, test } from "bun:test";

import { DefaultEditorFieldMaxSize, EditorField, FieldTypeEditor } from "@/fields/editor";

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

describe("TestEditorFieldBaseMethods", () => {
  testFieldBaseMethods(FieldTypeEditor);
});

test("TestEditorFieldColumnType", () => {
  const f = new EditorField();
  expect(f.columnType(noDBApp())).toBe("TEXT DEFAULT '' NOT NULL");
});

describe("TestEditorFieldPrepareValue", () => {
  const f = new EditorField();
  const record = new TestRecord(newBaseCollection("test"));

  const scenarios: [unknown, string][] = [
    ["", ""],
    ["test", "test"],
    [false, "false"],
    [true, "true"],
    [123.456, "123.456"],
  ];

  for (const [i, [raw, expected]] of scenarios.entries()) {
    test(`${i}_${String(raw)}`, () => {
      const [v, err] = f.prepareValue(record, raw);
      expect(err).toBeNull();
      expect(typeof v).toBe("string");
      expect(v).toBe(expected);
    });
  }
});

describe("TestEditorFieldValidateValue", () => {
  const collection = newBaseCollection("test_collection");

  const withValue = (value: unknown) => () => {
    const record = new TestRecord(collection);
    record.setRaw("test", value);
    return record;
  };

  const scenarios: {
    name: string;
    field: EditorField;
    record: () => TestRecord;
    expectError: boolean;
  }[] = [
    {
      name: "invalid raw value",
      field: new EditorField({ name: "test" }),
      record: withValue(123),
      expectError: true,
    },
    {
      name: "zero field value (not required)",
      field: new EditorField({ name: "test" }),
      record: withValue(""),
      expectError: false,
    },
    {
      name: "zero field value (required)",
      field: new EditorField({ name: "test", required: true }),
      record: withValue(""),
      expectError: true,
    },
    {
      name: "non-zero field value (required)",
      field: new EditorField({ name: "test", required: true }),
      record: withValue("abc"),
      expectError: false,
    },
    {
      name: "> default MaxSize",
      field: new EditorField({ name: "test", required: true }),
      record: withValue("a".repeat(1 + (5 << 20))),
      expectError: true,
    },
    {
      name: "> MaxSize",
      field: new EditorField({ name: "test", required: true, maxSize: 5 }),
      record: withValue("abcdef"),
      expectError: true,
    },
    {
      name: "<= MaxSize",
      field: new EditorField({ name: "test", required: true, maxSize: 5 }),
      record: withValue("abcde"),
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

describe("TestEditorFieldValidateSettings", () => {
  testDefaultFieldIdValidation(FieldTypeEditor);
  testDefaultFieldNameValidation(FieldTypeEditor);
  testDefaultFieldHelpValidation(FieldTypeEditor);

  const app = noDBApp();
  const collection = newBaseCollection("test_collection");

  const scenarios: { name: string; field: () => EditorField; expectErrors: string[] }[] = [
    {
      name: "< 0 MaxSize",
      field: () => new EditorField({ id: "test", name: "test", maxSize: -1 }),
      expectErrors: ["maxSize"],
    },
    {
      name: "= 0 MaxSize",
      field: () => new EditorField({ id: "test", name: "test" }),
      expectErrors: [],
    },
    {
      name: "> 0 MaxSize",
      field: () => new EditorField({ id: "test", name: "test", maxSize: 1 }),
      expectErrors: [],
    },
    {
      name: "MaxSize > safe json int",
      field: () => new EditorField({ id: "test", name: "test", maxSize: 2 ** 53 }),
      expectErrors: ["maxSize"],
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const errs = s.field().validateSettings(app, collection);

      expectValidationErrors(errs, s.expectErrors);
    });
  }
});

describe("TestEditorFieldCalculateMaxBodySize", () => {
  const scenarios: { field: EditorField; expected: number }[] = [
    { field: new EditorField(), expected: DefaultEditorFieldMaxSize },
    { field: new EditorField({ maxSize: 10 }), expected: 10 },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${s.field.maxSize}`, () => {
      const result = s.field.calculateMaxBodySize();

      expect(result).toBe(s.expected);
    });
  }
});
