// Upstream: core/record_model_test.go (TestNewRecord through
// TestRecordReplaceModifiers, without TestRecordHookTags)
//
// Records upstream loads with app.FindRecordById or
// app.FindAuthRecordByEmail are read from a copy of the vendored fixture
// with newRecordFromNullStringMap (test/records/app.ts). Go's typed
// integers are bigints, float64 values are numbers, Go's time.Time is a
// Date, []byte is a Uint8Array, maps are plain objects.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { newAuthCollection, newBaseCollection } from "@/collections/collection-model";
import { FileField } from "@/fields/file";
import type { Field, GetterFunc, SetterFunc } from "@/fields/field";
import { JSONField } from "@/fields/json";
import { NumberField } from "@/fields/number";
import { RelationField } from "@/fields/relation";
import { SelectField } from "@/fields/select";
import { TextField } from "@/fields/text";
import { BoolField } from "@/fields/bool";
import { findCollectionByNameOrId } from "@/collections/collection-query";
import { type Record, newRecord } from "@/records/record-model";
import { NewFileFromBytes } from "@/tools/filesystem/file";
import { toString as castToString } from "@/tools/types/cast";
import { DateTime } from "@/tools/types/datetime";
import { GeoPoint } from "@/tools/types/geo-point";
import {
  anyType,
  boolType,
  intType,
  mapOf,
  marshal,
  sliceOf,
  stringType,
  type GoType,
} from "@/tools/types/go-json";
import { JSONRaw } from "@/tools/types/json-raw";

import { openTestApp, type TestCollectionsApp } from "@test/collections/app";
import { findAuthRecordByEmail, findRecordById } from "@test/records/app";

// mockField (core/record_model_test.go): a text field with a custom
// getter and setters
class MockField extends TextField {
  findGetter(key: string): GetterFunc | null {
    switch (key) {
      case this.name + ":test":
        return () => "modifier_get";
      default:
        return null;
    }
  }

  override findSetter(key: string): SetterFunc | null {
    switch (key) {
      case this.name:
        return (record, raw) => record.setRaw(this.name, castToString(raw));
      case this.name + ":test":
        return (record) => record.setRaw(this.name, "modifier_set");
      default:
        return null;
    }
  }
}

let app: TestCollectionsApp;

beforeAll(() => {
  app = openTestApp();
});

afterAll(() => {
  app.cleanup();
});

test("NewRecord", () => {
  const collection = newBaseCollection("test");
  collection.fields.add(new BoolField({ name: "status" }));

  const m = newRecord(collection);

  // should be initialized with the defaults
  expect(marshal(m.fieldsData())).toBe(`{"id":"","status":false}`);
});

test("RecordCollection", () => {
  const collection = newBaseCollection("test");

  const m = newRecord(collection);

  expect(m.collection().name).toBe(collection.name);
});

test("RecordTableName", () => {
  const collection = newBaseCollection("test");

  const m = newRecord(collection);

  expect(m.tableName()).toBe(collection.name);
});

test("RecordPostScan", () => {
  const collection = newBaseCollection("test_collection");
  collection.fields.add(new TextField({ name: "test" }));

  const m = newRecord(collection);

  // calling PostScan without id
  expect(() => m.postScan()).toThrow("missing record primary key");

  m.id = "test_id";
  m.set("test", "abc");

  // before PostScan
  expect(m.isNew()).toBe(true);
  expect(m.original().pk()).toBe("");
  expect(m.original().get("test")).toBe("");

  m.postScan();

  // after PostScan
  expect(m.isNew()).toBe(false);
  expect(m.original().pk()).toBe("test_id");
  expect(m.original().get("test")).toBe("abc");
});

test("RecordBaseFilesPath", () => {
  const collection = newBaseCollection("test");

  const m = newRecord(collection);
  m.id = "abc";

  expect(m.baseFilesPath()).toBe(collection.baseFilesPath() + "/" + m.id);
});

const extraFieldsCheck = [`"email":`, `"custom":`];

test("RecordOriginal", () => {
  const record = findAuthRecordByEmail(app, "users", "test@example.com");
  const originalId = record.id;
  const originalName = record.getString("name");

  // change the fields
  record.id = "changed";
  record.set("name", "name_new");
  record.set("custom", "test_custom");
  record.setExpand({ test: 123n });
  record.ignoreEmailVisibility(true);
  record.ignoreUnchangedFields(true);
  record.withCustomData(true);
  record.unhide(...record.collection().fields.fieldNames());

  // ensure that the email visibility and the custom data toggles are active
  const raw = record.marshalJSON();
  for (const f of extraFieldsCheck) {
    expect(raw).toContain(f);
  }

  // check changes
  expect(record.getString("name")).toBe("name_new");
  expect(record.getString("custom")).toBe("test_custom");

  // check original
  expect(record.original().pk()).toBe(originalId);
  expect(record.original().id).toBe(originalId);
  expect(record.original().getString("name")).toBe(originalName);
  expect(record.original().getString("custom")).toBe("");
  expect(Object.keys(record.original().expand())).toHaveLength(0);

  // ensure that the email visibility and the custom flag toggles weren't copied
  const originalRaw = record.original().marshalJSON();
  for (const f of extraFieldsCheck) {
    expect(originalRaw).not.toContain(f);
  }

  // loading new data shouldn't affect the original state
  record.load({ name: "name_new2" });

  expect(record.getString("name")).toBe("name_new2");
  expect(record.original().getString("name")).toBe(originalName);
});

