// The record handlers of core/{external_auth,mfa,otp,auth_origin}_model.go
// through the record save and delete entry points: the collectionRef,
// recordRef and provider checks, and the cleanups on password, token key
// and verified changes and on delete. Upstream has no unit tests for them
// in core (its API tests cover them); the reference test
// (test/differential/records/save.test.ts) compares them with upstream.

import { afterEach, describe, expect, test } from "bun:test";

import { newAuthCollection, newBaseCollection } from "@/collections/collection-model";
import { findCollectionByNameOrId } from "@/collections/collection-query";
import { deleteCollection, saveCollection } from "@/collections/collection-save";
import {
  CollectionNameAuthOrigins,
  CollectionNameExternalAuths,
  CollectionNameMFAs,
  CollectionNameOTPs,
  findAllRefsByRecord,
} from "@/records/record-auth-refs";
import { type Record, newRecord } from "@/records/record-model";
import { findRecordById, type RecordsApp } from "@/records/record-query";
import { deleteRecord, saveRecord } from "@/records/record-save";
import { Errors } from "@/validation/error";

import { openTestApp, type TestCollectionsApp } from "@test/collections/app";

const apps: TestCollectionsApp[] = [];

function newTestApp(): TestCollectionsApp {
  const app = openTestApp();
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

// a new record of one of the four collections pointing to authRecord
async function addRef(
  app: RecordsApp,
  collectionName: string,
  authRecord: Record,
  extra: { [key: string]: unknown },
): Promise<Record> {
  const ref = newRecord(findCollectionByNameOrId(app, collectionName));
  ref.load({
    collectionRef: authRecord.collection().id,
    recordRef: authRecord.id,
    ...extra,
  });
  await saveRecord(app, ref);
  return ref;
}

const refExtras: { [name: string]: { [key: string]: unknown } } = {
  [CollectionNameExternalAuths]: { provider: "github", providerId: "p1" },
  [CollectionNameMFAs]: { method: "password" },
  [CollectionNameOTPs]: { password: "1234567890", sentTo: "a@example.com" },
  [CollectionNameAuthOrigins]: { fingerprint: "abc" },
};

async function addAllRefs(app: RecordsApp, authRecord: Record): Promise<void> {
  for (const [name, extra] of Object.entries(refExtras)) {
    await addRef(app, name, authRecord, extra);
  }
}

function refCounts(app: RecordsApp, authRecord: Record): { [name: string]: number } {
  const result: { [name: string]: number } = {};
  for (const name of Object.keys(refExtras)) {
    result[name] = findAllRefsByRecord(app, name, authRecord).length;
  }
  return result;
}

describe("ref validation", () => {
  test("collectionRef, recordRef and provider", async () => {
    const app = newTestApp();
    const user = findRecordById(app, "users", "oap640cot4yru2s");

    const collection = findCollectionByNameOrId(app, CollectionNameExternalAuths);

    const valid = {
      collectionRef: user.collection().id,
      recordRef: user.id,
      provider: "github",
      providerId: "p1",
    };
    const scenarios: [string, { [key: string]: unknown }, string][] = [
      [
        "no data (the field validators)",
        {},
        `{"collectionRef":"cannot be blank","provider":"cannot be blank","providerId":"cannot be blank","recordRef":"cannot be blank"}`,
      ],
      [
        "missing collection",
        { ...valid, collectionRef: "missing" },
        `{"collectionRef":"Missing or invalid collection."}`,
      ],
      [
        "non-auth collection",
        { ...valid, collectionRef: "wsmn24bux7wo113" },
        `{"collectionRef":"Invalid collection type - must be auth."}`,
      ],
      [
        "missing record",
        { ...valid, recordRef: "missing" },
        `{"recordRef":"Missing or invalid record."}`,
      ],
      [
        "record of another collection",
        { ...valid, recordRef: "gk390qegs4y47wn" },
        `{"recordRef":"Missing or invalid record."}`,
      ],
      [
        "unknown provider",
        { ...valid, provider: "GitHub" },
        `{"provider":"must be a valid value"}`,
      ],
      ["valid", valid, "null"],
    ];

    for (const [name, data, expected] of scenarios) {
      const record = newRecord(collection);
      record.load(data);
      const err = await errorOf(saveRecord(app, record));
      expect({ name, err: err instanceof Errors ? err.marshalJSON() : String(err) }).toEqual({
        name,
        err: expected,
      });
    }

    // the other collections check their refs too
    const mfa = newRecord(findCollectionByNameOrId(app, CollectionNameMFAs));
    mfa.load({ collectionRef: user.collection().id, recordRef: "missing", method: "password" });
    const err = await errorOf(saveRecord(app, mfa));
    expect((err as Errors).marshalJSON()).toBe(`{"recordRef":"Missing or invalid record."}`);
  });
});

describe("cleanups", () => {
  test("a deleted auth collection takes the refs of its records along", async () => {
    const app = newTestApp();
    const collection = newAuthCollection("new_auth");
    saveCollection(app, collection);

    const user = newRecord(findCollectionByNameOrId(app, "new_auth"));
    user.load({ email: "new@example.com", password: "1234567890" });
    await saveRecord(app, user);
    await addAllRefs(app, user);

    // refs of another collection's record stay
    const other = findRecordById(app, "users", "oap640cot4yru2s");
    await addAllRefs(app, other);

    deleteCollection(app, findCollectionByNameOrId(app, "new_auth"));
    expect(Object.values(refCounts(app, user))).toEqual([0, 0, 0, 0]);
    expect(Object.values(refCounts(app, other))).toEqual([1, 1, 1, 1]);
  });

  test("a deleted base collection leaves the refs alone", async () => {
    const app = newTestApp();
    const user = findRecordById(app, "users", "oap640cot4yru2s");
    await addAllRefs(app, user);

    const base = newBaseCollection("new_base");
    saveCollection(app, base);
    deleteCollection(app, findCollectionByNameOrId(app, "new_base"));
    expect(Object.values(refCounts(app, user))).toEqual([1, 1, 1, 1]);
  });

  test("a deleted auth record takes its refs along", async () => {
    const app = newTestApp();
    const user = findRecordById(app, "users", "oap640cot4yru2s");
    await addAllRefs(app, user);
    expect(Object.values(refCounts(app, user))).toEqual([1, 1, 1, 1]);

    await deleteRecord(app, user);
    expect(Object.values(refCounts(app, user))).toEqual([0, 0, 0, 0]);
  });

  test("a password change deletes MFAs, auth origins and (with the new token key) OTPs", async () => {
    const app = newTestApp();
    const user = findRecordById(app, "users", "oap640cot4yru2s");
    await addAllRefs(app, user);

    const tokenKey = user.tokenKey();
    user.setPassword("0987654321");
    await saveRecord(app, user);

    expect(user.tokenKey()).not.toBe(tokenKey);
    expect(refCounts(app, user)).toEqual({
      [CollectionNameExternalAuths]: 1,
      [CollectionNameMFAs]: 0,
      [CollectionNameOTPs]: 0,
      [CollectionNameAuthOrigins]: 0,
    });
  });

  test("a token key change deletes OTPs only", async () => {
    const app = newTestApp();
    const user = findRecordById(app, "users", "oap640cot4yru2s");
    await addAllRefs(app, user);

    user.refreshTokenKey();
    await saveRecord(app, user);

    expect(refCounts(app, user)).toEqual({
      [CollectionNameExternalAuths]: 1,
      [CollectionNameMFAs]: 1,
      [CollectionNameOTPs]: 0,
      [CollectionNameAuthOrigins]: 1,
    });
  });

  test("a verified upgrade deletes external auths and refreshes the token key", async () => {
    const app = newTestApp();
    const user = findRecordById(app, "users", "4q1xlclmfloku33");
    expect(user.verified()).toBe(false);
    expect(findAllRefsByRecord(app, CollectionNameExternalAuths, user).length).toBe(2);
    await addRef(app, CollectionNameOTPs, user, refExtras[CollectionNameOTPs] ?? {});

    const tokenKey = user.tokenKey();
    user.setVerified(true);
    await saveRecord(app, user);

    expect(user.tokenKey()).not.toBe(tokenKey);
    expect(findRecordById(app, "users", user.id).tokenKey()).toBe(user.tokenKey());
    expect(findAllRefsByRecord(app, CollectionNameExternalAuths, user).length).toBe(0);
    // the new token key deleted the OTPs too
    expect(findAllRefsByRecord(app, CollectionNameOTPs, user).length).toBe(0);
  });

  test("a verified user without external auths keeps its token key", async () => {
    const app = newTestApp();
    const user = findRecordById(app, "users", "4q1xlclmfloku33");
    for (const ref of findAllRefsByRecord(app, CollectionNameExternalAuths, user)) {
      await deleteRecord(app, ref);
    }

    const tokenKey = user.tokenKey();
    user.setVerified(true);
    await saveRecord(app, user);

    expect(user.tokenKey()).toBe(tokenKey);
  });
});
