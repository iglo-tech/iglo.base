// Upstream: core/record_query_test.go (TestRecordQueryWithDifferentCollectionValues,
// TestRecordQueryOne, TestRecordQueryAll, TestFindRecordById,
// TestFindRecordsByIds, TestFindAllRecords, TestFindFirstRecordByData,
// TestCountRecords, TestFindAuthRecordByEmail)
//
// Left out: the RecordProxy cases of TestRecordQueryOne/All (a library
// API, not ported) and the Go-only non-pointer []Record slice; the custom
// struct cases scan plain rows. TestFindRecordsByFilter,
// TestFindFirstRecordByFilter and TestCanAccessRecord are M2.2's,
// TestFindAuthRecordByToken M2.3's.
//
// Each Go test function runs on its own copy of the vendored fixture
// (openTestApp, as tests.NewTestApp). The error texts and kinds are
// checked too, as API handlers map them.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Collection } from "@/collections/collection-model";
import { findCollectionByNameOrId } from "@/collections/collection-query";
import { saveCollection } from "@/collections/collection-save";
import { type Expression, HashExp, like, not } from "@/db/dbx/expression";
import { ContextCanceledError, type Params, type Row } from "@/db/dbx/query";
import { NoRowsError } from "@/db/dbx/rows";
import type { SelectQuery } from "@/db/dbx/select";
import type { StructModel } from "@/db/dbx/struct";
import { FieldNameEmail } from "@/fields/field";
import type { Record } from "@/records/record-model";
import {
  type RecordQueryFilter,
  countRecords,
  findAllRecords,
  findAuthRecordByEmail,
  findFirstRecordByData,
  findRecordById,
  findRecordsByIds,
  recordQuery,
  recordsTarget,
  recordTarget,
} from "@/records/record-query";
import { findSingleColumnUniqueIndex } from "@/tools/dbutils/index";
import { equalFold } from "@/collections/go-strings";

import { openTestApp, type TestCollectionsApp } from "@test/collections/app";

// the error a call throws, or null (Go's returned error)
function errorOf(fn: () => unknown): Error | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

// Go's (value, error) result
// the error of a cancelled RecordQuery: context.Canceled, alone or wrapped
// with the failed query, caused by the collection lookup's NoRowsError
function expectCanceled(err: unknown, message: string): void {
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe(message);
  const canceled = err instanceof ContextCanceledError ? err : (err as Error).cause;
  expect(canceled).toBeInstanceOf(ContextCanceledError);
  expect((canceled as Error).cause).toBeInstanceOf(NoRowsError);
}

function resultOf<T>(fn: () => T): [T | null, Error | null] {
  try {
    return [fn(), null];
  } catch (err) {
    return [null, err instanceof Error ? err : new Error(String(err))];
  }
}

// Go's struct { Id string `db:"id" json:"id"` }
class CustomStruct implements StructModel {
  id = "";

  tableName(): string {
    return "";
  }

  dbColumns(): Params {
    return { id: this.id };
  }

  dbScan(row: Row): void {
    if (Object.hasOwn(row, "id")) {
      this.id = String(row.id);
    }
  }
}

function useApp(): () => TestCollectionsApp {
  let app: TestCollectionsApp | null = null;
  beforeAll(() => {
    app = openTestApp();
  });
  afterAll(() => {
    app?.cleanup();
  });
  return () => app as TestCollectionsApp;
}