test("RecordFresh", () => {
  const record = findAuthRecordByEmail(app, "users", "test@example.com");
  const originalId = record.id;

  const autodateTest = DateTime.fromDate(new Date());

  // change the fields
  record.id = "changed";
  record.set("name", "name_new");
  record.set("custom", "test_custom");
  record.setRaw("created", autodateTest);
  record.setExpand({ test: 123n });
  record.ignoreEmailVisibility(true);
  record.ignoreUnchangedFields(true);
  record.withCustomData(true);
  record.unhide(...record.collection().fields.fieldNames());

  // ensure that the email visibility and the custom data toggles are active
  const raw = record.marshalJSON();
  for (const f of extraFieldsCheck) {
    expect(raw).toContain(f);
  }

  // check changes
  expect(record.getString("name")).toBe("name_new");
  expect(record.getDateTime("created").string()).toBe(autodateTest.string());
  expect(record.getString("custom")).toBe("test_custom");

  // check fresh
  expect(record.fresh().lastSavedPK()).toBe(originalId);
  expect(record.fresh().pk()).toBe(record.id);
  expect(record.fresh().id).toBe(record.id);
  expect(record.fresh().getString("name")).toBe(record.getString("name"));
  expect(record.fresh().getDateTime("created").string()).toBe(autodateTest.string());
  expect(record.fresh().getDateTime("updated").string()).toBe(
    record.getDateTime("updated").string(),
  );
  expect(record.fresh().getString("custom")).toBe("");
  expect(Object.keys(record.fresh().expand())).toHaveLength(0);

  // ensure that the email visibility and the custom flag toggles weren't copied
  const freshRaw = record.fresh().marshalJSON();
  for (const f of extraFieldsCheck) {
    expect(freshRaw).not.toContain(f);
  }
});

test("RecordClone", () => {
  const record = findAuthRecordByEmail(app, "users", "test@example.com");
  const originalId = record.id;

  const autodateTest = DateTime.fromDate(new Date());

  // change the fields
  record.id = "changed";
  record.set("name", "name_new");
  record.set("custom", "test_custom");
  record.setRaw("created", autodateTest);
  record.setExpand({ test: 123n });
  record.ignoreEmailVisibility(true);
  record.withCustomData(true);
  record.unhide(...record.collection().fields.fieldNames());

  // ensure that the email visibility and the custom data toggles are active
  const raw = record.marshalJSON();
  for (const f of extraFieldsCheck) {
    expect(raw).toContain(f);
  }

  // check changes
  expect(record.getString("name")).toBe("name_new");
  expect(record.getDateTime("created").string()).toBe(autodateTest.string());
  expect(record.getString("custom")).toBe("test_custom");

  // check clone
  expect(record.clone().lastSavedPK()).toBe(originalId);
  expect(record.clone().pk()).toBe(record.id);
  expect(record.clone().id).toBe(record.id);
  expect(record.clone().getString("name")).toBe(record.getString("name"));
  expect(record.clone().getDateTime("created").string()).toBe(autodateTest.string());
  expect(record.clone().getDateTime("updated").string()).toBe(
    record.getDateTime("updated").string(),
  );
  expect(record.clone().getString("custom")).toBe("test_custom");
  expect(Object.hasOwn(record.clone().expand(), "test")).toBe(true);

  // ensure that the email visibility and the custom data toggles state were copied
  const cloneRaw = record.clone().marshalJSON();
  for (const f of extraFieldsCheck) {
    expect(cloneRaw).toContain(f);
  }
});

test("RecordExpand", () => {
  const record = newRecord(newBaseCollection("test"));

  let expand = record.expand();
  expect(expand).toEqual({});

  const data1 = { a: 123n, b: 456n };
  const data2: { [key: string]: unknown } = { c: 123n };
  record.setExpand(data1);
  record.setExpand(data2); // should overwrite the previous call

  // modify the expand map to check for shallow copy
  data2.d = 456n;

  expand = record.expand();
  expect(Object.keys(expand)).toHaveLength(1);
  expect(expand.c).toBe(123n);
});

