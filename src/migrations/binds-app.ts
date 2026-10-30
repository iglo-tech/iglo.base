// Upstream: core/app.go, with core/db.go's Save, SaveNoValidate, Delete and
// Validate choosing the model's save path
//
// The `app` a migration's up and down get: goja exposes the whole core.App
// with lowerCamelCase names (plugins/jsvm/mapper.go). This is a thin object
// over the transaction's internal modules, with the same names. Everything
// is synchronous, as it runs inside the synchronous write transaction
// (D8), and it stops working when the migration ends, so nothing left
// running can reach the closed transaction. A core.App method it does not
// have fails with an error that names it.

import type { App } from "@/app/app";
import {
  importCollections,
  importCollectionsByMarshaledJSON,
} from "@/collections/collection-import";
import { Collection } from "@/collections/collection-model";
import {
  collectionQuery,
  findAllCollections,
  findCachedCollectionByNameOrId,
  findCachedCollectionReferences,
  findCollectionByNameOrId,
  findCollectionReferences,
  isCollectionNameUnique,
  reloadCachedCollections,
  runInAppTransaction,
  truncateCollection,
} from "@/collections/collection-query";
import {
  deleteCollection,
  saveCollection,
  saveCollectionNoValidate,
} from "@/collections/collection-save";
import { validateCollection } from "@/collections/collection-validate";
import type { Params } from "@/db/dbx/query";
import {
  auxHasTable,
  auxVacuum,
  deleteTable,
  deleteView,
  hasTable,
  tableColumns,
  tableIndexes,
  tableInfo,
  vacuum,
} from "@/db/table";
import { auxRunInTransaction } from "@/db/tx";
import type { Adapter } from "@/migrations/membrane";
import { pass } from "@/migrations/membrane";
import { Record as RecordModel } from "@/records/record-model";
import { expandRecordSync } from "@/records/record-query-expand";
import {
  canAccessRecord,
  findFirstRecordByFilter,
  findRecordsByFilter,
} from "@/records/record-query-filter";
import {
  countRecords,
  findAllRecords,
  findAuthRecordByEmail,
  findAuthRecordByToken,
  findFirstRecordByData,
  findRecordById,
  findRecordsByIds,
  recordQuery,
} from "@/records/record-query";
import {
  deleteRecordSync,
  saveRecordNoValidateSync,
  saveRecordSync,
  validateRecordSync,
} from "@/records/record-save";
import { Settings } from "@/settings/settings-model";
import { saveSettingsSync } from "@/settings/settings-query";

// A function of the migration file with the (txApp) => error signature.
type TxFunc = unknown;

export type RunTxFunc = (fn: TxFunc, txApp: App) => void;

export class AppBinding {
  closed = false;
  readonly methods: Record<string, (...args: never[]) => unknown>;

  constructor(app: App, runTxFunc: RunTxFunc) {
    this.methods = newAppMethods(app, runTxFunc);
  }

  close(): void {
    this.closed = true;
  }
}

export const appBindingAdapter: Adapter = {
  get(target, key, m) {
    const binding = target as AppBinding;

    if (key === "then" || key === "toJSON") {
      return undefined; // not a thenable, not serializable
    }

    if (binding.closed) {
      throw new Error(`app.${key} was called after its migration ended`);
    }

    if (!Object.hasOwn(binding.methods, key)) {
      throw new Error(`app.${key} is not available in iglo.base migrations`);
    }

    return m.member(binding.methods, key);
  },
  set() {
    return pass;
  },
};

