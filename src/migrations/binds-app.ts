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
import { goArgs, goMethod, type Method } from "@/migrations/go-class";
import type { Adapter, Membrane } from "@/migrations/membrane";
import { pass } from "@/migrations/membrane";
import { Record as RecordModel } from "@/records/record-model";
import { expandRecordsSync, type ExpandFetchSyncFunc } from "@/records/record-query-expand";
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

  constructor(
    readonly app: App,
    runTxFunc: RunTxFunc,
  ) {
    this.methods = newAppMethods(app, runTxFunc);
  }

  close(): void {
    this.closed = true;
  }

  // Settings.DBExport(app)
  exportSettings(settings: Settings): unknown {
    return settings.dbExportSync(this.app.clock, this.app.getenv(this.app.encryptionEnv));
  }
}

// func(txApp core.App) error
function txFunc(m: Membrane, fn: unknown): unknown {
  if (typeof fn !== "function") {
    throw new m.vm.TypeError(
      `could not convert function call parameter 0: could not convert ${String(fn)} to func(core.App) error`,
    );
  }
  return fn;
}

// the ExpandFetchFunc of a migration file: a thrown error becomes the
// failure of its expand path
function expandFetch(m: Membrane, fn: unknown): ExpandFetchSyncFunc | null {
  if (fn === undefined || fn === null) {
    return null;
  }
  if (typeof fn !== "function") {
    throw new m.vm.TypeError(
      `could not convert function call parameter 2: could not convert ${String(fn)} to core.ExpandFetchFunc`,
    );
  }
  return (relCollection, relIds) => {
    const result = (fn as (...args: unknown[]) => unknown)(m.toVm(relCollection), m.toVm(relIds));
    if (result === undefined || result === null) {
      return [];
    }
    const records = m.toHost(result);
    if (!Array.isArray(records)) {
      throw new Error(`could not convert ${String(result)} to []*core.Record`);
    }
    return records as RecordModel[];
  };
}

// the Go signatures of core.App, with the names of go-class.ts
const appMethods: Readonly<Record<string, Method>> = {
  dataDir: "",
  encryptionEnv: "",
  isDev: "",
  settings: "",
  isTransactional: "",
  db: "",
  concurrentDB: "",
  nonconcurrentDB: "",
  auxDB: "",
  auxConcurrentDB: "",
  auxNonconcurrentDB: "",
  runInTransaction: (methods: AppMethods, args, m) => {
    methods.runInTransaction?.(txFunc(m, args[0]) as never);
  },
  auxRunInTransaction: (methods: AppMethods, args, m) => {
    methods.auxRunInTransaction?.(txFunc(m, args[0]) as never);
  },
  save: "M",
  saveNoValidate: "M",
  delete: "M",
  validate: "M",
  collectionQuery: "",
  findAllCollections: "...s",
  findCollectionByNameOrId: "s",
  findCachedCollectionByNameOrId: "s",
  findCollectionReferences: "a,...s",
  findCachedCollectionReferences: "a,...s",
  isCollectionNameUnique: "s,...s",
  truncateCollection: "a",
  reloadCachedCollections: "",
  importCollections: "a,b",
  importCollectionsByMarshaledJSON: "B,b",
  hasTable: "s",
  auxHasTable: "s",
  tableColumns: "s",
  tableInfo: "s",
  tableIndexes: "s",
  deleteTable: "s",
  deleteView: "s",
  vacuum: "",
  auxVacuum: "",
  recordQuery: "a",
  findRecordById: "a,s,...Q",
  findRecordsByIds: "a,L,...Q",
  findAllRecords: "a,...E",
  findFirstRecordByData: "a,s,a",
  findRecordsByFilter: "a,s,s,i,i,...P",
  findFirstRecordByFilter: "a,s,...P",
  countRecords: "a,...E",
  findAuthRecordByEmail: "a,s",
  findAuthRecordByToken: "s,...s",
  canAccessRecord: "a,a,a",
  expandRecord: (methods: AppMethods, args, m) => {
    const [record, expands] = goArgs(m, "a,L", args);
    return m.toVm(
      methods.expandRecord?.(record as never, expands as never, expandFetch(m, args[2]) as never),
    );
  },
  expandRecords: (methods: AppMethods, args, m) => {
    const [records, expands] = goArgs(m, "a,L", args);
    return m.toVm(
      methods.expandRecords?.(
        (records ?? []) as never,
        expands as never,
        expandFetch(m, args[2]) as never,
      ),
    );
  },
};

type AppMethods = AppBinding["methods"];

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

    return goMethod(m, binding.methods, key, appMethods[key] as Method);
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
      if (model === null) {
        return;
      }
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
    // Go's sql.NullString
    tableInfo: (name: string) =>
      tableInfo(db, name).map((row) => ({
        ...row,
        defaultValue: { string: row.defaultValue ?? "", valid: row.defaultValue !== null },
      })),
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
    expandRecords: (
      records: RecordModel[],
      expands: readonly string[],
      fetch: ExpandFetchSyncFunc | null,
    ) => expandRecordsSync(app, records, expands, fetch),
    expandRecord: (
      record: RecordModel,
      expands: readonly string[],
      fetch: ExpandFetchSyncFunc | null,
    ) => expandRecordsSync(app, [record], expands, fetch),
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
  saveSettingsSync(app, s, withValidations);

  // upstream's save reloads the app settings from the stored row
  if (s !== app.settings) {
    app.settings.merge(s);
  }
}

function unsupportedModel(model: unknown): Error {
  return new Error(`the model ${String(model)} is not supported in iglo.base migrations`);
}
