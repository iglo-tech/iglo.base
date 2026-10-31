// `prepare` and `after` steps of the record auth scenarios (upstream's
// BeforeTestFunc and AfterTestFunc in apis/record_auth_*_test.go): they
// change a scenario's fixture copy before any server starts on it, through
// the same model functions upstream's tests call on the test app, and read
// back the `_mfas` rows a scenario leaves.

import { reloadCachedCollections } from "@/collections/collection-query";
import { MFAMethodOAuth2, MFAMethodOTP, MFAMethodPassword, newMFA } from "@/records/mfa-model";
import { newOTP } from "@/records/otp-model";
import { CollectionNameSuperusers } from "@/records/record-model-superusers";
import { findAuthRecordByEmail } from "@/records/record-query";
import { saveRecordNoValidateSync, saveRecordSync } from "@/records/record-save";
import { findSingleColumnUniqueIndex } from "@/tools/dbutils/index";
import { DateTime } from "@/tools/types/datetime";

import { openDataDir } from "@test/collections/app";
import { queryRows } from "@test/scenarios/record-checks";
import { updateCollection } from "@test/scenarios/prepare";
import type { AfterContext, PrepareContext } from "@test/scenarios/scenario";

function withApp(dataDir: string, fn: (app: ReturnType<typeof openDataDir>) => void): void {
  const app = openDataDir(dataDir);
  try {
    reloadCachedCollections(app);
    fn(app);
  } finally {
    app.cleanup();
  }
}

// updateIdentityIndex of TestRecordAuthWithPassword: sets the collation of
// the "clients" single column unique indexes (upstream's helper ignores its
// collection argument and always changes "clients")
export function updateIdentityIndex(fieldCollateMap: {
  [column: string]: string;
}): (ctx: PrepareContext) => void {
  return ({ dataDir }) =>
    updateCollection(dataDir, "clients", (collection) => {
      for (const [column, collate] of Object.entries(fieldCollateMap)) {
        const [index, ok] = findSingleColumnUniqueIndex(collection.indexes, column);
        if (!ok) {
          throw new Error(`Missing unique identityField index for column ${column}`);
        }

        (index.columns[0] as { collate: string }).collate = collate;

        collection.removeIndex(index.indexName);
        collection.indexes.push(index.build());
      }
    });
}

// sets a record field without validation (record.Set + app.SaveNoValidate)
export function setAuthRecordField(
  collection: string,
  email: string,
  field: string,
  value: unknown,
): (ctx: PrepareContext) => void {
  return ({ dataDir }) =>
    withApp(dataDir, (app) => {
      const record = findAuthRecordByEmail(app, collection, email);
      record.set(field, value);
      saveRecordNoValidateSync(app, record);
    });
}

// a dummy MFA of the auth record (core.NewMFA + app.Save)
export function insertMFA(
  collection: string,
  email: string,
  id: string,
  method: string,
): (ctx: PrepareContext) => void {
  return ({ dataDir }) =>
    withApp(dataDir, (app) => {
      const user = findAuthRecordByEmail(app, collection, email);
      const mfa = newMFA(app);
      mfa.id = id;
      mfa.setCollectionRef(user.collection().id);
      mfa.setRecordRef(user.id);
      mfa.setMethod(method);
      const err = mfa.preValidate();
      if (err) {
        throw err;
      }
      saveRecordSync(app, mfa.record as NonNullable<typeof mfa.record>);
    });
}

// changes the MFA options of a collection
export function setMFA(
  collection: string,
  enabled: boolean,
  rule: string,
): (ctx: PrepareContext) => void {
  return ({ dataDir }) =>
    updateCollection(dataDir, collection, (c) => {
      c.mfa.enabled = enabled;
      c.mfa.rule = rule;
    });
}

// the number of _mfas rows of the record (app.FindAllMFAsByRecord)
export function mfasCount(
  collectionId: string,
  recordId: string,
  n: number,
): (ctx: AfterContext) => Promise<void> {
  return ({ dataDir }) => {
    const rows = queryRows(
      dataDir,
      `SELECT id FROM _mfas WHERE collectionRef = ? AND recordRef = ?`,
      collectionId,
      recordId,
    );
    if (rows.length !== n) {
      return Promise.reject(new Error(`expected ${n} mfa records, got ${rows.length}`));
    }
    return Promise.resolve();
  };
}

export interface OTPData {
  id: string;
  // the plain password (default "123456")
  password?: string;
  sentTo?: string;
  // the created (and updated) date
  date?: Date;
}

// three years ago, as upstream's expired OTPs
export function expiredDate(): Date {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 3);
  return date;
}

