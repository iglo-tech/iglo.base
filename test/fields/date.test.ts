// Upstream: core/field_date_test.go

import { describe, expect, test } from "bun:test";

import { DateField, FieldTypeDate } from "@/fields/date";
import { DateTime, Second, nowDateTime } from "@/tools/types/datetime";

import {
  TestRecord,
  expectValidationErrors,
  fixedClock,
  newBaseCollection,
  noDBApp,
} from "@test/support/fields";
import {
  testDefaultFieldHelpValidation,
  testDefaultFieldIdValidation,
  testDefaultFieldNameValidation,
  testFieldBaseMethods,
} from "@test/fields/shared";

const clock = fixedClock("2026-03-04T05:06:07.890Z");

describe("TestDateFieldBaseMethods", () => {
  testFieldBaseMethods(FieldTypeDate);
});

test("TestDateFieldColumnType", () => {
  const f = new DateField();
  expect(f.columnType(noDBApp(clock))).toBe("TEXT DEFAULT '' NOT NULL");
});

describe("TestDateFieldPrepareValue", () => {
  const f = new DateField();
  const record = new TestRecord(newBaseCollection("test"));

  const scenarios: [unknown, string][] = [
    ["", ""],
    ["invalid", ""],
    ["2024-01-01 00:11:22.345Z", "2024-01-01 00:11:22.345Z"],
    [new Date(Date.UTC(2024, 0, 2, 3, 4, 5)), "2024-01-02 03:04:05.000Z"],
  ];

  for (const [i, [raw, expected]] of scenarios.entries()) {
    test(`${i}_${String(raw)}`, () => {
      const [v, err] = f.prepareValue(record, raw);
      expect(err).toBeNull();
      expect(v).toBeInstanceOf(DateTime);
      expect((v as DateTime).string()).toBe(expected);
    });
  }
});

describe("TestDateFieldValidateValue", () => {
  const app = noDBApp(clock);
  const collection = newBaseCollection("test_collection");

  const withValue = (value: unknown) => () => {
    const record = new TestRecord(collection);
    record.setRaw("test", value);
    return record;
  };

  const scenarios: {
    name: string;
    field: DateField;
    record: () => TestRecord;
    expectError: boolean;
  }[] = [
    {
      name: "invalid raw value",
      field: new DateField({ name: "test" }),
      record: withValue(123),
      expectError: true,
    },
    {
      name: "zero field value (not required)",
      field: new DateField({ name: "test" }),
      record: withValue(new DateTime()),
      expectError: false,
    },
    {
      name: "zero field value (required)",
      field: new DateField({ name: "test", required: true }),
      record: withValue(new DateTime()),
      expectError: true,
    },
    {
      name: "non-zero field value (required)",
      field: new DateField({ name: "test", required: true }),
      record: withValue(nowDateTime(clock)),
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

describe("TestDateFieldValidateSettings", () => {
  testDefaultFieldIdValidation(FieldTypeDate);
  testDefaultFieldNameValidation(FieldTypeDate);
  testDefaultFieldHelpValidation(FieldTypeDate);

  const app = noDBApp(clock);
  const collection = newBaseCollection("test_collection");

  const scenarios: { name: string; field: () => DateField; expectErrors: string[] }[] = [
    {
      name: "zero Min/Max",
      field: () => new DateField({ id: "test", name: "test" }),
      expectErrors: [],
    },
    {
      name: "non-empty Min with empty Max",
      field: () => new DateField({ id: "test", name: "test", min: nowDateTime(clock) }),
      expectErrors: [],
    },
    {
      name: "empty Min non-empty Max",
      field: () => new DateField({ id: "test", name: "test", max: nowDateTime(clock) }),
      expectErrors: [],
    },
    {
      name: "Min = Max",
      field: () => {
        const date = nowDateTime(clock);
        return new DateField({ id: "test", name: "test", min: date, max: date });
      },
      expectErrors: [],
    },
    {
      name: "Min > Max",
      field: () => {
        const min = nowDateTime(clock);
        const max = min.add(-5 * Second);
        return new DateField({ id: "test", name: "test", min, max });
      },
      expectErrors: [],
    },
    {
      name: "Min < Max",
      field: () => {
        const max = nowDateTime(clock);
        const min = max.add(-5 * Second);
        return new DateField({ id: "test", name: "test", min, max });
      },
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
