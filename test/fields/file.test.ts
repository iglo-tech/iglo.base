// Upstream: core/field_file_test.go

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { DefaultFileFieldMaxSize, FieldTypeFile, FileField } from "@/fields/file";
import { File, NewFileFromBytes } from "@/tools/filesystem/file";
import { marshal } from "@/tools/types/go-json";

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

// a value that is only known once the files are created (in beforeAll)
type Lazy<T> = T | (() => T);

function resolve<T>(value: Lazy<T>): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

function label(raw: Lazy<unknown>): string {
  return typeof raw === "function" ? "file" : String(raw);
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("TestFileFieldBaseMethods", () => {
  testFieldBaseMethods(FieldTypeFile);
});

describe("TestFileFieldColumnType", () => {
  const app = noDBApp();

  const scenarios: { name: string; field: FileField; expected: string }[] = [
    { name: "single (zero)", field: new FileField(), expected: "TEXT DEFAULT '' NOT NULL" },
    {
      name: "single",
      field: new FileField({ maxSelect: 1 }),
      expected: "TEXT DEFAULT '' NOT NULL",
    },
    {
      name: "multiple",
      field: new FileField({ maxSelect: 2 }),
      expected: "JSON DEFAULT '[]' NOT NULL",
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      expect(s.field.columnType(app)).toBe(s.expected);
    });
  }
});

describe("TestFileFieldIsMultiple", () => {
  const scenarios: { name: string; field: FileField; expected: boolean }[] = [
    { name: "zero", field: new FileField(), expected: false },
    { name: "single", field: new FileField({ maxSelect: 1 }), expected: false },
    { name: "multiple", field: new FileField({ maxSelect: 2 }), expected: true },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      expect(s.field.isMultiple()).toBe(s.expected);
    });
  }
});

