// Upstream: core/record_model_test.go (TestRecordValidate, TestRecordSave,
// TestRecordSaveIdFromOtherCollection, TestRecordSaveIdUpdateNoValidation,
// TestRecordSaveWithAutoTokenKeyRefresh, TestRecordDelete,
// TestRecordDeleteWithMultipleRelationCascade,
// TestRecordDeleteBatchProcessing) and core/field_autodate_test.go
// (TestAutodateRecordResave)
//
// Left out: TestRecordModelEventSync (the hook events only). The forced
// update failure of TestAutodateRecordResave binds a failing hook
// upstream; here a temporary trigger on the test copy fails the update.
// TestRecordSaveWithAutoTokenKeyRefresh finds the first "nologin" record
// with "1=1" (FindFirstRecordByFilter, M2.2); here the first row of a
// plain record query.
//
// Each Go test function runs on its own copy of the vendored fixture
// (openTestApp, as tests.NewTestApp).

import { afterEach, describe, expect, test } from "bun:test";

import type { Clock } from "@/app/clock";
import { newBaseCollection } from "@/collections/collection-model";
import { findCollectionByNameOrId } from "@/collections/collection-query";
import { saveCollection, saveCollectionNoValidate } from "@/collections/collection-save";
import { NumberField } from "@/fields/number";
import { RelationField } from "@/fields/relation";
import { TextField } from "@/fields/text";
import { CollectionNameExternalAuths, findAllRefsByRecord } from "@/records/record-auth-refs";
import { type Record, newRecord } from "@/records/record-model";
import {
  findAllRecords,
  findAuthRecordByEmail,
  findFirstRecordByData,
  findRecordById,
  recordQuery,
  recordTarget,
  type RecordsApp,
} from "@/records/record-query";
import {
  deleteRecord,
  saveRecord,
  saveRecordNoValidate,
  validateRecord,
} from "@/records/record-save";
import type { JSONRaw } from "@/tools/types/json-raw";
import { Errors } from "@/validation/error";

import { openTestApp, type TestCollectionsApp } from "@test/collections/app";

const apps: TestCollectionsApp[] = [];

function newTestApp(queryLog?: (line: string) => void, clock?: Clock): TestCollectionsApp {
  const app = openTestApp(clock, queryLog);
  apps.push(app);
  return app;
}

afterEach(() => {
  for (const app of apps.splice(0)) {
    app.cleanup();
  }
});

// the rejection of a promise, or null (Go's returned error)
async function errorOf(p: Promise<unknown>): Promise<Error | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

// tests.TestValidationErrors: the error is a validation Errors with exactly
// the expected keys (or nil when none are expected)
function expectValidationErrors(err: Error | null, expectedKeys: string[]): void {
  if (expectedKeys.length === 0) {
    expect(err).toBeNull();
    return;
  }
  expect(err).toBeInstanceOf(Errors);
  expect(Object.keys((err as Errors).errors).toSorted()).toEqual(expectedKeys.toSorted());
}

function findOrNull(app: RecordsApp, collection: string, id: string): Record | null {
  try {
    return findRecordById(app, collection, id);
  } catch {
    return null;
  }
}

describe("TestRecordValidate", () => {
  test("validates the fields", async () => {
    const app = newTestApp();

    // dummy collection to ensure that the specified field validators are triggered
    const collection = newBaseCollection("validate_test");
    collection.fields.add(
      new TextField({ name: "f1", min: 3 }),
      new NumberField({ name: "f2", required: true }),
    );
    saveCollection(app, collection);

    const record = newRecord(collection);
    record.id = "!invalid";

    // no data set
    expectValidationErrors(await errorOf(validateRecord(app, record)), ["id", "f2"]);

    // failing the text field min requirement
    record.set("f1", "a");
    expectValidationErrors(await errorOf(validateRecord(app, record)), ["id", "f1", "f2"]);

    // satisfying the fields validations
    record.id = "b".repeat(15);
    record.set("f1", "abc");
    record.set("f2", 1);
    expectValidationErrors(await errorOf(validateRecord(app, record)), []);
  });
});

