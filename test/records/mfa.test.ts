// Upstream: core/mfa_model_test.go, core/mfa_query_test.go

import { afterEach, describe, expect, test } from "bun:test";

import type { Clock } from "@/app/clock";
import { findAllCollections, findCollectionByNameOrId } from "@/collections/collection-query";
import { saveCollection } from "@/collections/collection-save";
import { CollectionTypeAuth, newBaseCollection } from "@/collections/collection-model";
import {
  MFA,
  MFAMethodOAuth2,
  MFAMethodOTP,
  MFAMethodPassword,
  newMFA,
  saveMFA,
  validateMFA,
} from "@/records/mfa-model";
import {
  deleteAllMFAsByRecord,
  deleteExpiredMFAs,
  findAllMFAsByCollection,
  findAllMFAsByRecord,
  findMFAById,
} from "@/records/mfa-query";
import { CollectionNameMFAs } from "@/records/record-auth-refs";
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

// tests.StubMFARecords: the MFAs of superuser2, superuser3 and user1 with
// their ids (<label>_<index>), methods and created dates relative to now
async function stubMFARecords(app: RecordsApp, now: Date): Promise<void> {
  const superuser2 = findAuthRecordByEmail(app, CollectionNameSuperusers, "test2@example.com");
  const superuser3 = findAuthRecordByEmail(app, CollectionNameSuperusers, "test3@example.com");
  const user1 = findAuthRecordByEmail(app, "users", "test@example.com");

  const old = new Date(now.getTime() - 60 * msMinute);

  const stubs: [string, Record, [string, Date][]][] = [
    [
      "superuser2",
      superuser2,
      [
        [MFAMethodOTP, now],
        [MFAMethodOTP, old],
        [MFAMethodPassword, ago(now, 2 * msMinute)],
        [MFAMethodPassword, ago(now, 1)],
        [MFAMethodOAuth2, ago(old, 1)],
      ],
    ],
    [
      "superuser3",
      superuser3,
      [
        [MFAMethodOAuth2, ago(now, 3)],
        [MFAMethodPassword, ago(now, 3 * msMinute)],
      ],
    ],
    ["user1", user1, [[MFAMethodOAuth2, old]]],
  ];

  for (const [label, record, entries] of stubs) {
    for (const [i, [method, created]] of entries.entries()) {
      const mfa = newMFA(app);
      mfa.id = `${label}_${i}`;
      mfa.setRecordRef(record.id);
      mfa.setCollectionRef(record.collection().id);
      mfa.setMethod(method);
      (mfa.record as Record).setRaw("created", DateTime.fromDate(created));
      await saveRecordNoValidate(app, mfa.record as Record);
    }
  }
}

// the ids of the MFAs of all auth collections
function allMFAIds(app: RecordsApp): string[] {
  return findAllCollections(app, CollectionTypeAuth).flatMap((c) =>
    findAllMFAsByCollection(app, c).map((m) => m.id),
  );
}

function mfaIds(mfas: MFA[]): string[] {
  return mfas.map((m) => m.id);
}

describe("TestNewMFA", () => {
  test("creates a blank record of the mfas collection", () => {
    const app = newTestApp();

    const mfa = newMFA(app);

    expect(mfa.record?.collection().name).toBe(CollectionNameMFAs);
  });
});

describe("TestMFAProxyRecord", () => {
  test("setProxyRecord and proxyRecord", () => {
    const record = newRecord(newBaseCollection("test"));
    record.id = "test_id";

    const mfa = new MFA();
    mfa.setProxyRecord(record);

    expect(mfa.proxyRecord()?.id).toBe(record.id);
  });
});

describe("TestMFARecordRef", () => {
  const testValues = ["test_1", "test2", ""];
  testValues.forEach((testValue, i) => {
    test(`${i}_${JSON.stringify(testValue)}`, () => {
      const app = newTestApp();
      const mfa = newMFA(app);

      mfa.setRecordRef(testValue);

      expect(mfa.recordRef()).toBe(testValue);
      expect(mfa.record?.getString("recordRef")).toBe(testValue);
    });
  });
});

describe("TestMFACollectionRef", () => {
  const testValues = ["test_1", "test2", ""];
  testValues.forEach((testValue, i) => {
    test(`${i}_${JSON.stringify(testValue)}`, () => {
      const app = newTestApp();
      const mfa = newMFA(app);

      mfa.setCollectionRef(testValue);

      expect(mfa.collectionRef()).toBe(testValue);
      expect(mfa.record?.getString("collectionRef")).toBe(testValue);
    });
  });
});

