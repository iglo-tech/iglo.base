// Upstream: core/mfa_query.go
//
// The queries read through the app's main-thread connection (the
// transaction's, when app is a transaction app). Go's (value, error)
// results are the value, and the error is thrown (sql.ErrNoRows for a
// missing MFA, see isNoRows in src/records/record-save.ts).

import { findAllCollections } from "@/collections/collection-query";
import { type Collection, CollectionTypeAuth } from "@/collections/collection-model";
import { HashExp, newExp } from "@/db/dbx/expression";
import { MFA } from "@/records/mfa-model";
import {
  CollectionNameMFAs,
  deleteAllRefsByRecord,
  findAllRefsByRecord,
} from "@/records/record-auth-refs";
import type { Record } from "@/records/record-model";
import { recordQuery, recordsTarget, recordTarget, type RecordsApp } from "@/records/record-query";
import { deleteRecord, run } from "@/records/record-save";
import { DateTime } from "@/tools/types/datetime";

// FindAllMFAsByRecord returns all MFA models linked to the provided auth record.
export function findAllMFAsByRecord(app: RecordsApp, authRecord: Record): MFA[] {
  return findAllRefsByRecord(app, CollectionNameMFAs, authRecord).map((r) => new MFA(r));
}

// FindAllMFAsByCollection returns all MFA models linked to the provided collection.
export function findAllMFAsByCollection(app: RecordsApp, collection: Collection): MFA[] {
  return recordQuery(app, CollectionNameMFAs)
    .andWhere(new HashExp({ collectionRef: collection.id }))
    .orderBy("created DESC")
    .all<Record>(recordsTarget)
    .map((r) => new MFA(r));
}

// FindMFAById returns a single MFA model by its id.
export function findMFAById(app: RecordsApp, id: string): MFA {
  const record = recordQuery(app, CollectionNameMFAs)
    .andWhere(new HashExp({ id }))
    .limit(1)
    .one<Record>(recordTarget);

  return new MFA(record);
}

// DeleteAllMFAsByRecord deletes all MFA models associated with the provided record.
//
// Throws a combined error with the failed deletes.
export async function deleteAllMFAsByRecord(app: RecordsApp, authRecord: Record): Promise<void> {
  await run(deleteAllRefsByRecord(app, CollectionNameMFAs, authRecord));
}

// DeleteExpiredMFAs deletes the expired MFAs for all auth collections.
export async function deleteExpiredMFAs(app: RecordsApp): Promise<void> {
  const authCollections = findAllCollections(app, CollectionTypeAuth);

  for (const collection of authCollections) {
    const nowMs = app.clock.now().getTime();
    const durationMs = Number(collection.mfa.durationTime() / 1_000_000n);
    const minValidDate = DateTime.fromDate(new Date(nowMs - durationMs));

    const items = recordQuery(app, CollectionNameMFAs)
      .andWhere(new HashExp({ collectionRef: collection.id }))
      .andWhere(newExp("[[created]] < {:date}", { date: minValidDate.toString() }))
      .all<Record>(recordsTarget);

    for (const item of items) {
      await deleteRecord(app, item);
    }
  }
}