describe("TestRecordSave", () => {
  const scenarios: {
    name: string;
    record: (app: TestCollectionsApp) => Record;
    expectError: boolean;
  }[] = [
    // trigger validators
    {
      name: "create - trigger validators",
      record: (app) => newRecord(findCollectionByNameOrId(app, "demo2")),
      expectError: true,
    },
    {
      name: "update - trigger validators",
      record: (app) => {
        const record = findFirstRecordByData(app, "demo2", "title", "test1");
        record.set("title", "");
        return record;
      },
      expectError: true,
    },

    // create
    {
      name: "create base record",
      record: (app) => {
        const record = newRecord(findCollectionByNameOrId(app, "demo2"));
        record.set("title", "new_test");
        return record;
      },
      expectError: false,
    },
    {
      name: "create auth record",
      record: (app) => {
        const record = newRecord(findCollectionByNameOrId(app, "nologin"));
        record.set("email", "test_new@example.com");
        record.set("password", "1234567890");
        return record;
      },
      expectError: false,
    },
    {
      name: "create view record",
      record: (app) => {
        const record = newRecord(findCollectionByNameOrId(app, "view2"));
        record.set("state", true);
        return record;
      },
      expectError: true, // view records are read-only
    },

    // update
    {
      name: "update base record",
      record: (app) => {
        const record = findFirstRecordByData(app, "demo2", "title", "test1");
        record.set("title", "test_new");
        return record;
      },
      expectError: false,
    },
    {
      name: "update auth record",
      record: (app) => {
        const record = findAuthRecordByEmail(app, "nologin", "test@example.com");
        record.set("name", "test_new");
        record.set("email", "test_new@example.com");
        return record;
      },
      expectError: false,
    },
    {
      name: "update view record",
      record: (app) => {
        const record = findFirstRecordByData(app, "view2", "state", true);
        record.set("state", false);
        return record;
      },
      expectError: true, // view records are read-only
    },
  ];

  for (const s of scenarios) {
    test(s.name, async () => {
      const app = newTestApp();

      const record = s.record(app);

      const saveErr = await errorOf(saveRecord(app, record));

      expect(saveErr !== null).toBe(s.expectError);
      if (saveErr !== null) {
        return;
      }

      // the record should always have an id after successful Save
      expect(record.id).not.toBe("");
      expect(record.isNew()).toBe(false);

      // refetch and compare the serialization
      const refreshed = findRecordById(app, record.collection(), record.id);
      expect(record.marshalJSON()).toBe(refreshed.marshalJSON());
    });
  }
});

describe("TestRecordSaveIdFromOtherCollection", () => {
  test("auth ids are unique across auth collections", async () => {
    const app = newTestApp();

    const baseCollection = findCollectionByNameOrId(app, "demo2");
    const authCollection = findCollectionByNameOrId(app, "nologin");

    // base collection test
    const r1 = newRecord(baseCollection);
    r1.set("title", "test_new");
    r1.set("id", "mk5fmymtx4wsprk"); // existing id of demo3 record
    expect(await errorOf(saveRecord(app, r1))).toBeNull();

    // auth collection test
    const r2 = newRecord(authCollection);
    r2.setEmail("test_new@example.com");
    r2.setPassword("1234567890");
    r2.set("id", "gk390qegs4y47wn"); // existing id of "clients" record
    const err = await errorOf(saveRecord(app, r2));
    expect(err).toBeInstanceOf(Errors);
    expect((err as Errors).marshalJSON()).toBe(`{"id":"Invalid or duplicated auth record id."}`);

    // try again with unique id
    r2.set("id", "a".repeat(15));
    expect(await errorOf(saveRecord(app, r2))).toBeNull();
  });
});

describe("TestRecordSaveIdUpdateNoValidation", () => {
  test("the primary key cannot change", async () => {
    const app = newTestApp();

    const rec = findRecordById(app, "demo3", "7nwo8tuiatetxdm");

    rec.id = "a".repeat(15);

    const err = await errorOf(saveRecordNoValidate(app, rec));
    expect(err?.message).toBe("primary key change is not allowed");

    // no changes
    rec.load(rec.original().fieldsData());
    expect(await errorOf(saveRecordNoValidate(app, rec))).toBeNull();
  });
});

describe("TestRecordSaveWithAutoTokenKeyRefresh", () => {
  const app = (() => {
    let shared: TestCollectionsApp | null = null;
    return () => {
      shared ??= openTestApp();
      return shared;
    };
  })();

  const scenarios: [string, { [key: string]: unknown }, boolean][] = [
    ["no email or password change", { name: "example" }, false],
    ["password change", { password: "1234567890" }, true],
    ["email change", { email: "test_update@example.com" }, true],
  ];

  for (const [name, payload, expectedChange] of scenarios) {
    test(name, async () => {
      const record = recordQuery(app(), "nologin").limit(1).one<Record>(recordTarget);

      const originalTokenKey = record.tokenKey();

      record.load(payload);

      await saveRecord(app(), record);

      const hasChange = originalTokenKey !== record.tokenKey();
      expect(hasChange).toBe(expectedChange);
    });
  }

  test("cleanup", () => {
    app().cleanup();
  });
});