describe("TestMFAMethod", () => {
  const testValues = ["test_1", "test2", ""];
  testValues.forEach((testValue, i) => {
    test(`${i}_${JSON.stringify(testValue)}`, () => {
      const app = newTestApp();
      const mfa = newMFA(app);

      mfa.setMethod(testValue);

      expect(mfa.method()).toBe(testValue);
      expect(mfa.record?.getString("method")).toBe(testValue);
    });
  });
});

describe("TestMFACreated", () => {
  test("reads the created field", () => {
    const app = newTestApp();
    const mfa = newMFA(app);

    expect(mfa.created().string()).toBe("");

    const now = DateTime.fromDate(startTime);
    (mfa.record as Record).setRaw("created", now);

    expect(mfa.created().string()).toBe(now.string());
  });
});

describe("TestMFAUpdated", () => {
  test("reads the updated field", () => {
    const app = newTestApp();
    const mfa = newMFA(app);

    expect(mfa.updated().string()).toBe("");

    const now = DateTime.fromDate(startTime);
    (mfa.record as Record).setRaw("updated", now);

    expect(mfa.updated().string()).toBe(now.string());
  });
});

describe("TestMFAHasExpired", () => {
  test("expires once more than maxElapsed has passed since created", () => {
    const clock = new ManualClock(startTime);
    const app = newTestApp(clock);

    const mfa = newMFA(app);
    (mfa.record as Record).setRaw(
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
      expect({ name: `${i}_${label}`, expired: mfa.hasExpired(maxElapsed, clock) }).toEqual({
        name: `${i}_${label}`,
        expired: expected,
      });
    });
  });
});

describe("TestMFAPreValidate", () => {
  test("no proxy record", async () => {
    const app = newTestApp();

    const mfa = new MFA();

    expect(await errorOf(validateMFA(app, mfa))).not.toBeNull();
  });

  test("non-MFA collection", async () => {
    const app = newTestApp();
    const user = findAuthRecordByEmail(app, "users", "test@example.com");

    const mfa = new MFA();
    mfa.setProxyRecord(newRecord(newBaseCollection("invalid")));
    mfa.setRecordRef(user.id);
    mfa.setCollectionRef(user.collection().id);
    mfa.setMethod("test123");

    expect(await errorOf(validateMFA(app, mfa))).not.toBeNull();
  });

  test("MFA collection", async () => {
    const app = newTestApp();
    const user = findAuthRecordByEmail(app, "users", "test@example.com");
    const mfasCol = findCollectionByNameOrId(app, CollectionNameMFAs);

    const mfa = new MFA();
    mfa.setProxyRecord(newRecord(mfasCol));
    mfa.setRecordRef(user.id);
    mfa.setCollectionRef(user.collection().id);
    mfa.setMethod("test123");

    expect(await errorOf(validateMFA(app, mfa))).toBeNull();
  });
});

describe("TestMFAValidateHook", () => {
  const scenarios: [string, (app: RecordsApp) => MFA, string[]][] = [
    ["empty", (app) => newMFA(app), ["collectionRef", "recordRef", "method"]],
    [
      "non-auth collection",
      (app) => {
        const demo1 = findRecordById(app, "demo1", "84nmscqy84lsi1t");
        const mfa = newMFA(app);
        mfa.setCollectionRef(demo1.collection().id);
        mfa.setRecordRef(demo1.id);
        mfa.setMethod("test123");
        return mfa;
      },
      ["collectionRef"],
    ],
    [
      "missing record id",
      (app) => {
        const user = findAuthRecordByEmail(app, "users", "test@example.com");
        const mfa = newMFA(app);
        mfa.setCollectionRef(user.collection().id);
        mfa.setRecordRef("missing");
        mfa.setMethod("test123");
        return mfa;
      },
      ["recordRef"],
    ],
    [
      "valid ref",
      (app) => {
        const user = findAuthRecordByEmail(app, "users", "test@example.com");
        const mfa = newMFA(app);
        mfa.setCollectionRef(user.collection().id);
        mfa.setRecordRef(user.id);
        mfa.setMethod("test123");
        return mfa;
      },
      [],
    ],
  ];

  for (const [name, mfa, expectErrors] of scenarios) {
    test(name, async () => {
      const app = newTestApp();

      const err = await errorOf(validateMFA(app, mfa(app)));

      expectValidationErrors(err, expectErrors);
    });
  }
});

