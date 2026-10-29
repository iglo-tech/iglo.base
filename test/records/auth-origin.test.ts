// Upstream: core/auth_origin_model_test.go, core/auth_origin_query_test.go

import { afterEach, describe, expect, test } from "bun:test";

import type { Clock } from "@/app/clock";
import { findCollectionByNameOrId } from "@/collections/collection-query";
import { newBaseCollection } from "@/collections/collection-model";
import { AuthOrigin, newAuthOrigin, validateAuthOrigin } from "@/records/auth-origin-model";
import {
  deleteAllAuthOriginsByRecord,
  findAllAuthOriginsByCollection,
  findAllAuthOriginsByRecord,
  findAuthOriginById,
  findAuthOriginByRecordAndFingerprint,
} from "@/records/auth-origin-query";
import {
  CollectionNameAuthOrigins,
  CollectionNameExternalAuths,
  CollectionNameMFAs,
  CollectionNameOTPs,
  findAllRefsByRecord,
} from "@/records/record-auth-refs";
import { newRecord, type Record } from "@/records/record-model";
import { findAuthRecordByEmail, findRecordById, type RecordsApp } from "@/records/record-query";
import { saveRecord } from "@/records/record-save";
import { CollectionNameSuperusers } from "@/records/record-model-superusers";
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

