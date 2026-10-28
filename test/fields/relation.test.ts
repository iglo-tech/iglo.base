// Upstream: core/field_relation_test.go

import { afterAll, describe, expect, test } from "bun:test";

import type { Field } from "@/fields/field";
import { FieldTypeRelation, RelationField } from "@/fields/relation";
import { newBadRequestError } from "@/server/error";
import { Errors } from "@/validation/error";
import { marshal } from "@/tools/types/go-json";

import {
  TestApp,
  TestRecord,
  expectValidationErrors,
  newBaseCollection,
  noDBApp,
  type TestCollection,
} from "@test/support/fields";
import {
  testDefaultFieldHelpValidation,
  testDefaultFieldIdValidation,
  testDefaultFieldNameValidation,
  testFieldBaseMethods,
} from "@test/fields/shared";

describe("TestRelationFieldBaseMethods", () => {
  testFieldBaseMethods(FieldTypeRelation);
});

describe("TestRelationFieldColumnType", () => {
  const app = noDBApp();

  const scenarios: { name: string; field: RelationField; expected: string }[] = [
    { name: "single (zero)", field: new RelationField(), expected: "TEXT DEFAULT '' NOT NULL" },
    {
      name: "single",
      field: new RelationField({ maxSelect: 1 }),
      expected: "TEXT DEFAULT '' NOT NULL",
    },
    {
      name: "multiple",
      field: new RelationField({ maxSelect: 2 }),
      expected: "JSON DEFAULT '[]' NOT NULL",
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      expect(s.field.columnType(app)).toBe(s.expected);
    });
  }
});

describe("TestRelationFieldIsMultiple", () => {
  const scenarios: { name: string; field: RelationField; expected: boolean }[] = [
    { name: "zero", field: new RelationField(), expected: false },
    { name: "single", field: new RelationField({ maxSelect: 1 }), expected: false },
    { name: "multiple", field: new RelationField({ maxSelect: 2 }), expected: true },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      expect(s.field.isMultiple()).toBe(s.expected);
    });
  }
});