describe("TestRecordQueryWithDifferentCollectionValues", () => {
  const getApp = useApp();

  const scenarios: {
    name: string;
    collection: (app: TestCollectionsApp) => unknown;
    expectedTotal: number;
    expectError: boolean;
  }[] = [
    { name: "with nil value", collection: () => null, expectedTotal: 0, expectError: true },
    {
      name: "with invalid or missing collection id/name",
      collection: () => "missing",
      expectedTotal: 0,
      expectError: true,
    },
    {
      name: "with pointer model",
      collection: (app) => findCollectionByNameOrId(app, "demo1"),
      expectedTotal: 3,
      expectError: false,
    },
    { name: "with name", collection: () => "demo1", expectedTotal: 3, expectError: false },
    {
      name: "with id",
      collection: () => "wsmn24bux7wo113",
      expectedTotal: 3,
      expectError: false,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const app = getApp();
      const [records, err] = resultOf(() =>
        recordQuery(app, s.collection(app)).all<Record>(recordsTarget),
      );

      expect(err !== null).toBe(s.expectError);
      expect(records?.length ?? 0).toBe(s.expectedTotal);
    });
  }

  // not upstream's: the error of the cancelled query
  test("the cancelled query fails with context.Canceled carrying the collection error", () => {
    const app = getApp();

    const missing = errorOf(() => recordQuery(app, "missing").all<Record>(recordsTarget));
    expect(missing?.message).toBe(
      "context canceled; failed query: SELECT `@@__invalidCollectionModelOrIdentifier`.* FROM `@@__invalidCollectionModelOrIdentifier`",
    );
    const canceled = missing?.cause;
    expect(canceled).toBeInstanceOf(ContextCanceledError);
    expect((canceled as Error).cause).toBeInstanceOf(NoRowsError);

    const invalid = errorOf(() => recordQuery(app, null).one(recordTarget));
    expect(((invalid as Error).cause as Error).cause).toEqual(
      new Error("unknown collection identifier - must be collection model, id or name"),
    );
  });

  // not upstream's: every execution path of the cancelled query fails with
  // context.Canceled before its SQL runs, as dbx's QueryContext and
  // ExecContext do with upstream's cancelled context; the resolvers wrapped
  // by execLockRetry add the failed query, Rows() is not wrapped
  test("every execution path of the cancelled query fails before its SQL runs", async () => {
    const app = getApp();
    const failedQuery =
      "context canceled; failed query: SELECT `@@__invalidCollectionModelOrIdentifier`.* FROM `@@__invalidCollectionModelOrIdentifier`";

    const missing = (): SelectQuery => recordQuery(app, "missing");

    // the reproductions: Rows() neither reaches the fake table nor reads
    // the table the query was changed to
    expectCanceled(
      errorOf(() => missing().rows()),
      "context canceled",
    );
    expectCanceled(
      errorOf(() => missing().select("id").from("demo1").rows().first()),
      "context canceled",
    );

    for (const run of [
      () => missing().one(recordTarget),
      () => missing().one(),
      () => missing().all(recordsTarget),
      () => missing().all(),
      () => missing().row(),
      () => missing().column(),
      () => missing().build().execute(),
    ]) {
      expectCanceled(errorOf(run), failedQuery);
    }

    // changed with select/from/where, the query is still cancelled
    const changed = (): SelectQuery =>
      missing()
        .select("id")
        .from("demo1")
        .where(new HashExp({ id: "84nmscqy84lsi1t" }));
    const changedQuery =
      "context canceled; failed query: SELECT `id` FROM `demo1` WHERE `id`={:p0}";
    for (const run of [
      () => changed().one(),
      () => changed().all(),
      () => changed().row(),
      () => changed().column(),
      () => changed().clone().one(),
      // Prepare() takes no context (dbx); the prepared query is cancelled
      () => changed().build().prepare().row(),
    ]) {
      expectCanceled(errorOf(run), changedQuery);
    }
    expectCanceled(
      errorOf(() => changed().rows()),
      "context canceled",
    );

    for (const run of [
      () => missing().oneAsync(recordTarget),
      () => missing().allAsync(recordsTarget),
      () => missing().rowAsync(),
      () => missing().columnAsync(),
      () => changed().oneAsync(),
      () => changed().allAsync(),
    ]) {
      const err = await run().then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as Error).message).toStartWith("context canceled; failed query: ");
      expect((err as Error).cause).toBeInstanceOf(ContextCanceledError);
    }

    // a query of an existing collection is not cancelled
    expect([...recordQuery(app, "demo1").select("id").rows()].length).toBe(3);
  });

  test("the async resolvers hydrate records and fail the same way", async () => {
    const app = getApp();

    const records = await recordQuery(app, "demo1").allAsync<Record>(recordsTarget);
    expect(records.map((r) => r.id).toSorted()).toEqual([
      "84nmscqy84lsi1t",
      "al1h9ijdeojtsjy",
      "imy661ixudk5izi",
    ]);

    const one = await recordQuery(app, "demo1")
      .andWhere(new HashExp({ id: "84nmscqy84lsi1t" }))
      .oneAsync<Record>(recordTarget);
    expect(one.collection().name).toBe("demo1");
    expect(one.isNew()).toBe(false);

    await expect(recordQuery(app, "missing").allAsync(recordsTarget)).rejects.toThrow(
      "context canceled; failed query: ",
    );
  });
});

