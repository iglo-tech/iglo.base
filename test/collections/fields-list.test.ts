// Upstream: core/fields_list_test.go

import { describe, expect, test } from "bun:test";
import { FieldsList, newFieldsList } from "@/collections/fields-list";
import { BoolField } from "@/fields/bool";
import { EmailField, FieldTypeEmail } from "@/fields/email";
import { FieldTypeNumber, NumberField } from "@/fields/number";
import { TextField, FieldTypeText } from "@/fields/text";
import { FieldTypeURL, URLField } from "@/fields/url";

describe("NewFieldsList", () => {
  test("replaces the fields with the same id and sets the missing ids", () => {
    const fields = newFieldsList(
      new TextField({ id: "id1", name: "test1" }),
      new TextField({ name: "test2" }),
      new TextField({ id: "id1", name: "test1_new" }), // should replace the original id1 field
    );

    expect(fields.length).toBe(2);

    for (const f of fields) {
      expect(f.getId()).not.toBe("");
    }

    expect(fields.at(0)?.getName()).toBe("test1_new");
    expect(fields.at(1)?.getName()).toBe("test2");
  });
});

describe("FieldsListClone", () => {
  test("creates a deep clone", () => {
    const f1 = new TextField({ name: "test1" });
    const f2 = new EmailField({ name: "test2" });
    const s1 = newFieldsList(f1, f2);

    const s2 = s1.clone();

    const s1Str = s1.string();
    const s2Str = s2.string();

    expect(s1Str).toBe(s2Str);

    // change in one list shouldn't result to change in the other
    // (aka. check if it is a deep clone)
    s1.at(0)?.setName("test1_update");
    expect(s2.at(0)?.getName()).toBe("test1");
  });
});

describe("FieldsListFieldNames", () => {
  test("returns the names of all fields", () => {
    const f1 = new TextField({ name: "test1" });
    const f2 = new EmailField({ name: "test2" });
    const testFieldsList = newFieldsList(f1, f2);

    const result = testFieldsList.fieldNames();

    const expected = ["test1", "test2"];

    expect(result.length).toBe(expected.length);

    for (const name of expected) {
      expect(result).toContain(name);
    }
  });
});

describe("FieldsListAsMap", () => {
  test("indexes all fields by name", () => {
    const f1 = new TextField({ name: "test1" });
    const f2 = new EmailField({ name: "test2" });
    const testFieldsList = newFieldsList(f1, f2);

    const result = testFieldsList.asMap();

    const expectedIndexes = ["test1", "test2"];

    expect(result.size).toBe(expectedIndexes.length);

    for (const index of expectedIndexes) {
      expect(result.has(index)).toBe(true);
    }
  });
});

describe("FieldsListGetById", () => {
  test("returns the field by id or null", () => {
    const f1 = new TextField({ id: "id1", name: "test1" });
    const f2 = new EmailField({ id: "id2", name: "test2" });
    const testFieldsList = newFieldsList(f1, f2);

    // missing field id
    expect(testFieldsList.getById("test1")).toBeNull();

    // existing field id
    const result2 = testFieldsList.getById("id2");
    expect(result2).not.toBeNull();
    expect(result2?.getId()).toBe("id2");
  });
});

describe("FieldsListGetByName", () => {
  test("returns the field by name or null", () => {
    const f1 = new TextField({ id: "id1", name: "test1" });
    const f2 = new EmailField({ id: "id2", name: "test2" });
    const testFieldsList = newFieldsList(f1, f2);

    // missing field name
    expect(testFieldsList.getByName("id1")).toBeNull();

    // existing field name
    const result2 = testFieldsList.getByName("test2");
    expect(result2).not.toBeNull();
    expect(result2?.getName()).toBe("test2");
  });
});

describe("FieldsListRemove", () => {
  test("removes fields by id and by name", () => {
    const testFieldsList = newFieldsList(
      new TextField({ id: "id1", name: "test1" }),
      new TextField({ id: "id2", name: "test2" }),
      new TextField({ id: "id3", name: "test3" }),
      new TextField({ id: "id4", name: "test4" }),
      new TextField({ id: "id5", name: "test5" }),
      new TextField({ id: "id6", name: "test6" }),
    );

    // remove by id
    testFieldsList.removeById("id2");
    testFieldsList.removeById("test3"); // should do nothing

    // remove by name
    testFieldsList.removeByName("test5");
    testFieldsList.removeByName("id6"); // should do nothing

    const expected = ["test1", "test3", "test4", "test6"];

    expect(testFieldsList.length).toBe(expected.length);

    for (const name of expected) {
      expect(testFieldsList.getByName(name)).not.toBeNull();
    }
  });
});