test("RecordMergeExpand", () => {
  const collection = newBaseCollection("test");
  collection.id = "_pbc_123";

  const m = newRecord(collection);
  m.id = "m";

  const rec = (id: string): Record => {
    const r = newRecord(collection);
    r.id = id;
    return r;
  };

  // a
  const a = rec("a");
  const a1 = rec("a1");
  const a2 = rec("a2");
  const a3 = rec("a3");
  const a31 = rec("a31");
  const a32 = rec("a32");
  a.setExpand({ a1, a23: [a2, a3] });
  a3.setExpand({ a31, a32: [a32] });

  // b
  const b = rec("b");
  const b1 = rec("b1");
  b.setExpand({ b1 });

  // c
  const c = rec("c");

  // load initial expand
  m.setExpand({ a, b, c: [c] });

  // a (new)
  const aNew = rec(a.id);
  const a3New = rec(a3.id);
  const a32New = rec("a32New");
  const a33New = rec("a33New");
  a3New.setExpand({ a32: [a32New], a33New });
  aNew.setExpand({ a23: [a2, a3New] });

  // b (new)
  const bNew = rec("bNew");
  const dNew = rec("dNew");

  // merge expands
  m.mergeExpand({ a: aNew, b: [bNew], dNew });

  const expected = `{"a":{"collectionId":"_pbc_123","collectionName":"test","expand":{"a1":{"collectionId":"_pbc_123","collectionName":"test","id":"a1"},"a23":[{"collectionId":"_pbc_123","collectionName":"test","id":"a2"},{"collectionId":"_pbc_123","collectionName":"test","expand":{"a31":{"collectionId":"_pbc_123","collectionName":"test","id":"a31"},"a32":[{"collectionId":"_pbc_123","collectionName":"test","id":"a32"},{"collectionId":"_pbc_123","collectionName":"test","id":"a32New"}],"a33New":{"collectionId":"_pbc_123","collectionName":"test","id":"a33New"}},"id":"a3"}]},"id":"a"},"b":[{"collectionId":"_pbc_123","collectionName":"test","expand":{"b1":{"collectionId":"_pbc_123","collectionName":"test","id":"b1"}},"id":"b"},{"collectionId":"_pbc_123","collectionName":"test","id":"bNew"}],"c":[{"collectionId":"_pbc_123","collectionName":"test","id":"c"}],"dNew":{"collectionId":"_pbc_123","collectionName":"test","id":"dNew"}}`;

  expect(marshal(m.expand())).toBe(expected);
});

describe("RecordMergeExpandNilCheck", () => {
  const collection = newBaseCollection("test");
  collection.id = "_pbc_123";

  const scenarios: [string, { [key: string]: unknown } | null, string][] = [
    ["nil expand", null, `{"collectionId":"_pbc_123","collectionName":"test","id":""}`],
    ["empty expand", {}, `{"collectionId":"_pbc_123","collectionName":"test","id":""}`],
    [
      "non-empty expand",
      { test: newRecord(collection) },
      `{"collectionId":"_pbc_123","collectionName":"test","expand":{"test":{"collectionId":"_pbc_123","collectionName":"test","id":""}},"id":""}`,
    ],
  ];

  for (const [name, expand, expected] of scenarios) {
    test(name, () => {
      const m = newRecord(collection);
      m.mergeExpand(expand);

      expect(marshal(m)).toBe(expected);
    });
  }
});

function expandFixture(): Record {
  const collection = newBaseCollection("test");

  const main = newRecord(collection);

  const single = newRecord(collection);
  single.id = "single";

  const multiple1 = newRecord(collection);
  multiple1.id = "multiple1";

  const multiple2 = newRecord(collection);
  multiple2.id = "multiple2";

  main.setExpand({ single, multiple: [multiple1, multiple2] });

  return main;
}

test("RecordExpandedOne", () => {
  const main = expandFixture();

  expect(main.expandedOne("missing")).toBeNull();
  expect(main.expandedOne("single")?.id).toBe("single");
  expect(main.expandedOne("multiple")?.id).toBe("multiple1");
});

test("RecordExpandedAll", () => {
  const main = expandFixture();

  expect(main.expandedAll("missing")).toBeNull();
  expect(main.expandedAll("single")?.map((r) => r.id)).toEqual(["single"]);
  expect(main.expandedAll("multiple")?.map((r) => r.id)).toEqual(["multiple1", "multiple2"]);
});

function authFieldsRecord(): Record {
  const collection = newAuthCollection("test");
  collection.fields.add(new TextField({ name: "field1" }));
  collection.fields.add(new TextField({ name: "field2" }));

  const m = newRecord(collection);
  m.id = "test_id"; // direct id assignment
  m.set("email", "test@example.com");
  m.set("password", "123"); // hidden fields should be also returned
  m.set("tokenKey", "789");
  m.set("field1", 123n);
  m.set("field2", 456n);
  m.set("unknown", 789n);
  return m;
}

