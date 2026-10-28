// Upstream: core/collection_record_table_sync.go
//
// Errors are thrown; the index errors are a validation.Errors under
// "indexes", as upstream returns them. SQLite errors are converted to the
// Go driver's text (driver-error.ts).
//
// Go ranges over the `toRename` map in random order; the renames do not
// depend on each other (the temporary names are unique), so here they run
// in insertion order.

import type { Collection } from "@/collections/collection-model";
import { type CollectionsApp, fieldApp, runInAppTransaction } from "@/collections/collection-query";
import { driverError, withDriverErrors } from "@/collections/driver-error";
import { equalFold } from "@/collections/go-strings";
import { HashExp, newExp } from "@/db/dbx/expression";
import { setOwn } from "@/db/dbx/query";
import { deleteView, hasTable } from "@/db/table";
import { isMultiValuer } from "@/fields/field";
import { parseIndex } from "@/tools/dbutils/index";
import { pseudorandomString } from "@/tools/security/random";
import { jsonArrayString } from "@/tools/types/json-array";
import { Errors, NewError } from "@/validation/error";

// SyncRecordTableSchema compares the two provided collections
// and applies the necessary related record table changes.
//
// If oldCollection is null, then only newCollection is used to create the record table.
//
// This method is automatically invoked as part of a collection create/update/delete operation.
export function syncRecordTableSchema(
  app: CollectionsApp,
  newCollection: Collection,
  oldCollection: Collection | null,
): void {
  if (newCollection.isView()) {
    return; // nothing to sync since views don't have records table
  }

  runInAppTransaction(app, (txApp) => {
    const db = () => txApp.databases.db();

    // create
    // -----------------------------------------------------------
    if (oldCollection === null || !hasTable(app.databases, oldCollection.name)) {
      const tableName = newCollection.name;

      const fields = newCollection.fields;

      const cols: Record<string, string> = {};

      // add fields definition
      for (const field of fields) {
        setOwn(cols, field.getName(), field.columnType(fieldApp(app)));
      }

      // create table
      withDriverErrors(() => db().createTable(tableName, cols).execute());

      createCollectionIndexes(txApp, newCollection);
      return;
    }

    // update
    // -----------------------------------------------------------
    const oldTableName = oldCollection.name;
    const newTableName = newCollection.name;
    const oldFields = oldCollection.fields;
    const newFields = newCollection.fields;

    const needTableRename = !equalFold(oldTableName, newTableName);

    let needIndexesUpdate = false;
    if (
      needTableRename ||
      oldFields.string() !== newFields.string() ||
      jsonArrayString(oldCollection.indexes) !== jsonArrayString(newCollection.indexes)
    ) {
      needIndexesUpdate = true;
    }

    if (needIndexesUpdate) {
      // drop old indexes (if any)
      dropCollectionIndexes(txApp, oldCollection);
    }

    // check for renamed table
    if (needTableRename) {
      withDriverErrors(() =>
        db()
          .renameTable("{{" + oldTableName + "}}", "{{" + newTableName + "}}")
          .execute(),
      );
    }

    // check for deleted columns
    for (const oldField of oldFields) {
      if (newFields.getById(oldField.getId()) !== null) {
        continue; // exist
      }

      try {
        withDriverErrors(() => db().dropColumn(newTableName, oldField.getName()).execute());
      } catch (err) {
        throw wrap(`failed to drop column ${oldField.getName()} - `, err);
      }
    }

    // check for new or renamed columns
    const toRename = new Map<string, string>();
    for (const field of newFields) {
      const oldField = oldFields.getById(field.getId());
      // Note:
      // We are using a temporary column name when adding or renaming columns
      // to ensure that there are no name collisions in case there is
      // names switch/reuse of existing columns (eg. name, title -> title, name).
      // This way we are always doing 1 more rename operation but it provides better less ambiguous experience.

      if (oldField === null) {
        const tempName = field.getName() + pseudorandomString(5);
        toRename.set(tempName, field.getName());

        // add
        try {
          withDriverErrors(() =>
            db()
              .addColumn(newTableName, tempName, field.columnType(fieldApp(txApp)))
              .execute(),
          );
        } catch (err) {
          throw wrap(`failed to add column ${field.getName()} - `, err);
        }
      } else if (oldField.getName() !== field.getName()) {
        const tempName = field.getName() + pseudorandomString(5);
        toRename.set(tempName, field.getName());

        // rename
        try {
          withDriverErrors(() =>
            db().renameColumn(newTableName, oldField.getName(), tempName).execute(),
          );
        } catch (err) {
          throw wrap(`failed to rename column ${oldField.getName()} - `, err);
        }
      }
    }

    // set the actual columns name
    for (const [tempName, actualName] of toRename) {
      withDriverErrors(() => db().renameColumn(newTableName, tempName, actualName).execute());
    }

    normalizeSingleVsMultipleFieldChanges(txApp, newCollection, oldCollection);

    if (needIndexesUpdate) {
      createCollectionIndexes(txApp, newCollection);
    }
  });

  // run optimize per the SQLite recommendations
  // (https://www.sqlite.org/pragma.html#pragma_optimize)
  try {
    app.databases.nonconcurrentDB().newQuery("PRAGMA optimize").execute();
  } catch (err) {
    app.logger.error("Failed to run PRAGMA optimize after record table sync", driverError(err));
  }
}

