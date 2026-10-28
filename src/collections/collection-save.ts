// Upstream: core/collection_model.go (onCollectionSave,
// onCollectionSaveExecute, onCollectionDeleteExecute and the cache reloads
// registerCollectionHooks binds), with the order core/db.go's Save,
// SaveNoValidate and Delete run them in for a collection
//
// There is no hook system (D5): upstream's hook chain for a collection
// save is called directly, in the order its priorities give it:
//
//	saveCollection (app.Save) / saveCollectionNoValidate (app.SaveNoValidate)
//	  onCollectionSave             normalization (OnCollectionCreate/Update, -99)
//	  validateCollection           only saveCollection (OnCollectionValidate)
//	  onCollectionSaveExecute      the transaction (OnCollectionCreateExecute/UpdateExecute, 99)
//	    view (re)creation, the `_collections` row write (the model's db
//	    write), SyncRecordTableSchema; then the dependent views and the
//	    cache reload
//	  on error: a new collection is new again, and the cache is reloaded
//	  (onErrorReloadCachedCollections on OnCollectionAfterCreateError /
//	  AfterUpdateError); inside an outer transaction the same runs again
//	  if that transaction fails (the model's txInfo.OnComplete)
//
//	deleteCollection (app.Delete)
//	  the primary key check, then onCollectionDeleteExecute around the row
//	  delete; on error the cache reload as above
//
// Errors are thrown (Go's returned error). The bootstrap cache load
// (OnBootstrap: "failed to load collections cache: ...") is
// loadCollectionsCache, for whoever opens pb_data in serve (M1.2).
//
// The `_collections` row is written by src/db's saveNoValidate and
// deleteModel. Collection.dbExport() returns upstream's typed values
// (FieldsList, string[], DateTime, JSONRaw); the row holds what Go's
// driver binds for them (their driver Value: the JSON and date texts), so
// they are converted before src/db binds them (collectionRow).

import { unsetMissingOAuth2MappedFields } from "@/collections/collection-model-auth-options";
import { type Collection, CollectionTypeBase } from "@/collections/collection-model";
import {
  type CollectionsApp,
  findCachedCollectionByNameOrId,
  findCollectionReferences,
  normalizeViewQueryId,
  reloadCachedCollections,
  resaveViewsWithChangedFields,
  runInAppTransaction,
} from "@/collections/collection-query";
import { syncRecordTableSchema } from "@/collections/collection-record-table-sync";
import { validateCollection } from "@/collections/collection-validate";
import { driverError, withDriverErrors } from "@/collections/driver-error";
import { newFieldsList } from "@/collections/fields-list";
import { createViewFields, saveView, wrapError } from "@/collections/view";
import { type DBExporter, deleteModel, saveNoValidate } from "@/db/db";
import type { Params } from "@/db/dbx/query";
import type { Model } from "@/db/model";
import { deleteTable, deleteView } from "@/db/table";
import { parseIndex } from "@/tools/dbutils/index";
import { randomString } from "@/tools/security/random";
import { nowDateTime } from "@/tools/types/datetime";
import { toString } from "@/tools/types/cast";
import { bytesToText } from "@/tools/types/go-json";
import { JSONRaw } from "@/tools/types/json-raw";
import { jsonArrayValue } from "@/tools/types/json-array";
import { FieldsList } from "@/collections/fields-list";
import { DateTime } from "@/tools/types/datetime";

// app.Save(collection): validates and saves the collection, its view or
// records table and its indexes.
export function saveCollection(app: CollectionsApp, collection: Collection): void {
  save(app, collection, true);
}

// app.SaveNoValidate(collection): the same as saveCollection without the
// collection validator.
export function saveCollectionNoValidate(app: CollectionsApp, collection: Collection): void {
  save(app, collection, false);
}

// app.Delete(collection): deletes the collection with its view or records
// table.
export function deleteCollection(app: CollectionsApp, collection: Collection): void {
  try {
    const pk = toString(collection.lastSavedPK());
    if (pk === "") {
      throw new Error(
        "the model can be deleted only if it is existing and has a non-empty primary key",
      );
    }

    onCollectionDeleteExecute(app, collection, (txApp) => {
      withDriverErrors(() => deleteModel(txApp.databases, collectionRow(collection)));
    });
  } catch (err) {
    onErrorReloadCachedCollections(app);
    throw err;
  }

  afterTransactionError(app, () => {});
}

