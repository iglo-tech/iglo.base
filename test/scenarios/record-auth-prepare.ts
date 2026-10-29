// `prepare` and `after` steps of the record auth scenarios (upstream's
// BeforeTestFunc and AfterTestFunc in apis/record_auth_*_test.go): they
// change a scenario's fixture copy before any server starts on it, through
// the same model functions upstream's tests call on the test app, and read
// back the `_mfas` rows a scenario leaves.

import { reloadCachedCollections } from "@/collections/collection-query";
import { newMFA } from "@/records/mfa-model";
import { findAuthRecordByEmail } from "@/records/record-query";
import { saveRecordNoValidateSync, saveRecordSync } from "@/records/record-save";
import { findSingleColumnUniqueIndex } from "@/tools/dbutils/index";

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
