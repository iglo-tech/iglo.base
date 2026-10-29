// Upstream: core/record_query_expand_test.go (TestExpandRecords,
// TestExpandRecord, TestBackRelationExpandSingeVsArrayResult,
// TestExpandRecordsQuerySkipDuplicatedIds)
//
// Each Go test function runs on its own copy of the vendored fixture
// (openTestApp, as tests.NewTestApp). The scenarios of TestExpandRecords and
// TestExpandRecord share that copy, as they share upstream's app.
//
// app.ExpandRecords and app.ExpandRecord are expandRecords and expandRecord,
// async here: the default fetch and the back-relation lookups read through
// the async resolvers. The counts are taken from the marshaled JSON, as
// upstream does.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { findCollectionByNameOrId } from "@/collections/collection-query";
import { saveCollection } from "@/collections/collection-save";
import { FieldNameExpand } from "@/fields/field";
import { Record } from "@/records/record-model";
import { findRecordById, findRecordsByIds, type RecordsApp } from "@/records/record-query";
import { type ExpandFetchFunc, expandRecord, expandRecords } from "@/records/record-query-expand";
import { toUniqueStringSlice } from "@/tools/list/list";
import { marshal } from "@/tools/types/go-json";

import { openTestApp, type TestCollectionsApp } from "@test/collections/app";

// the fetchFunc of a scenario, built on the app the scenario runs on
// (null: the default fetch, all relation records)
type FetchFactory = (app: RecordsApp) => ExpandFetchFunc | null;

// func(c *core.Collection, ids []string) { return app.FindRecordsByIds(c.Id, ids, nil) }
const findByIds: FetchFactory = (app) => async (c, ids) => findRecordsByIds(app, c.id, ids);

// func(...) { return nil, errors.New("test error") }
const failingFetch: FetchFactory = () => async () => {
  throw new Error("test error");
};

// a nil fetchFunc
const nilFetch: FetchFactory = () => null;

// strings.Count
function countOf(s: string, substr: string): number {
  return s.split(substr).length - 1;
}

// the non-empty "expand" props of the marshaled records, as the Go tests count them
function nonemptyExpandProps(encoded: string): number {
  const expandKey = `"${FieldNameExpand}":`;
  return countOf(encoded, expandKey) - countOf(encoded, expandKey + "{}");
}

// the records of FindRecordsByIds, where the Go test ignores the error (an
// unknown collection gives no records)
function recordsByIdsOrNone(app: RecordsApp, collectionIdOrName: string, ids: string[]): Record[] {
  try {
    return findRecordsByIds(app, collectionIdOrName, ids);
  } catch {
    return [];
  }
}

interface ExpandRecordsScenario {
  testName: string;
  collectionIdOrName: string;
  recordIds: string[];
  expands: string[];
  fetchFunc: FetchFactory;
  expectNonemptyExpandProps: number;
  expectExpandFailures: number;
}

