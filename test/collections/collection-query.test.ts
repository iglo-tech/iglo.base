// Upstream: core/collection_query_test.go (all but TestFindCollectionTruncate,
// which is M1.7's)
//
// Each test runs on a copy of the vendored fixture with the collections
// cache loaded (openTestApp, as tests.NewTestApp). Upstream counts the
// queries with the concurrent DB's QueryLogFunc; here the data.db
// statement log (Databases' devSQLLog) counts them.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { CollectionTypeAuth, CollectionTypeView } from "@/collections/collection-model";
import {
  StoreKeyCachedCollections,
  collectionQuery,
  findAllCollections,
  findCachedCollectionByNameOrId,
  findCachedCollectionReferences,
  findCollectionByNameOrId,
  findCollectionReferences,
  isCollectionNameUnique,
  reloadCachedCollections,
} from "@/collections/collection-query";
import { equalFold } from "@/collections/go-strings";
import { isNoRowsError } from "@/db/dbx/rows";
import { nonzeroUniques } from "@/tools/list/list";

import { openTestApp, type TestCollectionsApp } from "@test/collections/app";

let totalQueries = 0;
let app: TestCollectionsApp;

beforeAll(() => {
  app = openTestApp(undefined, () => {
    totalQueries++;
  });
});

afterAll(() => {
  app.cleanup();
});

// the fixture's collections in rowid order (upstream's FindAllCollections order)
const fixtureNames = [
  "users",
  "demo1",
  "demo2",
  "demo3",
  "demo4",
  "clients",
  "nologin",
  "demo5",
  "view1",
  "view2",
  "numeric_id_view",
  "_superusers",
  "_externalAuths",
  "_mfas",
  "_otps",
  "_authOrigins",
];

test("TestCollectionQuery", () => {
  const expected = "SELECT {{_collections}}.* FROM `_collections`";

  const sql = collectionQuery(app).build().sql();
  expect(sql).toBe(expected);
});

test("TestReloadCachedCollections", () => {
  reloadCachedCollections(app);

  const cached = app.store.get(StoreKeyCachedCollections);
  expect(Array.isArray(cached)).toBe(true);
  const cachedCollections = cached as { id: string }[];

  const collections = findAllCollections(app);

  expect(cachedCollections.length).toBe(collections.length);

  for (const c of collections) {
    expect({ name: c.name, cached: cachedCollections.some((cc) => cc.id === c.id) }).toEqual({
      name: c.name,
      cached: true,
    });
  }
});