function newAppMethods(app: App, runTxFunc: RunTxFunc): AppBinding["methods"] {
  const db = app.databases;

  return {
    // -----------------------------------------------------------------
    // the app

    dataDir: () => app.dataDir,
    encryptionEnv: () => app.encryptionEnv,
    isDev: () => app.isDev,
    settings: () => app.settings,
    isTransactional: () => db.txInfo() !== null,

    db: () => db.db(),
    concurrentDB: () => db.concurrentDB(),
    nonconcurrentDB: () => db.nonconcurrentDB(),
    auxDB: () => db.auxDB(),
    auxConcurrentDB: () => db.auxConcurrentDB(),
    auxNonconcurrentDB: () => db.auxNonconcurrentDB(),

    runInTransaction: (fn: TxFunc) => {
      runInAppTransaction(app, (txApp) => runTxFunc(fn, txApp as App));
    },
    auxRunInTransaction: (fn: TxFunc) => {
      auxRunInTransaction(db, (txDatabases) => {
        runTxFunc(fn, txDatabases === db ? app : { ...app, databases: txDatabases });
      });
    },

    // -----------------------------------------------------------------
    // models

    save: (model: unknown) => save(app, model, true),
    saveNoValidate: (model: unknown) => save(app, model, false),
    delete: (model: unknown) => {
      if (model instanceof Collection) {
        deleteCollection(app, model);
      } else if (model instanceof RecordModel) {
        deleteRecordSync(app, model);
      } else {
        throw unsupportedModel(model);
      }
    },
    validate: (model: unknown) => {
      if (model instanceof Collection) {
        const err = validateCollection(app, model);
        if (err !== null) {
          throw err;
        }
      } else if (model instanceof RecordModel) {
        validateRecordSync(app, model);
      } else if (model instanceof Settings) {
        const err = model.validate();
        if (err !== null) {
          throw err;
        }
      } else {
        throw unsupportedModel(model);
      }
    },

    // -----------------------------------------------------------------
    // collections

    collectionQuery: () => collectionQuery(app),
    findAllCollections: (...types: string[]) => findAllCollections(app, ...types),
    findCollectionByNameOrId: (nameOrId: string) => findCollectionByNameOrId(app, nameOrId),
    findCachedCollectionByNameOrId: (nameOrId: string) =>
      findCachedCollectionByNameOrId(app, nameOrId),
    findCollectionReferences: (c: Collection, ...excludeIds: string[]) =>
      findCollectionReferences(app, c, ...excludeIds),
    findCachedCollectionReferences: (c: Collection, ...excludeIds: string[]) =>
      findCachedCollectionReferences(app, c, ...excludeIds),
    isCollectionNameUnique: (name: string, ...excludeIds: string[]) =>
      isCollectionNameUnique(app, name, ...excludeIds),
    truncateCollection: (c: Collection) => truncateCollection(app, c),
    reloadCachedCollections: () => reloadCachedCollections(app),
    importCollections: (
      data: readonly (Record<string, unknown> | null)[],
      deleteMissing: boolean,
    ) => importCollections(app, data, deleteMissing === true),
    importCollectionsByMarshaledJSON: (raw: string | Uint8Array, deleteMissing: boolean) =>
      importCollectionsByMarshaledJSON(app, raw, deleteMissing === true),

    // -----------------------------------------------------------------
    // tables

    hasTable: (name: string) => hasTable(db, name),
    auxHasTable: (name: string) => auxHasTable(db, name),
    tableColumns: (name: string) => tableColumns(db, name),
    tableInfo: (name: string) => tableInfo(db, name),
    tableIndexes: (name: string) => tableIndexes(db, name),
    deleteTable: (name: string) => deleteTable(db, name),
    deleteView: (name: string) => deleteView(db, name),
    vacuum: () => vacuum(db),
    auxVacuum: () => auxVacuum(db),

    // -----------------------------------------------------------------
    // records

    recordQuery: (c: Collection | string) => recordQuery(app, c),
    findRecordById: (
      c: Collection | string,
      id: string,
      ...filters: Parameters<typeof findRecordById>[3][]
    ) => findRecordById(app, c, id, ...filters),
    findRecordsByIds: (
      c: Collection | string,
      ids: readonly string[],
      ...filters: Parameters<typeof findRecordsByIds>[3][]
    ) => findRecordsByIds(app, c, ids, ...filters),
    findAllRecords: (c: Collection | string, ...exprs: Parameters<typeof findAllRecords>[2][]) =>
      findAllRecords(app, c, ...exprs),
    findFirstRecordByData: (c: Collection | string, key: string, value: unknown) =>
      findFirstRecordByData(app, c, key, value),
    findRecordsByFilter: (
      c: Collection | string,
      filter: string,
      sort?: string,
      limit?: number,
      offset?: number,
      ...params: Params[]
    ) => findRecordsByFilter(app, c, filter, sort ?? "", limit ?? 0, offset ?? 0, ...params),
    findFirstRecordByFilter: (c: Collection | string, filter: string, ...params: Params[]) =>
      findFirstRecordByFilter(app, c, filter, ...params),
    countRecords: (c: Collection | string, ...exprs: Parameters<typeof countRecords>[2][]) =>
      countRecords(app, c, ...exprs),
    findAuthRecordByEmail: (c: Collection | string, email: string) =>
      findAuthRecordByEmail(app, c, email),
    findAuthRecordByToken: (token: string, ...validTypes: string[]) =>
      findAuthRecordByToken(app, token, ...validTypes),
    canAccessRecord: (
      record: RecordModel,
      requestInfo: Parameters<typeof canAccessRecord>[2],
      accessRule: string | null,
    ) => canAccessRecord(app, record, requestInfo, accessRule),
    expandRecord: (record: RecordModel, expands: readonly string[]) =>
      expandRecordSync(app, record, expands),
    expandRecords: (records: readonly RecordModel[], expands: readonly string[]) => {
      for (const record of records) {
        const failed = expandRecordSync(app, record, expands);
        if (failed.size > 0) {
          return failed;
        }
      }
      return new Map<string, Error>();
    },
  };
}

function save(app: App, model: unknown, withValidations: boolean): void {
  if (model instanceof Collection) {
    if (withValidations) {
      saveCollection(app, model);
    } else {
      saveCollectionNoValidate(app, model);
    }
  } else if (model instanceof RecordModel) {
    if (withValidations) {
      saveRecordSync(app, model);
    } else {
      saveRecordNoValidateSync(app, model);
    }
  } else if (model instanceof Settings) {
    saveSettings(app, model, withValidations);
  } else {
    throw unsupportedModel(model);
  }
}

function saveSettings(app: App, s: Settings, withValidations: boolean): void {
  if (!withValidations) {
    throw new Error("app.saveNoValidate of the settings is not available in iglo.base migrations");
  }

  saveSettingsSync(app, s);

  // upstream's save reloads the app settings from the stored row
  if (s !== app.settings) {
    app.settings.merge(s);
  }
}

function unsupportedModel(model: unknown): Error {
  return new Error(`the model ${String(model)} is not supported in iglo.base migrations`);
}