describe("TestRecordDelete", () => {
  test("delete", async () => {
    const queries: string[] = [];
    let logging = false;
    const app = newTestApp((line) => {
      if (logging) {
        queries.push(line);
      }
    });

    const demoCollection = findCollectionByNameOrId(app, "demo2");

    // delete unsaved record
    const newRec = newRecord(demoCollection);
    expect(await errorOf(deleteRecord(app, newRec))).not.toBeNull();

    // delete view record
    let viewRec = findRecordById(app, "view2", "84nmscqy84lsi1t");
    expect((await errorOf(deleteRecord(app, viewRec)))?.message).toBe(
      "view records cannot be deleted",
    );
    // check if it still exists
    viewRec = findRecordById(app, viewRec.collection().id, viewRec.id);
    expect(viewRec).not.toBeNull();

    // delete existing record + external auths
    const rec1 = findRecordById(app, "users", "4q1xlclmfloku33");
    expect(findAllRefsByRecord(app, CollectionNameExternalAuths, rec1).length).toBeGreaterThan(0);
    expect(await errorOf(deleteRecord(app, rec1))).toBeNull();
    // check if it was really deleted
    expect(findOrNull(app, rec1.collection().id, rec1.id)).toBeNull();
    // check if the external auths were deleted
    expect(findAllRefsByRecord(app, CollectionNameExternalAuths, rec1)).toEqual([]);

    // delete existing record while being part of a non-cascade required relation
    const rec2 = findRecordById(app, "demo3", "7nwo8tuiatetxdm");
    expect(await errorOf(deleteRecord(app, rec2))).not.toBeNull();

    // delete existing record + cascade
    logging = true;
    const rec3 = findRecordById(app, "users", "oap640cot4yru2s");
    // delete
    expect(await errorOf(deleteRecord(app, rec3))).toBeNull();
    // check if it was really deleted
    expect(findOrNull(app, rec3.collection().id, rec3.id)).toBeNull();
    // check if the operation cascaded
    expect(findOrNull(app, "demo1", "84nmscqy84lsi1t")).toBeNull();
    // ensure that the json rel fields were prefixed
    // (Go's QueryLogFunc gets the SQL before dbx quotes the [[column]] and
    // {{table}} placeholders; src/db's log has them quoted)
    const joinedQueries = queries.join(" ");
    const expectedRelManyPart =
      "SELECT `demo1`.`id` FROM `demo1` WHERE EXISTS (SELECT 1 FROM json_each(CASE WHEN iif(json_valid(`demo1`.`rel_many`), json_type(`demo1`.`rel_many`)='array', FALSE) THEN `demo1`.`rel_many` ELSE json_array(`demo1`.`rel_many`) END) `__je__` WHERE `__je__`.`value`='";
    expect(joinedQueries).toContain(expectedRelManyPart);
    const expectedRelOnePart = "SELECT `demo1`.`id` FROM `demo1` WHERE (`demo1`.`rel_one`='";
    expect(joinedQueries).toContain(expectedRelOnePart);
  });
});

describe("TestRecordDeleteWithMultipleRelationCascade", () => {
  test("self referencing multiple relation", async () => {
    const app = newTestApp();

    // create a mock collection with self referencing multiple relation field
    const collection = newBaseCollection("test");
    saveCollection(app, collection);

    // for simpler mocks
    (collection.fields.getByName("id") as TextField).min = 1;

    collection.fields.add(
      new RelationField({
        name: "rels",
        collectionId: collection.id,
        maxSelect: 99,
        cascadeDelete: true,
      }),
    );

    saveCollection(app, collection);

    // create mock records
    const relsData: [string, string[] | null][] = [
      ["a", null],
      ["b", ["a"]],
      ["c", ["a", "b"]],
      ["d", []],
      ["e", ["c", "d"]],
    ];
    for (const [id, rels] of relsData) {
      const record = newRecord(collection);
      record.set("id", id);
      record.set("rels", rels);
      await saveRecordNoValidate(app, record);
    }

    // trigger cascade delete for the top record
    const aRecord = findRecordById(app, collection, "a");
    await deleteRecord(app, aRecord);

    // verify cascade delete
    const expectedRels = new Map<string, string[]>([
      ["d", []],
      ["e", ["d"]],
    ]);

    const allRecords = findAllRecords(app, collection);
    expect(allRecords.length).toBe(expectedRels.size);

    for (const r of allRecords) {
      expect(expectedRels.has(r.id)).toBe(true);
      expect(r.getStringSlice("rels")).toEqual(expectedRels.get(r.id) as string[]);
    }
  });
});