describe("TestRelationFieldPrepareValue", () => {
  const record = new TestRecord(newBaseCollection("test"));

  const scenarios: { raw: unknown; field: RelationField; expected: string }[] = [
    // single
    { raw: null, field: new RelationField({ maxSelect: 1 }), expected: `""` },
    { raw: "", field: new RelationField({ maxSelect: 1 }), expected: `""` },
    { raw: 123, field: new RelationField({ maxSelect: 1 }), expected: `"123"` },
    { raw: "a", field: new RelationField({ maxSelect: 1 }), expected: `"a"` },
    { raw: `["a"]`, field: new RelationField({ maxSelect: 1 }), expected: `"a"` },
    { raw: [], field: new RelationField({ maxSelect: 1 }), expected: `""` },
    { raw: ["a", "b"], field: new RelationField({ maxSelect: 1 }), expected: `"b"` },

    // multiple
    { raw: null, field: new RelationField({ maxSelect: 2 }), expected: `[]` },
    { raw: "", field: new RelationField({ maxSelect: 2 }), expected: `[]` },
    { raw: 123, field: new RelationField({ maxSelect: 2 }), expected: `["123"]` },
    { raw: "a", field: new RelationField({ maxSelect: 2 }), expected: `["a"]` },
    { raw: `["a"]`, field: new RelationField({ maxSelect: 2 }), expected: `["a"]` },
    { raw: [], field: new RelationField({ maxSelect: 2 }), expected: `[]` },
    {
      raw: ["a", "b", "c"],
      field: new RelationField({ maxSelect: 2 }),
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

describe("TestRelationFieldDriverValue", () => {
  const scenarios: { raw: unknown; field: RelationField; expected: string }[] = [
    // single
    { raw: null, field: new RelationField({ maxSelect: 1 }), expected: `""` },
    { raw: "", field: new RelationField({ maxSelect: 1 }), expected: `""` },
    { raw: 123, field: new RelationField({ maxSelect: 1 }), expected: `"123"` },
    { raw: "a", field: new RelationField({ maxSelect: 1 }), expected: `"a"` },
    { raw: `["a"]`, field: new RelationField({ maxSelect: 1 }), expected: `"a"` },
    { raw: [], field: new RelationField({ maxSelect: 1 }), expected: `""` },
    { raw: ["a", "b"], field: new RelationField({ maxSelect: 1 }), expected: `"b"` },

    // multiple
    { raw: null, field: new RelationField({ maxSelect: 2 }), expected: `[]` },
    { raw: "", field: new RelationField({ maxSelect: 2 }), expected: `[]` },
    { raw: 123, field: new RelationField({ maxSelect: 2 }), expected: `["123"]` },
    { raw: "a", field: new RelationField({ maxSelect: 2 }), expected: `["a"]` },
    { raw: `["a"]`, field: new RelationField({ maxSelect: 2 }), expected: `["a"]` },
    { raw: [], field: new RelationField({ maxSelect: 2 }), expected: `[]` },
    {
      raw: ["a", "b", "c"],
      field: new RelationField({ maxSelect: 2 }),
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

const withValue = (value: unknown) => () => {
  const record = new TestRecord(newBaseCollection("test_collection"));
  record.setRaw("test", value);
  return record;
};

describe("TestRelationFieldValidateValue", () => {
  const app = TestApp.open();
  afterAll(() => app.cleanup());

  const demo1 = app.findCollectionByNameOrId("demo1");

  const scenarios: {
    name: string;
    field: RelationField;
    record: () => TestRecord;
    expectError: boolean;
  }[] = [
    // single
    {
      name: "[single] zero field value (not required)",
      field: new RelationField({ name: "test", maxSelect: 1, collectionId: demo1.id }),
      record: withValue(""),
      expectError: false,
    },
    {
      name: "[single] zero field value (required)",
      field: new RelationField({
        name: "test",
        maxSelect: 1,
        collectionId: demo1.id,
        required: true,
      }),
      record: withValue(""),
      expectError: true,
    },
    {
      name: "[single] id from other collection",
      field: new RelationField({ name: "test", maxSelect: 1, collectionId: demo1.id }),
      record: withValue("achvryl401bhse3"),
      expectError: true,
    },
    {
      name: "[single] valid id",
      field: new RelationField({ name: "test", maxSelect: 1, collectionId: demo1.id }),
      record: withValue("84nmscqy84lsi1t"),
      expectError: false,
    },
    {
      name: "[single] > MaxSelect",
      field: new RelationField({ name: "test", maxSelect: 1, collectionId: demo1.id }),
      record: withValue(["84nmscqy84lsi1t", "al1h9ijdeojtsjy"]),
      expectError: true,
    },

    // multiple
    {
      name: "[multiple] zero field value (not required)",
      field: new RelationField({ name: "test", maxSelect: 2, collectionId: demo1.id }),
      record: withValue([]),
      expectError: false,
    },
    {
      name: "[multiple] zero field value (required)",
      field: new RelationField({
        name: "test",
        maxSelect: 2,
        collectionId: demo1.id,
        required: true,
      }),
      record: withValue([]),
      expectError: true,
    },
    {
      name: "[multiple] id from other collection",
      field: new RelationField({ name: "test", maxSelect: 2, collectionId: demo1.id }),
      record: withValue(["84nmscqy84lsi1t", "achvryl401bhse3"]),
      expectError: true,
    },
    {
      name: "[multiple] valid id",
      field: new RelationField({ name: "test", maxSelect: 2, collectionId: demo1.id }),
      record: withValue(["84nmscqy84lsi1t", "al1h9ijdeojtsjy"]),
      expectError: false,
    },
    {
      name: "[multiple] > MaxSelect",
      field: new RelationField({ name: "test", maxSelect: 2, collectionId: demo1.id }),
      record: withValue(["84nmscqy84lsi1t", "al1h9ijdeojtsjy", "imy661ixudk5izi"]),
      expectError: true,
    },
    {
      name: "[multiple] < MinSelect",
      field: new RelationField({
        name: "test",
        minSelect: 2,
        maxSelect: 99,
        collectionId: demo1.id,
      }),
      record: withValue(["84nmscqy84lsi1t"]),
      expectError: true,
    },
    {
      name: "[multiple] >= MinSelect",
      field: new RelationField({
        name: "test",
        minSelect: 2,
        maxSelect: 99,
        collectionId: demo1.id,
      }),
      record: withValue(["84nmscqy84lsi1t", "al1h9ijdeojtsjy", "imy661ixudk5izi"]),
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

describe("TestRelationFieldValidateSettings", () => {
  testDefaultFieldIdValidation(FieldTypeRelation);
  testDefaultFieldNameValidation(FieldTypeRelation);
  testDefaultFieldHelpValidation(FieldTypeRelation);

  const app = TestApp.open();
  afterAll(() => app.cleanup());

  const demo1 = app.findCollectionByNameOrId("demo1");

  const scenarios: {
    name: string;
    field: (col: TestCollection) => RelationField;
    expectErrors: string[];
  }[] = [
    {
      name: "zero minimal",
      field: () => new RelationField({ id: "test", name: "test" }),
      expectErrors: ["collectionId"],
    },
    {
      name: "invalid collectionId",
      field: () => new RelationField({ id: "test", name: "test", collectionId: demo1.name }),
      expectErrors: ["collectionId"],
    },
    {
      name: "valid collectionId",
      field: () => new RelationField({ id: "test", name: "test", collectionId: demo1.id }),
      expectErrors: [],
    },
    {
      name: "base->view",
      field: () => new RelationField({ id: "test", name: "test", collectionId: "v9gwnfh02gjq1q0" }),
      expectErrors: ["collectionId"],
    },
    {
      name: "view->view",
      field: (col) => {
        col.type = "view";
        return new RelationField({ id: "test", name: "test", collectionId: "v9gwnfh02gjq1q0" });
      },
      expectErrors: [],
    },
    {
      name: "MinSelect < 0",
      field: () =>
        new RelationField({ id: "test", name: "test", collectionId: demo1.id, minSelect: -1 }),
      expectErrors: ["minSelect"],
    },
    {
      name: "MinSelect > 0",
      field: () =>
        new RelationField({ id: "test", name: "test", collectionId: demo1.id, minSelect: 1 }),
      expectErrors: ["maxSelect"],
    },
    {
      name: "MaxSelect < MinSelect",
      field: () =>
        new RelationField({
          id: "test",
          name: "test",
          collectionId: demo1.id,
          minSelect: 2,
          maxSelect: 1,
        }),
      expectErrors: ["maxSelect"],
    },
    {
      name: "MaxSelect >= MinSelect",
      field: () =>
        new RelationField({
          id: "test",
          name: "test",
          collectionId: demo1.id,
          minSelect: 2,
          maxSelect: 2,
        }),
      expectErrors: [],
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const collection = newBaseCollection("test_collection");
      (collection.fields.getByName("id") as Field).setId("test"); // set a dummy known id so that it can be replaced

      const field = s.field(collection);

      collection.fields.add(field);

      const errs = field.validateSettings(app, collection);

      expectValidationErrors(errs, s.expectErrors);
    });
  }
});

describe("TestRelationFieldFindSetter", () => {
  const scenarios: {
    name: string;
    key: string;
    value: unknown;
    field: RelationField;
    hasSetter: boolean;
    expected: string;
  }[] = [
    {
      name: "no match",
      key: "example",
      value: "b",
      field: new RelationField({ name: "test", maxSelect: 1 }),
      hasSetter: false,
      expected: "",
    },
    {
      name: "exact match (single)",
      key: "test",
      value: "b",
      field: new RelationField({ name: "test", maxSelect: 1 }),
      hasSetter: true,
      expected: `"b"`,
    },
    {
      name: "exact match (multiple)",
      key: "test",
      value: ["a", "b"],
      field: new RelationField({ name: "test", maxSelect: 2 }),
      hasSetter: true,
      expected: `["a","b"]`,
    },
    {
      name: "append (single)",
      key: "test+",
      value: "b",
      field: new RelationField({ name: "test", maxSelect: 1 }),
      hasSetter: true,
      expected: `"b"`,
    },
    {
      name: "append (multiple)",
      key: "test+",
      value: ["a"],
      field: new RelationField({ name: "test", maxSelect: 2 }),
      hasSetter: true,
      expected: `["c","d","a"]`,
    },
    {
      name: "prepend (single)",
      key: "+test",
      value: "b",
      field: new RelationField({ name: "test", maxSelect: 1 }),
      hasSetter: true,
      expected: `"d"`, // the last of the existing values
    },
    {
      name: "prepend (multiple)",
      key: "+test",
      value: ["a"],
      field: new RelationField({ name: "test", maxSelect: 2 }),
      hasSetter: true,
      expected: `["a","c","d"]`,
    },
    {
      name: "subtract (single)",
      key: "test-",
      value: "d",
      field: new RelationField({ name: "test", maxSelect: 1 }),
      hasSetter: true,
      expected: `"c"`,
    },
    {
      name: "subtract (multiple)",
      key: "test-",
      value: ["unknown", "c"],
      field: new RelationField({ name: "test", maxSelect: 2 }),
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

// Go int settings above 2^53 keep their exact value (a bigint outside the
// safe range): in the stored JSON, comparisons and error params/messages.
const largeIntValueErrors = (err: Error | null): string =>
  err === null ? "null" : marshal(newBadRequestError("", new Errors({ test: err })).data);

describe("RelationField large integers", () => {
  const app = TestApp.open();
  afterAll(() => app.cleanup());

  const demo1 = app.findCollectionByNameOrId("demo1");

  const load = (settings: string): RelationField => {
    const field = new RelationField();
    field.unmarshalJSON(`{"id":"test","name":"test","collectionId":"${demo1.id}",${settings}}`);
    return field;
  };

  const settingsErrors = (field: RelationField): string | null => {
    const collection = newBaseCollection("test_collection");
    collection.fields.add(field);
    const err = field.validateSettings(app, collection);
    return err === null ? null : marshal(newBadRequestError("", err).data);
  };

  test("minSelect above 2^53 is compared exactly", () => {
    const field = load(`"minSelect":9007199254740993,"maxSelect":9007199254740992`);
    expect(field.minSelect).toBe(9007199254740993n);
    expect(field.maxSelect).toBe(9007199254740992n);
    expect(field.marshalJSON()).toContain(
      `"minSelect":9007199254740993,"maxSelect":9007199254740992,`,
    );
    expect(settingsErrors(field)).toBe(
      `{"maxSelect":{"code":"validation_min_greater_equal_than_required","message":"Must be no less than 9007199254740993.","params":{"threshold":9007199254740993}}}`,
    );
  });

  test("int64 bounds are accepted", () => {
    const field = load(`"minSelect":9223372036854775807,"maxSelect":9223372036854775807`);
    expect(field.marshalJSON()).toContain(
      `"minSelect":9223372036854775807,"maxSelect":9223372036854775807,`,
    );
    expect(settingsErrors(field)).toBeNull();
    expect(field.isMultiple()).toBe(true);

    const negative = load(`"minSelect":-9223372036854775808`);
    expect(settingsErrors(negative)).toBe(
      `{"minSelect":{"code":"validation_min_greater_equal_than_required","message":"Must be no less than 0.","params":{"threshold":0}}}`,
    );
  });

  test("out of int64 range, fractions and exponents are decode errors", () => {
    for (const [literal, msg] of [
      ["9223372036854775808", "value out of range"],
      ["-9223372036854775809", "value out of range"],
      ["1.0", "invalid syntax"],
      ["1e3", "invalid syntax"],
    ]) {
      expect(() => load(`"maxSelect":${literal}`)).toThrow(
        `json: cannot unmarshal JSON number ${literal} into Go int: ${msg}`,
      );
    }
  });

  test("value limits use the exact settings", () => {
    const record = withValue(["a", "b"])();
    expect(
      largeIntValueErrors(load(`"minSelect":9007199254740993`).validateValue(app, record)),
    ).toBe(
      `{"test":{"code":"validation_not_enough_values","message":"Select at least 9007199254740993.","params":{"minSelect":9007199254740993}}}`,
    );
    const negative = load(`"maxSelect":-9223372036854775808`);
    expect(largeIntValueErrors(negative.validateValue(app, record))).toBe(
      `{"test":{"code":"validation_too_many_values","message":"Select no more than 1.","params":{"maxSelect":1}}}`,
    );
  });
});