test("RecordFieldsData", () => {
  const m = authFieldsRecord();

  expect(marshal(m.fieldsData())).toBe(
    `{"email":"test@example.com","emailVisibility":false,"field1":"123","field2":"456","id":"test_id","password":"123","tokenKey":"789","verified":false}`,
  );
});

test("RecordCustomData", () => {
  const m = authFieldsRecord();

  expect(marshal(m.customData())).toBe(`{"unknown":789}`);
});

describe("RecordSetGet", () => {
  const collection = newBaseCollection("test");
  collection.fields.add(new TextField({ name: "text1" }));
  collection.fields.add(new TextField({ name: "text2" }));
  collection.fields.add(new MockField({ name: "mock1" }));
  collection.fields.add(new MockField({ name: "mock2" }));
  collection.fields.add(new MockField({ name: "mock3" }));

  const record = newRecord(collection);
  record.set("text1", 123n); // should be converted to string using the ScanValue fallback
  record.setRaw("text2", 456n);
  record.set("mock1", 1n); // should be converted to string using the setter
  record.setRaw("mock2", 1n);
  record.set("mock3:test", "abc");
  record.set("unknown", 789n);

  test("GetRaw", () => {
    const expected: [string, unknown][] = [
      ["text1", "123"],
      ["text2", 456n],
      ["mock1", "1"],
      ["mock2", 1n],
      ["mock3", "modifier_set"],
      ["mock3:test", undefined], // Go's nil
      ["unknown", 789n],
    ];
    for (const [k, v] of expected) {
      expect(record.getRaw(k)).toBe(v);
    }
  });

  test("Get", () => {
    const expected: [string, unknown][] = [
      ["text1", "123"],
      ["text2", 456n],
      ["mock1", "1"],
      ["mock2", 1n],
      ["mock3", "modifier_set"],
      ["mock3:test", "modifier_get"],
      ["unknown", 789n],
    ];
    for (const [k, v] of expected) {
      expect(record.get(k)).toBe(v);
    }
  });
});

test("RecordLoad", () => {
  const collection = newBaseCollection("test");
  collection.fields.add(new TextField({ name: "text" }));

  const record = newRecord(collection);
  record.load({ text: 123n, custom: 456n });

  expect(record.get("text")).toBe("123");
  expect(record.get("custom")).toBe(456n);
});

// runs a typed getter table on a custom ("test") key
function getterTable<T>(
  name: string,
  scenarios: [unknown, T][],
  getter: (record: Record) => unknown,
  check: (result: unknown, expected: T) => void = (result, expected) =>
    expect(result).toEqual(expected),
): void {
  describe(name, () => {
    const record = newRecord(newBaseCollection("test"));

    for (const [i, [value, expected]] of scenarios.entries()) {
      test(`${i} ${String(value)}`, () => {
        record.set("test", value);
        check(getter(record), expected);
      });
    }
  });
}

getterTable<boolean>(
  "RecordGetBool",
  [
    [null, false],
    ["", false],
    [0n, false],
    [1n, true],
    [["true"], false],
    [new Date(), false],
    ["test", false],
    ["false", false],
    ["true", true],
    [false, false],
    [true, true],
  ],
  (r) => r.getBool("test"),
);

getterTable<string>(
  "RecordGetString",
  [
    [null, ""],
    ["", ""],
    [0n, "0"],
    [1.4, "1.4"],
    [["true"], ""],
    [{ test: 1n }, ""],
    [new TextEncoder().encode("abc"), "abc"],
    ["test", "test"],
    [false, "false"],
    [true, "true"],
  ],
  (r) => r.getString("test"),
);

getterTable<number | bigint>(
  "RecordGetInt",
  [
    [null, 0],
    ["", 0],
    [["true"], 0],
    [{ test: 1n }, 0],
    [new Date(), 0],
    ["test", 0],
    [123n, 123],
    [2.4, 2],
    ["123", 123],
    ["123.5", 123],
    [false, 0],
    [true, 1],
  ],
  (r) => r.getInt("test"),
);

getterTable<number | bigint>(
  "RecordGetInt64",
  [
    [null, 0],
    ["", 0],
    [["true"], 0],
    [{ test: 1n }, 0],
    [new Date(), 0],
    ["test", 0],
    [123n, 123],
    [2.4, 2],
    [2n ** 63n - 1n, 2n ** 63n - 1n],
    ["123", 123],
    ["123.5", 123],
    [false, 0],
    [true, 1],
  ],
  (r) => r.getInt64("test"),
);