describe("TestRecordQueryOne", () => {
  const getApp = useApp();

  const scenarios: { name: string; collection: string; recordId: string; record: boolean }[] = [
    { name: "record model", collection: "demo1", recordId: "84nmscqy84lsi1t", record: true },
    { name: "custom struct", collection: "demo1", recordId: "84nmscqy84lsi1t", record: false },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const app = getApp();
      const collection = findCollectionByNameOrId(app, s.collection);

      const q = recordQuery(app, collection).where(new HashExp({ id: s.recordId }));

      let rawStr: string;
      if (s.record) {
        const record = q.one<Record>(recordTarget);
        expect(record.collection()).toBe(collection);
        rawStr = record.marshalJSON();
      } else {
        rawStr = JSON.stringify(q.one<CustomStruct>(new CustomStruct()));
      }

      expect(rawStr).toContain(`"id":"${s.recordId}"`);
    });
  }
});

describe("TestRecordQueryAll", () => {
  const getApp = useApp();

  const scenarios: { name: string; collection: string; recordIds: string[]; record: boolean }[] = [
    {
      name: "slice of pointer Record models",
      collection: "demo1",
      recordIds: ["84nmscqy84lsi1t", "al1h9ijdeojtsjy"],
      record: true,
    },
    {
      name: "slice of custom structs",
      collection: "demo1",
      recordIds: ["84nmscqy84lsi1t", "al1h9ijdeojtsjy"],
      record: false,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const app = getApp();
      const collection = findCollectionByNameOrId(app, s.collection);

      const q = recordQuery(app, collection).where(new HashExp({ id: s.recordIds }));

      let rawStr: string;
      let total: number;
      if (s.record) {
        const records = q.all<Record>(recordsTarget);
        total = records.length;
        rawStr = "[" + records.map((r) => r.marshalJSON()).join(",") + "]";
      } else {
        const rows = q.all<CustomStruct>(() => new CustomStruct());
        total = rows.length;
        rawStr = JSON.stringify(rows);
      }

      expect(total).toBe(s.recordIds.length);

      for (const id of s.recordIds) {
        expect(rawStr).toContain(`"id":"${id}"`);
      }
    });
  }
});

function titleFilter(title: string): RecordQueryFilter {
  return (q: SelectQuery) => {
    q.andWhere(new HashExp({ title }));
  };
}

function activeFilter(active: boolean): RecordQueryFilter {
  return (q: SelectQuery) => {
    q.andWhere(new HashExp({ active }));
  };
}

