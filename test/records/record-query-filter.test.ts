// Upstream: core/record_query_test.go (TestFindRecordsByFilter,
// TestFindFirstRecordByFilter, TestCanAccessRecord)
//
// Each Go test function runs on its own copy of the vendored fixture
// (openTestApp, as tests.NewTestApp). Each case also runs through the
// async form, once without and once with a read worker pool (the pool
// must be busy with the read while it runs), and must give the same
// result.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RequestInfo } from "@/app/event-request";
import { reloadCachedCollections } from "@/collections/collection-query";
import { Databases } from "@/db/base";
import type { Params } from "@/db/dbx/query";
import { NoRowsError } from "@/db/dbx/rows";
import type { Record } from "@/records/record-model";
import { findAuthRecordByEmail, findRecordById, type RecordsApp } from "@/records/record-query";
import {
  canAccessRecord,
  canAccessRecordAsync,
  findFirstRecordByFilter,
  findFirstRecordByFilterAsync,
  findRecordsByFilter,
  findRecordsByFilterAsync,
} from "@/records/record-query-filter";
import { Store } from "@/tools/store/store";

import { openTestApp, type TestCollectionsApp } from "@test/collections/app";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";

// a copy of the vendored fixture with a read worker pool
function openPooledApp(): RecordsApp & { cleanup(): Promise<void> } {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-filter-"));
  const dataDir = join(root, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  const databases = Databases.open({ dataDir, readWorkers: 1 });
  const app = {
    databases,
    store: new Store<string, unknown>(),
    clock: { now: () => new Date() },
    logger: { error: () => {} },
    async cleanup() {
      databases.close();
      await databases.closed();
      rmSync(root, { recursive: true, force: true });
    },
  };
  reloadCachedCollections(app);
  return app;
}

// runs an async read and checks that it ran on the pool
async function onPool<T>(app: RecordsApp, read: () => Promise<T>): Promise<T> {
  const pending = read();
  expect(app.databases.readPool()?.stats().busy).toBe(1);
  return pending;
}

// the error a call throws, or null (Go's returned error)
function errorOf(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

async function asyncErrorOf(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

function checkRecords(
  expectError: string,
  expectRecordIds: string[],
  records: Record[] | undefined,
  err: unknown,
): void {
  if (expectError !== "") {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(expectError);
    return;
  }
  expect(err).toBeNull();
  expect((records ?? []).map((r) => r.id)).toEqual(expectRecordIds);
}

function checkRecord(
  expectError: string,
  expectRecordId: string,
  record: Record | undefined,
  err: unknown,
): void {
  if (expectError !== "") {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(expectError);
    return;
  }
  expect(err).toBeNull();
  expect(record?.id).toBe(expectRecordId);
}

function requestInfo(init: { auth?: Record; body?: { [key: string]: unknown } }): RequestInfo {
  const info = new RequestInfo();
  info.auth = init.auth;
  if (init.body !== undefined) {
    info.body = init.body;
  }
  return info;
}

let app: TestCollectionsApp;
let pooled: RecordsApp & { cleanup(): Promise<void> };

beforeAll(() => {
  app = openTestApp();
  pooled = openPooledApp();
});

afterAll(async () => {
  app.cleanup();
  await pooled.cleanup();
});

describe("TestFindRecordsByFilter", () => {
  interface Scenario {
    name: string;
    collectionIdOrName: string;
    filter: string;
    sort: string;
    limit: number;
    offset: number;
    params: Params[];
    expectError: string;
    expectRecordIds: string[];
  }

  const scenarios: Scenario[] = [
    {
      name: "missing collection",
      collectionIdOrName: "missing",
      filter: "id != ''",
      sort: "",
      limit: 0,
      offset: 0,
      params: [],
      expectError: "sql: no rows in result set",
      expectRecordIds: [],
    },
    {
      name: "invalid filter",
      collectionIdOrName: "demo2",
      filter: "someMissingField > 1",
      sort: "",
      limit: 0,
      offset: 0,
      params: [],
      expectError:
        'invalid filter expression: invalid left operand "someMissingField" - unknown field "someMissingField"',
      expectRecordIds: [],
    },
    {
      name: "empty filter",
      collectionIdOrName: "demo2",
      filter: "",
      sort: "",
      limit: 0,
      offset: 0,
      params: [],
      expectError: "",
      expectRecordIds: ["llvuca81nly1qls", "achvryl401bhse3", "0yxhwia2amd8gec"],
    },
    {
      name: "simple filter",
      collectionIdOrName: "demo2",
      filter: "id != ''",
      sort: "",
      limit: 0,
      offset: 0,
      params: [],
      expectError: "",
      expectRecordIds: ["llvuca81nly1qls", "achvryl401bhse3", "0yxhwia2amd8gec"],
    },
    {
      name: "multi-condition filter with sort",
      collectionIdOrName: "demo2",
      filter: "id != '' && active=true",
      sort: "-created,title",
      limit: -1, // should behave the same as 0
      offset: 0,
      params: [],
      expectError: "",
      expectRecordIds: ["0yxhwia2amd8gec", "achvryl401bhse3"],
    },
    {
      name: "with limit and offset",
      collectionIdOrName: "sz5l5z67tg7gku0",
      filter: "id != ''",
      sort: "title",
      limit: 2,
      offset: 1,
      params: [],
      expectError: "",
      expectRecordIds: ["achvryl401bhse3", "0yxhwia2amd8gec"],
    },
    {
      name: "with placeholder params",
      collectionIdOrName: "demo2",
      filter: "active = {:active}",
      sort: "",
      limit: 10,
      offset: 0,
      params: [{ active: false }],
      expectError: "",
      expectRecordIds: ["llvuca81nly1qls"],
    },
    {
      name: "with json filter and sort",
      collectionIdOrName: "demo4",
      filter: "json_object != null && json_object.a.b = 'test'",
      sort: "-json_object.a",
      limit: 10,
      offset: 0,
      params: [{ active: false }],
      expectError: "",
      expectRecordIds: ["i9naidtvr6qsgb4"],
    },
    // not upstream's: an invalid sort field
    {
      name: "invalid sort field",
      collectionIdOrName: "demo2",
      filter: "",
      sort: "missing",
      limit: 0,
      offset: 0,
      params: [],
      expectError: 'invalid sort field "missing"',
      expectRecordIds: [],
    },
  ];

  for (const s of scenarios) {
    test(s.name, async () => {
      let records: Record[] | undefined;
      let err = errorOf(() => {
        records = findRecordsByFilter(
          app,
          s.collectionIdOrName,
          s.filter,
          s.sort,
          s.limit,
          s.offset,
          ...s.params,
        );
      });
      checkRecords(s.expectError, s.expectRecordIds, records, err);

      for (const a of [app, pooled]) {
        records = undefined;
        err = await asyncErrorOf(async () => {
          const read = () =>
            findRecordsByFilterAsync(
              a,
              s.collectionIdOrName,
              s.filter,
              s.sort,
              s.limit,
              s.offset,
              ...s.params,
            );
          records = a === pooled && s.expectError === "" ? await onPool(a, read) : await read();
        });
        checkRecords(s.expectError, s.expectRecordIds, records, err);
      }
    });
  }
});

describe("TestFindFirstRecordByFilter", () => {
  // [name, collectionIdOrName, filter, params, expectError, expectRecordId]
  const scenarios: [string, string, string, Params[], string, string][] = [
    ["missing collection", "missing", "id != ''", [], "sql: no rows in result set", ""],
    [
      "invalid filter",
      "demo2",
      "someMissingField > 1",
      [],
      'invalid filter expression: invalid left operand "someMissingField" - unknown field "someMissingField"',
      "",
    ],
    ["empty filter", "demo2", "", [], "", "llvuca81nly1qls"],
    ["valid filter but no matches", "demo2", "id = 'test'", [], "sql: no rows in result set", ""],
    ["valid filter and multiple matches", "sz5l5z67tg7gku0", "id != ''", [], "", "llvuca81nly1qls"],
    [
      "with placeholder params",
      "demo2",
      "active = {:active}",
      [{ active: false }],
      "",
      "llvuca81nly1qls",
    ],
  ];

  for (const [name, collectionIdOrName, filter, params, expectError, expectRecordId] of scenarios) {
    test(name, async () => {
      let record: Record | undefined;
      let err = errorOf(() => {
        record = findFirstRecordByFilter(app, collectionIdOrName, filter, ...params);
      });
      checkRecord(expectError, expectRecordId, record, err);

      for (const a of [app, pooled]) {
        record = undefined;
        err = await asyncErrorOf(async () => {
          record = await findFirstRecordByFilterAsync(a, collectionIdOrName, filter, ...params);
        });
        checkRecord(expectError, expectRecordId, record, err);
      }
    });
  }

  test("no matches is sql.ErrNoRows", () => {
    expect(errorOf(() => findFirstRecordByFilter(app, "demo2", "id = 'test'"))).toBeInstanceOf(
      NoRowsError,
    );
  });
});

describe("TestCanAccessRecord", () => {
  // [name, auth, body, rule, expected, expectError]
  type Scenario = [
    string,
    "superuser" | "user" | null,
    { [key: string]: unknown } | undefined,
    string | null,
    boolean,
    boolean,
  ];

  const scenarios: Scenario[] = [
    ["as superuser with nil rule", "superuser", undefined, null, true, false],
    // the filter rule should be ignored
    ["as superuser with non-empty rule", "superuser", undefined, "id = ''", true, false],
    // the filter rule should be ignored
    ["as superuser with invalid rule", "superuser", undefined, "id ?!@ 1", true, false],
    ["as guest with nil rule", null, undefined, null, false, false],
    ["as guest with empty rule", null, undefined, "", true, false],
    ["as guest with invalid rule", null, undefined, "id ?!@ 1", false, true],
    ["as guest with mismatched rule", null, undefined, "@request.auth.id != ''", false, false],
    [
      "as guest with matched rule",
      null,
      { test: 1 },
      "@request.auth.id != '' || @request.body.test = 1",
      true,
      false,
    ],
    ["as auth record with nil rule", "user", undefined, null, false, false],
    ["as auth record with empty rule", "user", undefined, "", true, false],
    ["as auth record with invalid rule", "user", undefined, "id ?!@ 1", false, true],
    [
      "as auth record with mismatched rule",
      "user",
      { test: 1 },
      "@request.auth.id != '' && @request.body.test > 1",
      false,
      false,
    ],
    [
      "as auth record with matched rule",
      "user",
      { test: 2 },
      "@request.auth.id != '' && @request.body.test > 1",
      true,
      false,
    ],
  ];

  for (const [name, authName, body, rule, expected, expectError] of scenarios) {
    test(name, async () => {
      for (const a of [app, pooled]) {
        const superuser = findAuthRecordByEmail(a, "_superusers", "test@example.com");
        const user = findAuthRecordByEmail(a, "users", "test@example.com");
        const record = findRecordById(a, "demo1", "imy661ixudk5izi");
        const auth = authName === "superuser" ? superuser : authName === "user" ? user : undefined;
        const info = requestInfo({ ...(auth ? { auth } : {}), ...(body ? { body } : {}) });

        // Go returns (false, err): the result of a thrown error is false
        let result = false;
        let err = errorOf(() => {
          result = canAccessRecord(a, record, info, rule);
        });
        expect({ result, hasErr: err !== null }).toEqual({ result: expected, hasErr: expectError });

        result = false;
        err = await asyncErrorOf(async () => {
          result = await canAccessRecordAsync(a, record, info, rule);
        });
        expect({ result, hasErr: err !== null }).toEqual({ result: expected, hasErr: expectError });
      }
    });
  }
});