function normalizeSingleVsMultipleFieldChanges(
  app: CollectionsApp,
  newCollection: Collection,
  oldCollection: Collection | null,
): void {
  if (newCollection.isView() || oldCollection === null) {
    return; // view or not an update
  }

  runInAppTransaction(app, (txApp) => {
    const db = () => txApp.databases.db();

    for (const newField of newCollection.fields) {
      // allow to continue even if there is no old field for the cases
      // when a new field is added and there are already inserted data
      let isOldMultiple = false;
      const oldField = oldCollection.fields.getById(newField.getId());
      if (oldField !== null && isMultiValuer(oldField)) {
        isOldMultiple = oldField.isMultiple();
      }

      let isNewMultiple = false;
      if (isMultiValuer(newField)) {
        isNewMultiple = newField.isMultiple();
      }

      if (isOldMultiple === isNewMultiple) {
        continue; // no change
      }

      // -------------------------------------------------------
      // update the field column definition
      // -------------------------------------------------------

      // temporary drop all views to prevent reference errors during the columns renaming
      // (this is used as an "alternative" to the writable_schema PRAGMA)
      const views = withDriverErrors(() =>
        db()
          .select("name", "sql")
          .from("sqlite_master")
          .andWhere(newExp("sql is not null"))
          .andWhere(new HashExp({ type: "view" }))
          .all<{ name: string; sql: string }>(),
      );
      for (const view of views) {
        withDriverErrors(() => deleteView(txApp.databases, view.name));
      }

      const originalName = newField.getName();
      const oldTempName = "_" + newField.getName() + pseudorandomString(5);

      // rename temporary the original column to something else to allow inserting a new one in its place
      withDriverErrors(() =>
        db().renameColumn(newCollection.name, originalName, oldTempName).execute(),
      );

      // reinsert the field column with the new type
      withDriverErrors(() =>
        db()
          .addColumn(newCollection.name, originalName, newField.columnType(fieldApp(txApp)))
          .execute(),
      );

      let copyQuery: string;

      if (!isOldMultiple && isNewMultiple) {
        // single -> multiple (convert to array)
        copyQuery = `UPDATE {{${newCollection.name}}} set [[${originalName}]] = (
							CASE
								WHEN COALESCE([[${oldTempName}]], '') = ''
								THEN '[]'
								ELSE (
									CASE
										WHEN json_valid([[${oldTempName}]]) AND json_type([[${oldTempName}]]) == 'array'
										THEN [[${oldTempName}]]
										ELSE json_array([[${oldTempName}]])
									END
								)
							END
						)`;
      } else {
        // multiple -> single (keep only the last element)
        //
        // note: for file fields the actual file objects are not
        // deleted allowing additional custom handling via migration
        copyQuery = `UPDATE {{${newCollection.name}}} set [[${originalName}]] = (
						CASE
							WHEN COALESCE([[${oldTempName}]], '[]') = '[]'
							THEN ''
							ELSE (
								CASE
									WHEN json_valid([[${oldTempName}]]) AND json_type([[${oldTempName}]]) == 'array'
									THEN COALESCE(json_extract([[${oldTempName}]], '$[#-1]'), '')
									ELSE [[${oldTempName}]]
								END
							)
						END
					)`;
      }

      // copy the normalized values
      withDriverErrors(() => db().newQuery(copyQuery).execute());

      // drop the original column
      withDriverErrors(() => db().dropColumn(newCollection.name, oldTempName).execute());

      // restore views
      for (const view of views) {
        withDriverErrors(() => db().newQuery(view.sql).execute());
      }
    }
  });
}

function dropCollectionIndexes(app: CollectionsApp, collection: Collection): void {
  if (collection.isView()) {
    return; // views don't have indexes
  }

  runInAppTransaction(app, (txApp) => {
    for (const raw of collection.indexes) {
      const parsed = parseIndex(raw);

      // note: don't check IsValid because the index table name may not be populated
      // (https://ganigeorgiev.com/pocketbase/discussions/7689)
      if (parsed.indexName === "") {
        throw new Error(`failed to dop index - missing index name: ${raw}`);
      }

      withDriverErrors(() =>
        txApp.databases.db().newQuery(`DROP INDEX IF EXISTS [[${parsed.indexName}]]`).execute(),
      );
    }
  });
}

function createCollectionIndexes(app: CollectionsApp, collection: Collection): void {
  if (collection.isView()) {
    return; // views don't have indexes
  }

  runInAppTransaction(app, (txApp) => {
    // upsert new indexes
    //
    // note: we are returning validation errors because the indexes cannot be
    //       easily validated in a form, aka. before persisting the related
    //       collection record table changes
    const errs = new Errors();
    for (const [i, idx] of collection.indexes.entries()) {
      const parsed = parseIndex(idx);

      // ensure that the index is always for the current collection
      parsed.tableName = collection.name;

      if (!parsed.isValid()) {
        errs.errors[String(i)] = NewError(
          "validation_invalid_index_expression",
          "Invalid CREATE INDEX expression.",
        );
        continue;
      }

      try {
        withDriverErrors(() => txApp.databases.db().newQuery(parsed.build()).execute());
      } catch (err) {
        errs.errors[String(i)] = NewError(
          "validation_invalid_index_expression",
          `Failed to create index ${parsed.indexName} - ${err instanceof Error ? err.message : String(err)}.`,
        );
        continue;
      }
    }

    if (errs.size > 0) {
      throw new Errors({ indexes: errs });
    }
  });
}

// fmt.Errorf("<prefix>%w", err)
function wrap(prefix: string, err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  return new Error(prefix + e.message, { cause: e });
}