// The OnBootstrap cache load: loads the collections cache once the app
// databases are open.
export function loadCollectionsCache(app: CollectionsApp): void {
  try {
    withDriverErrors(() => reloadCachedCollections(app));
  } catch (err) {
    throw wrapError("failed to load collections cache", err);
  }
}

// app.save for a collection (core/db.go create/update)
function save(app: CollectionsApp, collection: Collection, withValidations: boolean): void {
  const isNew = collection.isNew();

  try {
    onCollectionSave(app, collection);

    // run validations (if any)
    if (withValidations) {
      const validateErr = validateCollection(app, collection);
      if (validateErr !== null) {
        throw validateErr;
      }
    }

    // db write
    onCollectionSaveExecute(app, collection, (txApp) => {
      withDriverErrors(() => saveNoValidate(txApp.databases, collectionRow(collection)));
    });
  } catch (err) {
    if (isNew) {
      collection.markAsNew(); // reset "new" state
    }
    onErrorReloadCachedCollections(app);
    throw err;
  }

  afterTransactionError(app, () => {
    if (isNew) {
      collection.markAsNew(); // reset "new" state
    }
  });
}

// the model's txInfo.OnComplete: when the outer transaction fails, the
// collection change is rolled back, so the cache is reloaded on the
// parent app
function afterTransactionError(app: CollectionsApp, onError: () => void): void {
  const txInfo = app.databases.txInfo();
  if (txInfo === null) {
    return;
  }

  txInfo.onComplete((txErr) => {
    if (txErr === null) {
      return;
    }
    onError();
    onErrorReloadCachedCollections({ ...app, databases: txInfo.parent });
  });
}

// reload cache on failure
function onErrorReloadCachedCollections(app: CollectionsApp): void {
  try {
    reloadCachedCollections(app);
  } catch (err) {
    app.logger.error(
      "Failed to reload collections cache after collection change error",
      driverError(err),
    );
  }
}

function reloadCachedCollectionsOrWarn(app: CollectionsApp): void {
  try {
    reloadCachedCollections(app);
  } catch (err) {
    app.logger.error("Failed to reload collections cache", driverError(err));
  }
}

// onCollectionSave: the normalizations before the validation
export function onCollectionSave(app: CollectionsApp, collection: Collection): void {
  if (collection.type === "") {
    collection.type = CollectionTypeBase;
  }

  if (collection.isNew()) {
    collection.initDefaultId();
    collection.created = nowDateTime(app.clock);
  }

  collection.updated = nowDateTime(app.clock);

  // recreate the fields list to ensure that all normalizations
  // like default field id are applied
  collection.fields = newFieldsList(...collection.fields);

  collection.initDefaultFields();

  if (collection.isAuth()) {
    unsetMissingOAuth2MappedFields(collection);
  }

  collection.updateGeneratedIdIfExists(app);

  // normalize indexes table name
  for (const [i, raw] of collection.indexes.entries()) {
    const parsed = parseIndex(raw);

    // no need to normalize
    if (parsed.tableName === collection.name) {
      continue;
    }

    parsed.tableName = collection.name;

    const normalized = parsed.build();
    if (normalized === "") {
      continue; // leave to the model validator to decide whether to return an error
    }

    collection.indexes[i] = normalized;
  }
}