const expandRecordsScenarios: ExpandRecordsScenario[] = [
  {
    testName: "empty records",
    collectionIdOrName: "",
    recordIds: [],
    expands: ["self_rel_one", "self_rel_many.self_rel_one"],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 0,
    expectExpandFailures: 0,
  },
  {
    testName: "empty expand",
    collectionIdOrName: "demo4",
    recordIds: ["i9naidtvr6qsgb4", "qzaqccwrmva4o1n"],
    expands: [],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 0,
    expectExpandFailures: 0,
  },
  {
    testName: "fetchFunc with error",
    collectionIdOrName: "demo4",
    recordIds: ["i9naidtvr6qsgb4", "qzaqccwrmva4o1n"],
    expands: ["self_rel_one", "self_rel_many.self_rel_one"],
    fetchFunc: failingFetch,
    expectNonemptyExpandProps: 0,
    expectExpandFailures: 2,
  },
  {
    testName: "missing relation field",
    collectionIdOrName: "demo4",
    recordIds: ["i9naidtvr6qsgb4", "qzaqccwrmva4o1n"],
    expands: ["missing"],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 0,
    expectExpandFailures: 1,
  },
  {
    testName: "existing, but non-relation type field",
    collectionIdOrName: "demo4",
    recordIds: ["i9naidtvr6qsgb4", "qzaqccwrmva4o1n"],
    expands: ["title"],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 0,
    expectExpandFailures: 1,
  },
  {
    testName: "invalid/missing second level expand",
    collectionIdOrName: "demo4",
    recordIds: ["i9naidtvr6qsgb4", "qzaqccwrmva4o1n"],
    expands: ["rel_one_no_cascade.title"],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 0,
    expectExpandFailures: 1,
  },
  {
    testName: "with nil fetchfunc",
    collectionIdOrName: "users",
    recordIds: [
      "bgs820n361vj1qd",
      "4q1xlclmfloku33",
      "oap640cot4yru2s", // no rels
    ],
    expands: ["rel"],
    fetchFunc: nilFetch,
    expectNonemptyExpandProps: 2,
    expectExpandFailures: 0,
  },
  {
    testName: "expand normalizations",
    collectionIdOrName: "demo4",
    recordIds: ["i9naidtvr6qsgb4", "qzaqccwrmva4o1n"],
    expands: [
      "self_rel_one",
      "self_rel_many.self_rel_many.rel_one_no_cascade",
      "self_rel_many.self_rel_one.self_rel_many.self_rel_one.rel_one_no_cascade",
      "self_rel_many",
      "self_rel_many.",
      "  self_rel_many  ",
      "",
    ],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 9,
    expectExpandFailures: 0,
  },
  {
    testName: "single expand",
    collectionIdOrName: "users",
    recordIds: [
      "bgs820n361vj1qd",
      "4q1xlclmfloku33",
      "oap640cot4yru2s", // no rels
    ],
    expands: ["rel"],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 2,
    expectExpandFailures: 0,
  },
  {
    testName: "with nil fetchfunc",
    collectionIdOrName: "users",
    recordIds: [
      "bgs820n361vj1qd",
      "4q1xlclmfloku33",
      "oap640cot4yru2s", // no rels
    ],
    expands: ["rel"],
    fetchFunc: nilFetch,
    expectNonemptyExpandProps: 2,
    expectExpandFailures: 0,
  },
  {
    testName: "maxExpandDepth reached",
    collectionIdOrName: "demo4",
    recordIds: ["qzaqccwrmva4o1n"],
    expands: [
      "self_rel_many.self_rel_many.self_rel_many.self_rel_many.self_rel_many.self_rel_many.self_rel_many.self_rel_many.self_rel_many.self_rel_many.self_rel_many.self_rel_many",
    ],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 6,
    expectExpandFailures: 0,
  },
  {
    testName: "simple back single relation field expand (deprecated syntax)",
    collectionIdOrName: "demo3",
    recordIds: ["lcl9d87w22ml6jy"],
    expands: ["demo4(rel_one_no_cascade_required)"],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 1,
    expectExpandFailures: 0,
  },
  {
    testName: "simple back expand via single relation field",
    collectionIdOrName: "demo3",
    recordIds: ["lcl9d87w22ml6jy"],
    expands: ["demo4_via_rel_one_no_cascade_required"],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 1,
    expectExpandFailures: 0,
  },
  {
    testName: "nested back expand via single relation field",
    collectionIdOrName: "demo3",
    recordIds: ["lcl9d87w22ml6jy"],
    expands: ["demo4_via_rel_one_no_cascade_required.self_rel_many.self_rel_many.self_rel_one"],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 5,
    expectExpandFailures: 0,
  },
  {
    testName: "nested back expand via multiple relation field",
    collectionIdOrName: "demo3",
    recordIds: ["lcl9d87w22ml6jy"],
    expands: [
      "demo4_via_rel_many_no_cascade_required.self_rel_many.rel_many_no_cascade_required.demo4_via_rel_many_no_cascade_required",
    ],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 7,
    expectExpandFailures: 0,
  },
  {
    testName: "expand multiple relations sharing a common path",
    collectionIdOrName: "demo4",
    recordIds: ["qzaqccwrmva4o1n"],
    expands: [
      "rel_one_no_cascade",
      "rel_many_no_cascade",
      "self_rel_many.self_rel_one.rel_many_cascade",
      "self_rel_many.self_rel_one.rel_many_no_cascade_required",
    ],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 5,
    expectExpandFailures: 0,
  },
];

