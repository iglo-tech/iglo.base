// Upstream: core/collection_query.go (CollectionQuery, FindAllCollections,
// ReloadCachedCollections, FindCollectionByNameOrId,
// FindCachedCollectionByNameOrId, FindCollectionReferences,
// FindCachedCollectionReferences, IsCollectionNameUnique)
//
// Upstream's methods are on BaseApp. Here they are functions of the narrow
// CollectionsApp below: the databases (src/db), the app store holding the
// collections cache, and the clock. fieldApp() gives src/fields' FieldApp
// over them, so fields' ValidateSettings look up real collections.
//
// Go's (value, error) results are the value, and the error is thrown: a
// missing collection throws src/db's NoRowsError (sql.ErrNoRows).
// FindCollectionReferences returns a Map whose keys are the collections
// in the order the query returns them (Go's map order is random).
//
// normalizeViewQueryId and resaveViewsWithChangedFields are at the end.
// runInAppTransaction is app.RunInTransaction: the callback's txApp is the
// app with the transaction's databases (src/db/tx.ts).
//
// Not here: TruncateCollection (M1.8).

import type { ErrorLogger } from "@/app/app";
import type { Clock } from "@/app/clock";
import { Collection, CollectionTypeView } from "@/collections/collection-model";
import { saveCollection } from "@/collections/collection-save";
import { withDriverErrors } from "@/collections/driver-error";
import { toLower, equalFold, trim, trimSpace } from "@/collections/go-strings";
import {
  IdentifiersParser,
  createViewFields,
  getQueryTableInfo,
  joinErrors,
  wrapError,
} from "@/collections/view";
import type { Databases } from "@/db/base";
import { modelQuery } from "@/db/db";
import { inExp, newExp, notIn } from "@/db/dbx/expression";
import { NoRowsError } from "@/db/dbx/rows";
import { runInTransaction } from "@/db/tx";
import type { SelectQuery } from "@/db/dbx/select";
import { type Field, type FieldApp, FieldNameId } from "@/fields/field";
import { RelationField } from "@/fields/relation";
import { existInSlice, nonzeroUniques, toInterfaceSlice } from "@/tools/list/list";
import type { Store } from "@/tools/store/store";

export const StoreKeyCachedCollections = "pbAppCachedCollections";

// The app members the collection queries, the collections cache and the
// collection validator use (core/app.go).
export interface CollectionsApp {
  // the data.db and auxiliary.db builders (DB, ConcurrentDB, ModelQuery, ...)
  readonly databases: Databases;
  // Store returns the app runtime store.
  readonly store: Store<string, unknown>;
  // the clock that replaces upstream's time.Now()
  readonly clock: Clock;
  // receives upstream's Logger().Warn calls (errors the save path only
  // reports)
  readonly logger: ErrorLogger;
}

// RunInTransaction wraps fn into a transaction for the regular app
// database; nested calls run in the existing transaction.
export function runInAppTransaction(
  app: CollectionsApp,
  fn: (txApp: CollectionsApp) => void,
): void {
  runInTransaction(app.databases, (txDatabases) => {
    fn(txDatabases === app.databases ? app : { ...app, databases: txDatabases });
  });
}

// CollectionQuery returns a new Collection select query.
export function collectionQuery(app: CollectionsApp): SelectQuery {
  return modelQuery(app.databases, new Collection());
}

// FindCollections finds all collections by the given type(s).
//
// If collectionTypes is not set, it returns all collections.
//
// Example:
//
//	findAllCollections(app) // all collections
//	findAllCollections(app, "auth", "view") // only auth and view collections
export function findAllCollections(
  app: CollectionsApp,
  ...collectionTypes: string[]
): Collection[] {
  const q = collectionQuery(app);

  const types = nonzeroUniques(collectionTypes);
  if (types.length > 0) {
    q.andWhere(inExp("type", ...toInterfaceSlice(types)));
  }

  return q.orderBy("rowid ASC").all<Collection>(() => new Collection());
}

// ReloadCachedCollections fetches all collections and caches them into the app store.
export function reloadCachedCollections(app: CollectionsApp): void {
  const collections = findAllCollections(app);

  app.store.set(StoreKeyCachedCollections, collections);
}