describe("FieldsListAdd", () => {
  test("replaces fields by id and appends new ones", () => {
    const f0 = new TextField({});
    const f1 = new TextField({ name: "test1" });
    const f2 = new TextField({ id: "f2Id", name: "test2" });
    const f3 = new TextField({ id: "f3Id", name: "test3" });
    const testFieldsList = newFieldsList(f0, f1, f2, f3);

    const f2New = new EmailField({ id: "f2Id", name: "test2_new" });
    const f4 = new URLField({ name: "test4" });

    testFieldsList.add(f2New);
    testFieldsList.add(f4);

    expect(testFieldsList.length).toBe(5);

    // check if each field has id
    for (const f of testFieldsList) {
      expect(f.getId()).not.toBe("");
    }

    // check if f2 field was replaced
    const byId = testFieldsList.getById("f2Id");
    expect(byId).not.toBeNull();
    expect(byId?.type()).toBe(FieldTypeEmail);

    // check if f4 was added
    const byName = testFieldsList.getByName("test4");
    expect(byName).not.toBeNull();
    expect(byName?.getName()).toBe("test4");
  });
});

describe("FieldsListAddMarshaledJSON", () => {
  const scenarios: {
    name: string;
    raw: string | Uint8Array;
    expectError: boolean;
    expectedFields: Record<string, string>;
  }[] = [
    {
      name: "nil",
      raw: new Uint8Array(),
      expectError: false,
      expectedFields: { abc: FieldTypeNumber },
    },
    {
      name: "empty array",
      raw: `[]`,
      expectError: false,
      expectedFields: { abc: FieldTypeNumber },
    },
    {
      name: "empty object",
      raw: `{}`,
      expectError: true,
      expectedFields: { abc: FieldTypeNumber },
    },
    {
      name: "array with empty object",
      raw: `[{}]`,
      expectError: true,
      expectedFields: { abc: FieldTypeNumber },
    },
    {
      name: "single object with invalid type",
      raw: `{"type":"missing","name":"test"}`,
      expectError: true,
      expectedFields: { abc: FieldTypeNumber },
    },
    {
      name: "single object with valid type",
      raw: `{"type":"text","name":"test"}`,
      expectError: false,
      expectedFields: {
        abc: FieldTypeNumber,
        test: FieldTypeText,
      },
    },
    {
      name: "array of object with valid types",
      raw: `[{"type":"text","name":"test1"},{"type":"url","name":"test2"}]`,
      expectError: false,
      expectedFields: {
        abc: FieldTypeNumber,
        test1: FieldTypeText,
        test2: FieldTypeURL,
      },
    },
    {
      name: "fields with duplicated ids should replace existing fields",
      raw: `[{"type":"text","name":"test1"},{"type":"url","name":"test2"},{"type":"text","name":"abc2", "id":"abc_id"}]`,
      expectError: false,
      expectedFields: {
        abc2: FieldTypeText,
        test1: FieldTypeText,
        test2: FieldTypeURL,
      },
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const testList = newFieldsList(new NumberField({ name: "abc", id: "abc_id" }));

      let hasErr = false;
      try {
        testList.addMarshaledJSON(s.raw);
      } catch {
        hasErr = true;
      }

      expect(hasErr).toBe(s.expectError);

      expect(testList.length).toBe(Object.keys(s.expectedFields).length);

      for (const [fieldName, typ] of Object.entries(s.expectedFields)) {
        const f = testList.getByName(fieldName);

        expect(f).not.toBeNull();
        expect(f?.type()).toBe(typ);
      }
    });
  }
});

