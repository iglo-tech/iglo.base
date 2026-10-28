// Upstream: core/field_select_test.go

import { describe, expect, test } from "bun:test";

import { FieldTypeSelect, SelectField } from "@/fields/select";
import { marshal } from "@/tools/types/go-json";

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

describe("TestSelectFieldBaseMethods", () => {
  testFieldBaseMethods(FieldTypeSelect);
});

describe("TestSelectFieldColumnType", () => {
  const app = noDBApp();

  const scenarios: { name: string; field: SelectField; expected: string }[] = [
    { name: "single (zero)", field: new SelectField(), expected: "TEXT DEFAULT '' NOT NULL" },
    {
      name: "single",
      field: new SelectField({ maxSelect: 1 }),
      expected: "TEXT DEFAULT '' NOT NULL",
    },
    {
      name: "multiple",
      field: new SelectField({ maxSelect: 2 }),
      expected: "JSON DEFAULT '[]' NOT NULL",
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      expect(s.field.columnType(app)).toBe(s.expected);
    });
  }
});

describe("TestSelectFieldIsMultiple", () => {
  const scenarios: { name: string; field: SelectField; expected: boolean }[] = [
    { name: "single (zero)", field: new SelectField(), expected: false },
    { name: "single", field: new SelectField({ maxSelect: 1 }), expected: false },
    { name: "multiple (>1)", field: new SelectField({ maxSelect: 2 }), expected: true },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      expect(s.field.isMultiple()).toBe(s.expected);
    });
  }
});

describe("TestSelectFieldPrepareValue", () => {
  const record = new TestRecord(newBaseCollection("test"));

  const scenarios: { raw: unknown; field: SelectField; expected: string }[] = [
    // single
    { raw: null, field: new SelectField(), expected: `""` },
    { raw: "", field: new SelectField(), expected: `""` },
    { raw: 123, field: new SelectField(), expected: `"123"` },
    { raw: "a", field: new SelectField(), expected: `"a"` },
    { raw: `["a"]`, field: new SelectField(), expected: `"a"` },
    { raw: [], field: new SelectField(), expected: `""` },
    { raw: ["a", "b"], field: new SelectField(), expected: `"b"` },

    // multiple
    { raw: null, field: new SelectField({ maxSelect: 2 }), expected: `[]` },
    { raw: "", field: new SelectField({ maxSelect: 2 }), expected: `[]` },
    { raw: 123, field: new SelectField({ maxSelect: 2 }), expected: `["123"]` },
    { raw: "a", field: new SelectField({ maxSelect: 2 }), expected: `["a"]` },
    { raw: `["a"]`, field: new SelectField({ maxSelect: 2 }), expected: `["a"]` },
    { raw: [], field: new SelectField({ maxSelect: 2 }), expected: `[]` },
    {
      raw: ["a", "b", "c"],
      field: new SelectField({ maxSelect: 2 }),
      expected: `["a","b","c"]`,
    },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${String(s.raw)}_${s.field.isMultiple()}`, () => {
      const [v, err] = s.field.prepareValue(record, s.raw);
      expect(err).toBeNull();

      expect(marshal(v)).toBe(s.expected);
    });
  }
});

describe("TestSelectFieldDriverValue", () => {
  const scenarios: { raw: unknown; field: SelectField; expected: string }[] = [
    // single
    { raw: null, field: new SelectField(), expected: `""` },
    { raw: "", field: new SelectField(), expected: `""` },
    { raw: 123, field: new SelectField(), expected: `"123"` },
    { raw: "a", field: new SelectField(), expected: `"a"` },
    { raw: `["a"]`, field: new SelectField(), expected: `"a"` },
    { raw: [], field: new SelectField(), expected: `""` },
    { raw: ["a", "b"], field: new SelectField(), expected: `"b"` },

    // multiple
    { raw: null, field: new SelectField({ maxSelect: 2 }), expected: `[]` },
    { raw: "", field: new SelectField({ maxSelect: 2 }), expected: `[]` },
    { raw: 123, field: new SelectField({ maxSelect: 2 }), expected: `["123"]` },
    { raw: "a", field: new SelectField({ maxSelect: 2 }), expected: `["a"]` },
    { raw: `["a"]`, field: new SelectField({ maxSelect: 2 }), expected: `["a"]` },
    { raw: [], field: new SelectField({ maxSelect: 2 }), expected: `[]` },
    {
      raw: ["a", "b", "c"],
      field: new SelectField({ maxSelect: 2 }),
      expected: `["a","b","c"]`,
    },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${String(s.raw)}_${s.field.isMultiple()}`, () => {
      const record = new TestRecord(newBaseCollection("test"));
      record.setRaw(s.field.getName(), s.raw);

      const [v, err] = s.field.driverValue(record);
      expect(err).toBeNull();

      if (s.field.isMultiple()) {
        expect(Array.isArray(v)).toBe(true);
      } else {
        expect(typeof v).toBe("string");
      }

      expect(marshal(v)).toBe(s.expected);
    });
  }
});