describe("TestExpandRecords", () => {
  let app: TestCollectionsApp;

  beforeAll(() => {
    app = openTestApp();
  });

  afterAll(() => {
    app.cleanup();
  });

  for (const s of expandRecordsScenarios) {
    test(s.testName, async () => {
      const ids = toUniqueStringSlice(s.recordIds);
      const records = recordsByIdsOrNone(app, s.collectionIdOrName, ids);
      const failed = await expandRecords(app, records, s.expands, s.fetchFunc(app));

      expect(failed.size).toBe(s.expectExpandFailures);

      const encoded = marshal(records);
      expect(nonemptyExpandProps(encoded)).toBe(s.expectNonemptyExpandProps);
    });
  }
});

interface ExpandRecordScenario {
  testName: string;
  collectionIdOrName: string;
  recordId: string;
  expands: string[];
  fetchFunc: FetchFactory;
  expectNonemptyExpandProps: number;
  expectExpandFailures: number;
}

const expandRecordScenarios: ExpandRecordScenario[] = [
  {
    testName: "empty expand",
    collectionIdOrName: "demo4",
    recordId: "i9naidtvr6qsgb4",
    expands: [],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 0,
    expectExpandFailures: 0,
  },
  {
    testName: "fetchFunc with error",
    collectionIdOrName: "demo4",
    recordId: "i9naidtvr6qsgb4",
    expands: ["self_rel_one", "self_rel_many.self_rel_one"],
    fetchFunc: failingFetch,
    expectNonemptyExpandProps: 0,
    expectExpandFailures: 2,
  },
  {
    testName: "missing relation field",
    collectionIdOrName: "demo4",
    recordId: "i9naidtvr6qsgb4",
    expands: ["missing"],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 0,
    expectExpandFailures: 1,
  },
  {
    testName: "existing, but non-relation type field",
    collectionIdOrName: "demo4",
    recordId: "i9naidtvr6qsgb4",
    expands: ["title"],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 0,
    expectExpandFailures: 1,
  },
  {
    testName: "invalid/missing second level expand",
    collectionIdOrName: "demo4",
    recordId: "qzaqccwrmva4o1n",
    expands: ["rel_one_no_cascade.title"],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 0,
    expectExpandFailures: 1,
  },
  {
    testName: "expand normalizations",
    collectionIdOrName: "demo4",
    recordId: "qzaqccwrmva4o1n",
    expands: [
      "self_rel_one",
      "self_rel_many.self_rel_many.rel_one_no_cascade",
      "self_rel_many.self_rel_one.self_rel_many.self_rel_one.rel_one_no_cascade",
      "self_rel_many",
      "self_rel_many.",
      "  self_rel_many  ",
      "",
    ],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 8,
    expectExpandFailures: 0,
  },
  {
    testName: "no rels to expand",
    collectionIdOrName: "users",
    recordId: "oap640cot4yru2s",
    expands: ["rel"],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 0,
    expectExpandFailures: 0,
  },
  {
    testName: "maxExpandDepth reached",
    collectionIdOrName: "demo4",
    recordId: "qzaqccwrmva4o1n",
    expands: [
      "self_rel_many.self_rel_many.self_rel_many.self_rel_many.self_rel_many.self_rel_many.self_rel_many.self_rel_many.self_rel_many.self_rel_many.self_rel_many.self_rel_many",
    ],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 6,
    expectExpandFailures: 0,
  },
  {
    testName: "simple indirect expand via single relation field (deprecated syntax)",
    collectionIdOrName: "demo3",
    recordId: "lcl9d87w22ml6jy",
    expands: ["demo4(rel_one_no_cascade_required)"],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 1,
    expectExpandFailures: 0,
  },
  {
    testName: "simple indirect expand via single relation field",
    collectionIdOrName: "demo3",
    recordId: "lcl9d87w22ml6jy",
    expands: ["demo4_via_rel_one_no_cascade_required"],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 1,
    expectExpandFailures: 0,
  },
  {
    testName: "nested indirect expand via single relation field",
    collectionIdOrName: "demo3",
    recordId: "lcl9d87w22ml6jy",
    expands: ["demo4(rel_one_no_cascade_required).self_rel_many.self_rel_many.self_rel_one"],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 5,
    expectExpandFailures: 0,
  },
  {
    testName: "nested indirect expand via single relation field",
    collectionIdOrName: "demo3",
    recordId: "lcl9d87w22ml6jy",
    expands: [
      "demo4_via_rel_many_no_cascade_required.self_rel_many.rel_many_no_cascade_required.demo4_via_rel_many_no_cascade_required",
    ],
    fetchFunc: findByIds,
    expectNonemptyExpandProps: 7,
    expectExpandFailures: 0,
  },
];