// FindCollectionByNameOrId finds a single collection by its name (case insensitive) or id.
export function findCollectionByNameOrId(app: CollectionsApp, nameOrId: string): Collection {
  const m = new Collection();

  collectionQuery(app)
    .andWhere(
      newExp("[[id]]={:id} OR LOWER([[name]])={:name}", {
        id: nameOrId,
        name: toLower(nameOrId),
      }),
    )
    .limit(1)
    .one(m);

  return m;
}

// the cached collections (undefined when the cache is not initialized)
function cachedCollections(app: CollectionsApp): Collection[] | undefined {
  const cached = app.store.get(StoreKeyCachedCollections);
  return Array.isArray(cached) ? (cached as Collection[]) : undefined;
}

// FindCachedCollectionByNameOrId is similar to findCollectionByNameOrId
// but retrieves the Collection from the app cache instead of making a db call.
//
// NB! This method is suitable for read-only Collection operations.
//
// Throws NoRowsError (sql.ErrNoRows) if no Collection is found for
// consistency with the findCollectionByNameOrId method.
//
// If you plan making changes to the returned Collection model,
// use findCollectionByNameOrId instead.
//
// Caveats:
//
//   - The returned Collection should be used only for read-only operations.
//     Avoid directly modifying the returned cached Collection as it will affect
//     the global cached value even if you don't persist the changes in the database!
//   - If you are updating a Collection in a transaction and then call this method before commit,
//     it'll return the cached Collection state and not the one from the uncommitted transaction.
//   - The cache is automatically updated on collections db change (create/update/delete).
//     To manually reload the cache you can call reloadCachedCollections.
export function findCachedCollectionByNameOrId(app: CollectionsApp, nameOrId: string): Collection {
  const collections = cachedCollections(app);
  if (collections === undefined) {
    // cache is not initialized yet (eg. run in a system migration)
    return findCollectionByNameOrId(app, nameOrId);
  }

  for (const c of collections) {
    if (equalFold(c.name, nameOrId) || c.id === nameOrId) {
      return c;
    }
  }

  throw new NoRowsError();
}

// FindCollectionReferences returns information for all relation fields
// referencing the provided collection.
//
// If the provided collection has reference to itself then it will be
// also included in the result. To exclude it, pass the collection id
// as the excludeIds argument.
export function findCollectionReferences(
  app: CollectionsApp,
  collection: Collection,
  ...excludeIds: string[]
): Map<Collection, Field[]> {
  const query = collectionQuery(app);

  const uniqueExcludeIds = nonzeroUniques(excludeIds);
  if (uniqueExcludeIds.length > 0) {
    query.andWhere(notIn("id", ...toInterfaceSlice(uniqueExcludeIds)));
  }

  const collections = query.all<Collection>(() => new Collection());

  return relationReferences(collections, collection);
}

// FindCachedCollectionReferences is similar to findCollectionReferences
// but retrieves the Collection from the app cache instead of making a db call.
//
// NB! This method is suitable for read-only Collection operations.
//
// If you plan making changes to the returned Collection model,
// use findCollectionReferences instead.
//
// Caveats:
//
//   - The returned Collection should be used only for read-only operations.
//     Avoid directly modifying the returned cached Collection as it will affect
//     the global cached value even if you don't persist the changes in the database!
//   - If you are updating a Collection in a transaction and then call this method before commit,
//     it'll return the cached Collection state and not the one from the uncommitted transaction.
//   - The cache is automatically updated on collections db change (create/update/delete).
//     To manually reload the cache you can call reloadCachedCollections.
export function findCachedCollectionReferences(
  app: CollectionsApp,
  collection: Collection,
  ...excludeIds: string[]
): Map<Collection, Field[]> {
  const collections = cachedCollections(app);
  if (collections === undefined) {
    // cache is not initialized yet (eg. run in a system migration)
    return findCollectionReferences(app, collection, ...excludeIds);
  }

  return relationReferences(
    collections.filter((c) => !excludeIds.includes(c.id)),
    collection,
  );
}