// not in upstream's tests: a cascade as deep as Go's growing stack allows
describe("deep relation cascade", () => {
  for (const depth of [1_000, 10_000]) {
    test(`a self-relation chain of ${depth} records`, async () => {
      const app = newTestApp();

      const collection = newBaseCollection("chain");
      saveCollection(app, collection);
      collection.fields.add(
        new RelationField({ name: "parent", collectionId: collection.id, cascadeDelete: true }),
      );
      saveCollection(app, collection);

      // record n references n-1; the root has none
      const db = app.databases.nonconcurrentDB();
      const ids = Array.from({ length: depth }, (_, i) => "r" + String(i).padStart(14, "0"));
      db.newQuery("BEGIN").execute();
      for (const [i, id] of ids.entries()) {
        db.insert("chain", { id, parent: i === 0 ? "" : ids[i - 1] }).execute();
      }
      db.newQuery("COMMIT").execute();

      await deleteRecord(app, findRecordById(app, collection, ids[0] as string));

      expect(findAllRecords(app, collection).length).toBe(0);
    }, 120_000);
  }
});

describe("TestRecordDeleteBatchProcessing", () => {
  test("batches", async () => {
    const app = newTestApp();

    await createMockBatchProcessingData(app);

    // find and delete the first c1 record to trigger cascade
    const mainRecord = findRecordById(app, "c1", "a");
    await deleteRecord(app, mainRecord);

    // check if the main record was deleted
    expect(findOrNull(app, mainRecord.collection().id, mainRecord.id)).toBeNull();

    // check if the c1 b rel field were updated
    const c1RecordB = findRecordById(app, "c1", "b");
    expect(c1RecordB.getString("rel")).toBe("");

    // check if the c2 rel fields were updated
    const c2Records = findAllRecords(app, "c2", null);
    expect(c2Records.length).toBeGreaterThan(0);
    for (const r of c2Records) {
      expect(r.getStringSlice("rel")).toEqual(["b"]);
    }

    // check if all c3 relations were deleted
    expect(findAllRecords(app, "c3", null).length).toBe(0);
  }, 60_000);
});

async function createMockBatchProcessingData(app: TestCollectionsApp): Promise<void> {
  // create mock collection without relation
  const c1 = newBaseCollection("c1");
  c1.id = "c1";
  c1.fields.add(
    new TextField({ name: "text" }),
    new RelationField({
      name: "rel",
      maxSelect: 1,
      collectionId: "c1",
      cascadeDelete: false, // should unset all rel fields
    }),
  );
  saveCollectionNoValidate(app, c1);

  // create mock collection with a multi-rel field
  const c2 = newBaseCollection("c2");
  c2.id = "c2";
  c2.fields.add(
    new TextField({ name: "text" }),
    new RelationField({
      name: "rel",
      maxSelect: 10,
      collectionId: "c1",
      cascadeDelete: false, // should unset all rel fields
    }),
  );
  saveCollectionNoValidate(app, c2);

  // create mock collection with a single-rel field
  const c3 = newBaseCollection("c3");
  c3.id = "c3";
  c3.fields.add(
    new RelationField({
      name: "rel",
      maxSelect: 1,
      collectionId: "c1",
      cascadeDelete: true, // should delete all c3 records
    }),
  );
  saveCollectionNoValidate(app, c3);

  // insert mock records
  const c1RecordA = newRecord(c1);
  c1RecordA.id = "a";
  c1RecordA.set("rel", c1RecordA.id); // self reference
  await saveRecordNoValidate(app, c1RecordA);
  const c1RecordB = newRecord(c1);
  c1RecordB.id = "b";
  c1RecordB.set("rel", c1RecordA.id); // rel to another record from the same collection
  await saveRecordNoValidate(app, c1RecordB);
  for (let i = 0; i < 4500; i++) {
    const c2Record = newRecord(c2);
    c2Record.set("rel", [c1RecordA.id, c1RecordB.id]);
    await saveRecordNoValidate(app, c2Record);

    const c3Record = newRecord(c3);
    c3Record.set("rel", c1RecordA.id);
    await saveRecordNoValidate(app, c3Record);
  }

  // set the same id as the relation for at least 1 record
  // to check whether the correct condition will be added
  const c3Record = newRecord(c3);
  c3Record.set("rel", c1RecordA.id);
  c3Record.id = c1RecordA.id;
  await saveRecordNoValidate(app, c3Record);
}