describe("TestMFAClearOnPasswordChange", () => {
  test("a password change deletes the MFAs of the record", async () => {
    const app = newTestApp();
    const user1 = findAuthRecordByEmail(app, "users", "test@example.com");
    const user2 = findAuthRecordByEmail(app, "users", "test2@example.com");

    const mfasToCreate: [Record, number][] = [
      [user1, 3],
      [user2, 2],
    ];
    for (const [user, total] of mfasToCreate) {
      for (let i = 0; i < total; i++) {
        const mfa = newMFA(app);
        mfa.setCollectionRef(user.collection().id);
        mfa.setRecordRef(user.id);
        mfa.setMethod(MFAMethodPassword);
        await saveMFA(app, mfa);
      }
    }

    // update both users
    await saveRecord(app, user1);
    user2.setRandomPassword();
    await saveRecord(app, user2);

    expect(findAllMFAsByRecord(app, user1).length).toBe(3);
    expect(findAllMFAsByRecord(app, user2).length).toBe(0);
  });
});

// -------------------------------------------------------------------
// queries (core/mfa_query_test.go)

describe("TestFindAllMFAsByRecord", () => {
  const scenarios: [string, (app: RecordsApp) => Record, string[]][] = [
    ["demo1", (app) => findRecordById(app, "demo1", "84nmscqy84lsi1t"), []],
    [
      "superuser2",
      (app) => findAuthRecordByEmail(app, CollectionNameSuperusers, "test2@example.com"),
      ["superuser2_0", "superuser2_3", "superuser2_2", "superuser2_1", "superuser2_4"],
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
      await stubMFARecords(app, startTime);

      const result = findAllMFAsByRecord(app, record(app));

      expect(mfaIds(result)).toEqual(expected);
    });
  }
});

describe("TestFindAllMFAsByCollection", () => {
  const scenarios: [string, string[]][] = [
    ["demo1", []],
    [
      CollectionNameSuperusers,
      [
        "superuser2_0",
        "superuser2_3",
        "superuser3_0",
        "superuser2_2",
        "superuser3_1",
        "superuser2_1",
        "superuser2_4",
      ],
    ],
    ["clients", []],
    ["users", ["user1_0"]],
  ];

  for (const [name, expected] of scenarios) {
    test(name, async () => {
      const app = newTestApp();
      await stubMFARecords(app, startTime);
      const collection = findCollectionByNameOrId(app, name);

      const result = findAllMFAsByCollection(app, collection);

      expect(mfaIds(result)).toEqual(expected);
    });
  }
});

describe("TestFindMFAById", () => {
  const scenarios: [string, boolean][] = [
    ["", true],
    ["84nmscqy84lsi1t", true], // non-mfa id
    ["superuser2_0", false],
    ["superuser2_4", false], // expired
    ["user1_0", false],
  ];

  for (const [id, expectError] of scenarios) {
    test(JSON.stringify(id), async () => {
      const app = newTestApp();
      await stubMFARecords(app, startTime);

      if (expectError) {
        expect(() => findMFAById(app, id)).toThrow();
        return;
      }

      expect(findMFAById(app, id).id).toBe(id);
    });
  }
});

describe("TestDeleteAllMFAsByRecord", () => {
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
      await stubMFARecords(app, startTime);
      const target = record(app);
      const before = mfaIds(findAllMFAsByRecord(app, target));

      await deleteAllMFAsByRecord(app, target);

      const after = mfaIds(findAllMFAsByRecord(app, target));
      const deleted = before.filter((id) => !after.includes(id));
      expect(deleted.toSorted()).toEqual([...deletedIds].toSorted());
    });
  }
});

// stubs the MFAs, deletes the expired ones and compares the deleted ids
async function checkDeletedIds(app: RecordsApp, expectedDeletedIds: string[]): Promise<void> {
  await stubMFARecords(app, startTime);
  const before = allMFAIds(app);

  await deleteExpiredMFAs(app);

  const after = allMFAIds(app);
  const deleted = before.filter((id) => !after.includes(id));
  expect(deleted.toSorted()).toEqual([...expectedDeletedIds].toSorted());
}

describe("TestDeleteExpiredMFAs", () => {
  test("default test collections", async () => {
    const app = newTestApp();

    await checkDeletedIds(app, ["user1_0", "superuser2_1", "superuser2_4"]);
  });

  test("mfa collection duration mock", async () => {
    const app = newTestApp();

    const superusers = findCollectionByNameOrId(app, CollectionNameSuperusers);
    superusers.mfa.duration = 60;
    saveCollection(app, superusers);

    await checkDeletedIds(app, [
      "user1_0",
      "superuser2_1",
      "superuser2_2",
      "superuser2_4",
      "superuser3_1",
    ]);
  });
});
