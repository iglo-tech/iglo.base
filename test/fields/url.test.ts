// Upstream: core/field_url_test.go

import { describe, expect, test } from "bun:test";

import { FieldTypeURL, URLField } from "@/fields/url";

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

describe("TestURLFieldBaseMethods", () => {
  testFieldBaseMethods(FieldTypeURL);
});

test("TestURLFieldColumnType", () => {
  const f = new URLField();
  expect(f.columnType(noDBApp())).toBe("TEXT DEFAULT '' NOT NULL");
});

describe("TestURLFieldPrepareValue", () => {
  const f = new URLField();
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

describe("TestURLFieldValidateValue", () => {
  const app = noDBApp();
  const collection = newBaseCollection("test_collection");

  const withValue = (value: unknown) => () => {
    const record = new TestRecord(collection);
    record.setRaw("test", value);
    return record;
  };

  const scenarios: {
    name: string;
    field: URLField;
    record: () => TestRecord;
    expectError: boolean;
  }[] = [
    {
      name: "invalid raw value",
      field: new URLField({ name: "test" }),
      record: withValue(123),
      expectError: true,
    },
    {
      name: "zero field value (not required)",
      field: new URLField({ name: "test" }),
      record: withValue(""),
      expectError: false,
    },
    {
      name: "zero field value (required)",
      field: new URLField({ name: "test", required: true }),
      record: withValue(""),
      expectError: true,
    },
    {
      name: "non-zero field value (required)",
      field: new URLField({ name: "test", required: true }),
      record: withValue("https://example.com"),
      expectError: false,
    },
    {
      name: "invalid url",
      field: new URLField({ name: "test" }),
      record: withValue("invalid"),
      expectError: true,
    },
    {
      name: "failed onlyDomains",
      field: new URLField({ name: "test", onlyDomains: ["example.org", "example.net"] }),
      record: withValue("https://example.com"),
      expectError: true,
    },
    {
      name: "success onlyDomains",
      field: new URLField({ name: "test", onlyDomains: ["example.org", "example.com"] }),
      record: withValue("https://example.com"),
      expectError: false,
    },
    {
      name: "failed exceptDomains",
      field: new URLField({ name: "test", exceptDomains: ["example.org", "example.com"] }),
      record: withValue("https://example.com"),
      expectError: true,
    },
    {
      name: "success exceptDomains",
      field: new URLField({ name: "test", exceptDomains: ["example.org", "example.net"] }),
      record: withValue("https://example.com"),
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

describe("TestURLFieldValidateSettings", () => {
  testDefaultFieldIdValidation(FieldTypeURL);
  testDefaultFieldNameValidation(FieldTypeURL);
  testDefaultFieldHelpValidation(FieldTypeURL);

  const app = noDBApp();
  const collection = newBaseCollection("test_collection");

  const scenarios: { name: string; field: () => URLField; expectErrors: string[] }[] = [
    {
      name: "zero minimal",
      field: () => new URLField({ id: "test", name: "test" }),
      expectErrors: [],
    },
    {
      name: "both onlyDomains and exceptDomains",
      field: () =>
        new URLField({
          id: "test",
          name: "test",
          onlyDomains: ["example.com"],
          exceptDomains: ["example.org"],
        }),
      expectErrors: ["onlyDomains", "exceptDomains"],
    },
    {
      name: "invalid onlyDomains",
      field: () =>
        new URLField({ id: "test", name: "test", onlyDomains: ["example.com", "invalid"] }),
      expectErrors: ["onlyDomains"],
    },
    {
      name: "valid onlyDomains",
      field: () =>
        new URLField({ id: "test", name: "test", onlyDomains: ["example.com", "example.org"] }),
      expectErrors: [],
    },
    {
      name: "invalid exceptDomains",
      field: () =>
        new URLField({ id: "test", name: "test", exceptDomains: ["example.com", "invalid"] }),
      expectErrors: ["exceptDomains"],
    },
    {
      name: "valid exceptDomains",
      field: () =>
        new URLField({ id: "test", name: "test", exceptDomains: ["example.com", "example.org"] }),
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