describe("TestFileFieldPrepareValue", () => {
  const record = new TestRecord(newBaseCollection("test"));

  let f1: File;
  let f1Raw: string;

  beforeAll(async () => {
    f1 = await NewFileFromBytes(bytes("test"), "test1.txt");
    f1Raw = marshal(f1);
  });

  const scenarios: { raw: Lazy<unknown>; field: FileField; expected: Lazy<string> }[] = [
    // single
    { raw: null, field: new FileField({ maxSelect: 1 }), expected: `""` },
    { raw: "", field: new FileField({ maxSelect: 1 }), expected: `""` },
    { raw: 123, field: new FileField({ maxSelect: 1 }), expected: `"123"` },
    { raw: "a", field: new FileField({ maxSelect: 1 }), expected: `"a"` },
    { raw: `["a"]`, field: new FileField({ maxSelect: 1 }), expected: `"a"` },
    { raw: () => f1, field: new FileField({ maxSelect: 1 }), expected: () => f1Raw },
    { raw: () => f1, field: new FileField({ maxSelect: 1 }), expected: () => f1Raw },
    { raw: null as File | null, field: new FileField({ maxSelect: 1 }), expected: `""` },
    { raw: [], field: new FileField({ maxSelect: 1 }), expected: `""` },
    { raw: ["a", "b"], field: new FileField({ maxSelect: 1 }), expected: `"b"` },

    // multiple
    { raw: null, field: new FileField({ maxSelect: 2 }), expected: `[]` },
    { raw: "", field: new FileField({ maxSelect: 2 }), expected: `[]` },
    { raw: 123, field: new FileField({ maxSelect: 2 }), expected: `["123"]` },
    { raw: "a", field: new FileField({ maxSelect: 2 }), expected: `["a"]` },
    { raw: `["a"]`, field: new FileField({ maxSelect: 2 }), expected: `["a"]` },
    { raw: () => [f1], field: new FileField({ maxSelect: 2 }), expected: () => `[${f1Raw}]` },
    { raw: () => [f1], field: new FileField({ maxSelect: 2 }), expected: () => `[${f1Raw}]` },
    { raw: () => [f1], field: new FileField({ maxSelect: 2 }), expected: () => `[${f1Raw}]` },
    { raw: () => [null, f1], field: new FileField({ maxSelect: 2 }), expected: () => `[${f1Raw}]` },
    { raw: [], field: new FileField({ maxSelect: 2 }), expected: `[]` },
    {
      raw: ["a", "b", "c"],
      field: new FileField({ maxSelect: 2 }),
      expected: `["a","b","c"]`,
    },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${label(s.raw)}_${s.field.isMultiple()}`, () => {
      const [v, err] = s.field.prepareValue(record, resolve(s.raw));
      expect(err).toBeNull();

      expect(marshal(v)).toBe(resolve(s.expected));
    });
  }
});

describe("TestFileFieldDriverValue", () => {
  let f1: File;

  beforeAll(async () => {
    f1 = await NewFileFromBytes(bytes("test"), "test.txt");
  });

  const scenarios: { raw: Lazy<unknown>; field: FileField; expected: Lazy<string> }[] = [
    // single
    { raw: null, field: new FileField({ maxSelect: 1 }), expected: `""` },
    { raw: "", field: new FileField({ maxSelect: 1 }), expected: `""` },
    { raw: 123, field: new FileField({ maxSelect: 1 }), expected: `"123"` },
    { raw: "a", field: new FileField({ maxSelect: 1 }), expected: `"a"` },
    { raw: `["a"]`, field: new FileField({ maxSelect: 1 }), expected: `"a"` },
    { raw: () => f1, field: new FileField({ maxSelect: 1 }), expected: () => `"${f1.name}"` },
    { raw: [], field: new FileField({ maxSelect: 1 }), expected: `""` },
    { raw: ["a", "b"], field: new FileField({ maxSelect: 1 }), expected: `"b"` },

    // multiple
    { raw: null, field: new FileField({ maxSelect: 2 }), expected: `[]` },
    { raw: "", field: new FileField({ maxSelect: 2 }), expected: `[]` },
    { raw: 123, field: new FileField({ maxSelect: 2 }), expected: `["123"]` },
    { raw: "a", field: new FileField({ maxSelect: 2 }), expected: `["a"]` },
    { raw: `["a"]`, field: new FileField({ maxSelect: 2 }), expected: `["a"]` },
    {
      raw: () => ["a", f1],
      field: new FileField({ maxSelect: 2 }),
      expected: () => `["a","${f1.name}"]`,
    },
    { raw: [], field: new FileField({ maxSelect: 2 }), expected: `[]` },
    {
      raw: ["a", "b", "c"],
      field: new FileField({ maxSelect: 2 }),
      expected: `["a","b","c"]`,
    },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${label(s.raw)}_${s.field.isMultiple()}`, () => {
      const record = new TestRecord(newBaseCollection("test"));
      record.setRaw(s.field.getName(), resolve(s.raw));

      const [v, err] = s.field.driverValue(record);
      expect(err).toBeNull();

      if (s.field.isMultiple()) {
        expect(Array.isArray(v)).toBe(true);
      } else {
        expect(typeof v).toBe("string");
      }

      expect(marshal(v)).toBe(resolve(s.expected));
    });
  }
});

