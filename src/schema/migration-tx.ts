// The helpers a TypeScript migration's up(tx) gets (D40, S.5). Not an upstream
// file. They run on the apply transaction's App, so every write is part of
// the apply and rolls back with it.
//
// Saves go through the records layer's synchronous save with validation, as
// the records API's create and update do (record-save.ts), so a value the API
// would refuse is refused here. The check over every record waits for the
// apply's record check (step 8), so a migration can fill a new required field
// in several passes.
//
// Not available, on purpose: file uploads (a File or Blob value is refused)
// and the network (mail, S3, OAuth2): the helpers are the only way to reach
// the database, and the apply holds a write transaction.

import type { App } from "@/app/app";
import { findCollectionByNameOrId } from "@/collections/collection-query";
import { isNoRowsError } from "@/db/dbx/rows";
import { deleteRecordSync, saveRecordSync } from "@/records/record-save";
import { findRecordById, findRecordsByIds } from "@/records/record-query";
import { findRecordsByFilter } from "@/records/record-query-filter";
import { newRecord, type Record as RecordModel } from "@/records/record-model";

// the record of a helper: the record as a superuser's API read returns it, so
// the hidden fields and the email are in it whatever emailVisibility says (the
// generated types say the same). The password and the token key are never
// returned, not even to a superuser, as upstream does.
export type MigrationRow = Record<string, unknown>;

export interface MigrationQuery {
  filter?: string;
  sort?: string;
  params?: Record<string, unknown>;
}

// the helpers of up(tx); the typed form is in the generated types file
export interface MigrationHelpers {
  records(collection: string, query?: MigrationQuery): Generator<MigrationRow, void, undefined>;
  findFirst(collection: string, query?: MigrationQuery): MigrationRow | null;
  findById(collection: string, id: string): MigrationRow | null;
  create(collection: string, data: Record<string, unknown>): MigrationRow;
  update(collection: string, id: string, data: Record<string, unknown>): MigrationRow;
  delete(collection: string, id: string): void;
  sql(query: string, params?: Record<string, unknown>): Record<string, unknown>[];
}

// the type of the tx argument of up (the generated types declare it too)
export type MigrationTx = MigrationHelpers;

// the record as the helpers return it: every field unhidden and the email
// visible, as upstream's superuser reads do (autoResolveRecordsFlags). The
// migration runs as the superuser of the database, so no visibility applies.
function rowOf(record: RecordModel): MigrationRow {
  record.unhide(...record.collection().fields.fieldNames());
  record.ignoreEmailVisibility(true);
  return JSON.parse(record.marshalJSON()) as MigrationRow;
}

// a value the apply refuses: files need the request's upload path
function refuseUploads(data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value instanceof Blob) {
      throw new Error(
        `a migration cannot upload files (the value of ${JSON.stringify(key)} is a file)`,
      );
    }
  }
}

// the records that records() reads at a time
const recordsPage = 500;

// The ids of the records that match a query, in the query's order. They are
// read a page at a time, and only the ids are kept, so the matches are fixed
// before the migration's first record is yielded. With a sort, the id comes
// last: the order is then total, so the pages do not overlap or skip rows. A
// random sort differs on every query, so its matches are read in one query.
function matchingIds(app: App, collection: string, query: MigrationQuery): string[] {
  const filter = query.filter ?? "";
  const params = query.params ?? {};
  const sort = query.sort ?? "";
  if (sort.includes("@random")) {
    return findRecordsByFilter(app, collection, filter, sort, 0, 0, params).map((r) => r.id);
  }
  const order = sort === "" ? "" : `${sort},id`;
  const ids: string[] = [];
  for (let offset = 0; ; offset += recordsPage) {
    const page = findRecordsByFilter(app, collection, filter, order, recordsPage, offset, params);
    for (const record of page) {
      ids.push(record.id);
    }
    if (page.length < recordsPage) {
      return ids;
    }
  }
}

// The helpers of a migration on the transaction's App.
export function newMigrationHelpers(app: App): MigrationHelpers {
  return {
    *records(collection, query = {}) {
      // the matches are fixed before the first record is yielded, so a write
      // made while the migration iterates does not change the set or its order.
      // A record that the migration changes or deletes before the page holding
      // it is read shows the change, or is skipped
      const ids = matchingIds(app, collection, query);
      for (let start = 0; start < ids.length; start += recordsPage) {
        const page = ids.slice(start, start + recordsPage);
        const byId = new Map(
          findRecordsByIds(app, collection, page).map((record) => [record.id, record]),
        );
        for (const id of page) {
          const record = byId.get(id);
          if (record !== undefined) {
            yield rowOf(record);
          }
        }
      }
    },

    findFirst(collection, query = {}) {
      const [first] = findRecordsByFilter(
        app,
        collection,
        query.filter ?? "",
        query.sort ?? "",
        1,
        0,
        query.params ?? {},
      );
      return first === undefined ? null : rowOf(first);
    },

    findById(collection, id) {
      try {
        return rowOf(findRecordById(app, collection, id));
      } catch (err) {
        if (isNoRowsError(err)) {
          return null;
        }
        throw err;
      }
    },

    create(collection, data) {
      refuseUploads(data);
      const record = newRecord(findCollectionByNameOrId(app, collection));
      record.load(data);
      saveRecordSync(app, record);
      return rowOf(record);
    },

    update(collection, id, data) {
      refuseUploads(data);
      const record = findRecordById(app, collection, id);
      record.load(data);
      saveRecordSync(app, record);
      return rowOf(record);
    },

    delete(collection, id) {
      deleteRecordSync(app, findRecordById(app, collection, id));
    },

    sql(query, params = {}) {
      return app.databases.db().newQuery(query).bind(params).all<Record<string, unknown>>();
    },
  };
}