// OTPs of the auth record (core.NewOTP + app.SaveNoValidate: upstream's
// stub ids, such as "otp_0", are too short for the id field's validator)
export function insertOTPs(
  collection: string,
  email: string,
  ...otps: OTPData[]
): (ctx: PrepareContext) => void {
  return ({ dataDir }) =>
    withApp(dataDir, (app) => {
      const user = findAuthRecordByEmail(app, collection, email);
      for (const data of otps) {
        const otp = newOTP(app);
        otp.id = data.id;
        otp.setCollectionRef(user.collection().id);
        otp.setRecordRef(user.id);
        otp.setPassword(data.password ?? "123456");
        if (data.sentTo !== undefined) {
          otp.setSentTo(data.sentTo);
        }
        if (data.date !== undefined) {
          const date = DateTime.fromDate(data.date);
          otp.record?.setRaw("created", date);
          otp.record?.setRaw("updated", date);
        }
        saveRecordNoValidateSync(app, otp.record as NonNullable<typeof otp.record>);
      }
    });
}

// changes the OTP options of a collection
export function setOTP(collection: string, enabled: boolean): (ctx: PrepareContext) => void {
  return ({ dataDir }) =>
    updateCollection(dataDir, collection, (c) => {
      c.otp.enabled = enabled;
    });
}

// the `_otps` rows of the record, the newest first
export function otpRows(dataDir: string, recordId: string): OTPRow[] {
  return queryRows(
    dataDir,
    "SELECT id, collectionRef, recordRef, password, sentTo, created, updated FROM _otps WHERE recordRef = ? ORDER BY created DESC",
    recordId,
  ) as OTPRow[];
}

export interface OTPRow {
  id: string;
  collectionRef: string;
  recordRef: string;
  password: string;
  sentTo: string;
  created: string;
  updated: string;
}

function stubDate(ms: number): DateTime {
  return DateTime.fromDate(new Date(Date.now() + ms));
}

const msMinute = 60 * 1000;
const msHour = 60 * msMinute;

// the three auth records of tests.StubOTPRecords and tests.StubMFARecords
const stubOwners = [
  { stubId: "superuser2", collection: CollectionNameSuperusers, email: "test2@example.com" },
  { stubId: "superuser3", collection: CollectionNameSuperusers, email: "test3@example.com" },
  { stubId: "user1", collection: "users", email: "test@example.com" },
] as const;

// tests.StubOTPRecords
export function stubOTPRecords({ dataDir }: PrepareContext): void {
  const dates = {
    superuser2: [0, -1, -msHour, -2, -msHour - 1],
    superuser3: [-3, -2 * msMinute],
    user1: [-msHour],
  };
  withApp(dataDir, (app) => {
    for (const owner of stubOwners) {
      const record = findAuthRecordByEmail(app, owner.collection, owner.email);
      dates[owner.stubId].forEach((ms, i) => {
        const otp = newOTP(app);
        otp.id = `${owner.stubId}_${i}`;
        otp.setRecordRef(record.id);
        otp.setCollectionRef(record.collection().id);
        otp.setPassword("test123");
        otp.record?.setRaw("created", stubDate(ms));
        saveRecordNoValidateSync(app, otp.record as NonNullable<typeof otp.record>);
      });
    }
  });
}

// tests.StubMFARecords
export function stubMFARecords({ dataDir }: PrepareContext): void {
  const data: { [stubId: string]: [string, number][] } = {
    superuser2: [
      [MFAMethodOTP, 0],
      [MFAMethodOTP, -msHour],
      [MFAMethodPassword, -2 * msMinute],
      [MFAMethodPassword, -1],
      [MFAMethodOAuth2, -msHour - 1],
    ],
    superuser3: [
      [MFAMethodOAuth2, -3],
      [MFAMethodPassword, -3 * msMinute],
    ],
    user1: [[MFAMethodOAuth2, -msHour]],
  };
  withApp(dataDir, (app) => {
    for (const owner of stubOwners) {
      const record = findAuthRecordByEmail(app, owner.collection, owner.email);
      (data[owner.stubId] ?? []).forEach(([method, ms], i) => {
        const mfa = newMFA(app);
        mfa.id = `${owner.stubId}_${i}`;
        mfa.setRecordRef(record.id);
        mfa.setCollectionRef(record.collection().id);
        mfa.setMethod(method);
        mfa.record?.setRaw("created", stubDate(ms));
        saveRecordNoValidateSync(app, mfa.record as NonNullable<typeof mfa.record>);
      });
    }
  });
}