getterTable<number>(
  "RecordGetFloat",
  [
    [null, 0],
    ["", 0],
    [["true"], 0],
    [{ test: 1n }, 0],
    [new Date(), 0],
    ["test", 0],
    [123n, 123],
    [2.4, 2.4],
    ["123", 123],
    ["123.5", 123.5],
    [false, 0],
    [true, 1],
  ],
  (r) => r.getFloat("test"),
);

{
  const nowTime = new Date();
  const testTime = new Date("2022-01-01T08:00:40.000Z");
  const zeroTime = new DateTime();

  getterTable<DateTime>(
    "RecordGetDateTime",
    [
      [null, zeroTime],
      ["", zeroTime],
      [false, zeroTime],
      [true, zeroTime],
      ["test", zeroTime],
      [["true"], zeroTime],
      [{ test: 1n }, zeroTime],
      [1641024040n, DateTime.fromDate(testTime)],
      ["2022-01-01 08:00:40.000", DateTime.fromDate(testTime)],
      [nowTime, DateTime.fromDate(nowTime)],
    ],
    (r) => r.getDateTime("test"),
    (result, expected) => expect((result as DateTime).equal(expected)).toBe(true),
  );
}

getterTable<string[]>(
  "RecordGetStringSlice",
  [
    [null, []],
    ["", []],
    [false, ["false"]],
    [true, ["true"]],
    [new Date(), []],
    [123n, ["123"]],
    ["test", ["test"]],
    [{ test: 1n }, []],
    [`["test1", "test2"]`, ["test1", "test2"]],
    [
      [123n, 123n, 456n],
      ["123", "456"],
    ],
    [
      ["test", "test", "123"],
      ["test", "123"],
    ],
  ],
  (r) => r.getStringSlice("test"),
  (result, expected) => expect((result as string[]).toSorted()).toEqual(expected.toSorted()),
);

getterTable<string>(
  "RecordGetGeoPoint",
  [
    [null, `{"lon":0,"lat":0}`],
    ["", `{"lon":0,"lat":0}`],
    [0n, `{"lon":0,"lat":0}`],
    [false, `{"lon":0,"lat":0}`],
    ["{}", `{"lon":0,"lat":0}`],
    ["[]", `{"lon":0,"lat":0}`],
    [[1n, 2n], `{"lon":0,"lat":0}`],
    [{ lon: 1n, lat: 2n }, `{"lon":1,"lat":2}`],
    [new TextEncoder().encode(`{"lon":1,"lat":2}`), `{"lon":1,"lat":2}`],
    [`{"lon":1,"lat":2}`, `{"lon":1,"lat":2}`],
    [new GeoPoint(1, 2), `{"lon":1,"lat":2}`],
  ],
  (r) => r.getGeoPoint("test").string(),
);

describe("RecordGetUnsavedFiles", () => {
  let record: Record;

  beforeAll(async () => {
    const f1 = await NewFileFromBytes(new TextEncoder().encode("test"), "f1");
    f1.name = "f1";

    const f2 = await NewFileFromBytes(new TextEncoder().encode("test"), "f2");
    f2.name = "f2";

    record = findRecordById(app, "demo3", "lcl9d87w22ml6jy");
    record.set("files+", [f1, f2]);
  });

  const scenarios: [string, string][] = [
    ["", "null"],
    ["title", "null"],
    [
      "files",
      `[{"name":"f1","originalName":"f1","size":4},{"name":"f2","originalName":"f2","size":4}]`,
    ],
    [
      "files:unsaved",
      `[{"name":"f1","originalName":"f1","size":4},{"name":"f2","originalName":"f2","size":4}]`,
    ],
  ];

  for (const [i, [key, expected]] of scenarios.entries()) {
    test(`${i} ${JSON.stringify(key)}`, () => {
      // json.FormatNilSliceAsNull(true): Go's nil slice is null
      expect(marshal(record.getUnsavedFiles(key))).toBe(expected);
      expect(marshal(record.getUploadedFiles(key))).toBe(expected);
    });
  }
});