describe("TestSelectFieldValidateValue", () => {
  const collection = newBaseCollection("test_collection");

  const values = ["a", "b", "c"];

  const withValue = (value: unknown) => () => {
    const record = new TestRecord(collection);
    record.setRaw("test", value);
    return record;
  };

  const scenarios: {
    name: string;
    field: SelectField;
    record: () => TestRecord;
    expectError: boolean;
  }[] = [
    // single
    {
      name: "[single] zero field value (not required)",
      field: new SelectField({ name: "test", values, maxSelect: 1 }),
      record: withValue(""),
      expectError: false,
    },
    {
      name: "[single] zero field value (required)",
      field: new SelectField({ name: "test", values, maxSelect: 1, required: true }),
      record: withValue(""),
      expectError: true,
    },
    {
      name: "[single] unknown value",
      field: new SelectField({ name: "test", values, maxSelect: 1 }),
      record: withValue("unknown"),
      expectError: true,
    },
    {
      name: "[single] known value",
      field: new SelectField({ name: "test", values, maxSelect: 1 }),
      record: withValue("a"),
      expectError: false,
    },
    {
      name: "[single] > MaxSelect",
      field: new SelectField({ name: "test", values, maxSelect: 1 }),
      record: withValue(["a", "b"]),
      expectError: true,
    },

    // multiple
    {
      name: "[multiple] zero field value (not required)",
      field: new SelectField({ name: "test", values, maxSelect: 2 }),
      record: withValue([]),
      expectError: false,
    },
    {
      name: "[multiple] zero field value (required)",
      field: new SelectField({ name: "test", values, maxSelect: 2, required: true }),
      record: withValue([]),
      expectError: true,
    },
    {
      name: "[multiple] unknown value",
      field: new SelectField({ name: "test", values, maxSelect: 2 }),
      record: withValue(["a", "unknown"]),
      expectError: true,
    },
    {
      name: "[multiple] known value",
      field: new SelectField({ name: "test", values, maxSelect: 2 }),
      record: withValue(["a", "b"]),
      expectError: false,
    },
    {
      name: "[multiple] > MaxSelect",
      field: new SelectField({ name: "test", values, maxSelect: 2 }),
      record: withValue(["a", "b", "c"]),
      expectError: true,
    },
    {
      name: "[multiple] > MaxSelect (duplicated values)",
      field: new SelectField({ name: "test", values, maxSelect: 2 }),
      record: withValue(["a", "b", "b", "a"]),
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

describe("TestSelectFieldValidateSettings", () => {
  testDefaultFieldIdValidation(FieldTypeSelect);
  testDefaultFieldNameValidation(FieldTypeSelect);
  testDefaultFieldHelpValidation(FieldTypeSelect);

  const app = noDBApp();

  const scenarios: {
    name: string;
    field: () => SelectField;
    expectErrors: string[];
  }[] = [
    {
      name: "zero minimal",
      field: () => new SelectField({ id: "test", name: "test" }),
      expectErrors: ["values"],
    },
    {
      name: "MaxSelect > Values length",
      field: () => new SelectField({ id: "test", name: "test", values: ["a", "b"], maxSelect: 3 }),
      expectErrors: ["maxSelect"],
    },
    {
      name: "MaxSelect <= Values length",
      field: () => new SelectField({ id: "test", name: "test", values: ["a", "b"], maxSelect: 2 }),
      expectErrors: [],
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const field = s.field();

      const collection = newBaseCollection("test_collection");
      collection.fields.add(field);

      const errs = field.validateSettings(app, collection);

      expectValidationErrors(errs, s.expectErrors);
    });
  }
});

describe("TestSelectFieldFindSetter", () => {
  const values = ["a", "b", "c", "d"];

  const scenarios: {
    name: string;
    key: string;
    value: unknown;
    field: SelectField;
    hasSetter: boolean;
    expected: string;
  }[] = [
    {
      name: "no match",
      key: "example",
      value: "b",
      field: new SelectField({ name: "test", maxSelect: 1, values }),
      hasSetter: false,
      expected: "",
    },
    {
      name: "exact match (single)",
      key: "test",
      value: "b",
      field: new SelectField({ name: "test", maxSelect: 1, values }),
      hasSetter: true,
      expected: `"b"`,
    },
    {
      name: "exact match (multiple)",
      key: "test",
      value: ["a", "b"],
      field: new SelectField({ name: "test", maxSelect: 2, values }),
      hasSetter: true,
      expected: `["a","b"]`,
    },
    {
      name: "append (single)",
      key: "test+",
      value: "b",
      field: new SelectField({ name: "test", maxSelect: 1, values }),
      hasSetter: true,
      expected: `"b"`,
    },
    {
      name: "append (multiple)",
      key: "test+",
      value: ["a"],
      field: new SelectField({ name: "test", maxSelect: 2, values }),
      hasSetter: true,
      expected: `["c","d","a"]`,
    },
    {
      name: "prepend (single)",
      key: "+test",
      value: "b",
      field: new SelectField({ name: "test", maxSelect: 1, values }),
      hasSetter: true,
      expected: `"d"`, // the last of the existing values
    },
    {
      name: "prepend (multiple)",
      key: "+test",
      value: ["a"],
      field: new SelectField({ name: "test", maxSelect: 2, values }),
      hasSetter: true,
      expected: `["a","c","d"]`,
    },
    {
      name: "subtract (single)",
      key: "test-",
      value: "d",
      field: new SelectField({ name: "test", maxSelect: 1, values }),
      hasSetter: true,
      expected: `"c"`,
    },
    {
      name: "subtract (multiple)",
      key: "test-",
      value: ["unknown", "c"],
      field: new SelectField({ name: "test", maxSelect: 2, values }),
      hasSetter: true,
      expected: `["d"]`,
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