describe("TestFileFieldValidateValue", () => {
  const app = TestApp.open();
  afterAll(() => app.cleanup());

  const collection = newBaseCollection("test_collection");

  let f1: File;
  let f2: File;
  let f3: File;
  let f4: File;
  let f5: File;

  beforeAll(async () => {
    f1 = await NewFileFromBytes(bytes("test"), "test1.txt");
    f2 = await NewFileFromBytes(bytes("test"), "test2.txt");
    f3 = await NewFileFromBytes(bytes("test_abc"), "test3.txt");
    f4 = await NewFileFromBytes(new Uint8Array(DefaultFileFieldMaxSize + 1), "test4.txt");
    f5 = await NewFileFromBytes(new Uint8Array(DefaultFileFieldMaxSize), "test5.txt");
  });

  const scenarios: {
    name: string;
    field: FileField;
    record: () => TestRecord;
    expectError: boolean;
  }[] = [
    // single
    {
      name: "zero field value (not required)",
      field: new FileField({ name: "test", maxSize: 9999, maxSelect: 1 }),
      record: () => {
        const record = new TestRecord(collection);
        record.setRaw("test", "");
        return record;
      },
      expectError: false,
    },
    {
      name: "zero field value (required)",
      field: new FileField({ name: "test", maxSize: 9999, maxSelect: 1, required: true }),
      record: () => {
        const record = new TestRecord(collection);
        record.setRaw("test", "");
        return record;
      },
      expectError: true,
    },
    {
      name: "new plain filename", // new files must be *filesystem.File
      field: new FileField({ name: "test", maxSize: 9999, maxSelect: 1 }),
      record: () => {
        const record = new TestRecord(collection);
        record.setRaw("test", "a");
        return record;
      },
      expectError: true,
    },
    {
      name: "new file",
      field: new FileField({ name: "test", maxSize: 9999, maxSelect: 1 }),
      record: () => {
        const record = new TestRecord(collection);
        record.setRaw("test", f1);
        return record;
      },
      expectError: false,
    },
    {
      name: "new files > MaxSelect",
      field: new FileField({ name: "test", maxSize: 9999, maxSelect: 1 }),
      record: () => {
        const record = new TestRecord(collection);
        record.setRaw("test", [f1, f2]);
        return record;
      },
      expectError: true,
    },
    {
      name: "new files <= MaxSelect",
      field: new FileField({ name: "test", maxSize: 9999, maxSelect: 2 }),
      record: () => {
        const record = new TestRecord(collection);
        record.setRaw("test", [f1, f2]);
        return record;
      },
      expectError: false,
    },
    {
      name: "> default MaxSize",
      field: new FileField({ name: "test" }),
      record: () => {
        const record = new TestRecord(collection);
        record.setRaw("test", f4);
        return record;
      },
      expectError: true,
    },
    {
      name: "<= default MaxSize",
      field: new FileField({ name: "test" }),
      record: () => {
        const record = new TestRecord(collection);
        record.setRaw("test", f5);
        return record;
      },
      expectError: false,
    },
    {
      name: "> MaxSize",
      field: new FileField({ name: "test", maxSize: 4, maxSelect: 3 }),
      record: () => {
        const record = new TestRecord(collection);
        record.setRaw("test", [f1, f2, f3]); // f3=8
        return record;
      },
      expectError: true,
    },
    {
      name: "<= MaxSize",
      field: new FileField({ name: "test", maxSize: 8, maxSelect: 3 }),
      record: () => {
        const record = new TestRecord(collection);
        record.setRaw("test", [f1, f2, f3]);
        return record;
      },
      expectError: false,
    },
    {
      name: "non-matching MimeType",
      field: new FileField({
        name: "test",
        maxSize: 999,
        maxSelect: 3,
        mimeTypes: ["a", "b"],
      }),
      record: () => {
        const record = new TestRecord(collection);
        record.setRaw("test", [f1, f2]);
        return record;
      },
      expectError: true,
    },
    {
      name: "matching MimeType",
      field: new FileField({
        name: "test",
        maxSize: 999,
        maxSelect: 3,
        mimeTypes: ["text/plain", "b"],
      }),
      record: () => {
        const record = new TestRecord(collection);
        record.setRaw("test", [f1, f2]);
        return record;
      },
      expectError: false,
    },
    {
      name: "existing files > MaxSelect",
      field: new FileField({ name: "file_many", maxSize: 999, maxSelect: 2 }),
      record: () => app.findRecordById("demo1", "84nmscqy84lsi1t"), // 5 files
      expectError: true,
    },
    {
      name: "existing files should ignore the MaxSize and Mimetypes checks",
      field: new FileField({
        name: "file_many",
        maxSize: 1,
        maxSelect: 5,
        mimeTypes: ["a", "b"],
      }),
      record: () => app.findRecordById("demo1", "84nmscqy84lsi1t"),
      expectError: false,
    },
    {
      name: "existing + new file > MaxSelect (5+2)",
      field: new FileField({ name: "file_many", maxSize: 999, maxSelect: 6 }),
      record: () => {
        const record = app.findRecordById("demo1", "84nmscqy84lsi1t");
        record.set("file_many+", [f1, f2]);
        return record;
      },
      expectError: true,
    },
    {
      name: "existing + new file <= MaxSelect (5+2)",
      field: new FileField({ name: "file_many", maxSize: 999, maxSelect: 7 }),
      record: () => {
        const record = app.findRecordById("demo1", "84nmscqy84lsi1t");
        record.set("file_many+", [f1, f2]);
        return record;
      },
      expectError: false,
    },
    {
      name: "existing + new filename",
      field: new FileField({ name: "file_many", maxSize: 999, maxSelect: 99 }),
      record: () => {
        const record = app.findRecordById("demo1", "84nmscqy84lsi1t");
        record.set("file_many+", "test123.png");
        return record;
      },
      expectError: true,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const err = s.field.validateValue(app, s.record());

      const hasErr = err !== null;
      expect(hasErr).toBe(s.expectError);
    });
  }
});

