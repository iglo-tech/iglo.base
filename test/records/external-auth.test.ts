// Upstream: core/external_auth_model_test.go, core/external_auth_query_test.go

import { afterEach, describe, expect, test } from "bun:test";

import type { Clock } from "@/app/clock";
import { newBaseCollection } from "@/collections/collection-model";
import { findCollectionByNameOrId } from "@/collections/collection-query";
import { HashExp } from "@/db/dbx/expression";
import { ExternalAuth, newExternalAuth, validateExternalAuth } from "@/records/external-auth-model";
import {
  deleteAllExternalAuthsByRecord,
  findAllExternalAuthsByCollection,
  findAllExternalAuthsByRecord,
  findFirstExternalAuthByExpr,
} from "@/records/external-auth-query";
import { newRecord, type Record } from "@/records/record-model";
import { CollectionNameSuperusers } from "@/records/record-model-superusers";
import { findAuthRecordByEmail, findRecordById, type RecordsApp } from "@/records/record-query";
import { saveRecord } from "@/records/record-save";
import { DateTime } from "@/tools/types/datetime";

import { openTestApp, type TestCollectionsApp } from "@test/collections/app";
import { expectValidationErrors } from "@test/collections/validation";

// a clock the test moves by hand (tests never sleep)
class ManualClock implements Clock {
  current: Date;

  constructor(start: Date) {
    this.current = new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }
}

const startTime = new Date("2026-10-29T12:00:00.000Z");

const apps: TestCollectionsApp[] = [];

function newTestApp(clock: ManualClock = new ManualClock(startTime)): TestCollectionsApp {
  const app = openTestApp(clock);
  apps.push(app);
  return app;
}

afterEach(() => {
  for (const app of apps.splice(0)) {
    app.cleanup();
  }
});

async function errorOf(p: Promise<unknown>): Promise<Error | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

function idsOf(eas: ExternalAuth[]): string[] {
  return eas.map((ea) => ea.id);
}

// the values of the Go setter/getter tables
const testValues = ["test_1", "test2", ""];

// -------------------------------------------------------------------
// model (core/external_auth_model_test.go)

describe("TestNewExternalAuth", () => {
  test("creates a blank record of the externalAuths collection", () => {
    const app = newTestApp();

    const ea = newExternalAuth(app);

    expect(ea.record?.collection().name).toBe("_externalAuths");
  });
});

describe("TestExternalAuthProxyRecord", () => {
  test("setProxyRecord and proxyRecord", () => {
    const record = newRecord(newBaseCollection("test"));
    record.id = "test_id";

    const ea = new ExternalAuth();
    ea.setProxyRecord(record);

    expect(ea.proxyRecord()?.id).toBe(record.id);
  });
});

describe("TestExternalAuthRecordRef", () => {
  testValues.forEach((testValue, i) => {
    test(`${i}_${JSON.stringify(testValue)}`, () => {
      const app = newTestApp();
      const ea = newExternalAuth(app);

      ea.setRecordRef(testValue);

      expect(ea.recordRef()).toBe(testValue);
      expect(ea.record?.getString("recordRef")).toBe(testValue);
    });
  });
});

describe("TestExternalAuthCollectionRef", () => {
  testValues.forEach((testValue, i) => {
    test(`${i}_${JSON.stringify(testValue)}`, () => {
      const app = newTestApp();
      const ea = newExternalAuth(app);

      ea.setCollectionRef(testValue);

      expect(ea.collectionRef()).toBe(testValue);
      expect(ea.record?.getString("collectionRef")).toBe(testValue);
    });
  });
});

describe("TestExternalAuthProvider", () => {
  testValues.forEach((testValue, i) => {
    test(`${i}_${JSON.stringify(testValue)}`, () => {
      const app = newTestApp();
      const ea = newExternalAuth(app);

      ea.setProvider(testValue);

      expect(ea.provider()).toBe(testValue);
      expect(ea.record?.getString("provider")).toBe(testValue);
    });
  });
});

describe("TestExternalAuthProviderId", () => {
  testValues.forEach((testValue, i) => {
    test(`${i}_${JSON.stringify(testValue)}`, () => {
      const app = newTestApp();
      const ea = newExternalAuth(app);

      ea.setProviderId(testValue);

      expect(ea.providerId()).toBe(testValue);
      expect(ea.record?.getString("providerId")).toBe(testValue);
    });
  });
});

describe("TestExternalAuthCreated", () => {
  test("reads the created field", () => {
    const app = newTestApp();
    const ea = newExternalAuth(app);

    expect(ea.created().string()).toBe("");

    const now = DateTime.fromDate(startTime);
    (ea.record as Record).setRaw("created", now);

    expect(ea.created().string()).toBe(now.string());
  });
});

describe("TestExternalAuthUpdated", () => {
  test("reads the updated field", () => {
    const app = newTestApp();
    const ea = newExternalAuth(app);

    expect(ea.updated().string()).toBe("");

    const now = DateTime.fromDate(startTime);
    (ea.record as Record).setRaw("updated", now);

    expect(ea.updated().string()).toBe(now.string());
  });
});

