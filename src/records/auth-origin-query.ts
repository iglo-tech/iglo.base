// Upstream: core/auth_origin_query.go
//
// The queries read through the app's main-thread connection (the
// transaction's, when app is a transaction app). Go's (value, error)
// results are the value, and the error is thrown (sql.ErrNoRows for a
// missing origin, see isNoRows in src/records/record-save.ts).

import type { Collection } from "@/collections/collection-model";
import { HashExp } from "@/db/dbx/expression";
import { AuthOrigin } from "@/records/auth-origin-model";
import {
  CollectionNameAuthOrigins,
  deleteAllRefsByRecord,
  findAllRefsByRecord,
} from "@/records/record-auth-refs";
import type { Record } from "@/records/record-model";
import { recordQuery, recordsTarget, recordTarget, type RecordsApp } from "@/records/record-query";
import { run } from "@/records/record-save";

// FindAllAuthOriginsByRecord returns all AuthOrigin models linked to the provided auth record (in DESC order).
export function findAllAuthOriginsByRecord(app: RecordsApp, authRecord: Record): AuthOrigin[] {
  return findAllRefsByRecord(app, CollectionNameAuthOrigins, authRecord).map(
    (r) => new AuthOrigin(r),
  );
}

// FindAllAuthOriginsByCollection returns all AuthOrigin models linked to the provided collection (in DESC order).
export function findAllAuthOriginsByCollection(
  app: RecordsApp,
  collection: Collection,
): AuthOrigin[] {
  return recordQuery(app, CollectionNameAuthOrigins)
    .andWhere(new HashExp({ collectionRef: collection.id }))
    .orderBy("created DESC")
    .all<Record>(recordsTarget)
    .map((r) => new AuthOrigin(r));
}

// FindAuthOriginById returns a single AuthOrigin model by its id.
export function findAuthOriginById(app: RecordsApp, id: string): AuthOrigin {
  const record = recordQuery(app, CollectionNameAuthOrigins)
    .andWhere(new HashExp({ id }))
    .limit(1)
    .one<Record>(recordTarget);

  return new AuthOrigin(record);
}

// FindAuthOriginByRecordAndFingerprint returns a single AuthOrigin model
// by its authRecord relation and fingerprint.
export function findAuthOriginByRecordAndFingerprint(
  app: RecordsApp,
  authRecord: Record,
  fingerprint: string,
): AuthOrigin {
  const record = recordQuery(app, CollectionNameAuthOrigins)
    .andWhere(
      new HashExp({
        collectionRef: authRecord.collection().id,
        recordRef: authRecord.id,
        fingerprint,
      }),
    )
    .limit(1)
    .one<Record>(recordTarget);

  return new AuthOrigin(record);
}

// DeleteAllAuthOriginsByRecord deletes all AuthOrigin models associated with the provided record.
//
// Throws a combined error with the failed deletes.
export async function deleteAllAuthOriginsByRecord(
  app: RecordsApp,
  authRecord: Record,
): Promise<void> {
  await run(deleteAllRefsByRecord(app, CollectionNameAuthOrigins, authRecord));
}
