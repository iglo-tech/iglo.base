// Upstream: core/field_email_test.go

import { describe, expect, test } from "bun:test";

import { EmailField, FieldTypeEmail } from "@/fields/email";

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

describe("TestEmailFieldBaseMethods", () => {
  testFieldBaseMethods(FieldTypeEmail);
});

test("TestEmailFieldColumnType", () => {
  const f = new EmailField();
  expect(f.columnType(noDBApp())).toBe("TEXT DEFAULT '' NOT NULL");
});

describe("TestEmailFieldPrepareValue", () => {
  const f = new EmailField();
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

describe("TestEmailFieldValidateValue", () => {
  const collection = newBaseCollection("test_collection");

  const withValue = (value: unknown) => () => {
    const record = new TestRecord(collection);
    record.setRaw("test", value);
    return record;
  };

  const scenarios: {
    name: string;
    field: EmailField;
    record: () => TestRecord;
    expectError: boolean;
  }[] = [
    {
      name: "invalid raw value",
      field: new EmailField({ name: "test" }),
      record: withValue(123),
      expectError: true,
    },
    {
      name: "zero field value (not required)",
      field: new EmailField({ name: "test" }),
      record: withValue(""),
      expectError: false,
    },
    {
      name: "zero field value (required)",
      field: new EmailField({ name: "test", required: true }),
      record: withValue(""),
      expectError: true,
    },
    {
      name: "non-zero field value (required)",
      field: new EmailField({ name: "test", required: true }),
      record: withValue("test@example.com"),
      expectError: false,
    },
    {
      name: "invalid email",
      field: new EmailField({ name: "test" }),
      record: withValue("invalid"),
      expectError: true,
    },
    {
      name: "failed onlyDomains",
      field: new EmailField({ name: "test", onlyDomains: ["example.org", "example.net"] }),
      record: withValue("test@example.com"),
      expectError: true,
    },
    {
      name: "success onlyDomains",
      field: new EmailField({ name: "test", onlyDomains: ["example.org", "example.com"] }),
      record: withValue("test@example.com"),
      expectError: false,
    },
    {
      name: "failed exceptDomains",
      field: new EmailField({ name: "test", exceptDomains: ["example.org", "example.com"] }),
      record: withValue("test@example.com"),
      expectError: true,
    },
    {
      name: "success exceptDomains",
      field: new EmailField({ name: "test", exceptDomains: ["example.org", "example.net"] }),
      record: withValue("test@example.com"),
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

describe("TestEmailFieldValidateSettings", () => {
  testDefaultFieldIdValidation(FieldTypeEmail);
  testDefaultFieldNameValidation(FieldTypeEmail);
  testDefaultFieldHelpValidation(FieldTypeEmail);

  const app = noDBApp();
  const collection = newBaseCollection("test_collection");

  const scenarios: { name: string; field: () => EmailField; expectErrors: string[] }[] = [
    {
      name: "zero minimal",
      field: () => new EmailField({ id: "test", name: "test" }),
      expectErrors: [],
    },
    {
      name: "both onlyDomains and exceptDomains",
      field: () =>
        new EmailField({
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
        new EmailField({ id: "test", name: "test", onlyDomains: ["example.com", "invalid"] }),
      expectErrors: ["onlyDomains"],
    },
    {
      name: "valid onlyDomains",
      field: () =>
        new EmailField({ id: "test", name: "test", onlyDomains: ["example.com", "example.org"] }),
      expectErrors: [],
    },
    {
      name: "invalid exceptDomains",
      field: () =>
        new EmailField({ id: "test", name: "test", exceptDomains: ["example.com", "invalid"] }),
      expectErrors: ["exceptDomains"],
    },
    {
      name: "valid exceptDomains",
      field: () =>
        new EmailField({ id: "test", name: "test", exceptDomains: ["example.com", "example.org"] }),
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