describe("TestExternalAuthPreValidate", () => {
  test("no proxy record", async () => {
    const app = newTestApp();

    const ea = new ExternalAuth();

    expect(await errorOf(validateExternalAuth(app, ea))).not.toBeNull();
  });

  test("non-ExternalAuth collection", async () => {
    const app = newTestApp();
    const user = findAuthRecordByEmail(app, "users", "test@example.com");

    const ea = new ExternalAuth();
    ea.setProxyRecord(newRecord(newBaseCollection("invalid")));
    ea.setRecordRef(user.id);
    ea.setCollectionRef(user.collection().id);
    ea.setProvider("gitlab");
    ea.setProviderId("test123");

    expect(await errorOf(validateExternalAuth(app, ea))).not.toBeNull();
  });

  test("ExternalAuth collection", async () => {
    const app = newTestApp();
    const user = findAuthRecordByEmail(app, "users", "test@example.com");
    const externalAuthsCol = findCollectionByNameOrId(app, "_externalAuths");

    const ea = new ExternalAuth();
    ea.setProxyRecord(newRecord(externalAuthsCol));
    ea.setRecordRef(user.id);
    ea.setCollectionRef(user.collection().id);
    ea.setProvider("gitlab");
    ea.setProviderId("test123");

    expect(await errorOf(validateExternalAuth(app, ea))).toBeNull();
  });
});

describe("TestExternalAuthValidateHook", () => {
  const scenarios: [string, (app: RecordsApp) => ExternalAuth, string[]][] = [
    [
      "empty",
      (app) => newExternalAuth(app),
      ["collectionRef", "recordRef", "provider", "providerId"],
    ],
    [
      "non-auth collection",
      (app) => {
        const demo1 = findRecordById(app, "demo1", "84nmscqy84lsi1t");
        const ea = newExternalAuth(app);
        ea.setCollectionRef(demo1.collection().id);
        ea.setRecordRef(demo1.id);
        ea.setProvider("gitlab");
        ea.setProviderId("test123");
        return ea;
      },
      ["collectionRef"],
    ],
    [
      "disabled provider",
      (app) => {
        const user = findAuthRecordByEmail(app, "users", "test@example.com");
        const ea = newExternalAuth(app);
        ea.setCollectionRef(user.collection().id);
        ea.setRecordRef("missing");
        ea.setProvider("apple");
        ea.setProviderId("test123");
        return ea;
      },
      ["recordRef"],
    ],
    [
      "missing record id",
      (app) => {
        const user = findAuthRecordByEmail(app, "users", "test@example.com");
        const ea = newExternalAuth(app);
        ea.setCollectionRef(user.collection().id);
        ea.setRecordRef("missing");
        ea.setProvider("gitlab");
        ea.setProviderId("test123");
        return ea;
      },
      ["recordRef"],
    ],
    [
      "valid ref",
      (app) => {
        const user = findAuthRecordByEmail(app, "users", "test@example.com");
        const ea = newExternalAuth(app);
        ea.setCollectionRef(user.collection().id);
        ea.setRecordRef(user.id);
        ea.setProvider("gitlab");
        ea.setProviderId("test123");
        return ea;
      },
      [],
    ],
  ];

  for (const [name, ea, expectErrors] of scenarios) {
    test(name, async () => {
      const app = newTestApp();

      const err = await errorOf(validateExternalAuth(app, ea(app)));

      expectValidationErrors(err, expectErrors);
    });
  }
});

describe("TestExternalAuthClearOnVerfiedUpgrade", () => {
  // The Go subtests share one app and run in order. Each case here gets its
  // own app: every case reads only the user it names, so the order does not matter.
  test("unverified->no changes", async () => {
    const app = newTestApp();
    const user = findAuthRecordByEmail(app, "users", "test@example.com");

    expect(user.verified()).toBe(false);

    const beforeAuths = findAllExternalAuthsByRecord(app, user);
    expect(beforeAuths.length).toBeGreaterThan(0);

    const oldTokenKey = user.tokenKey();

    await saveRecord(app, user);

    expect(user.tokenKey()).toBe(oldTokenKey);

    const afterAuths = findAllExternalAuthsByRecord(app, user);
    expect(afterAuths.length).toBe(beforeAuths.length);
  });

  test("unverified->verified", async () => {
    const app = newTestApp();
    const user = findAuthRecordByEmail(app, "users", "test@example.com");

    expect(user.verified()).toBe(false);

    expect(findAllExternalAuthsByRecord(app, user).length).toBeGreaterThan(0);

    const oldTokenKey = user.tokenKey();

    user.setVerified(true);
    await saveRecord(app, user);

    expect(user.tokenKey()).not.toBe(oldTokenKey);

    expect(findAllExternalAuthsByRecord(app, user)).toEqual([]);
  });

  test("verified->no changes", async () => {
    const app = newTestApp();
    const user = findAuthRecordByEmail(app, "users", "test3@example.com");

    expect(user.verified()).toBe(true);

    const beforeAuths = findAllExternalAuthsByRecord(app, user);
    expect(beforeAuths.length).toBeGreaterThan(0);

    const oldTokenKey = user.tokenKey();

    await saveRecord(app, user);

    expect(user.tokenKey()).toBe(oldTokenKey);

    const afterAuths = findAllExternalAuthsByRecord(app, user);
    expect(afterAuths.length).toBe(beforeAuths.length);
  });
});

