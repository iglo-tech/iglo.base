// Upstream: core/record_model_superusers_test.go (TestRecordIsSuperUser;
// the protections are M1.8c's)

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { CollectionNameSuperusers } from "@/records/record-model-superusers";

import { openTestApp, type TestCollectionsApp } from "@test/collections/app";
import { findAuthRecordByEmail, findRecordById } from "@/records/record-query";

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
