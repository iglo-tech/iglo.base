// Upstream: core/record_model_auth_test.go

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { newAuthCollection } from "@/collections/collection-model";
import { FieldNamePassword } from "@/fields/field";
import { PasswordField } from "@/fields/password";
import { newRecord } from "@/records/record-model";
import { pseudorandomString } from "@/tools/security/random";
import { fieldApp } from "@/collections/collection-query";

import { openTestApp, type TestCollectionsApp } from "@test/collections/app";

test("RecordEmail", () => {
  const record = newRecord(newAuthCollection("test"));

  expect(record.email()).toBe("");

  const email = "test@example.com";
  record.setEmail(email);

  expect(record.email()).toBe(email);
});

test("RecordEmailVisibility", () => {
  const record = newRecord(newAuthCollection("test"));

  expect(record.emailVisibility()).toBe(false);

  record.setEmailVisibility(true);

  expect(record.emailVisibility()).toBe(true);
});

test("RecordVerified", () => {
  const record = newRecord(newAuthCollection("test"));

  expect(record.verified()).toBe(false);

  record.setVerified(true);

  expect(record.verified()).toBe(true);
});

test("RecordTokenKey", () => {
  const record = newRecord(newAuthCollection("test"));

  expect(record.tokenKey()).toBe("");

  const tokenKey = "example";

  record.setTokenKey(tokenKey);

  expect(record.tokenKey()).toBe(tokenKey);

  record.refreshTokenKey();

  // random generated
  expect(record.tokenKey()).not.toBe(tokenKey);
  expect(record.tokenKey()).toHaveLength(50);
});

describe("RecordPassword", () => {
  const scenarios: [string, string, boolean][] = [
    ["empty password", "", false],
    ["non-empty password", "123456", true],
  ];

  for (const [name, password, expected] of scenarios) {
    test(name, () => {
      const record = newRecord(newAuthCollection("test"));

      // before set
      expect(record.validatePassword(password)).toBe(false);

      record.setPassword(password);

      // after set
      expect(record.validatePassword(password)).toBe(expected);

      // try with a random string to ensure that not any string validates
      expect(record.validatePassword(pseudorandomString(5))).toBe(false);
    });
  }
});

describe("RecordSetRandomPassword", () => {
  let app: TestCollectionsApp;

  beforeAll(() => {
    app = openTestApp();
  });

  afterAll(() => {
    app.cleanup();
  });

  test("random password", () => {
    const oldTokenKey = "old_tokenKey";
    const record = newRecord(newAuthCollection("test"));
    record.setTokenKey(oldTokenKey);

    const pass = record.setRandomPassword();

    expect(pass).not.toBe("");

    expect(record.validatePassword(pass)).toBe(true);

    expect(record.tokenKey()).not.toBe(oldTokenKey);

    const f = record.collection().fields.getByName(FieldNamePassword);
    if (!(f instanceof PasswordField)) {
      throw new Error("Expected PasswordField");
    }

    // ensure that the field validators will be ignored
    f.min = 1;
    f.max = 2;
    f.pattern = String.raw`\d+`;

    expect(f.validateValue(fieldApp(app), record)).toBeNull();
  });
});