describe("RecordUnmarshalJSONField", () => {
  const collection = newBaseCollection("test");
  collection.fields.add(new JSONField({ name: "field" }));

  const record = newRecord(collection);

  // the Go destination types: *string, string, int, bool, []int,
  // map[string]any
  const testPointer = anyType;
  const testStr = stringType;
  const testInt = intType;
  const testBool = boolType;
  const testSlice = sliceOf(intType);
  const testMap = mapOf(anyType);

  const scenarios: [unknown, GoType, boolean, string][] = [
    [null, testPointer, false, `null`],
    [null, testStr, false, `""`],
    ["", testStr, false, `""`],
    [1n, testInt, false, `1`],
    [true, testBool, false, `true`],
    [[1n, 2n, 3n], testSlice, false, `[1,2,3]`],
    [{ test: 123n }, testMap, false, `{"test":123}`],
    // json encoded values
    [`null`, testPointer, false, `null`],
    [`true`, testBool, false, `true`],
    [`456`, testInt, false, `456`],
    [`"test"`, testStr, false, `"test"`],
    [`[4,5,6]`, testSlice, false, `[4,5,6]`],
    [`{"test":456}`, testMap, false, `{"test":456}`],
  ];

  for (const [i, [value, destination, expectError, expectedJSON]] of scenarios.entries()) {
    test(`${i} ${String(value)}`, () => {
      record.set("field", value);

      let result: unknown;
      let hasErr = false;
      try {
        result = record.unmarshalJSONField("field", destination);
      } catch {
        hasErr = true;
      }

      expect(hasErr).toBe(expectError);
      expect(marshal(result)).toBe(expectedJSON);
    });
  }
});

describe("RecordFindFileFieldByFile", () => {
  const collection = newBaseCollection("test");
  collection.fields.add(
    new TextField({ name: "field1" }),
    new FileField({ name: "field2", maxSelect: 1, maxSize: 1 }),
    new FileField({ name: "field3", maxSelect: 2, maxSize: 1 }),
  );

  const m = newRecord(collection);
  m.set("field1", "test");
  m.set("field2", "test.png");
  m.set("field3", ["test1.png", "test2.png"]);

  const scenarios: [string, string][] = [
    ["", ""],
    ["test", ""],
    ["test2", ""],
    ["test.png", "field2"],
    ["test2.png", "field3"],
  ];

  for (const [i, [filename, expectField]] of scenarios.entries()) {
    test(`${i} ${JSON.stringify(filename)}`, () => {
      const result = m.findFileFieldByFile(filename);
      expect(result?.name ?? "").toBe(expectField);
    });
  }
});

function dbExportFields(): Field[] {
  return [
    new TextField({ name: "field1" }),
    new FileField({ name: "field2", maxSelect: 1, maxSize: 1 }),
    new SelectField({ name: "field3", maxSelect: 2, values: ["test1", "test2", "test3"] }),
    new RelationField({ name: "field4", maxSelect: 2 }),
  ];
}