describe("FieldsListAddAt", () => {
  const scenarios: { position: number; expected: string[] }[] = [
    { position: -2, expected: ["test1", "test2_new", "test3", "test4"] },
    { position: -1, expected: ["test1", "test2_new", "test3", "test4"] },
    { position: 0, expected: ["test2_new", "test4", "test1", "test3"] },
    { position: 1, expected: ["test1", "test2_new", "test4", "test3"] },
    { position: 2, expected: ["test1", "test3", "test2_new", "test4"] },
    { position: 3, expected: ["test1", "test3", "test2_new", "test4"] },
    { position: 4, expected: ["test1", "test3", "test2_new", "test4"] },
    { position: 5, expected: ["test1", "test3", "test2_new", "test4"] },
  ];

  for (const s of scenarios) {
    test(String(s.position), () => {
      const f1 = new TextField({ id: "f1Id", name: "test1" });
      const f2 = new TextField({ id: "f2Id", name: "test2" });
      const f3 = new TextField({ id: "f3Id", name: "test3" });
      const testFieldsList = newFieldsList(f1, f2, f3);

      const f2New = new EmailField({ id: "f2Id", name: "test2_new" });
      const f4 = new URLField({ name: "test4" });
      testFieldsList.addAt(s.position, f2New, f4);

      expect(testFieldsList.fieldNames()).toEqual(s.expected);
    });
  }
});

describe("FieldsListAddMarshaledJSONAt", () => {
  const scenarios: { position: number; expected: string[] }[] = [
    { position: -2, expected: ["test1", "test2_new", "test3", "test4"] },
    { position: -1, expected: ["test1", "test2_new", "test3", "test4"] },
    { position: 0, expected: ["test2_new", "test4", "test1", "test3"] },
    { position: 1, expected: ["test1", "test2_new", "test4", "test3"] },
    { position: 2, expected: ["test1", "test3", "test2_new", "test4"] },
    { position: 3, expected: ["test1", "test3", "test2_new", "test4"] },
    { position: 4, expected: ["test1", "test3", "test2_new", "test4"] },
    { position: 5, expected: ["test1", "test3", "test2_new", "test4"] },
  ];

  for (const s of scenarios) {
    test(String(s.position), () => {
      const f1 = new TextField({ id: "f1Id", name: "test1" });
      const f2 = new TextField({ id: "f2Id", name: "test2" });
      const f3 = new TextField({ id: "f3Id", name: "test3" });
      const testFieldsList = newFieldsList(f1, f2, f3);

      testFieldsList.addMarshaledJSONAt(
        s.position,
        `[
				{"id":"f2Id", "name":"test2_new", "type": "text"},
				{"name": "test4", "type": "text"}
			]`,
      );

      expect(testFieldsList.fieldNames()).toEqual(s.expected);
    });
  }
});

describe("FieldsListStringAndValue", () => {
  test("empty list", () => {
    const testFieldsList = new FieldsList();

    const str = testFieldsList.string();
    expect(str).toBe("[]");

    const v = testFieldsList.value();
    expect(v).toBe(str);
  });

  test("list with fields", () => {
    const testFieldsList = newFieldsList(
      new TextField({ id: "f1id", name: "test1" }),
      new BoolField({ id: "f2id", name: "test2" }),
      new URLField({ id: "f3id", name: "test3" }),
    );

    const str = testFieldsList.string();

    const v = testFieldsList.value();
    expect(v).toBe(str);

    const expectedParts = [
      `"type":"bool"`,
      `"type":"url"`,
      `"type":"text"`,
      `"id":"f1id"`,
      `"id":"f2id"`,
      `"id":"f3id"`,
      `"name":"test1"`,
      `"name":"test2"`,
      `"name":"test3"`,
    ];

    for (const part of expectedParts) {
      expect(str).toContain(part);
    }
  });
});