describe("TestFileFieldValidateSettings", () => {
  testDefaultFieldIdValidation(FieldTypeFile);
  testDefaultFieldNameValidation(FieldTypeFile);
  testDefaultFieldHelpValidation(FieldTypeFile);

  const app = noDBApp();

  const scenarios: {
    name: string;
    field: () => FileField;
    expectErrors: string[];
  }[] = [
    {
      name: "zero minimal",
      field: () => new FileField({ id: "test", name: "test" }),
      expectErrors: [],
    },
    {
      name: "0x0 thumb",
      field: () =>
        new FileField({
          id: "test",
          name: "test",
          maxSelect: 1,
          thumbs: ["100x200", "0x0"],
        }),
      expectErrors: ["thumbs"],
    },
    {
      name: "0x0t thumb",
      field: () =>
        new FileField({
          id: "test",
          name: "test",
          maxSize: 1,
          maxSelect: 1,
          thumbs: ["100x200", "0x0t"],
        }),
      expectErrors: ["thumbs"],
    },
    {
      name: "0x0b thumb",
      field: () =>
        new FileField({
          id: "test",
          name: "test",
          maxSize: 1,
          maxSelect: 1,
          thumbs: ["100x200", "0x0b"],
        }),
      expectErrors: ["thumbs"],
    },
    {
      name: "0x0f thumb",
      field: () =>
        new FileField({
          id: "test",
          name: "test",
          maxSize: 1,
          maxSelect: 1,
          thumbs: ["100x200", "0x0f"],
        }),
      expectErrors: ["thumbs"],
    },
    {
      name: "invalid format",
      field: () =>
        new FileField({
          id: "test",
          name: "test",
          maxSize: 1,
          maxSelect: 1,
          thumbs: ["100x200", "100x"],
        }),
      expectErrors: ["thumbs"],
    },
    {
      name: "valid thumbs",
      field: () =>
        new FileField({
          id: "test",
          name: "test",
          maxSize: 1,
          maxSelect: 1,
          thumbs: ["100x200", "100x40", "100x200"],
        }),
      expectErrors: [],
    },
    {
      name: "MaxSize > safe json int",
      field: () => new FileField({ id: "test", name: "test", maxSize: 2n ** 53n }),
      expectErrors: ["maxSize"],
    },
    {
      name: "MaxSize < 0",
      field: () => new FileField({ id: "test", name: "test", maxSize: -1 }),
      expectErrors: ["maxSize"],
    },
    {
      name: "MaxSelect > safe json int",
      field: () => new FileField({ id: "test", name: "test", maxSelect: 2n ** 53n }),
      expectErrors: ["maxSelect"],
    },
    {
      name: "MaxSelect < 0",
      field: () => new FileField({ id: "test", name: "test", maxSelect: -1 }),
      expectErrors: ["maxSelect"],
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

describe("TestFileFieldCalculateMaxBodySize", () => {
  const scenarios: { field: FileField; expected: number }[] = [
    { field: new FileField(), expected: DefaultFileFieldMaxSize },
    { field: new FileField({ maxSelect: 2 }), expected: 2 * DefaultFileFieldMaxSize },
    { field: new FileField({ maxSize: 10 }), expected: 10 },
    { field: new FileField({ maxSize: 10, maxSelect: 1 }), expected: 10 },
    { field: new FileField({ maxSize: 10, maxSelect: 2 }), expected: 20 },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${s.field.maxSelect}_${s.field.maxSize}`, () => {
      const result = s.field.calculateMaxBodySize();

      expect(result).toBe(s.expected);
    });
  }
});

describe("TestFileFieldFindGetter", () => {
  const app = TestApp.open();
  afterAll(() => app.cleanup());

  const record = app.findRecordById("demo3", "lcl9d87w22ml6jy");

  const field = record.collection.fields.getByName("files");
  if (!(field instanceof FileField)) {
    throw new Error(`Expected FileField, got ${field?.constructor.name}`);
  }

  beforeAll(async () => {
    const f1 = await NewFileFromBytes(bytes("test"), "f1");
    f1.name = "f1";

    const f2 = await NewFileFromBytes(bytes("test"), "f2");
    f2.name = "f2";

    record.set("files+", [f1, f2]);
    record.set("files-", "test_FLurQTgrY8.txt");
  });

  const scenarios: {
    name: string;
    key: string;
    hasGetter: boolean;
    expected: string;
  }[] = [
    {
      name: "no match",
      key: "example",
      hasGetter: false,
      expected: "",
    },
    {
      name: "exact match",
      key: field.getName(),
      hasGetter: true,
      expected: `["300_UhLKX91HVb.png",{"name":"f1","originalName":"f1","size":4},{"name":"f2","originalName":"f2","size":4}]`,
    },
    {
      name: "unsaved",
      key: field.getName() + ":unsaved",
      hasGetter: true,
      expected: `[{"name":"f1","originalName":"f1","size":4},{"name":"f2","originalName":"f2","size":4}]`,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const getter = field.findGetter(s.key);

      const hasGetter = getter !== null;
      expect(hasGetter).toBe(s.hasGetter);

      if (getter === null) {
        return;
      }

      const v = getter(record);

      expect(marshal(v)).toBe(s.expected);
    });
  }
});

describe("TestFileFieldFindSetter", () => {
  const scenarios: {
    name: string;
    key: string;
    value: unknown;
    field: FileField;
    hasSetter: boolean;
    expected: string;
  }[] = [
    {
      name: "no match",
      key: "example",
      value: "b",
      field: new FileField({ name: "test", maxSelect: 1 }),
      hasSetter: false,
      expected: "",
    },
    {
      name: "exact match (single)",
      key: "test",
      value: "b",
      field: new FileField({ name: "test", maxSelect: 1 }),
      hasSetter: true,
      expected: `"b"`,
    },
    {
      name: "exact match (multiple)",
      key: "test",
      value: ["a", "b", "b"],
      field: new FileField({ name: "test", maxSelect: 2 }),
      hasSetter: true,
      expected: `["a","b"]`,
    },
    {
      name: "append (single)",
      key: "test+",
      value: "b",
      field: new FileField({ name: "test", maxSelect: 1 }),
      hasSetter: true,
      expected: `"b"`,
    },
    {
      name: "append (multiple)",
      key: "test+",
      value: ["a"],
      field: new FileField({ name: "test", maxSelect: 2 }),
      hasSetter: true,
      expected: `["c","d","a"]`,
    },
    {
      name: "prepend (single)",
      key: "+test",
      value: "b",
      field: new FileField({ name: "test", maxSelect: 1 }),
      hasSetter: true,
      expected: `"d"`, // the last of the existing values
    },
    {
      name: "prepend (multiple)",
      key: "+test",
      value: ["a"],
      field: new FileField({ name: "test", maxSelect: 2 }),
      hasSetter: true,
      expected: `["a","c","d"]`,
    },
    {
      name: "subtract (single)",
      key: "test-",
      value: "d",
      field: new FileField({ name: "test", maxSelect: 1 }),
      hasSetter: true,
      expected: `"c"`,
    },
    {
      name: "subtract (multiple)",
      key: "test-",
      value: ["unknown", "c"],
      field: new FileField({ name: "test", maxSelect: 2 }),
      hasSetter: true,
      expected: `["d"]`,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const collection = newBaseCollection("test_collection");
      collection.fields.add(s.field);

      const setter = s.field.findSetter(s.key);

      const hasSetter = setter !== null;
      expect(hasSetter).toBe(s.hasSetter);

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

// The cases below are not in upstream's tests: the exact errors, the
// stored JSON and the int64 settings.

const random = (n: number): string => "r".repeat(n);

describe("errors", () => {
  const app = noDBApp();

  function validate(field: FileField, value: unknown, old?: unknown): unknown {
    const collection = newBaseCollection("test_collection");
    collection.fields.add(field);
    const record = new TestRecord(collection);
    if (old !== undefined) {
      record.setRaw(field.name, old);
      record.id = "abcdefghijklmno";
      record.postScan();
    }
    record.setRaw(field.name, value);
    const err = field.validateValue(app, record);
    if (err === null) {
      return null;
    }
    const v = err as unknown as { code(): string; message: string; params(): unknown };
    return { code: v.code(), message: v.message, params: marshal(v.params()) };
  }

  test("required", () => {
    expect(validate(new FileField({ name: "f", required: true }), [])).toEqual({
      code: "validation_required",
      message: "cannot be blank",
      params: "{}",
    });
  });

  test("new plain names: cut at 250 bytes", () => {
    const long = "ą".repeat(130); // 260 bytes
    expect(
      validate(new FileField({ name: "f", maxSelect: 5 }), ["old.txt", "a b", long], ["old.txt"]),
    ).toEqual({
      code: "validation_invalid_file",
      message: `Invalid new files: [a b ${"ą".repeat(125)}].`,
      params: `{"invalidFiles":["a b","${"ą".repeat(125)}"]}`,
    });
    // an old name is accepted again, the order does not matter
    expect(
      validate(new FileField({ name: "f", maxSelect: 5 }), ["b.txt", "a.txt"], ["a.txt", "b.txt"]),
    ).toBeNull();
  });

  test("too many files", async () => {
    const f1 = await NewFileFromBytes(bytes("test"), "a.txt", { random });
    expect(
      validate(new FileField({ name: "f", maxSelect: 3 }), ["old.txt", f1, "x"], ["old.txt", "x"]),
    ).toBeNull();
    expect(
      validate(new FileField({ name: "f", maxSelect: 1 }), ["old.txt", f1], ["old.txt"]),
    ).toEqual({
      code: "validation_too_many_files",
      message: "The maximum allowed files is 1",
      params: `{"maxSelect":1}`,
    });
  });

  test("changed names of new files", async () => {
    const f = await NewFileFromBytes(bytes("test"), "a.txt", { random });
    const field = new FileField({ name: "f" });
    for (const [name, expected] of [
      [
        ".hidden",
        { code: "validation_match_invalid", message: "must be in a valid format", params: "{}" },
      ],
      [
        "a/b",
        { code: "validation_match_invalid", message: "must be in a valid format", params: "{}" },
      ],
      [
        "a\\b",
        { code: "validation_match_invalid", message: "must be in a valid format", params: "{}" },
      ],
      [
        "a",
        { code: "validation_match_invalid", message: "must be in a valid format", params: "{}" },
      ],
      [
        "a".repeat(151),
        {
          code: "validation_length_out_of_range",
          message: "the length must be between 1 and 150",
          params: `{"max":150,"min":1}`,
        },
      ],
      ["ab", null],
      ["a".repeat(150), null],
    ] as const) {
      f.name = name;
      expect({ name, err: validate(field, f) }).toEqual({ name, err: expected });
    }
  });

  test("size and type", async () => {
    const f = await NewFileFromBytes(bytes("hello"), "hello.txt", { random });
    expect(validate(new FileField({ name: "f", maxSize: 4 }), f)).toEqual({
      code: "validation_file_size_limit",
      message: "Failed to upload hello.txt - the maximum allowed file size is 4 bytes.",
      params: `{"file":"hello.txt","maxSize":4}`,
    });
    expect(validate(new FileField({ name: "f", mimeTypes: ["image/png"] }), f)).toEqual({
      code: "validation_invalid_mime_type",
      message: `"hello_rrrrrrrrrr.txt" mime type must be one of: image/png.`,
      params: "{}",
    });
    // the size is checked first
    expect(
      (
        validate(new FileField({ name: "f", maxSize: 1, mimeTypes: ["image/png"] }), f) as {
          code: string;
        }
      ).code,
    ).toBe("validation_file_size_limit");
  });
});

describe("settings JSON", () => {
  test("marshal", () => {
    expect(new FileField().marshalJSON()).toBe(
      `{"name":"","id":"","system":false,"hidden":false,"presentable":false,"help":"","maxSize":0,"maxSelect":0,"mimeTypes":[],"thumbs":[],"protected":false,"required":false}`,
    );
  });

  test("unmarshal", () => {
    const text = `{"name":"f","id":"file1","system":true,"hidden":true,"presentable":true,"help":"h","maxSize":9007199254740993,"maxSelect":-9223372036854775808,"mimeTypes":["image/png"],"thumbs":["10x10"],"protected":true,"required":true}`;
    const field = new FileField();
    field.unmarshalJSON(text);
    expect(field.maxSize).toBe(9007199254740993n);
    expect(field.maxSelect).toBe(-9223372036854775808n);
    expect(field.marshalJSON()).toBe(text);

    // json.Unmarshal into an existing struct keeps the members that are
    // not in the text; null resets a slice
    field.unmarshalJSON(`{"mimeTypes":null,"thumbs":null}`);
    expect(field.marshalJSON()).toBe(
      text.replace(`["image/png"]`, "[]").replace(`["10x10"]`, "[]"),
    );

    expect(() => field.unmarshalJSON(`{"maxSize":1.5}`)).toThrow();
    expect(() => field.unmarshalJSON(`{"maxSize":9223372036854775808}`)).toThrow();
  });
});

test("CalculateMaxBodySize wraps around as Go's int64", () => {
  expect(new FileField({ maxSize: 2 ** 52, maxSelect: 2 ** 11 }).calculateMaxBodySize()).toBe(
    -9223372036854775808n,
  );
  expect(new FileField({ maxSize: 2 ** 40, maxSelect: 2 ** 12 }).calculateMaxBodySize()).toBe(
    2 ** 52,
  );
  expect(new FileField({ maxSize: 2 ** 40, maxSelect: 2 ** 13 }).calculateMaxBodySize()).toBe(
    2n ** 53n,
  );
});

test("the :uploaded getter is :unsaved", async () => {
  const f = await NewFileFromBytes(bytes("test"), "a.txt");
  const field = new FileField({ name: "f", maxSelect: 3 });
  const record = new TestRecord(newBaseCollection("test"));
  record.setRaw("f", ["old.txt", f]);
  expect(field.findGetter("f:uploaded")?.(record)).toEqual([f]);
  expect(field.findGetter("f:unsaved")?.(record)).toEqual([f]);
  expect(field.findGetter("f:other")).toBeNull();
});
