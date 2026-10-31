// Upstream: core/otp_query.go
//
// The queries read through the app's main-thread connection (the
// transaction's, when app is a transaction app). Go's (value, error)
// results are the value, and the error is thrown (sql.ErrNoRows for a
// missing OTP, see isNoRows in src/records/record-save.ts).

import { findAllCollections } from "@/collections/collection-query";
import { type Collection, CollectionTypeAuth } from "@/collections/collection-model";
import { HashExp, newExp } from "@/db/dbx/expression";
import { OTP } from "@/records/otp-model";
import {
  CollectionNameOTPs,
  deleteAllRefsByRecord,
  findAllRefsByRecord,
} from "@/records/record-auth-refs";
import type { Record } from "@/records/record-model";
import { recordQuery, recordsTarget, recordTarget, type RecordsApp } from "@/records/record-query";
import { deleteRecord, run } from "@/records/record-save";
import { DateTime } from "@/tools/types/datetime";

// FindAllOTPsByRecord returns all OTP models linked to the provided auth record.
export function findAllOTPsByRecord(app: RecordsApp, authRecord: Record): OTP[] {
  return findAllRefsByRecord(app, CollectionNameOTPs, authRecord).map((r) => new OTP(r));
}

// FindAllOTPsByCollection returns all OTP models linked to the provided collection.
export function findAllOTPsByCollection(app: RecordsApp, collection: Collection): OTP[] {
  return recordQuery(app, CollectionNameOTPs)
    .andWhere(new HashExp({ collectionRef: collection.id }))
    .orderBy("created DESC")
    .all<Record>(recordsTarget)
    .map((r) => new OTP(r));
}

// FindOTPById returns a single OTP model by its id.
export function findOTPById(app: RecordsApp, id: string): OTP {
  const record = recordQuery(app, CollectionNameOTPs)
    .andWhere(new HashExp({ id }))
    .limit(1)
    .one<Record>(recordTarget);

  return new OTP(record);
}

// DeleteAllOTPsByRecord deletes all OTP models associated with the provided record.
//
// Throws a combined error with the failed deletes.
export async function deleteAllOTPsByRecord(app: RecordsApp, authRecord: Record): Promise<void> {
  await run(deleteAllRefsByRecord(app, CollectionNameOTPs, authRecord));
}

// DeleteExpiredOTPs deletes the expired OTPs for all auth collections.
export async function deleteExpiredOTPs(app: RecordsApp): Promise<void> {
  const authCollections = findAllCollections(app, CollectionTypeAuth);

  // note: perform even if OTP is disabled to ensure that there are no dangling old records
  for (const collection of authCollections) {
    const nowMs = app.clock.now().getTime();
    const durationMs = Number(collection.otp.durationTime() / 1_000_000n);
    const minValidDate = DateTime.fromDate(new Date(nowMs - durationMs));

    const items = recordQuery(app, CollectionNameOTPs)
      .andWhere(new HashExp({ collectionRef: collection.id }))
      .andWhere(newExp("[[created]] < {:date}", { date: minValidDate.toString() }))
      .all<Record>(recordsTarget);

    for (const item of items) {
      await deleteRecord(app, item);
    }
  }
}