describe("TestAutodateRecordResave", () => {
  test("resave", async () => {
    // a clock that moves 1s on every read, so that no two saves share a time
    let now = Date.parse("2026-01-01T00:00:00Z");
    const app = newTestApp(undefined, {
      now: () => {
        now += 1000;
        return new Date(now);
      },
    });

    const collection = findCollectionByNameOrId(app, "demo2");

    const record = findRecordById(app, collection, "llvuca81nly1qls");

    let lastUpdated = record.getDateTime("updated");

    // save with autogenerated date
    await saveRecord(app, record);

    let newUpdated = record.getDateTime("updated");
    expect(newUpdated.equal(lastUpdated)).toBe(false); // [0]
    lastUpdated = newUpdated;

    // save with custom date
    const manualUpdated = lastUpdated.add(-60_000);
    record.setRaw("updated", manualUpdated);
    await saveRecord(app, record);

    newUpdated = record.getDateTime("updated");
    expect(newUpdated.equal(manualUpdated)).toBe(true); // [1]
    lastUpdated = newUpdated;

    // save again with autogenerated date
    await saveRecord(app, record);

    newUpdated = record.getDateTime("updated");
    expect(newUpdated.equal(lastUpdated)).toBe(false); // [2]
    lastUpdated = newUpdated;

    // simulate save failure (upstream: a failing OnRecordUpdateExecute hook)
    const db = app.databases.nonconcurrentDB();
    db.newQuery(
      `CREATE TEMP TRIGGER test_failure BEFORE UPDATE ON demo2 BEGIN SELECT RAISE(ABORT, 'test'); END`,
    ).execute();

    // save again with autogenerated date (should fail)
    expect(await errorOf(saveRecord(app, record))).not.toBeNull();

    // updated should still be set even after save failure
    newUpdated = record.getDateTime("updated");
    expect(newUpdated.equal(lastUpdated)).toBe(false); // [3]
    lastUpdated = newUpdated;

    // cleanup the error and resave again
    db.newQuery("DROP TRIGGER temp.test_failure").execute();

    await saveRecord(app, record);

    newUpdated = record.getDateTime("updated");
    expect(newUpdated.equal(lastUpdated)).toBe(false); // [4]
  });
});

// not in upstream's tests: the stored storage classes of the write path
describe("stored values", () => {
  test("JSONRaw bytes that are not valid UTF-8 are stored as TEXT", async () => {
    const app = newTestApp();

    const collection = findCollectionByNameOrId(app, "demo1");
    const record = newRecord(collection);
    record.id = "utf8test0000001";
    record.set("text", "x");
    // a quoted string with the byte 0xff, as Go keeps it in a JSONRaw
    record.set("json", new Uint8Array([0x22, 0x61, 0xff, 0x22]));
    record.set("bool", true);
    record.set("number", 1.5);
    await saveRecordNoValidate(app, record);

    const row = app.databases
      .concurrentDB()
      .newQuery(
        "SELECT typeof([[json]]) a, hex([[json]]) b, typeof([[bool]]) c, [[bool]] d, typeof([[number]]) e, typeof([[datetime]]) f FROM demo1 WHERE id = {:id}",
      )
      .bind({ id: record.id })
      .one();
    expect(row).toEqual({ a: "text", b: "2261FF22", c: "integer", d: 1, e: "real", f: "text" });

    // the record keeps the bytes it wrote
    expect((record.dbExport().json as JSONRaw).value()).toEqual(
      new Uint8Array([0x22, 0x61, 0xff, 0x22]),
    );
  });

  test("a field named __proto__ is stored", async () => {
    const app = newTestApp();

    const collection = newBaseCollection("protos");
    collection.fields.add(new TextField({ name: "__proto__" }));
    saveCollection(app, collection);

    const record = newRecord(collection);
    record.set("__proto__", "keep-me");
    await saveRecord(app, record);

    const stored = () =>
      app.databases
        .concurrentDB()
        .newQuery("SELECT [[__proto__]] v FROM protos WHERE id = {:id}")
        .bind({ id: record.id })
        .column<string>();
    expect(stored()).toEqual(["keep-me"]);
    expect(findRecordById(app, collection, record.id).getString("__proto__")).toBe("keep-me");

    record.set("__proto__", "updated");
    await saveRecord(app, record);
    expect(stored()).toEqual(["updated"]);
  });
});
