// Upstream: core/otp_model_test.go, core/otp_query_test.go

import { afterEach, describe, expect, test } from "bun:test";

import type { Clock } from "@/app/clock";
import { findAllCollections, findCollectionByNameOrId } from "@/collections/collection-query";
import { saveCollection } from "@/collections/collection-save";
import { CollectionTypeAuth, newBaseCollection } from "@/collections/collection-model";
import { OTP, newOTP, saveOTP, validateOTP } from "@/records/otp-model";
import {
  deleteAllOTPsByRecord,
  deleteExpiredOTPs,
  findAllOTPsByCollection,
  findAllOTPsByRecord,
  findOTPById,
} from "@/records/otp-query";
import { CollectionNameOTPs } from "@/records/record-auth-refs";
import { CollectionNameSuperusers } from "@/records/record-model-superusers";
import { newRecord, type Record } from "@/records/record-model";
import { findAuthRecordByEmail, findRecordById, type RecordsApp } from "@/records/record-query";
import { saveRecord, saveRecordNoValidate } from "@/records/record-save";
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

const msMinute = 60 * 1000;

function ago(d: Date, ms: number): Date {
  return new Date(d.getTime() - ms);
}

// tests.StubOTPRecords: the OTPs of superuser2, superuser3 and user1 with
// their ids (<label>_<index>) and created dates relative to now
async function stubOTPRecords(app: RecordsApp, now: Date): Promise<void> {
  const superuser2 = findAuthRecordByEmail(app, CollectionNameSuperusers, "test2@example.com");
  const superuser3 = findAuthRecordByEmail(app, CollectionNameSuperusers, "test3@example.com");
  const user1 = findAuthRecordByEmail(app, "users", "test@example.com");

  const old = new Date(now.getTime() - 60 * msMinute);

  const stubs: [string, Record, Date[]][] = [
    ["superuser2", superuser2, [now, ago(now, 1), old, ago(now, 2), ago(old, 1)]],
    ["superuser3", superuser3, [ago(now, 3), ago(now, 2 * msMinute)]],
    ["user1", user1, [old]],
  ];

  for (const [label, record, dates] of stubs) {
    for (const [i, created] of dates.entries()) {
      const otp = newOTP(app);
      otp.id = `${label}_${i}`;
      otp.setRecordRef(record.id);
      otp.setCollectionRef(record.collection().id);
      otp.setPassword("test123");
      (otp.record as Record).setRaw("created", DateTime.fromDate(created));
      await saveRecordNoValidate(app, otp.record as Record);
    }
  }
}

// the ids of the OTPs of all auth collections
function allOTPIds(app: RecordsApp): string[] {
  return findAllCollections(app, CollectionTypeAuth).flatMap((c) =>
    findAllOTPsByCollection(app, c).map((m) => m.id),
  );
}

function otpIds(otps: OTP[]): string[] {
  return otps.map((m) => m.id);
}

describe("TestNewOTP", () => {
  test("creates a blank record of the otps collection", () => {
    const app = newTestApp();

    const otp = newOTP(app);

    expect(otp.record?.collection().name).toBe(CollectionNameOTPs);
  });
});

describe("TestOTPProxyRecord", () => {
  test("setProxyRecord and proxyRecord", () => {
    const record = newRecord(newBaseCollection("test"));
    record.id = "test_id";

    const otp = new OTP();
    otp.setProxyRecord(record);

    expect(otp.proxyRecord()?.id).toBe(record.id);
  });
});

describe("TestOTPRecordRef", () => {
  const testValues = ["test_1", "test2", ""];
  testValues.forEach((testValue, i) => {
    test(`${i}_${JSON.stringify(testValue)}`, () => {
      const app = newTestApp();
      const otp = newOTP(app);

      otp.setRecordRef(testValue);

      expect(otp.recordRef()).toBe(testValue);
      expect(otp.record?.getString("recordRef")).toBe(testValue);
    });
  });
});

describe("TestOTPCollectionRef", () => {
  const testValues = ["test_1", "test2", ""];
  testValues.forEach((testValue, i) => {
    test(`${i}_${JSON.stringify(testValue)}`, () => {
      const app = newTestApp();
      const otp = newOTP(app);

      otp.setCollectionRef(testValue);

      expect(otp.collectionRef()).toBe(testValue);
      expect(otp.record?.getString("collectionRef")).toBe(testValue);
    });
  });
});

describe("TestOTPSentTo", () => {
  const testValues = ["test_1", "test2", ""];
  testValues.forEach((testValue, i) => {
    test(`${i}_${JSON.stringify(testValue)}`, () => {
      const app = newTestApp();
      const otp = newOTP(app);

      otp.setSentTo(testValue);

      expect(otp.sentTo()).toBe(testValue);
      expect(otp.record?.getString("sentTo")).toBe(testValue);
    });
  });
});

describe("TestOTPCreated", () => {
  test("reads the created field", () => {
    const app = newTestApp();
    const otp = newOTP(app);

    expect(otp.created().string()).toBe("");

    const now = DateTime.fromDate(startTime);
    (otp.record as Record).setRaw("created", now);

    expect(otp.created().string()).toBe(now.string());
  });
});