describe("TestFindRecordById", () => {
  const getApp = useApp();

  const scenarios: {
    collectionIdOrName: string;
    id: string;
    filters: RecordQueryFilter[] | null;
    expectError: boolean;
  }[] = [
    { collectionIdOrName: "demo2", id: "missing", filters: null, expectError: true },
    { collectionIdOrName: "missing", id: "0yxhwia2amd8gec", filters: null, expectError: true },
    { collectionIdOrName: "demo2", id: "0yxhwia2amd8gec", filters: null, expectError: false },
    { collectionIdOrName: "demo2", id: "0yxhwia2amd8gec", filters: [], expectError: false },
    {
      collectionIdOrName: "demo2",
      id: "0yxhwia2amd8gec",
      filters: [null, null],
      expectError: false,
    },
    {
      collectionIdOrName: "demo2",
      id: "0yxhwia2amd8gec",
      filters: [null, () => {}],
      expectError: false,
    },
    {
      collectionIdOrName: "demo2",
      id: "0yxhwia2amd8gec",
      filters: [titleFilter("missing")],
      expectError: true,
    },
    {
      collectionIdOrName: "demo2",
      id: "0yxhwia2amd8gec",
      filters: [
        () => {
          throw new Error("test error");
        },
      ],
      expectError: true,
    },
    {
      collectionIdOrName: "demo2",
      id: "0yxhwia2amd8gec",
      filters: [titleFilter("test3")],
      expectError: false,
    },
    {
      collectionIdOrName: "demo2",
      id: "0yxhwia2amd8gec",
      filters: [titleFilter("test3"), null],
      expectError: false,
    },
    {
      collectionIdOrName: "demo2",
      id: "0yxhwia2amd8gec",
      filters: [titleFilter("test3"), activeFilter(false)],
      expectError: true,
    },
    {
      collectionIdOrName: "sz5l5z67tg7gku0",
      id: "0yxhwia2amd8gec",
      filters: [titleFilter("test3"), activeFilter(true)],
      expectError: false,
    },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${s.collectionIdOrName}_${s.id}_${s.filters?.length ?? 0}`, () => {
      const [record, err] = resultOf(() =>
        findRecordById(getApp(), s.collectionIdOrName, s.id, ...(s.filters ?? [])),
      );

      expect({ hasErr: err !== null, err: err?.message }).toMatchObject({
        hasErr: s.expectError,
      });

      if (record !== null) {
        expect(record.id).toBe(s.id);
      }
    });
  }

  // not upstream's: the error kinds API handlers map
  test("error kinds", () => {
    const app = getApp();
    expect(errorOf(() => findRecordById(app, "demo2", "missing"))).toBeInstanceOf(NoRowsError);
    expect(errorOf(() => findRecordById(app, "missing", "0yxhwia2amd8gec"))).toBeInstanceOf(
      NoRowsError,
    );
    expect(
      errorOf(() =>
        findRecordById(app, "demo2", "0yxhwia2amd8gec", () => {
          throw new Error("test error");
        }),
      )?.message,
    ).toBe("test error");
  });
});

describe("TestFindRecordsByIds", () => {
  const getApp = useApp();

  const scenarios: {
    collectionIdOrName: string;
    ids: string[];
    filters: RecordQueryFilter[] | null;
    expectTotal: number;
    expectError: boolean;
  }[] = [
    { collectionIdOrName: "demo2", ids: [], filters: null, expectTotal: 0, expectError: false },
    { collectionIdOrName: "demo2", ids: [""], filters: null, expectTotal: 0, expectError: false },
    {
      collectionIdOrName: "demo2",
      ids: ["missing"],
      filters: null,
      expectTotal: 0,
      expectError: false,
    },
    {
      collectionIdOrName: "missing",
      ids: ["0yxhwia2amd8gec"],
      filters: null,
      expectTotal: 0,
      expectError: true,
    },
    {
      collectionIdOrName: "demo2",
      ids: ["0yxhwia2amd8gec"],
      filters: null,
      expectTotal: 1,
      expectError: false,
    },
    {
      collectionIdOrName: "sz5l5z67tg7gku0",
      ids: ["0yxhwia2amd8gec"],
      filters: null,
      expectTotal: 1,
      expectError: false,
    },
    {
      collectionIdOrName: "demo2",
      ids: ["0yxhwia2amd8gec", "llvuca81nly1qls"],
      filters: null,
      expectTotal: 2,
      expectError: false,
    },
    {
      collectionIdOrName: "demo2",
      ids: ["0yxhwia2amd8gec", "llvuca81nly1qls"],
      filters: [],
      expectTotal: 2,
      expectError: false,
    },
    {
      collectionIdOrName: "demo2",
      ids: ["0yxhwia2amd8gec", "llvuca81nly1qls"],
      filters: [null, null],
      expectTotal: 2,
      expectError: false,
    },
    {
      collectionIdOrName: "demo2",
      ids: ["0yxhwia2amd8gec", "llvuca81nly1qls"],
      filters: [
        () => {}, // empty filter
      ],
      expectTotal: 2,
      expectError: false,
    },
    {
      collectionIdOrName: "demo2",
      ids: ["0yxhwia2amd8gec", "llvuca81nly1qls"],
      filters: [
        () => {}, // empty filter
        () => {
          throw new Error("test error");
        },
      ],
      expectTotal: 0,
      expectError: true,
    },
    {
      collectionIdOrName: "demo2",
      ids: ["0yxhwia2amd8gec", "llvuca81nly1qls"],
      filters: [
        (q) => {
          q.andWhere(new HashExp({ active: true }));
        },
        null,
      ],
      expectTotal: 1,
      expectError: false,
    },
    {
      collectionIdOrName: "sz5l5z67tg7gku0",
      ids: ["0yxhwia2amd8gec", "llvuca81nly1qls"],
      filters: [
        (q) => {
          q.andWhere(new HashExp({ active: true }));
        },
        (q) => {
          q.andWhere(not(new HashExp({ title: "" })));
        },
      ],
      expectTotal: 1,
      expectError: false,
    },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${s.collectionIdOrName}_[${s.ids.join(" ")}]_${s.filters?.length ?? 0}`, () => {
      const [records, err] = resultOf(() =>
        findRecordsByIds(getApp(), s.collectionIdOrName, s.ids, ...(s.filters ?? [])),
      );

      expect(err !== null).toBe(s.expectError);
      expect(records?.length ?? 0).toBe(s.expectTotal);

      for (const r of records ?? []) {
        expect(s.ids).toContain(r.id);
      }
    });
  }
});

