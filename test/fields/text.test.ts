// Upstream: core/field_text_test.go

import { afterAll, describe, expect, test } from "bun:test";

import {
  InterceptorActionCreate,
  InterceptorActionUpdate,
  InterceptorActionValidate,
} from "@/fields/field";
import { FieldTypeText, TextField } from "@/fields/text";

import {
  TestApp,
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

describe("TestTextFieldBaseMethods", () => {
  testFieldBaseMethods(FieldTypeText);
});

test("TestTextFieldColumnType", () => {
  const f = new TextField();
  expect(f.columnType(noDBApp())).toBe("TEXT DEFAULT '' NOT NULL");

  // primary key (not in upstream's table; upstream's collection tests cover it)
  const pk = new TextField({ primaryKey: true });
  expect(pk.columnType(noDBApp())).toBe(
    "TEXT PRIMARY KEY DEFAULT ('r'||lower(hex(randomblob(7)))) NOT NULL",
  );
});

describe("TestTextFieldPrepareValue", () => {
  const f = new TextField();
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

describe("TestTextFieldValidateValue", () => {
  const app = TestApp.open();
  afterAll(() => app.cleanup());

  const collection = app.findCollectionByNameOrId("demo1");
  const existingRecordId = app.firstRecordId(collection);

  const withValue = (value: unknown) => () => {
    const record = new TestRecord(collection);
    record.setRaw("test", value);
    return record;
  };

  const scenarios: {
    name: string;
    field: TextField;
    record: () => TestRecord;
    expectError: boolean;
  }[] = [
    {
      name: "invalid raw value",
      field: new TextField({ name: "test" }),
      record: withValue(123),
      expectError: true,
    },
    {
      name: "zero field value (not required)",
      // other fields validators should be ignored
      field: new TextField({ name: "test", pattern: String.raw`\d+`, min: 10, max: 100 }),
      record: withValue(""),
      expectError: false,
    },
    {
      name: "zero field value (required)",
      field: new TextField({ name: "test", required: true }),
      record: withValue(""),
      expectError: true,
    },
    {
      name: "non-zero field value (required)",
      field: new TextField({ name: "test", required: true }),
      record: withValue("abc"),
      expectError: false,
    },
    {
      name: "special forbidden character / (non-primaryKey)",
      field: new TextField({ name: "test", primaryKey: false }),
      record: withValue("abc/"),
      expectError: false,
    },
    {
      name: "special forbidden character \\ (non-primaryKey)",
      field: new TextField({ name: "test", primaryKey: false }),
      record: withValue("abc\\"),
      expectError: false,
    },
    {
      name: "special forbidden character . (non-primaryKey)",
      field: new TextField({ name: "test", primaryKey: false }),
      record: withValue("abc."),
      expectError: false,
    },
    {
      name: "special forbidden character ' ' (non-primaryKey)",
      field: new TextField({ name: "test", primaryKey: false }),
      record: withValue("ab c"),
      expectError: false,
    },
    {
      name: "special forbidden character * (non-primaryKey)",
      field: new TextField({ name: "test", primaryKey: false }),
      record: withValue("abc*"),
      expectError: false,
    },
    {
      name: "special forbidden character / (primaryKey)",
      field: new TextField({ name: "test", primaryKey: true }),
      record: withValue("abc/"),
      expectError: true,
    },
    {
      name: "special forbidden character \\ (primaryKey)",
      field: new TextField({ name: "test", primaryKey: true }),
      record: withValue("abc\\"),
      expectError: true,
    },
    {
      name: "special forbidden character . (primaryKey)",
      field: new TextField({ name: "test", primaryKey: true }),
      record: withValue("abc."),
      expectError: true,
    },
    {
      name: "special forbidden character ' ' (primaryKey)",
      field: new TextField({ name: "test", primaryKey: true }),
      record: withValue("ab c"),
      expectError: true,
    },
    {
      name: "special forbidden character * (primaryKey; used in the realtime events too)",
      field: new TextField({ name: "test", primaryKey: true }),
      record: withValue("abc*"),
      expectError: true,
    },
    {
      name: "reserved pk literal (non-primaryKey)",
      field: new TextField({ name: "test", primaryKey: false }),
      record: withValue("aUx"),
      expectError: false,
    },
    {
      name: "reserved pk literal (primaryKey)",
      field: new TextField({ name: "test", primaryKey: true }),
      record: withValue("aUx"),
      expectError: true,
    },
    {
      name: "reserved pk literal (non-exact match, primaryKey)",
      field: new TextField({ name: "test", primaryKey: true }),
      record: withValue("aUx-"),
      expectError: false,
    },
    {
      name: "zero field value (primaryKey)",
      field: new TextField({ name: "test", primaryKey: true }),
      record: withValue(""),
      expectError: true,
    },
    {
      name: "non-zero field value (primaryKey)",
      field: new TextField({ name: "test", primaryKey: true }),
      record: withValue("abcd"),
      expectError: false,
    },
    {
      name: "case-insensitive duplicated primary key check",
      field: new TextField({ name: "test", primaryKey: true }),
      record: withValue(existingRecordId.toUpperCase()),
      expectError: true,
    },
    {
      name: "< min",
      field: new TextField({ name: "test", min: 4 }),
      record: withValue("абв"), // multi-byte
      expectError: true,
    },
    {
      name: ">= min",
      field: new TextField({ name: "test", min: 3 }),
      record: withValue("абв"), // multi-byte
      expectError: false,
    },
    {
      name: "> default max",
      field: new TextField({ name: "test" }),
      record: withValue("a".repeat(5001)),
      expectError: true,
    },
    {
      name: "<= default max",
      field: new TextField({ name: "test" }),
      record: withValue("a".repeat(500)),
      expectError: false,
    },
    {
      name: "> max",
      field: new TextField({ name: "test", max: 2 }),
      record: withValue("абв"), // multi-byte
      expectError: true,
    },
    {
      name: "<= max",
      field: new TextField({ name: "test", min: 3 }),
      record: withValue("абв"), // multi-byte
      expectError: false,
    },
    {
      name: "mismatched pattern",
      field: new TextField({ name: "test", pattern: String.raw`\d+` }),
      record: withValue("abc"),
      expectError: true,
    },
    {
      name: "matched pattern",
      field: new TextField({ name: "test", pattern: String.raw`\d+` }),
      record: withValue("123"),
      expectError: false,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const err = s.field.validateValue(app, s.record());
      expect(err !== null).toBe(s.expectError);
    });
  }
});

describe("TestTextFieldValidateSettings", () => {
  testDefaultFieldIdValidation(FieldTypeText);
  testDefaultFieldNameValidation(FieldTypeText);
  testDefaultFieldHelpValidation(FieldTypeText);

  const app = noDBApp();

  const scenarios: { name: string; field: () => TextField; expectErrors: string[] }[] = [
    {
      name: "zero minimal",
      field: () => new TextField({ id: "test", name: "test" }),
      expectErrors: [],
    },
    {
      name: "primaryKey without required",
      field: () =>
        new TextField({ id: "test", name: "id", primaryKey: true, pattern: String.raw`\d+` }),
      expectErrors: ["required"],
    },
    {
      name: "primaryKey without pattern",
      field: () => new TextField({ id: "test", name: "id", primaryKey: true, required: true }),
      expectErrors: ["pattern"],
    },
    {
      name: "primaryKey with hidden",
      field: () =>
        new TextField({
          id: "test",
          name: "id",
          required: true,
          primaryKey: true,
          hidden: true,
          pattern: String.raw`\d+`,
        }),
      expectErrors: ["hidden"],
    },
    {
      name: "primaryKey with name != id",
      field: () =>
        new TextField({
          id: "test",
          name: "test",
          primaryKey: true,
          required: true,
          pattern: String.raw`\d+`,
        }),
      expectErrors: ["name"],
    },
    {
      name: "multiple primaryKey fields",
      field: () =>
        new TextField({
          id: "test2",
          name: "id",
          primaryKey: true,
          pattern: String.raw`\d+`,
          required: true,
        }),
      expectErrors: ["primaryKey"],
    },
    {
      name: "invalid pattern",
      field: () => new TextField({ id: "test2", name: "id", pattern: "(invalid" }),
      expectErrors: ["pattern"],
    },
    {
      name: "valid pattern",
      field: () => new TextField({ id: "test2", name: "id", pattern: String.raw`\d+` }),
      expectErrors: [],
    },
    {
      name: "invalid autogeneratePattern",
      field: () => new TextField({ id: "test2", name: "id", autogeneratePattern: "(invalid" }),
      expectErrors: ["autogeneratePattern"],
    },
    {
      name: "valid autogeneratePattern",
      field: () => new TextField({ id: "test2", name: "id", autogeneratePattern: "[a-z]+" }),
      expectErrors: [],
    },
    {
      name: "conflicting pattern and autogeneratePattern",
      field: () =>
        new TextField({
          id: "test2",
          name: "id",
          pattern: String.raw`\d+`,
          autogeneratePattern: "[a-z]+",
        }),
      expectErrors: ["autogeneratePattern"],
    },
    {
      name: "Max > safe json int",
      field: () => new TextField({ id: "test", name: "test", max: 2 ** 53 }),
      expectErrors: ["max"],
    },
    {
      name: "Max < 0",
      field: () => new TextField({ id: "test", name: "test", max: -1 }),
      expectErrors: ["max"],
    },
    {
      name: "Min > safe json int",
      field: () => new TextField({ id: "test", name: "test", min: 2 ** 53 }),
      expectErrors: ["min"],
    },
    {
      name: "Min < 0",
      field: () => new TextField({ id: "test", name: "test", min: -1 }),
      expectErrors: ["min"],
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const field = s.field();

      const collection = newBaseCollection("test_collection");
      collection.fields.getByName("id")?.setId("test"); // set a dummy known id so that it can be replaced
      collection.fields.add(field);

      const errs = field.validateSettings(app, collection);

      expectValidationErrors(errs, s.expectErrors);
    });
  }
});

describe("TestTextFieldAutogenerate", () => {
  const app = noDBApp();
  const collection = newBaseCollection("test_collection");

  const scenarios: {
    name: string;
    actionName: string;
    field: TextField;
    record: () => TestRecord;
    expected: string;
  }[] = [
    {
      name: "non-matching action",
      actionName: InterceptorActionUpdate,
      field: new TextField({ name: "test", autogeneratePattern: "abc" }),
      record: () => new TestRecord(collection),
      expected: "",
    },
    {
      name: "matching action (create)",
      actionName: InterceptorActionCreate,
      field: new TextField({ name: "test", autogeneratePattern: "abc" }),
      record: () => new TestRecord(collection),
      expected: "abc",
    },
    {
      name: "matching action (validate)",
      actionName: InterceptorActionValidate,
      field: new TextField({ name: "test", autogeneratePattern: "abc" }),
      record: () => new TestRecord(collection),
      expected: "abc",
    },
    {
      name: "existing non-zero value",
      actionName: InterceptorActionCreate,
      field: new TextField({ name: "test", autogeneratePattern: "abc" }),
      record: () => {
        const record = new TestRecord(collection);
        record.setRaw("test", "123");
        return record;
      },
      expected: "123",
    },
    {
      name: "non-new record",
      actionName: InterceptorActionValidate,
      field: new TextField({ name: "test", autogeneratePattern: "abc" }),
      record: () => {
        const record = new TestRecord(collection);
        record.id = "test";
        record.postScan();
        return record;
      },
      expected: "",
    },
  ];

  for (const s of scenarios) {
    test(s.name, async () => {
      let actionCalls = 0;
      const record = s.record();

      await s.field.intercept(app, record, s.actionName, async () => {
        actionCalls++;
      });

      expect(actionCalls).toBe(1);
      expect(record.getString(s.field.getName())).toBe(s.expected);
    });
  }
});

describe("TestTextFieldFindSetter", () => {
  const scenarios: {
    name: string;
    key: string;
    value: unknown;
    field: TextField;
    hasSetter: boolean;
    expected: string;
  }[] = [
    {
      name: "no match",
      key: "example",
      value: "abc",
      field: new TextField({ name: "test", autogeneratePattern: "test" }),
      hasSetter: false,
      expected: "",
    },
    {
      name: "exact match",
      key: "test",
      value: "abc",
      field: new TextField({ name: "test", autogeneratePattern: "test" }),
      hasSetter: true,
      expected: "abc",
    },
    {
      name: "autogenerate modifier",
      key: "test:autogenerate",
      value: "abc",
      field: new TextField({ name: "test", autogeneratePattern: "test" }),
      hasSetter: true,
      expected: "abctest",
    },
    {
      name: "autogenerate modifier without AutogeneratePattern option",
      key: "test:autogenerate",
      value: "abc",
      field: new TextField({ name: "test" }),
      hasSetter: true,
      expected: "abc",
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

      setter(record, s.value);

      expect(record.getString(s.field.name)).toBe(s.expected);
    });
  }
});