describe("TestOTPUpdated", () => {
  test("reads the updated field", () => {
    const app = newTestApp();
    const otp = newOTP(app);

    expect(otp.updated().string()).toBe("");

    const now = DateTime.fromDate(startTime);
    (otp.record as Record).setRaw("updated", now);

    expect(otp.updated().string()).toBe(now.string());
  });
});

describe("TestOTPHasExpired", () => {
  test("expires once more than maxElapsed has passed since created", () => {
    const clock = new ManualClock(startTime);
    const app = newTestApp(clock);

    const otp = newOTP(app);
    (otp.record as Record).setRaw(
      "created",
      DateTime.fromDate(new Date(startTime.getTime() - 5 * msMinute)),
    );
    // upstream checks a moment after the stub is created; the injected
    // clock moves on by one millisecond instead
    clock.current = new Date(startTime.getTime() + 1);

    const scenarios: [string, bigint, boolean][] = [
      ["0m", 0n, true],
      ["3m", 3n * 60n * 1_000_000_000n, true],
      ["5m", 5n * 60n * 1_000_000_000n, true],
      ["6m", 6n * 60n * 1_000_000_000n, false],
    ];

    scenarios.forEach(([label, maxElapsed, expected], i) => {
      expect({ name: `${i}_${label}`, expired: otp.hasExpired(maxElapsed, clock) }).toEqual({
        name: `${i}_${label}`,
        expired: expected,
      });
    });
  });
});

describe("TestOTPPreValidate", () => {
  test("no proxy record", async () => {
    const app = newTestApp();

    const otp = new OTP();

    expect(await errorOf(validateOTP(app, otp))).not.toBeNull();
  });

  test("non-OTP collection", async () => {
    const app = newTestApp();
    const user = findAuthRecordByEmail(app, "users", "test@example.com");

    const otp = new OTP();
    otp.setProxyRecord(newRecord(newBaseCollection("invalid")));
    otp.setRecordRef(user.id);
    otp.setCollectionRef(user.collection().id);
    otp.setPassword("test123");

    expect(await errorOf(validateOTP(app, otp))).not.toBeNull();
  });

  test("OTP collection", async () => {
    const app = newTestApp();
    const user = findAuthRecordByEmail(app, "users", "test@example.com");
    const otpsCol = findCollectionByNameOrId(app, CollectionNameOTPs);

    const otp = new OTP();
    otp.setProxyRecord(newRecord(otpsCol));
    otp.setRecordRef(user.id);
    otp.setCollectionRef(user.collection().id);
    otp.setPassword("test123");

    expect(await errorOf(validateOTP(app, otp))).toBeNull();
  });
});

describe("TestOTPValidateHook", () => {
  const scenarios: [string, (app: RecordsApp) => OTP, string[]][] = [
    ["empty", (app) => newOTP(app), ["collectionRef", "recordRef", "password"]],
    [
      "non-auth collection",
      (app) => {
        const demo1 = findRecordById(app, "demo1", "84nmscqy84lsi1t");
        const otp = newOTP(app);
        otp.setCollectionRef(demo1.collection().id);
        otp.setRecordRef(demo1.id);
        otp.setPassword("test123");
        return otp;
      },
      ["collectionRef"],
    ],
    [
      "missing record id",
      (app) => {
        const user = findAuthRecordByEmail(app, "users", "test@example.com");
        const otp = newOTP(app);
        otp.setCollectionRef(user.collection().id);
        otp.setRecordRef("missing");
        otp.setPassword("test123");
        return otp;
      },
      ["recordRef"],
    ],
    [
      "valid ref",
      (app) => {
        const user = findAuthRecordByEmail(app, "users", "test@example.com");
        const otp = newOTP(app);
        otp.setCollectionRef(user.collection().id);
        otp.setRecordRef(user.id);
        otp.setPassword("test123");
        return otp;
      },
      [],
    ],
  ];

  for (const [name, otp, expectErrors] of scenarios) {
    test(name, async () => {
      const app = newTestApp();

      const err = await errorOf(validateOTP(app, otp(app)));

      expectValidationErrors(err, expectErrors);
    });
  }
});

describe("TestOTPClearOnTokenKeyChange", () => {
  test("a token key change deletes the OTPs of the record", async () => {
    const app = newTestApp();
    const user1 = findAuthRecordByEmail(app, "users", "test@example.com");
    const user2 = findAuthRecordByEmail(app, "users", "test2@example.com");

    const otpsToCreate: [Record, number][] = [
      [user1, 3],
      [user2, 2],
    ];
    for (const [user, total] of otpsToCreate) {
      for (let i = 0; i < total; i++) {
        const otp = newOTP(app);
        otp.setCollectionRef(user.collection().id);
        otp.setRecordRef(user.id);
        otp.setPassword("123456");
        await saveOTP(app, otp);
      }
    }

    // update both users
    await saveRecord(app, user1);
    user2.refreshTokenKey();
    await saveRecord(app, user2);

    expect(findAllOTPsByRecord(app, user1).length).toBe(3);
    expect(findAllOTPsByRecord(app, user2).length).toBe(0);
  });
});