describe("FieldsListScan", () => {
  const scenarios: {
    name: string;
    data: unknown;
    expectError: boolean;
    expectJSON: string;
  }[] = [
    { name: "nil", data: null, expectError: false, expectJSON: "[]" },
    { name: "empty string", data: "", expectError: false, expectJSON: "[]" },
    { name: "empty byte", data: new Uint8Array(), expectError: false, expectJSON: "[]" },
    { name: "empty string array", data: "[]", expectError: false, expectJSON: "[]" },
    { name: "invalid string", data: "invalid", expectError: true, expectJSON: "[]" },
    { name: "non-string", data: 123, expectError: true, expectJSON: "[]" },
    { name: "item with no field type", data: `[{}]`, expectError: true, expectJSON: "[]" },
    {
      name: "unknown field type",
      data: `[{"id":"123","name":"test1","type":"unknown"},{"id":"456","name":"test2","type":"bool"}]`,
      expectError: true,
      expectJSON: `[]`,
    },
    {
      name: "only the minimum field options",
      data: `[{"id":"123","name":"test1","type":"text","required":true},{"id":"456","name":"test2","type":"bool"}]`,
      expectError: false,
      expectJSON: `[{"autogeneratePattern":"","help":"","hidden":false,"id":"123","max":0,"min":0,"name":"test1","pattern":"","presentable":false,"primaryKey":false,"required":true,"system":false,"type":"text"},{"help":"","hidden":false,"id":"456","name":"test2","presentable":false,"required":false,"system":false,"type":"bool"}]`,
    },
    {
      name: "all field options",
      data: `[{"autogeneratePattern":"","help":"abc","hidden":true,"id":"123","max":12,"min":0,"name":"test1","pattern":"","presentable":true,"primaryKey":false,"required":true,"system":false,"type":"text"},{"help":"def","hidden":false,"id":"456","name":"test2","presentable":false,"required":false,"system":true,"type":"bool"}]`,
      expectError: false,
      expectJSON: `[{"autogeneratePattern":"","help":"abc","hidden":true,"id":"123","max":12,"min":0,"name":"test1","pattern":"","presentable":true,"primaryKey":false,"required":true,"system":false,"type":"text"},{"help":"def","hidden":false,"id":"456","name":"test2","presentable":false,"required":false,"system":true,"type":"bool"}]`,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const testFieldsList = new FieldsList();

      let hasErr = false;
      try {
        testFieldsList.scan(s.data);
      } catch {
        hasErr = true;
      }

      expect(hasErr).toBe(s.expectError);

      expect(testFieldsList.string()).toBe(s.expectJSON);
    });
  }
});

describe("FieldsListJSON", () => {
  const scenarios: {
    name: string;
    data: string;
    expectError: boolean;
    expectJSON: string;
  }[] = [
    { name: "empty string", data: "", expectError: true, expectJSON: "[]" },
    { name: "invalid string", data: "invalid", expectError: true, expectJSON: "[]" },
    { name: "empty string array", data: "[]", expectError: false, expectJSON: "[]" },
    { name: "item with no field type", data: `[{}]`, expectError: true, expectJSON: "[]" },
    {
      name: "unknown field type",
      data: `[{"id":"123","name":"test1","type":"unknown"},{"id":"456","name":"test2","type":"bool"}]`,
      expectError: true,
      expectJSON: `[]`,
    },
    {
      name: "only the minimum field options",
      data: `[{"id":"123","name":"test1","type":"text","required":true},{"id":"456","name":"test2","type":"bool"}]`,
      expectError: false,
      expectJSON: `[{"autogeneratePattern":"","help":"","hidden":false,"id":"123","max":0,"min":0,"name":"test1","pattern":"","presentable":false,"primaryKey":false,"required":true,"system":false,"type":"text"},{"help":"","hidden":false,"id":"456","name":"test2","presentable":false,"required":false,"system":false,"type":"bool"}]`,
    },
    {
      name: "all field options",
      data: `[{"autogeneratePattern":"","help":"abc","hidden":true,"id":"123","max":12,"min":0,"name":"test1","pattern":"","presentable":true,"primaryKey":false,"required":true,"system":false,"type":"text"},{"help":"def","hidden":false,"id":"456","name":"test2","presentable":false,"required":false,"system":true,"type":"bool"}]`,
      expectError: false,
      expectJSON: `[{"autogeneratePattern":"","help":"abc","hidden":true,"id":"123","max":12,"min":0,"name":"test1","pattern":"","presentable":true,"primaryKey":false,"required":true,"system":false,"type":"text"},{"help":"def","hidden":false,"id":"456","name":"test2","presentable":false,"required":false,"system":true,"type":"bool"}]`,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const testFieldsList = new FieldsList();

      let hasErr = false;
      try {
        testFieldsList.unmarshalJSON(s.data);
      } catch {
        hasErr = true;
      }

      expect(hasErr).toBe(s.expectError);

      const str = testFieldsList.marshalJSON();
      expect(str).toBe(s.expectJSON);
    });
  }
});
