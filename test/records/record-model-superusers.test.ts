// Upstream: core/record_model_superusers_test.go (TestRecordIsSuperUser)
//
// The record checks of registerSuperuserHooks have no unit test upstream
// (its API tests cover them); the tests below check them through the
// record save and delete entry points.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { findCollectionByNameOrId } from "@/collections/collection-query";
import { newRecord } from "@/records/record-model";
import { CollectionNameSuperusers, DefaultInstallerEmail } from "@/records/record-model-superusers";
import { countRecords, findAuthRecordByEmail, findRecordById } from "@/records/record-query";
import { deleteRecord, saveRecord } from "@/records/record-save";
import { ApiError } from "@/server/error";

import { openTestApp, type TestCollectionsApp } from "@test/collections/app";

describe("RecordIsSuperUser", () => {
  let app: TestCollectionsApp;

  beforeAll(() => {
    app = openTestApp();
  });

  afterAll(() => {
    app.cleanup();
  });

  test("demo1, users and _superusers records", () => {
    const demo1 = findRecordById(app, "demo1", "84nmscqy84lsi1t");
    const user = findAuthRecordByEmail(app, "users", "test@example.com");
    const superuser = findAuthRecordByEmail(app, CollectionNameSuperusers, "test@example.com");

    expect(demo1.isSuperuser()).toBe(false);
    expect(user.isSuperuser()).toBe(false);
    expect(superuser.isSuperuser()).toBe(true);
  });
});

describe("superusers record checks", () => {
  let app: TestCollectionsApp;

  beforeAll(() => {
    app = openTestApp();
  });

  afterAll(() => {
    app.cleanup();
  });

  test("a saved superuser is always verified", async () => {
    const superuser = findAuthRecordByEmail(app, CollectionNameSuperusers, "test2@example.com");
    superuser.setVerified(false);
    await saveRecord(app, superuser);
    expect(superuser.verified()).toBe(true);
    expect(findRecordById(app, CollectionNameSuperusers, superuser.id).verified()).toBe(true);

    const created = newRecord(findCollectionByNameOrId(app, CollectionNameSuperusers));
    created.setEmail("verified@example.com");
    created.setPassword("1234567890");
    await saveRecord(app, created);
    expect(findRecordById(app, CollectionNameSuperusers, created.id).verified()).toBe(true);
  });

  test("a new superuser deletes the installer superuser", async () => {
    const collection = findCollectionByNameOrId(app, CollectionNameSuperusers);

    // the installer itself is kept
    const installer = newRecord(collection);
    installer.setEmail(DefaultInstallerEmail);
    installer.setPassword("1234567890");
    await saveRecord(app, installer);
    expect(findRecordById(app, CollectionNameSuperusers, installer.id).id).toBe(installer.id);

    // an update of another superuser keeps it
    const other = findAuthRecordByEmail(app, CollectionNameSuperusers, "test3@example.com");
    other.set("password", "1234567890");
    await saveRecord(app, other);
    expect(findRecordById(app, CollectionNameSuperusers, installer.id).id).toBe(installer.id);

    // a new superuser deletes it
    const created = newRecord(collection);
    created.setEmail("installed@example.com");
    created.setPassword("1234567890");
    await saveRecord(app, created);
    expect(() => findRecordById(app, CollectionNameSuperusers, installer.id)).toThrow(
      "sql: no rows in result set",
    );
    expect(app.logged).toEqual([]);
  });

  test("the last superuser cannot be deleted", async () => {
    expect(countRecords(app, CollectionNameSuperusers)).toBeGreaterThan(1);

    const all = [
      ...new Set(
        app.databases
          .concurrentDB()
          .newQuery("SELECT id FROM _superusers ORDER BY id")
          .column<string>(),
      ),
    ];
    for (const id of all.slice(1)) {
      await deleteRecord(app, findRecordById(app, CollectionNameSuperusers, id));
    }
    expect(countRecords(app, CollectionNameSuperusers)).toBe(1);

    const last = findRecordById(app, CollectionNameSuperusers, all[0] as string);
    const err = await deleteRecord(app, last).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).toJSON()).toEqual({
      data: {},
      message: "You can't delete the only existing superuser.",
      status: 400,
    });
    expect(countRecords(app, CollectionNameSuperusers)).toBe(1);
  });
});