describe("TestExpandRecord", () => {
  let app: TestCollectionsApp;

  beforeAll(() => {
    app = openTestApp();
  });

  afterAll(() => {
    app.cleanup();
  });

  for (const s of expandRecordScenarios) {
    test(s.testName, async () => {
      const record = findRecordById(app, s.collectionIdOrName, s.recordId);
      const failed = await expandRecord(app, record, s.expands, s.fetchFunc(app));

      expect(failed.size).toBe(s.expectExpandFailures);

      const encoded = marshal(record);
      expect(nonemptyExpandProps(encoded)).toBe(s.expectNonemptyExpandProps);
    });
  }
});

describe("TestBackRelationExpandSingeVsArrayResult", () => {
  test("TestBackRelationExpandSingeVsArrayResult", async () => {
    const app = openTestApp();
    try {
      const record = findRecordById(app, "demo3", "7nwo8tuiatetxdm");

      // non-unique indirect expand
      {
        const errs = await expandRecord(app, record, ["demo4_via_rel_one_cascade"], findByIds(app));
        expect(errs.size).toBe(0);

        expect(Array.isArray(record.expand()["demo4_via_rel_one_cascade"])).toBe(true);
      }

      // unique indirect expand
      {
        // mock a unique constraint for the rel_one_cascade field
        // ---
        const demo4 = findCollectionByNameOrId(app, "demo4");
        demo4.indexes.push("create unique index idx_unique_expand on demo4 (rel_one_cascade)");
        saveCollection(app, demo4);
        // ---

        const errs = await expandRecord(app, record, ["demo4_via_rel_one_cascade"], findByIds(app));
        expect(errs.size).toBe(0);

        expect(record.expand()["demo4_via_rel_one_cascade"]).toBeInstanceOf(Record);
      }
    } finally {
      app.cleanup();
    }
  });
});

describe("TestExpandRecordsQuerySkipDuplicatedIds", () => {
  test("TestExpandRecordsQuerySkipDuplicatedIds", async () => {
    // the SQL log of the app's data.db (openTestApp opens it without a read
    // pool, so the async reads of the expand run on this logged connection);
    // each line is "[<ms>ms] <sql>"
    const logged: string[] = [];
    const app = openTestApp(undefined, (line) => logged.push(line));
    try {
      // fetch records that are known to have at least 1 common relation between them
      const records = findRecordsByIds(app, "demo1", ["84nmscqy84lsi1t", "al1h9ijdeojtsjy"]);

      // log selects from here on
      logged.length = 0;

      // expand
      const failed = await expandRecords(app, records, ["rel_many"], null);
      expect(failed.size).toBe(0);

      const concurrentQueries = logged.map((line) => line.replace(/^\[[\d.]+ms\] /, ""));
      expect(concurrentQueries).toHaveLength(1);

      // "oap640cot4yru2s" is used in both relations but must exists only once
      expect(concurrentQueries[0]).toBe(
        "SELECT `users`.* FROM `users` WHERE `users`.`id` IN ('oap640cot4yru2s', 'bgs820n361vj1qd', '4q1xlclmfloku33')",
      );
    } finally {
      app.cleanup();
    }
  });
});