// -------------------------------------------------------------------
// queries (core/external_auth_query_test.go)

describe("TestFindAllExternalAuthsByRecord", () => {
  const scenarios: [string, (app: RecordsApp) => Record, string[]][] = [
    ["demo1_84nmscqy84lsi1t", (app) => findRecordById(app, "demo1", "84nmscqy84lsi1t"), []],
    [
      `${CollectionNameSuperusers}_test@example.com`,
      (app) => findAuthRecordByEmail(app, CollectionNameSuperusers, "test@example.com"),
      [],
    ],
    [
      "clients_test@example.com",
      (app) => findAuthRecordByEmail(app, "clients", "test@example.com"),
      ["f1z5b3843pzc964"],
    ],
    [
      "users_test@example.com",
      (app) => findAuthRecordByEmail(app, "users", "test@example.com"),
      ["clmflokuq1xl341", "dlmflokuq1xl342"],
    ],
    [
      "users_test2@example.com",
      (app) => findAuthRecordByEmail(app, "users", "test2@example.com"),
      [],
    ],
    [
      "users_test3@example.com",
      (app) => findAuthRecordByEmail(app, "users", "test3@example.com"),
      ["5eto7nmys833164"],
    ],
  ];

  for (const [label, record, expected] of scenarios) {
    test(label, () => {
      const app = newTestApp();

      const result = findAllExternalAuthsByRecord(app, record(app));

      expect(idsOf(result)).toEqual(expected);
    });
  }
});

describe("TestFindAllExternalAuthsByCollection", () => {
  const scenarios: [string, string[]][] = [
    ["demo1", []],
    [CollectionNameSuperusers, []],
    ["clients", ["f1z5b3843pzc964"]],
    ["users", ["5eto7nmys833164", "clmflokuq1xl341", "dlmflokuq1xl342"]],
  ];

  for (const [name, expected] of scenarios) {
    test(name, () => {
      const app = newTestApp();
      const collection = findCollectionByNameOrId(app, name);

      const result = findAllExternalAuthsByCollection(app, collection);

      expect(idsOf(result)).toEqual(expected);
    });
  }
});

describe("TestFindFirstExternalAuthByExpr", () => {
  // [label, expression, expected id ("" when no row matches)]
  const scenarios: [string, () => HashExp, string][] = [
    ["0_collectionRef=invalid", () => new HashExp({ collectionRef: "invalid" }), ""],
    [
      "1_collectionRef=_pb_users_auth_",
      () => new HashExp({ collectionRef: "_pb_users_auth_" }),
      "5eto7nmys833164",
    ],
    [
      "2_collectionRef=_pb_users_auth_,provider=gitlab",
      () => new HashExp({ collectionRef: "_pb_users_auth_", provider: "gitlab" }),
      "dlmflokuq1xl342",
    ],
  ];

  for (const [label, expr, expectedId] of scenarios) {
    test(label, async () => {
      const app = newTestApp();

      if (expectedId === "") {
        // upstream returns an error when no row matches
        expect(() => findFirstExternalAuthByExpr(app, expr())).toThrow();
        return;
      }

      expect(findFirstExternalAuthByExpr(app, expr()).id).toBe(expectedId);
    });
  }
});

describe("TestDeleteAllExternalAuthsByRecord", () => {
  // Upstream counts OnRecordDelete calls to learn the deleted ids. This port
  // has no hooks, so each case reads the rows back: the ids that exist before
  // the delete and not after it are the deleted ids.
  const scenarios: [string, (app: RecordsApp) => Record, string[]][] = [
    ["0_demo1", (app) => findRecordById(app, "demo1", "84nmscqy84lsi1t"), []], // non-auth record
    [
      "1_users_test@example.com",
      (app) => findAuthRecordByEmail(app, "users", "test@example.com"),
      ["dlmflokuq1xl342", "clmflokuq1xl341"],
    ],
    [
      "2_clients_test@example.com",
      (app) => findAuthRecordByEmail(app, "clients", "test@example.com"),
      ["f1z5b3843pzc964"],
    ],
    [
      "3_clients_test2@example.com",
      (app) => findAuthRecordByEmail(app, "clients", "test2@example.com"),
      [],
    ],
  ];

  for (const [label, record, expectedDeleted] of scenarios) {
    test(label, async () => {
      const app = newTestApp();
      const rec = record(app);
      const before = idsOf(findAllExternalAuthsByRecord(app, rec));

      await deleteAllExternalAuthsByRecord(app, rec);

      const after = idsOf(findAllExternalAuthsByRecord(app, rec));
      const deleted = before.filter((id) => !after.includes(id));

      expect(deleted.toSorted()).toEqual(expectedDeleted.toSorted());
      expect(after).toEqual([]);
    });
  }
});