describe("TestFindAllCollections", () => {
  const scenarios: { collectionTypes: string[]; expectTotal: number }[] = [
    { collectionTypes: [], expectTotal: 16 }, // nil
    { collectionTypes: [], expectTotal: 16 },
    { collectionTypes: [""], expectTotal: 16 },
    { collectionTypes: ["unknown"], expectTotal: 0 },
    { collectionTypes: ["unknown", CollectionTypeAuth], expectTotal: 4 },
    { collectionTypes: [CollectionTypeAuth, CollectionTypeView], expectTotal: 7 },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${s.collectionTypes.join("_")}`, () => {
      const collections = findAllCollections(app, ...s.collectionTypes);

      expect(collections.length).toBe(s.expectTotal);

      const expectedTypes = nonzeroUniques(s.collectionTypes);
      if (expectedTypes.length > 0) {
        for (const c of collections) {
          expect(expectedTypes).toContain(c.type);
        }
      }
    });
  }

  test("rowid order", () => {
    expect(findAllCollections(app).map((c) => c.name)).toEqual(fixtureNames);
    expect(findAllCollections(app, CollectionTypeView).map((c) => c.name)).toEqual([
      "view1",
      "view2",
      "numeric_id_view",
    ]);
  });
});

const nameOrIdScenarios: { nameOrId: string; expectError: boolean }[] = [
  { nameOrId: "", expectError: true },
  { nameOrId: "missing", expectError: true },
  { nameOrId: "wsmn24bux7wo113", expectError: false },
  { nameOrId: "demo1", expectError: false },
  { nameOrId: "DEMO1", expectError: false }, // case insensitive
];

describe("TestFindCollectionByNameOrId", () => {
  for (const [i, s] of nameOrIdScenarios.entries()) {
    test(`${i}_${s.nameOrId}`, () => {
      let err: unknown = null;
      let model = null;
      try {
        model = findCollectionByNameOrId(app, s.nameOrId);
      } catch (e) {
        err = e;
      }

      expect(err !== null).toBe(s.expectError);
      if (err !== null) {
        expect(isNoRowsError(err)).toBe(true);
      }

      if (model !== null) {
        expect(model.id === s.nameOrId || equalFold(model.name, s.nameOrId)).toBe(true);
        // a loaded model is not new
        expect(model.isNew()).toBe(false);
      }
    });
  }
});

function runFindCachedCollectionByNameOrId(withCache: boolean): void {
  let expectedTotalQueries: number;

  if (withCache) {
    reloadCachedCollections(app);
    expectedTotalQueries = 0;
  } else {
    app.store.reset();
    expectedTotalQueries = nameOrIdScenarios.length;
  }

  totalQueries = 0;

  for (const s of nameOrIdScenarios) {
    let err: unknown = null;
    let model = null;
    try {
      model = findCachedCollectionByNameOrId(app, s.nameOrId);
    } catch (e) {
      err = e;
    }

    expect({ nameOrId: s.nameOrId, hasErr: err !== null }).toEqual({
      nameOrId: s.nameOrId,
      hasErr: s.expectError,
    });
    if (err !== null) {
      expect(isNoRowsError(err)).toBe(true);
    }

    if (model !== null) {
      expect(model.id === s.nameOrId || equalFold(model.name, s.nameOrId)).toBe(true);
    }
  }

  expect(totalQueries).toBe(expectedTotalQueries);
}

describe("TestFindCachedCollectionByNameOrId", () => {
  test("with cache", () => runFindCachedCollectionByNameOrId(true));

  test("without cache", () => runFindCachedCollectionByNameOrId(false));
});

const expectedReferenceFields = [
  "rel_one_no_cascade",
  "rel_one_no_cascade_required",
  "rel_one_cascade",
  "rel_one_unique",
  "rel_many_no_cascade",
  "rel_many_no_cascade_required",
  "rel_many_cascade",
  "rel_many_unique",
];

test("TestFindCollectionReferences", () => {
  const collection = findCollectionByNameOrId(app, "demo3");

  const result = findCollectionReferences(
    app,
    collection,
    collection.id,
    // test whether "nonempty" exclude ids condition will be skipped
    "",
    "",
  );

  expect(result.size).toBe(1);

  for (const [col, fields] of result) {
    expect(col.name).toBe("demo4");
    expect(fields.map((f) => f.getName()).toSorted()).toEqual(expectedReferenceFields.toSorted());
  }
});

function runFindCachedCollectionReferences(withCache: boolean): void {
  const collection = findCollectionByNameOrId(app, "demo3");

  let expectedTotalQueries: number;

  if (withCache) {
    reloadCachedCollections(app);
    expectedTotalQueries = 0;
  } else {
    app.store.reset();
    expectedTotalQueries = 1;
  }

  totalQueries = 0;

  const result = findCachedCollectionReferences(
    app,
    collection,
    collection.id,
    // test whether "nonempty" exclude ids condition will be skipped
    "",
    "",
  );

  expect(result.size).toBe(1);

  for (const [col, fields] of result) {
    expect(col.name).toBe("demo4");
    expect(fields.map((f) => f.getName()).toSorted()).toEqual(expectedReferenceFields.toSorted());
  }

  expect(totalQueries).toBe(expectedTotalQueries);
}

// collection name → its referencing field names
function referenceNames(
  refs: Map<{ name: string }, { getName(): string }[]>,
): (string | string[])[][] {
  return [...refs].map(([col, fields]) => [col.name, fields.map((f) => f.getName())]);
}

describe("TestFindCachedCollectionReferences", () => {
  test("with cache", () => runFindCachedCollectionReferences(true));

  test("without cache", () => runFindCachedCollectionReferences(false));

  test("the cached references are the queried ones", () => {
    reloadCachedCollections(app);
    for (const name of ["demo3", "demo4", "users"]) {
      const c = findCollectionByNameOrId(app, name);
      for (const exclude of [[], [c.id]]) {
        expect(referenceNames(findCachedCollectionReferences(app, c, ...exclude))).toEqual(
          referenceNames(findCollectionReferences(app, c, ...exclude)),
        );
      }
    }
  });
});

describe("TestIsCollectionNameUnique", () => {
  const scenarios: { name: string; excludeId: string; expected: boolean }[] = [
    { name: "", excludeId: "", expected: false },
    { name: "demo1", excludeId: "", expected: false },
    { name: "Demo1", excludeId: "", expected: false },
    { name: "new", excludeId: "", expected: true },
    { name: "demo1", excludeId: "wsmn24bux7wo113", expected: true },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${s.name}`, () => {
      expect(isCollectionNameUnique(app, s.name, s.excludeId)).toBe(s.expected);
    });
  }
});

describe("Go's strings.ToLower on the looked up name", () => {
  // Go lowers U+0130 to "i" (JS: "i" + U+0307), so the name matches
  test("FindCollectionByNameOrId", () => {
    expect(findCollectionByNameOrId(app, "CL\u0130ENTS").name).toBe("clients");
  });

  test("IsCollectionNameUnique", () => {
    expect(isCollectionNameUnique(app, "CL\u0130ENTS")).toBe(false);
  });
});