describe("TestFindAllRecords", () => {
  const getApp = useApp();

  const scenarios: {
    collectionIdOrName: string;
    expressions: (Expression | null)[] | null;
    expectIds: string[];
    expectError: boolean;
  }[] = [
    { collectionIdOrName: "missing", expressions: null, expectIds: [], expectError: true },
    {
      collectionIdOrName: "demo2",
      expressions: null,
      expectIds: ["achvryl401bhse3", "llvuca81nly1qls", "0yxhwia2amd8gec"],
      expectError: false,
    },
    {
      collectionIdOrName: "demo2",
      expressions: [null, new HashExp({ id: "123" })],
      expectIds: [],
      expectError: false,
    },
    {
      collectionIdOrName: "sz5l5z67tg7gku0",
      expressions: [like("title", "test").match(true, true), new HashExp({ active: true })],
      expectIds: ["achvryl401bhse3", "0yxhwia2amd8gec"],
      expectError: false,
    },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${s.collectionIdOrName}`, () => {
      const [records, err] = resultOf(() =>
        findAllRecords(getApp(), s.collectionIdOrName, ...(s.expressions ?? [])),
      );

      expect(err !== null).toBe(s.expectError);
      expect(records?.length ?? 0).toBe(s.expectIds.length);

      for (const r of records ?? []) {
        expect(s.expectIds).toContain(r.id);
      }
    });
  }
});

describe("TestFindFirstRecordByData", () => {
  const getApp = useApp();

  const scenarios: {
    collectionIdOrName: string;
    key: string;
    value: unknown;
    expectId: string;
    expectError: boolean;
    // not upstream's: the error text
    expectErrorText?: string;
  }[] = [
    {
      collectionIdOrName: "missing",
      key: "id",
      value: "llvuca81nly1qls",
      expectId: "llvuca81nly1qls",
      expectError: true,
      expectErrorText: "sql: no rows in result set",
    },
    {
      collectionIdOrName: "demo2",
      key: "",
      value: "llvuca81nly1qls",
      expectId: "",
      expectError: true,
      expectErrorText: "invalid or missing field ",
    },
    {
      collectionIdOrName: "demo2",
      key: "invalid_or_missing",
      value: "llvuca81nly1qls",
      expectId: "",
      expectError: true,
      expectErrorText: "invalid or missing field invalid_or_missing",
    },
    {
      collectionIdOrName: "demo2",
      key: "id",
      value: "invalid",
      expectId: "",
      expectError: true,
      expectErrorText: "sql: no rows in result set",
    },
    {
      collectionIdOrName: "demo2",
      key: "id",
      value: "llvuca81nly1qls",
      expectId: "llvuca81nly1qls",
      expectError: false,
    },
    {
      collectionIdOrName: "sz5l5z67tg7gku0",
      key: "title",
      value: "test3",
      expectId: "0yxhwia2amd8gec",
      expectError: false,
    },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${s.collectionIdOrName}_${s.key}_${String(s.value)}`, () => {
      const [record, err] = resultOf(() =>
        findFirstRecordByData(getApp(), s.collectionIdOrName, s.key, s.value),
      );

      expect(err !== null).toBe(s.expectError);
      if (s.expectErrorText !== undefined) {
        expect(err?.message).toBe(s.expectErrorText);
      }

      if (!s.expectError) {
        expect(record?.id).toBe(s.expectId);
      }
    });
  }
});

