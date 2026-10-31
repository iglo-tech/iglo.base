// Upstream: core/external_auth_query.go
//
// The queries read through the app's main-thread connection (the
// transaction's, when app is a transaction app). Go's (value, error)
// results are the value, and the error is thrown (sql.ErrNoRows for a
// missing row, see isNoRows in src/records/record-save.ts).

import type { Collection } from "@/collections/collection-model";
import { type Expression, HashExp, not } from "@/db/dbx/expression";
import { ExternalAuth } from "@/records/external-auth-model";
import {
  CollectionNameExternalAuths,
  deleteAllRefsByRecord,
  findAllRefsByRecord,
} from "@/records/record-auth-refs";
import type { Record } from "@/records/record-model";
import { recordQuery, recordsTarget, recordTarget, type RecordsApp } from "@/records/record-query";
import { run, runSync } from "@/records/record-save";

// FindAllExternalAuthsByRecord returns all ExternalAuth models
// linked to the provided auth record.
export function findAllExternalAuthsByRecord(app: RecordsApp, authRecord: Record): ExternalAuth[] {
  return findAllRefsByRecord(app, CollectionNameExternalAuths, authRecord).map(
    (r) => new ExternalAuth(r),
  );
}

// FindAllExternalAuthsByCollection returns all ExternalAuth models
// linked to the provided auth collection.
export function findAllExternalAuthsByCollection(
  app: RecordsApp,
  collection: Collection,
): ExternalAuth[] {
  return recordQuery(app, CollectionNameExternalAuths)
    .andWhere(new HashExp({ collectionRef: collection.id }))
    .orderBy("created DESC")
    .all<Record>(recordsTarget)
    .map((r) => new ExternalAuth(r));
}

// FindFirstExternalAuthByExpr returns the first available (the most recent created)
// ExternalAuth model that satisfies the non-nil expression.
export function findFirstExternalAuthByExpr(app: RecordsApp, expr: Expression): ExternalAuth {
  const record = recordQuery(app, CollectionNameExternalAuths)
    .andWhere(not(new HashExp({ providerId: "" }))) // exclude empty providerIds
    .andWhere(expr)
    .orderBy("created DESC")
    .limit(1)
    .one<Record>(recordTarget);

  return new ExternalAuth(record);
}

// DeleteAllExternalAuthsByRecord deletes all ExternalAuth models associated with the provided record.
//
// Throws a combined error with the failed deletes.
export async function deleteAllExternalAuthsByRecord(
  app: RecordsApp,
  authRecord: Record,
): Promise<void> {
  await run(deleteAllRefsByRecord(app, CollectionNameExternalAuths, authRecord));
}

// DeleteAllExternalAuthsByRecord inside a transaction
export function deleteAllExternalAuthsByRecordSync(app: RecordsApp, authRecord: Record): void {
  runSync(deleteAllRefsByRecord(app, CollectionNameExternalAuths, authRecord));
}