// onCollectionSaveExecute; next is the model's db write
function onCollectionSaveExecute(
  app: CollectionsApp,
  collection: Collection,
  next: (txApp: CollectionsApp) => void,
): void {
  try {
    let oldCollection: Collection | null = null;
    if (!collection.isNew()) {
      oldCollection = findCachedCollectionByNameOrId(app, collection.id);

      // invalidate previously issued auth tokens on auth rule change
      if (toString(oldCollection.authRule) !== toString(collection.authRule)) {
        collection.authToken.secret = randomString(50);
      }
    }

    runInAppTransaction(app, (txApp) => {
      const isView = collection.isView();

      // ensures that the view collection shema is properly loaded
      if (isView) {
        let query = collection.viewQuery;

        // generate collection fields list from the query
        const [viewFields, err] = createViewFields(txApp, query);
        if (err !== null) {
          throw err;
        }

        // delete old renamed view
        if (oldCollection !== null) {
          const oldName = oldCollection.name;
          withDriverErrors(() => deleteView(txApp.databases, oldName));
        }

        // wrap view query if necessary
        try {
          query = normalizeViewQueryId(txApp, query);
        } catch (normalizeErr) {
          throw wrapError("failed to normalize view query id", normalizeErr);
        }

        // (re)create the view
        saveView(txApp, collection.name, query);

        // updates newCollection.Fields based on the generated view table info and query
        collection.fields = viewFields;
      }

      // save the Collection model
      next(txApp);

      // sync the changes with the related records table
      if (!isView) {
        // note: don't wrap to allow propagating indexes validation.Errors
        syncRecordTableSchema(txApp, collection, oldCollection);
      }
    });

    // trigger an update for all views with changed fields as a result of the current collection save
    // (only log the error to allow users to adjust the problematic view queries from the UI)
    try {
      resaveViewsWithChangedFields(app, collection.id);
    } catch (depViewsErr) {
      app.logger.error(
        "Dependent view collection(s) may need to be updated after " +
          collection.name +
          " collection change",
        depViewsErr,
      );
    }
  } finally {
    reloadCachedCollectionsOrWarn(app);
  }
}

// onCollectionDeleteExecute; next is the model's db delete
function onCollectionDeleteExecute(
  app: CollectionsApp,
  collection: Collection,
  next: (txApp: CollectionsApp) => void,
): void {
  if (collection.system) {
    throw new Error(`[${collection.name}] system collections cannot be deleted`);
  }

  try {
    if (!collection.disableIntegrityChecks) {
      // ensure that there aren't any existing references.
      // note: the select is outside of the transaction to prevent SQLITE_LOCKED error when mixing read&write in a single transaction
      let references: Map<Collection, unknown>;
      try {
        references = withDriverErrors(() =>
          findCollectionReferences(app, collection, collection.id),
        );
      } catch (err) {
        throw wrapError(`[${collection.name}] failed to check collection references`, err);
      }
      if (references.size > 0) {
        const names = [...references.keys()].map((ref) => ref.name);
        throw new Error(
          `[${collection.name}] failed to delete due to existing relation references: ${names.join(", ")}`,
        );
      }
    }

    runInAppTransaction(app, (txApp) => {
      // delete the related view or records table
      if (collection.isView()) {
        withDriverErrors(() => deleteView(txApp.databases, collection.name));
      } else {
        withDriverErrors(() => deleteTable(txApp.databases, collection.name));
      }

      if (!collection.disableIntegrityChecks) {
        // trigger views resave to check for dependencies
        try {
          resaveViewsWithChangedFields(txApp, collection.id);
        } catch (err) {
          throw wrapError(
            `[${collection.name}] failed to delete due to existing view dependency`,
            err,
          );
        }
      }

      // delete
      next(txApp);
    });
  } finally {
    reloadCachedCollectionsOrWarn(app);
  }
}

// -------------------------------------------------------------------

// The collection as src/db writes it: its dbExport() with each value
// converted to what Go's driver binds (database/sql calls the Valuer of
// FieldsList, JSONArray, DateTime and JSONRaw; strings, bools and nil are
// bound as they are).
function collectionRow(collection: Collection): Model & DBExporter {
  return {
    tableName: () => collection.tableName(),
    pk: () => collection.pk(),
    lastSavedPK: () => collection.lastSavedPK(),
    isNew: () => collection.isNew(),
    markAsNew: () => collection.markAsNew(),
    markAsNotNew: () => collection.markAsNotNew(),
    dbExport: () => driverValues(collection.dbExport()),
  };
}

function driverValues(data: Params): Params {
  const result: Params = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = driverValue(key, value);
  }
  return result;
}

function driverValue(key: string, value: unknown): unknown {
  if (value instanceof FieldsList || value instanceof DateTime) {
    return value.value();
  }
  if (value instanceof JSONRaw) {
    const v = value.value();
    // the options text is valid UTF-8 (Collection.dbExport() marshals it)
    return v instanceof Uint8Array ? bytesToText(v) : v;
  }
  if (key === "indexes" && Array.isArray(value)) {
    return jsonArrayValue(value);
  }
  return value;
}