describe("TestCountRecords", () => {
  const getApp = useApp();

  const scenarios: {
    name: string;
    collectionIdOrName: string;
    expressions: (Expression | null)[] | null;
    expectTotal: number;
    expectError: boolean;
  }[] = [
    {
      name: "missing collection",
      collectionIdOrName: "missing",
      expressions: null,
      expectTotal: 0,
      expectError: true,
    },
    {
      name: "valid collection name",
      collectionIdOrName: "demo2",
      expressions: null,
      expectTotal: 3,
      expectError: false,
    },
    {
      name: "valid collection id",
      collectionIdOrName: "sz5l5z67tg7gku0",
      expressions: null,
      expectTotal: 3,
      expectError: false,
    },
    {
      name: "nil expression",
      collectionIdOrName: "demo2",
      expressions: [null],
      expectTotal: 3,
      expectError: false,
    },
    {
      name: "no matches",
      collectionIdOrName: "demo2",
      expressions: [null, like("title", "missing"), new HashExp({ active: true })],
      expectTotal: 0,
      expectError: false,
    },
    {
      name: "with matches",
      collectionIdOrName: "demo2",
      expressions: [null, like("title", "test"), new HashExp({ active: true })],
      expectTotal: 2,
      expectError: false,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const [total, err] = resultOf(() =>
        countRecords(getApp(), s.collectionIdOrName, ...(s.expressions ?? [])),
      );

      expect(err !== null).toBe(s.expectError);
      expect(total ?? 0).toBe(s.expectTotal);
    });
  }

  // not upstream's: the cancelled count query's error
  test("missing collection error", () => {
    expect(errorOf(() => countRecords(getApp(), "missing"))?.message).toBe(
      "context canceled; failed query: SELECT count(*) FROM `@@__invalidCollectionModelOrIdentifier`",
    );
  });
});

describe("TestFindAuthRecordByEmail", () => {
  const scenarios: {
    collectionIdOrName: string;
    email: string;
    nocaseIndex: boolean;
    expectError: boolean;
    // not upstream's: the error text
    expectErrorText?: string;
  }[] = [
    {
      collectionIdOrName: "missing",
      email: "test@example.com",
      nocaseIndex: false,
      expectError: true,
      expectErrorText: "failed to fetch auth collection: sql: no rows in result set",
    },
    {
      collectionIdOrName: "demo2",
      email: "test@example.com",
      nocaseIndex: false,
      expectError: true,
      expectErrorText: `"demo2" is not an auth collection`,
    },
    {
      collectionIdOrName: "users",
      email: "missing@example.com",
      nocaseIndex: false,
      expectError: true,
      expectErrorText: "sql: no rows in result set",
    },
    {
      collectionIdOrName: "users",
      email: "test@example.com",
      nocaseIndex: false,
      expectError: false,
    },
    {
      collectionIdOrName: "clients",
      email: "test2@example.com",
      nocaseIndex: false,
      expectError: false,
    },
    // case-insensitive tests
    {
      collectionIdOrName: "clients",
      email: "TeSt2@example.com",
      nocaseIndex: false,
      expectError: true,
    },
    {
      collectionIdOrName: "clients",
      email: "TeSt2@example.com",
      nocaseIndex: true,
      expectError: false,
    },
  ];

  for (const s of scenarios) {
    test(`${s.collectionIdOrName}_${s.email}_${s.nocaseIndex}`, () => {
      const app = openTestApp();
      try {
        let collection: Collection | null = null;
        try {
          collection = findCollectionByNameOrId(app, s.collectionIdOrName);
        } catch {
          collection = null;
        }
        if (collection !== null) {
          const [emailIndex, ok] = findSingleColumnUniqueIndex(collection.indexes, FieldNameEmail);
          if (ok) {
            emailIndex.columns[0]!.collate = s.nocaseIndex ? "nocase" : "";

            collection.removeIndex(emailIndex.indexName);
            collection.indexes.push(emailIndex.build());
            saveCollection(app, collection);
          }
        }

        const [record, err] = resultOf(() =>
          findAuthRecordByEmail(app, s.collectionIdOrName, s.email),
        );

        expect({ hasErr: err !== null, err: err?.message }).toMatchObject({
          hasErr: s.expectError,
        });
        if (s.expectErrorText !== undefined) {
          expect(err?.message).toBe(s.expectErrorText);
        }

        if (err !== null) {
          return;
        }

        expect(equalFold(record!.email(), s.email)).toBe(true);
      } finally {
        app.cleanup();
      }
    });
  }
});