function relationReferences(
  collections: readonly Collection[],
  collection: Collection,
): Map<Collection, Field[]> {
  const result = new Map<Collection, Field[]>();

  for (const c of collections) {
    for (const rawField of c.fields) {
      if (rawField instanceof RelationField && rawField.collectionId === collection.id) {
        const refs = result.get(c);
        if (refs === undefined) {
          result.set(c, [rawField]);
        } else {
          refs.push(rawField);
        }
      }
    }
  }

  return result;
}

// IsCollectionNameUnique checks that there is no existing collection
// with the provided name (case insensitive!).
//
// Note: case insensitive check because the name is used also as
// table name for the records.
export function isCollectionNameUnique(
  app: CollectionsApp,
  name: string,
  ...excludeIds: string[]
): boolean {
  if (name === "") {
    return false;
  }

  const query = collectionQuery(app)
    .select("count(*)")
    .andWhere(newExp("LOWER([[name]])={:name}", { name: toLower(name) }))
    .limit(1);

  const uniqueExcludeIds = nonzeroUniques(excludeIds);
  if (uniqueExcludeIds.length > 0) {
    query.andWhere(notIn("id", ...toInterfaceSlice(uniqueExcludeIds)));
  }

  try {
    const [total] = query.row();
    return Number(total) === 0;
  } catch {
    return false;
  }
}

// The FieldApp the fields' ValidateSettings use: the collection lookups
// above on the app's databases and cache.
export function fieldApp(app: CollectionsApp): FieldApp {
  return {
    concurrentDB: () => app.databases.concurrentDB(),
    clock: app.clock,
    findCollectionByNameOrId: (nameOrId) => findCollectionByNameOrId(app, nameOrId),
    findCachedCollectionByNameOrId: (nameOrId) => findCachedCollectionByNameOrId(app, nameOrId),
  };
}

// -------------------------------------------------------------------

// normalizeViewQueryId wraps (if necessary) the provided view query
// with a subselect to ensure that the id column is a text since
// currently we don't support non-string model ids
// (see https://ganigeorgiev.com/pocketbase/discussions/3110).
export function normalizeViewQueryId(app: CollectionsApp, query: string): string {
  query = trim(trimSpace(query), ";");

  const info = getQueryTableInfo(app, query);

  for (const row of info) {
    if (equalFold(row.name, FieldNameId) && equalFold(row.type, "TEXT")) {
      return query; // no wrapping needed
    }
  }

  // raw parse to preserve the columns order
  const rawParsed = new IdentifiersParser();
  rawParsed.parse(query);

  const columns: string[] = [];
  for (const col of rawParsed.columns) {
    if (col.alias === FieldNameId) {
      columns.push(`CAST([[${col.alias}]] as TEXT) [[${col.alias}]]`);
    } else {
      columns.push("[[" + col.alias + "]]");
    }
  }

  return `SELECT ${columns.join(",")} FROM (${query})`;
}

// resaveViewsWithChangedFields updates all view collections with changed fields.
export function resaveViewsWithChangedFields(app: CollectionsApp, ...excludeIds: string[]): void {
  const collections = withDriverErrors(() => findAllCollections(app, CollectionTypeView));

  runInAppTransaction(app, (txApp) => {
    const collectionErrors: Error[] = [];

    for (const collection of collections) {
      if (excludeIds.length > 0 && existInSlice(collection.id, excludeIds)) {
        continue;
      }

      const check = (): void => {
        // clone the existing fields for temp modifications
        const oldFields = collection.fields.clone();

        // generate new fields from the query
        const [newFields, err] = createViewFields(txApp, collection.viewQuery);
        if (err !== null) {
          throw err;
        }

        // unset the fields' ids to exclude from the comparison
        for (const f of oldFields) {
          f.setId("");
        }
        for (const f of newFields) {
          f.setId("");
        }

        const encodedNewFields = newFields.marshalJSON();
        const encodedOldFields = oldFields.marshalJSON();

        if (equalFold(encodedNewFields, encodedOldFields)) {
          return; // no changes
        }

        saveCollection(txApp, collection);
      };

      try {
        check();
      } catch (err) {
        collectionErrors.push(wrapError(`[${collection.name}]`, err));
      }
    }

    if (collectionErrors.length > 0) {
      throw joinErrors(collectionErrors);
    }
  });
}
