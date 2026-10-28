// Upstream: core/field_json_test.go

import { describe, expect, test } from "bun:test";

import { FieldTypeJSON, JSONField, DefaultJSONFieldMaxSize } from "@/fields/json";
import { newBadRequestError } from "@/server/error";
import { marshal } from "@/tools/types/go-json";
import { JSONRaw } from "@/tools/types/json-raw";

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

describe("TestJSONFieldBaseMethods", () => {
  testFieldBaseMethods(FieldTypeJSON);
});

test("TestJSONFieldColumnType", () => {
  const f = new JSONField();

  const expected = "JSON DEFAULT NULL";

  expect(f.columnType(noDBApp())).toBe(expected);
});

describe("TestJSONFieldPrepareValue", () => {
  const f = new JSONField();
  const record = new TestRecord(newBaseCollection("test"));

  const scenarios: { raw: unknown; expected: string }[] = [
    { raw: "null", expected: `null` },
    { raw: "", expected: `""` },
    { raw: "true", expected: `true` },
    { raw: "false", expected: `false` },
    { raw: "test", expected: `"test"` },
    { raw: "123", expected: `123` },
    { raw: "-456", expected: `-456` },
    { raw: "[1,2,3]", expected: `[1,2,3]` },
    { raw: "[1,2,3", expected: `"[1,2,3"` },
    { raw: String.raw`{"a":1,"b":2}`, expected: String.raw`{"a":1,"b":2}` },
    { raw: String.raw`{"a":1,"b":2`, expected: String.raw`"{\"a\":1,\"b\":2"` },
    { raw: [1, 2, 3], expected: `[1,2,3]` },
    { raw: { a: 1, b: 2 }, expected: `{"a":1,"b":2}` },
    { raw: null, expected: `null` },
    { raw: false, expected: `false` },
    { raw: true, expected: `true` },
    { raw: -78, expected: `-78` },
    { raw: 123.456, expected: `123.456` },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${String(s.raw)}`, () => {
      const [v, err] = f.prepareValue(record, s.raw);
      expect(err).toBeNull();

      expect(v).toBeInstanceOf(JSONRaw);
      const rawStr = (v as JSONRaw).string();

      expect(rawStr).toBe(s.expected);
    });
  }
});

describe("TestJSONFieldValidateValue", () => {
  const collection = newBaseCollection("test_collection");

  const withValue = (value: unknown) => () => {
    const record = new TestRecord(collection);
    record.setRaw("test", value);
    return record;
  };

  const scenarios: {
    name: string;
    field: JSONField;
    record: () => TestRecord;
    expectError: boolean;
  }[] = [
    {
      name: "invalid raw value",
      field: new JSONField({ name: "test" }),
      record: withValue(123),
      expectError: true,
    },
    {
      name: "invalid raw value (v2 semantics)",
      field: new JSONField({ name: "test" }),
      record: withValue(new JSONRaw(String.raw`{"a": 1, "a": 2}`)),
      expectError: true,
    },
    {
      name: "zero field value (not required)",
      field: new JSONField({ name: "test" }),
      record: withValue(new JSONRaw()),
      expectError: false,
    },
    {
      name: "zero field value (required)",
      field: new JSONField({ name: "test", required: true }),
      record: withValue(new JSONRaw()),
      expectError: true,
    },
    {
      name: "non-zero field value (required)",
      field: new JSONField({ name: "test", required: true }),
      record: withValue(new JSONRaw("[1,2,3]")),
      expectError: false,
    },
    {
      name: "non-zero field value (required)",
      field: new JSONField({ name: "test", required: true }),
      record: withValue(new JSONRaw(`"aaa"`)),
      expectError: false,
    },
    {
      name: "> default MaxSize",
      field: new JSONField({ name: "test" }),
      record: withValue(new JSONRaw(`"${"a".repeat(2 ** 20)}"`)),
      expectError: true,
    },
    {
      name: "> MaxSize",
      field: new JSONField({ name: "test", maxSize: 5 }),
      record: withValue(new JSONRaw(`"aaaa"`)),
      expectError: true,
    },
    {
      name: "<= MaxSize",
      field: new JSONField({ name: "test", maxSize: 5 }),
      record: withValue(new JSONRaw(`"aaa"`)),
      expectError: false,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const err = s.field.validateValue(noDBApp(), s.record());
      expect(err !== null).toBe(s.expectError);
    });
  }
});

describe("TestJSONFieldValidateSettings", () => {
  testDefaultFieldIdValidation(FieldTypeJSON);
  testDefaultFieldNameValidation(FieldTypeJSON);
  testDefaultFieldHelpValidation(FieldTypeJSON);

  const app = noDBApp();
  const collection = newBaseCollection("test_collection");

  const scenarios: {
    name: string;
    field: () => JSONField;
    expectErrors: string[];
  }[] = [
    {
      name: "MaxSize < 0",
      field: () => new JSONField({ id: "test", name: "test", maxSize: -1 }),
      expectErrors: ["maxSize"],
    },
    {
      name: "MaxSize = 0",
      field: () => new JSONField({ id: "test", name: "test" }),
      expectErrors: [],
    },
    {
      name: "MaxSize > 0",
      field: () => new JSONField({ id: "test", name: "test", maxSize: 1 }),
      expectErrors: [],
    },
    {
      name: "MaxSize > safe json int",
      field: () => new JSONField({ id: "test", name: "test", maxSize: 2 ** 53 }),
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

describe("TestJSONFieldCalculateMaxBodySize", () => {
  const scenarios: { field: JSONField; expected: number }[] = [
    { field: new JSONField(), expected: DefaultJSONFieldMaxSize },
    { field: new JSONField({ maxSize: 10 }), expected: 10 },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${s.field.maxSize}`, () => {
      const result = s.field.calculateMaxBodySize();

      expect(result).toBe(s.expected);
    });
  }
});