function newTestApp(): TestCollectionsApp {
  const app = openTestApp(new ManualClock(startTime));
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

// the ids of the auth refs (external auths, MFAs, OTPs and auth origins)
// of an auth record
function refIds(app: RecordsApp, record: Record): string[] {
  return [
    CollectionNameExternalAuths,
    CollectionNameMFAs,
    CollectionNameOTPs,
    CollectionNameAuthOrigins,
  ].flatMap((name) => findAllRefsByRecord(app, name, record).map((r) => r.id));
}

function originIds(origins: AuthOrigin[]): string[] {
  return origins.map((o) => o.id);
}

describe("TestNewAuthOrigin", () => {
  test("creates a blank record of the authOrigins collection", () => {
    const app = newTestApp();

    const origin = newAuthOrigin(app);

    expect(origin.record?.collection().name).toBe(CollectionNameAuthOrigins);
  });
});

describe("TestAuthOriginProxyRecord", () => {
  test("setProxyRecord and proxyRecord", () => {
    const record = newRecord(newBaseCollection("test"));
    record.id = "test_id";

    const origin = new AuthOrigin();
    origin.setProxyRecord(record);

    expect(origin.proxyRecord()?.id).toBe(record.id);
  });
});

describe("TestAuthOriginRecordRef", () => {
  const testValues = ["test_1", "test2", ""];
  testValues.forEach((testValue, i) => {
    test(`${i}_${JSON.stringify(testValue)}`, () => {
      const app = newTestApp();
      const origin = newAuthOrigin(app);

      origin.setRecordRef(testValue);

      expect(origin.recordRef()).toBe(testValue);
      expect(origin.record?.getString("recordRef")).toBe(testValue);
    });
  });
});

describe("TestAuthOriginCollectionRef", () => {
  const testValues = ["test_1", "test2", ""];
  testValues.forEach((testValue, i) => {
    test(`${i}_${JSON.stringify(testValue)}`, () => {
      const app = newTestApp();
      const origin = newAuthOrigin(app);

      origin.setCollectionRef(testValue);

      expect(origin.collectionRef()).toBe(testValue);
      expect(origin.record?.getString("collectionRef")).toBe(testValue);
    });
  });
});

describe("TestAuthOriginFingerprint", () => {
  const testValues = ["test_1", "test2", ""];
  testValues.forEach((testValue, i) => {
    test(`${i}_${JSON.stringify(testValue)}`, () => {
      const app = newTestApp();
      const origin = newAuthOrigin(app);

      origin.setFingerprint(testValue);

      expect(origin.fingerprint()).toBe(testValue);
      expect(origin.record?.getString("fingerprint")).toBe(testValue);
    });
  });
});

describe("TestAuthOriginCreated", () => {
  test("reads the created field", () => {
    const app = newTestApp();
    const origin = newAuthOrigin(app);

    expect(origin.created().string()).toBe("");

    const now = DateTime.fromDate(startTime);
    (origin.record as Record).setRaw("created", now);

    expect(origin.created().string()).toBe(now.string());
  });
});

describe("TestAuthOriginUpdated", () => {
  test("reads the updated field", () => {
    const app = newTestApp();
    const origin = newAuthOrigin(app);

    expect(origin.updated().string()).toBe("");

    const now = DateTime.fromDate(startTime);
    (origin.record as Record).setRaw("updated", now);

    expect(origin.updated().string()).toBe(now.string());
  });
});

describe("TestAuthOriginPreValidate", () => {
  test("no proxy record", async () => {
    const app = newTestApp();

    const origin = new AuthOrigin();

    expect(await errorOf(validateAuthOrigin(app, origin))).not.toBeNull();
  });

  test("non-AuthOrigin collection", async () => {
    const app = newTestApp();
    const user = findAuthRecordByEmail(app, "users", "test@example.com");

    const origin = new AuthOrigin();
    origin.setProxyRecord(newRecord(newBaseCollection("invalid")));
    origin.setRecordRef(user.id);
    origin.setCollectionRef(user.collection().id);
    origin.setFingerprint("abc");

    expect(await errorOf(validateAuthOrigin(app, origin))).not.toBeNull();
  });

  test("AuthOrigin collection", async () => {
    const app = newTestApp();
    const user = findAuthRecordByEmail(app, "users", "test@example.com");
    const originsCol = findCollectionByNameOrId(app, CollectionNameAuthOrigins);

    const origin = new AuthOrigin();
    origin.setProxyRecord(newRecord(originsCol));
    origin.setRecordRef(user.id);
    origin.setCollectionRef(user.collection().id);
    origin.setFingerprint("abc");

    expect(await errorOf(validateAuthOrigin(app, origin))).toBeNull();
  });
});

describe("TestAuthOriginValidateHook", () => {
  const scenarios: [string, (app: RecordsApp) => AuthOrigin, string[]][] = [
    ["empty", (app) => newAuthOrigin(app), ["collectionRef", "recordRef", "fingerprint"]],
    [
      "non-auth collection",
      (app) => {
        const demo1 = findRecordById(app, "demo1", "84nmscqy84lsi1t");
        const origin = newAuthOrigin(app);
        origin.setCollectionRef(demo1.collection().id);
        origin.setRecordRef(demo1.id);
        origin.setFingerprint("abc");
        return origin;
      },
      ["collectionRef"],
    ],
    [
      "missing record id",
      (app) => {
        const user = findAuthRecordByEmail(app, "users", "test@example.com");
        const origin = newAuthOrigin(app);
        origin.setCollectionRef(user.collection().id);
        origin.setRecordRef("missing");
        origin.setFingerprint("abc");
        return origin;
      },
      ["recordRef"],
    ],
    [
      "valid ref",
      (app) => {
        const user = findAuthRecordByEmail(app, "users", "test@example.com");
        const origin = newAuthOrigin(app);
        origin.setCollectionRef(user.collection().id);
        origin.setRecordRef(user.id);
        origin.setFingerprint("abc");
        return origin;
      },
      [],
    ],
  ];

  for (const [name, origin, expectErrors] of scenarios) {
    test(name, async () => {
      const app = newTestApp();

      const err = await errorOf(validateAuthOrigin(app, origin(app)));

      expectValidationErrors(err, expectErrors);
    });
  }
});

describe("TestAuthOriginPasswordChangeDeletion", () => {
  const scenarios: [string, string, string[]][] = [
    // no auth origin associated with it
    ["users", "test@example.com", []],
    [
      CollectionNameSuperusers,
      "test2@example.com",
      ["5798yh833k6w6w0", "ic55o70g4f8pcl4", "dmy260k6ksjr4ib"],
    ],
    ["clients", "test@example.com", ["9r2j0m74260ur8i"]],
  ];

  scenarios.forEach(([collection, email, deletedIds], i) => {
    test(`${i}_${collection}_${email}`, async () => {
      const app = newTestApp();
      const record = findAuthRecordByEmail(app, collection, email);
      const before = refIds(app, record);

      record.setPassword("new_password");
      await saveRecord(app, record);

      const after = refIds(app, record);
      const deleted = before.filter((id) => !after.includes(id));
      expect(deleted.toSorted()).toEqual([...deletedIds].toSorted());
    });
  });
});

// -------------------------------------------------------------------
// queries (core/auth_origin_query_test.go)

describe("TestFindAllAuthOriginsByRecord", () => {
  const scenarios: [string, string, string, string[]][] = [
    ["demo1", "demo1", "84nmscqy84lsi1t", []],
    [
      CollectionNameSuperusers,
      "test2@example.com",
      "superuser2",
      ["5798yh833k6w6w0", "ic55o70g4f8pcl4", "dmy260k6ksjr4ib"],
    ],
    [CollectionNameSuperusers, "test4@example.com", "superuser4", []],
    ["clients", "test@example.com", "client1", ["9r2j0m74260ur8i"]],
  ];

  for (const [collection, email, label, expected] of scenarios) {
    test(`${collection}_${label}`, () => {
      const app = newTestApp();
      const record =
        collection === "demo1"
          ? findRecordById(app, "demo1", "84nmscqy84lsi1t")
          : findAuthRecordByEmail(app, collection, email);

      const result = findAllAuthOriginsByRecord(app, record);

      expect(originIds(result)).toEqual(expected);
    });
  }
});

describe("TestFindAllAuthOriginsByCollection", () => {
  const scenarios: [string, string[]][] = [
    ["demo1", []],
    [
      CollectionNameSuperusers,
      ["5798yh833k6w6w0", "ic55o70g4f8pcl4", "dmy260k6ksjr4ib", "5f29jy38bf5zm3f"],
    ],
    ["clients", ["9r2j0m74260ur8i"]],
  ];

  for (const [name, expected] of scenarios) {
    test(name, () => {
      const app = newTestApp();
      const collection = findCollectionByNameOrId(app, name);

      const result = findAllAuthOriginsByCollection(app, collection);

      expect(originIds(result)).toEqual(expected);
    });
  }
});

describe("TestFindAuthOriginById", () => {
  const scenarios: [string, boolean][] = [
    ["", true],
    ["84nmscqy84lsi1t", true], // non-origin id
    ["9r2j0m74260ur8i", false],
  ];

  for (const [id, expectError] of scenarios) {
    test(JSON.stringify(id), () => {
      const app = newTestApp();

      if (expectError) {
        expect(() => findAuthOriginById(app, id)).toThrow();
        return;
      }

      expect(findAuthOriginById(app, id).id).toBe(id);
    });
  }
});

describe("TestFindAuthOriginByRecordAndFingerprint", () => {
  // the record is demo1 (a non-auth record) or superuser test2@example.com
  const scenarios: [boolean, string, boolean][] = [
    [false, "6afbfe481c31c08c55a746cccb88ece0", true],
    [true, "", true],
    [true, "abc", true],
    // fingerprint from different origin
    [true, "22bbbcbed36e25321f384ccf99f60057", false],
    [true, "6afbfe481c31c08c55a746cccb88ece0", false],
  ];

  scenarios.forEach(([isSuperuser, fingerprint, expectError], i) => {
    test(`${i}_${isSuperuser ? "superuser2" : "demo1"}_${fingerprint}`, () => {
      const app = newTestApp();
      const record = isSuperuser
        ? findAuthRecordByEmail(app, CollectionNameSuperusers, "test2@example.com")
        : findRecordById(app, "demo1", "84nmscqy84lsi1t");

      if (expectError) {
        expect(() => findAuthOriginByRecordAndFingerprint(app, record, fingerprint)).toThrow();
        return;
      }

      const result = findAuthOriginByRecordAndFingerprint(app, record, fingerprint);

      expect(result.fingerprint()).toBe(fingerprint);
      expect(result.recordRef()).toBe(record.id);
      expect(result.collectionRef()).toBe(record.collection().id);
    });
  });
});

describe("TestDeleteAllAuthOriginsByRecord", () => {
  const scenarios: [string, string, string, string[]][] = [
    ["demo1", "demo1", "84nmscqy84lsi1t", []], // non-auth record
    [
      CollectionNameSuperusers,
      "test2@example.com",
      "superuser2",
      ["5798yh833k6w6w0", "ic55o70g4f8pcl4", "dmy260k6ksjr4ib"],
    ],
    [CollectionNameSuperusers, "test4@example.com", "superuser4", []],
    ["clients", "test@example.com", "client1", ["9r2j0m74260ur8i"]],
  ];

  for (const [collection, email, label, deletedIds] of scenarios) {
    test(`${collection}_${label}`, async () => {
      const app = newTestApp();
      const record =
        collection === "demo1"
          ? findRecordById(app, "demo1", "84nmscqy84lsi1t")
          : findAuthRecordByEmail(app, collection, email);
      const before = originIds(findAllAuthOriginsByRecord(app, record));

      await deleteAllAuthOriginsByRecord(app, record);

      const after = originIds(findAllAuthOriginsByRecord(app, record));
      const deleted = before.filter((id) => !after.includes(id));
      expect(deleted.toSorted()).toEqual([...deletedIds].toSorted());
    });
  }
});
