// Upstream: core/field_autodate_test.go

import { afterAll, describe, expect, test } from "bun:test";

import { InterceptorActionCreateExecute, InterceptorActionUpdateExecute } from "@/fields/field";
import { AutodateField, FieldTypeAutodate } from "@/fields/autodate";
import { DateTime, nowDateTime, parseDateTime } from "@/tools/types/datetime";

import {
  TestApp,
  TestRecord,
  expectValidationErrors,
  fixedClock,
  newBaseCollection,
  noDBApp,
} from "@test/support/fields";
import {
  testDefaultFieldIdValidation,
  testDefaultFieldNameValidation,
  testFieldBaseMethods,
} from "@test/fields/shared";

const clock = fixedClock("2026-03-04T05:06:07.890Z");

describe("TestAutodateFieldBaseMethods", () => {
  testFieldBaseMethods(FieldTypeAutodate);
});

test("TestAutodateFieldColumnType", () => {
  const f = new AutodateField();
  expect(f.columnType(noDBApp(clock))).toBe("TEXT DEFAULT '' NOT NULL");
});

describe("TestAutodateFieldPrepareValue", () => {
  const f = new AutodateField();
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

describe("TestAutodateFieldValidateValue", () => {
  const app = noDBApp(clock);
  const collection = newBaseCollection("test_collection");

  const scenarios: {
    name: string;
    field: AutodateField;
    record: () => TestRecord;
    expectError: boolean;
  }[] = [
    {
      name: "invalid raw value",
      field: new AutodateField({ name: "test" }),
      record: () => {
        const record = new TestRecord(collection);
        record.setRaw("test", 123);
        return record;
      },
      expectError: false,
    },
    {
      name: "missing field value",
      field: new AutodateField({ name: "test" }),
      record: () => {
        const record = new TestRecord(collection);
        record.setRaw("abc", true);
        return record;
      },
      expectError: false,
    },
    {
      name: "existing field value",
      field: new AutodateField({ name: "test" }),
      record: () => {
        const record = new TestRecord(collection);
        record.setRaw("test", nowDateTime(clock));
        return record;
      },
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

describe("TestAutodateFieldValidateSettings", () => {
  testDefaultFieldIdValidation(FieldTypeAutodate);
  testDefaultFieldNameValidation(FieldTypeAutodate);

  const app = TestApp.open();
  afterAll(() => app.cleanup());

  const superusers = app.findCollectionByNameOrId("_superusers");

  const scenarios: {
    name: string;
    field: () => AutodateField;
    expectErrors: string[];
  }[] = [
    {
      name: "empty onCreate and onUpdate",
      field: () => new AutodateField({ id: "test", name: "test" }),
      expectErrors: ["onCreate", "onUpdate"],
    },
    {
      name: "with onCreate",
      field: () => new AutodateField({ id: "test", name: "test", onCreate: true }),
      expectErrors: [],
    },
    {
      name: "with onUpdate",
      field: () => new AutodateField({ id: "test", name: "test", onUpdate: true }),
      expectErrors: [],
    },
    {
      name: "change of a system autodate field",
      field: () => {
        const created = superusers.fields.getByName("created") as AutodateField;
        created.onCreate = !created.onCreate;
        created.onUpdate = !created.onUpdate;
        return created;
      },
      expectErrors: ["onCreate", "onUpdate"],
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const errs = s.field().validateSettings(app, superusers);

      expectValidationErrors(errs, s.expectErrors);
    });
  }
});

describe("TestAutodateFieldFindSetter", () => {
  const field = new AutodateField({ name: "test" });

  const collection = newBaseCollection("test_collection");
  collection.fields.add(field);

  const initialDate = parseDateTime("2024-01-02 03:04:05.789Z");

  const record = new TestRecord(collection);
  record.setRaw("test", initialDate);

  test("no matching setter", () => {
    expect(field.findSetter("abc")).toBeNull();
  });

  test("matching setter", () => {
    const setter = field.findSetter("test");
    expect(setter).not.toBeNull();
    if (setter === null) {
      return;
    }

    setter(record, nowDateTime(clock)); // should be ignored

    expect(record.getString("test")).toBe("2024-01-02 03:04:05.789Z");
  });
});

// cutMilliseconds (the upstream test helper): keeps the "YYYY-MM-DD HH:MM:SS" part
function cutMilliseconds(datetime: string): string {
  return datetime.length > 19 ? datetime.slice(0, 19) : datetime;
}

describe("TestAutodateFieldIntercept", () => {
  const app = noDBApp(clock);
  const collection = newBaseCollection("test_collection");
  const initialDate = parseDateTime("2024-01-02 03:04:05.789Z");

  const scenarios: {
    name: string;
    actionName: string;
    field: AutodateField;
    record: () => TestRecord;
    expected: string;
  }[] = [
    {
      name: "non-matching action",
      actionName: "test",
      field: new AutodateField({ name: "test", onCreate: true, onUpdate: true }),
      record: () => new TestRecord(collection),
      expected: "",
    },
    {
      name: "create with zero value (disabled onCreate)",
      actionName: InterceptorActionCreateExecute,
      field: new AutodateField({ name: "test", onCreate: false, onUpdate: true }),
      record: () => new TestRecord(collection),
      expected: "",
    },
    {
      name: "create with zero value",
      actionName: InterceptorActionCreateExecute,
      field: new AutodateField({ name: "test", onCreate: true, onUpdate: true }),
      record: () => new TestRecord(collection),
      expected: "{NOW}",
    },
    {
      name: "create with non-zero value",
      actionName: InterceptorActionCreateExecute,
      field: new AutodateField({ name: "test", onCreate: true, onUpdate: true }),
      record: () => {
        const record = new TestRecord(collection);
        record.setRaw("test", initialDate);
        return record;
      },
      expected: initialDate.string(),
    },
    {
      name: "update with zero value (disabled onUpdate)",
      actionName: InterceptorActionUpdateExecute,
      field: new AutodateField({ name: "test", onCreate: true, onUpdate: false }),
      record: () => new TestRecord(collection),
      expected: "",
    },
    {
      name: "update with zero value",
      actionName: InterceptorActionUpdateExecute,
      field: new AutodateField({ name: "test", onCreate: true, onUpdate: true }),
      record: () => new TestRecord(collection),
      expected: "{NOW}",
    },
    {
      name: "update with non-zero value",
      actionName: InterceptorActionUpdateExecute,
      field: new AutodateField({ name: "test", onCreate: true, onUpdate: true }),
      record: () => {
        const record = new TestRecord(collection);
        record.setRaw("test", initialDate);
        return record;
      },
      expected: initialDate.string(),
    },
  ];

  for (const s of scenarios) {
    test(s.name, async () => {
      let actionCalls = 0;
      const record = s.record();

      const now = nowDateTime(clock).string();
      await s.field.intercept(app, record, s.actionName, async () => {
        actionCalls++;
      });

      expect(actionCalls).toBe(1);

      const expected = cutMilliseconds(s.expected.replaceAll("{NOW}", now));

      const v = cutMilliseconds(record.getString(s.field.getName()));
      expect(v).toBe(expected);
    });
  }
});