// Go int settings above 2^53 keep their exact value (a bigint outside the
// safe range): in the stored JSON, comparisons and error params/messages.
const loadLargeInt = (settings: string): JSONField => {
  const field = new JSONField();
  field.unmarshalJSON(`{"id":"test","name":"test",${settings}}`);
  return field;
};

describe("JSONField large integers", () => {
  const app = noDBApp();

  const settingsErrors = (field: JSONField): string | null => {
    const collection = newBaseCollection("test_collection");
    collection.fields.add(field);
    const err = field.validateSettings(app, collection);
    return err === null ? null : marshal(newBadRequestError("", err).data);
  };

  test("maxSize keeps its exact value", () => {
    expect(settingsErrors(loadLargeInt(`"maxSize":9007199254740991`))).toBeNull();
    const field = loadLargeInt(`"maxSize":9007199254740993`);
    expect(field.marshalJSON()).toContain(`"maxSize":9007199254740993`);
    expect(field.calculateMaxBodySize()).toBe(9007199254740993n);
    expect(settingsErrors(field)).toBe(
      `{"maxSize":{"code":"validation_max_less_equal_than_required","message":"Must be no greater than 9007199254740991.","params":{"threshold":9007199254740991}}}`,
    );
    expect(loadLargeInt(`"maxSize":-9223372036854775808`).calculateMaxBodySize()).toBe(
      DefaultJSONFieldMaxSize,
    );
  });

  test("out of int64 range is a decode error", () => {
    expect(() => loadLargeInt(`"maxSize":9223372036854775808`)).toThrow(
      "json: cannot unmarshal JSON number 9223372036854775808 into Go int64: value out of range",
    );
    expect(() => loadLargeInt(`"maxSize":1e3`)).toThrow(
      "json: cannot unmarshal JSON number 1e3 into Go int64: invalid syntax",
    );
  });

  test("the value size is compared with the exact maxSize", () => {
    const record = new TestRecord(newBaseCollection("test_collection"));
    record.setRaw("test", new JSONRaw("[1]"));
    expect(loadLargeInt(`"maxSize":9223372036854775807`).validateValue(app, record)).toBeNull();
  });
});