describe("RecordDBExport", () => {
  const colBase = newBaseCollection("test_base");
  colBase.fields.add(...dbExportFields());

  const colAuth = newAuthCollection("test_auth");
  colAuth.fields.add(...dbExportFields());

  const scenarios = [
    {
      collection: colBase,
      expected: `{"field1":"test","field2":"test.png","field3":["test1","test2"],"field4":["test11","test12"],"id":"test_id"}`,
    },
    {
      collection: colAuth,
      expected: `{"email":"test_email","emailVisibility":true,"field1":"test","field2":"test.png","field3":["test1","test2"],"field4":["test11","test12"],"id":"test_id","password":"_TEST_","tokenKey":"test_tokenKey","verified":false}`,
    },
  ];

  const data = {
    id: "test_id",
    field1: "test",
    field2: "test.png",
    field3: ["test1", "test2"],
    field4: ["test11", "test12", "test11"], // strip duplicate,
    unknown: "test_unknown",
    password: "test_passwordHash",
    username: "test_username",
    emailVisibility: true,
    email: "test_email",
    verified: "invalid", // should be casted
    tokenKey: "test_tokenKey",
  };

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${s.collection.type}_${s.collection.name}`, () => {
      const record = newRecord(s.collection);

      record.load(data);

      const rawStr = marshal(record.dbExport());

      // replace _TEST_ placeholder with .+ regex pattern
      const pattern = new RegExp("^" + RegExp.escape(s.expected).replaceAll("_TEST_", ".+") + "$");
      expect(rawStr).toMatch(pattern);
    });
  }
});

describe("RecordIgnoreUnchangedFields", () => {
  let scenarios: { ignoreUnchangedFields: boolean; record: Record; expected: string[] }[] = [];

  beforeAll(() => {
    const col = findCollectionByNameOrId(app, "demo3");

    const fresh = newRecord(col);

    const existing = findRecordById(app, col, "mk5fmymtx4wsprk");
    existing.set("title", "test_new");
    existing.set("files", existing.get("files")); // no change

    scenarios = [
      {
        ignoreUnchangedFields: false,
        record: fresh,
        expected: ["id", "created", "updated", "title", "files"],
      },
      {
        ignoreUnchangedFields: true,
        record: fresh,
        expected: ["id", "created", "updated", "title", "files"],
      },
      {
        ignoreUnchangedFields: false,
        record: existing,
        expected: ["id", "created", "updated", "title", "files"],
      },
      { ignoreUnchangedFields: true, record: existing, expected: ["id", "title"] },
    ];
  });

  for (const i of [0, 1, 2, 3]) {
    test(String(i), () => {
      const s = scenarios[i] as (typeof scenarios)[number];
      s.record.ignoreUnchangedFields(s.ignoreUnchangedFields);

      const result = s.record.dbExport();

      expect(Object.keys(result).toSorted()).toEqual(s.expected.toSorted());
    });
  }
});

function publicExportFields(): Field[] {
  return [
    new TextField({ name: "field1" }),
    new FileField({ name: "field2", maxSelect: 1, maxSize: 1 }),
    new SelectField({ name: "field3", maxSelect: 2, values: ["test1", "test2", "test3"] }),
    new TextField({ name: "field4", hidden: true }),
    new TextField({ name: "field5", hidden: true }),
    new JSONField({ name: "field6" }),
  ];
}

describe("RecordPublicExportAndMarshalJSON", () => {
  const colBase = newBaseCollection("test_base");
  colBase.id = "_pbc_base_123";
  colBase.fields.add(...publicExportFields());

  const colAuth = newAuthCollection("test_auth");
  colAuth.id = "_pbc_auth_123";
  colAuth.fields.add(...publicExportFields());

  const scenarios: {
    name: string;
    collection: typeof colBase;
    ignoreEmailVisibility: boolean;
    withCustomData: boolean;
    hideFields: string[];
    unhideFields: string[];
    expectedJSON: string;
  }[] = [
    // base
    {
      name: "[base] no extra flags",
      collection: colBase,
      ignoreEmailVisibility: false,
      withCustomData: false,
      hideFields: [],
      unhideFields: [],
      expectedJSON: `{"collectionId":"_pbc_base_123","collectionName":"test_base","expand":{"test":123},"field1":"field_1�","field2":"field_2.png","field3":["test1","test2"],"field6":{"a":1,"a":2},"id":"test_id"}`,
    },
    {
      name: "[base] with email visibility",
      collection: colBase,
      ignoreEmailVisibility: true, // should have no effect
      withCustomData: false,
      hideFields: [],
      unhideFields: [],
      expectedJSON: `{"collectionId":"_pbc_base_123","collectionName":"test_base","expand":{"test":123},"field1":"field_1�","field2":"field_2.png","field3":["test1","test2"],"field6":{"a":1,"a":2},"id":"test_id"}`,
    },
    {
      name: "[base] with custom data",
      collection: colBase,
      ignoreEmailVisibility: true, // should have no effect
      withCustomData: true,
      hideFields: [],
      unhideFields: [],
      expectedJSON: `{"collectionId":"_pbc_base_123","collectionName":"test_base","email":"test_email","emailVisibility":"test_invalid","expand":{"test":123},"field1":"field_1�","field2":"field_2.png","field3":["test1","test2"],"field6":{"a":1,"a":2},"id":"test_id","password":"test_passwordHash","tokenKey":"test_tokenKey","unknown":"test_unknown","verified":true}`,
    },
    {
      name: "[base] with explicit hide and unhide fields",
      collection: colBase,
      ignoreEmailVisibility: false,
      withCustomData: true,
      hideFields: [
        "field3",
        "field1",
        "expand",
        "collectionId",
        "collectionName",
        "email",
        "tokenKey",
        "unknown",
      ],
      unhideFields: ["field4", "@pbInternalAbc"],
      expectedJSON: `{"emailVisibility":"test_invalid","field2":"field_2.png","field4":"field_4","field6":{"a":1,"a":2},"id":"test_id","password":"test_passwordHash","verified":true}`,
    },
    {
      name: "[base] trying to unhide custom fields without explicit WithCustomData",
      collection: colBase,
      ignoreEmailVisibility: false,
      withCustomData: true,
      hideFields: [],
      unhideFields: ["field5", "@pbInternalAbc", "email", "tokenKey", "unknown"],
      expectedJSON: `{"collectionId":"_pbc_base_123","collectionName":"test_base","email":"test_email","emailVisibility":"test_invalid","expand":{"test":123},"field1":"field_1�","field2":"field_2.png","field3":["test1","test2"],"field5":"field_5","field6":{"a":1,"a":2},"id":"test_id","password":"test_passwordHash","tokenKey":"test_tokenKey","unknown":"test_unknown","verified":true}`,
    },

    // auth
    {
      name: "[auth] no extra flags",
      collection: colAuth,
      ignoreEmailVisibility: false,
      withCustomData: false,
      hideFields: [],
      unhideFields: [],
      expectedJSON: `{"collectionId":"_pbc_auth_123","collectionName":"test_auth","emailVisibility":false,"expand":{"test":123},"field1":"field_1�","field2":"field_2.png","field3":["test1","test2"],"field6":{"a":1,"a":2},"id":"test_id","verified":true}`,
    },
    {
      name: "[auth] with email visibility",
      collection: colAuth,
      ignoreEmailVisibility: true,
      withCustomData: false,
      hideFields: [],
      unhideFields: [],
      expectedJSON: `{"collectionId":"_pbc_auth_123","collectionName":"test_auth","email":"test_email","emailVisibility":false,"expand":{"test":123},"field1":"field_1�","field2":"field_2.png","field3":["test1","test2"],"field6":{"a":1,"a":2},"id":"test_id","verified":true}`,
    },
    {
      name: "[auth] with custom data",
      collection: colAuth,
      ignoreEmailVisibility: false,
      withCustomData: true,
      hideFields: [],
      unhideFields: [],
      expectedJSON: `{"collectionId":"_pbc_auth_123","collectionName":"test_auth","emailVisibility":false,"expand":{"test":123},"field1":"field_1�","field2":"field_2.png","field3":["test1","test2"],"field6":{"a":1,"a":2},"id":"test_id","unknown":"test_unknown","verified":true}`,
    },
    {
      name: "[auth] with explicit hide and unhide fields",
      collection: colAuth,
      ignoreEmailVisibility: true,
      withCustomData: true,
      hideFields: [
        "field3",
        "field1",
        "expand",
        "collectionId",
        "collectionName",
        "email",
        "unknown",
      ],
      unhideFields: ["field4", "@pbInternalAbc"],
      expectedJSON: `{"emailVisibility":false,"field2":"field_2.png","field4":"field_4","field6":{"a":1,"a":2},"id":"test_id","verified":true}`,
    },
    {
      name: "[auth] trying to unhide custom fields without explicit WithCustomData",
      collection: colAuth,
      ignoreEmailVisibility: false,
      withCustomData: true,
      hideFields: [],
      // emailVisibility:false has higher priority
      unhideFields: ["field5", "@pbInternalAbc", "tokenKey", "unknown", "email"],
      expectedJSON: `{"collectionId":"_pbc_auth_123","collectionName":"test_auth","emailVisibility":false,"expand":{"test":123},"field1":"field_1�","field2":"field_2.png","field3":["test1","test2"],"field5":"field_5","field6":{"a":1,"a":2},"id":"test_id","unknown":"test_unknown","verified":true}`,
    },
  ];

  const data = {
    id: "test_id",
    field1: "field_1\udcc3" /* invalid utf8 suffix (the byte 0xc3) to test mangling */,
    field2: "field_2.png",
    field3: ["test1", "test2"],
    field4: "field_4",
    field5: "field_5",
    field6: new JSONRaw(`{"a":1,"a":2}`), // intentionally duplicated to check serialization
    expand: { test: 123n },
    collectionId: "m_id", // should be always ignored
    collectionName: "m_name", // should be always ignored
    unknown: "test_unknown",
    password: "test_passwordHash",
    emailVisibility: "test_invalid", // for auth collections should be casted to bool
    email: "test_email",
    verified: true,
    tokenKey: "test_tokenKey",
    "@pbInternalAbc": "test_custom_inter", // always hidden
  };

  for (const s of scenarios) {
    test(s.name, () => {
      const m = newRecord(s.collection);

      m.load(data);
      m.ignoreEmailVisibility(s.ignoreEmailVisibility);
      m.withCustomData(s.withCustomData);
      m.unhide(...s.unhideFields);
      m.hide(...s.hideFields);

      const exportResult = marshal(m.publicExport(), {
        allowDuplicateNames: true,
        allowInvalidUTF8: true,
      });

      // MarshalJSON and PublicExport should return the same
      expect(m.marshalJSON()).toBe(exportResult);

      expect(exportResult).toBe(s.expectedJSON);
    });
  }
});

test("RecordUnmarshalJSON", () => {
  const collection = newBaseCollection("test");
  collection.fields.add(new TextField({ name: "text" }));

  const record = newRecord(collection);

  record.unmarshalJSON(marshal({ text: 123n, custom: 456.789 }));

  expect(record.get("text")).toBe("123");
  expect(record.get("custom")).toBe(456.789);
});

test("RecordReplaceModifiers", () => {
  const collection = newBaseCollection("test");
  collection.fields.add(new MockField({ name: "mock" }), new NumberField({ name: "number" }));

  const originalData: [string, unknown][] = [
    ["mock", "a"],
    ["number", 2.1],
  ];

  const record = newRecord(collection);
  for (const [k, v] of originalData) {
    record.set(k, v);
  }

  const result = record.replaceModifiers({
    "mock:test": "b",
    "number+": 3n,
  });

  expect(result).toEqual({ mock: "modifier_set", number: 5.1 });

  // ensure that the original data hasn't changed
  for (const [k, v] of originalData) {
    expect(record.get(k)).toBe(v);
  }
});