// -------------------------------------------------------------------
// queries (core/otp_query_test.go)

describe("TestFindAllOTPsByRecord", () => {
  const scenarios: [string, (app: RecordsApp) => Record, string[]][] = [
    ["demo1", (app) => findRecordById(app, "demo1", "84nmscqy84lsi1t"), []],
    [
      "superuser2",
      (app) => findAuthRecordByEmail(app, CollectionNameSuperusers, "test2@example.com"),
      ["superuser2_0", "superuser2_1", "superuser2_3", "superuser2_2", "superuser2_4"],
    ],
    [
      "superuser4",
      (app) => findAuthRecordByEmail(app, CollectionNameSuperusers, "test4@example.com"),
      [],
    ],
    ["user1", (app) => findAuthRecordByEmail(app, "users", "test@example.com"), ["user1_0"]],
  ];

  for (const [label, record, expected] of scenarios) {
    test(label, async () => {
      const app = newTestApp();
      await stubOTPRecords(app, startTime);

      const result = findAllOTPsByRecord(app, record(app));

      expect(otpIds(result)).toEqual(expected);
    });
  }
});

describe("TestFindAllOTPsByCollection", () => {
  const scenarios: [string, string[]][] = [
    ["demo1", []],
    [
      CollectionNameSuperusers,
      [
        "superuser2_0",
        "superuser2_1",
        "superuser2_3",
        "superuser3_0",
        "superuser3_1",
        "superuser2_2",
        "superuser2_4",
      ],
    ],
    ["clients", []],
    ["users", ["user1_0"]],
  ];

  for (const [name, expected] of scenarios) {
    test(name, async () => {
      const app = newTestApp();
      await stubOTPRecords(app, startTime);
      const collection = findCollectionByNameOrId(app, name);

      const result = findAllOTPsByCollection(app, collection);

      expect(otpIds(result)).toEqual(expected);
    });
  }
});

describe("TestFindOTPById", () => {
  const scenarios: [string, boolean][] = [
    ["", true],
    ["84nmscqy84lsi1t", true], // non-otp id
    ["superuser2_0", false],
    ["superuser2_4", false], // expired
    ["user1_0", false],
  ];

  for (const [id, expectError] of scenarios) {
    test(JSON.stringify(id), async () => {
      const app = newTestApp();
      await stubOTPRecords(app, startTime);

      if (expectError) {
        expect(() => findOTPById(app, id)).toThrow();
        return;
      }

      expect(findOTPById(app, id).id).toBe(id);
    });
  }
});

describe("TestDeleteAllOTPsByRecord", () => {
  const scenarios: [string, (app: RecordsApp) => Record, string[]][] = [
    ["demo1", (app) => findRecordById(app, "demo1", "84nmscqy84lsi1t"), []], // non-auth record
    [
      "superuser2",
      (app) => findAuthRecordByEmail(app, CollectionNameSuperusers, "test2@example.com"),
      ["superuser2_0", "superuser2_1", "superuser2_3", "superuser2_2", "superuser2_4"],
    ],
    [
      "superuser4",
      (app) => findAuthRecordByEmail(app, CollectionNameSuperusers, "test4@example.com"),
      [],
    ],
    ["user1", (app) => findAuthRecordByEmail(app, "users", "test@example.com"), ["user1_0"]],
  ];

  for (const [label, record, deletedIds] of scenarios) {
    test(label, async () => {
      const app = newTestApp();
      await stubOTPRecords(app, startTime);
      const target = record(app);
      const before = otpIds(findAllOTPsByRecord(app, target));

      await deleteAllOTPsByRecord(app, target);

      const after = otpIds(findAllOTPsByRecord(app, target));
      const deleted = before.filter((id) => !after.includes(id));
      expect(deleted.toSorted()).toEqual([...deletedIds].toSorted());
    });
  }
});

// stubs the OTPs, deletes the expired ones and compares the deleted ids
async function checkDeletedIds(app: RecordsApp, expectedDeletedIds: string[]): Promise<void> {
  await stubOTPRecords(app, startTime);
  const before = allOTPIds(app);

  await deleteExpiredOTPs(app);

  const after = allOTPIds(app);
  const deleted = before.filter((id) => !after.includes(id));
  expect(deleted.toSorted()).toEqual([...expectedDeletedIds].toSorted());
}

describe("TestDeleteExpiredOTPs", () => {
  test("default test collections", async () => {
    const app = newTestApp();

    await checkDeletedIds(app, ["user1_0", "superuser2_2", "superuser2_4"]);
  });

  test("otp collection duration mock", async () => {
    const app = newTestApp();

    const superusers = findCollectionByNameOrId(app, CollectionNameSuperusers);
    superusers.otp.duration = 60;
    saveCollection(app, superusers);

    await checkDeletedIds(app, ["user1_0", "superuser2_2", "superuser2_4", "superuser3_1"]);
  });
});
