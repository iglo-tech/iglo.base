// Upstream: core/migrations_list.go (SystemMigrations, sorted by file name),
// the registrations in migrations/*.go, core/base.go RunSystemMigrations
// and the system-list part of core/migrations_runner.go Up
//
// iglo.base does not port upstream's historical system migrations (D12).
// It knows their file names and acts on open as 03-data-compatibility.md
// "Migrations" says:
//
//  1. a fresh data.db (no system migration recorded and none of the
//     baseline tables): build the v0.41.0 end state (baseline.ts) and
//     record every system migration, as upstream's Up does, in one
//     auxiliary.db transaction around one data.db transaction;
//  2. existing data: every system migration must be recorded and the
//     system collections must exist, otherwise the start is refused
//     (OlderDataError);
//  3. other `_migrations` rows are kept; `.go` rows newer than the
//     baseline produce one warning.
//
// 1640988000_aux_init.go keeps upstream's ReapplyCondition: when
// auxiliary.db has no `_logs` table, the table is created again and the
// row is re-recorded, as upstream does on every start.

import { CollectionTypeAuth, CollectionTypeBase } from "@/collections/collection-model";
import { type CollectionsApp, runInAppTransaction } from "@/collections/collection-query";
import { HashExp } from "@/db/dbx/expression";
import { auxRunInTransaction } from "@/db/tx";
import { auxHasTable, hasTable } from "@/db/table";
import {
  createInitSchema,
  createLogsTable,
  resaveNonSystemCollections,
} from "@/migrations/baseline";
import {
  appliedMigrationFiles,
  initMigrationsTable,
  isMigrationApplied,
  saveAppliedMigration,
  saveRevertedMigration,
} from "@/migrations/migrations-runner";
import {
  CollectionNameAuthOrigins,
  CollectionNameExternalAuths,
  CollectionNameMFAs,
  CollectionNameOTPs,
} from "@/records/record-auth-refs";
import { CollectionNameSuperusers } from "@/records/record-model-superusers";

interface SystemMigration {
  readonly file: string;
  // what the migration does on a fresh install (none: nothing)
  readonly up?: (txApp: CollectionsApp) => void;
}

// SystemMigrations, sorted by file name as MigrationsList.Register sorts them
export const systemMigrations: readonly SystemMigration[] = Object.freeze([
  { file: "1640988000_aux_init.go", up: createLogsTable },
  { file: "1640988000_init.go", up: createInitSchema },
  { file: "1717233556_v0.23_migrate.go" },
  { file: "1717233557_v0.23_migrate2.go" },
  { file: "1717233558_v0.23_migrate3.go" },
  { file: "1717233559_v0.23_migrate4.go" },
  { file: "1763020353_update_default_auth_alert_templates.go" },
  { file: "1778828400_normalize_indexes.go", up: resaveNonSystemCollections },
]);

export const systemMigrationFiles: readonly string[] = Object.freeze(
  systemMigrations.map((m) => m.file),
);

// the timestamp of the newest system migration (03-data-compatibility.md)
const baselineTimestamp = 1778828400;

const auxInitFile = "1640988000_aux_init.go";

// the data.db tables the baseline creates, besides `_migrations`
const baselineTables: readonly string[] = Object.freeze([
  "_params",
  "_collections",
  CollectionNameMFAs,
  CollectionNameOTPs,
  CollectionNameExternalAuths,
  CollectionNameAuthOrigins,
  CollectionNameSuperusers,
  "users",
]);

// the system collections every v0.40.x/v0.41.0 pb_data has, with their type
const systemCollections: readonly (readonly [string, string])[] = Object.freeze([
  [CollectionNameMFAs, CollectionTypeBase],
  [CollectionNameOTPs, CollectionTypeBase],
  [CollectionNameExternalAuths, CollectionTypeBase],
  [CollectionNameAuthOrigins, CollectionTypeBase],
  [CollectionNameSuperusers, CollectionTypeAuth],
]);

export const olderDataMessage =
  "This pb_data was written by an older PocketBase. Run PocketBase v0.41.0 on it once, then start iglo.base.";

// The start is refused: the pb_data needs system migrations iglo.base
// does not port.
export class OlderDataError extends Error {
  constructor() {
    super(olderDataMessage);
    this.name = "OlderDataError";
  }
}

export interface SystemMigrationsResult {
  // whether the baseline was created (a fresh install)
  readonly created: boolean;
  // the warnings to print once (newer migrations)
  readonly warnings: readonly string[];
}

// RunSystemMigrations: creates the baseline on a fresh data.db, or checks
// that existing data needs nothing iglo.base does not port.
export function runSystemMigrations(app: CollectionsApp): SystemMigrationsResult {
  const applied = appliedMigrationFiles(app.databases);
  const appliedSet = new Set(applied);
  const recordedSystem = systemMigrationFiles.filter((file) => appliedSet.has(file));

  if (recordedSystem.length === 0 && !baselineTables.some((t) => hasTable(app.databases, t))) {
    createBaseline(app);
    return { created: true, warnings: [] };
  }

  if (recordedSystem.length !== systemMigrationFiles.length || !hasSystemCollections(app)) {
    throw new OlderDataError();
  }

  reapplyAuxInit(app);

  const newer = applied.filter((file) => isNewerGoMigration(file));
  const warnings =
    newer.length > 0
      ? [
          `pb_data has migrations newer than PocketBase v0.41.0 (${newer.join(", ")}); the data may come from a newer PocketBase.`,
        ]
      : [];

  return { created: false, warnings };
}

// a `.go` row that is not a known system migration and whose timestamp
// prefix is after the baseline's
function isNewerGoMigration(file: string): boolean {
  if (!file.endsWith(".go") || systemMigrationFiles.includes(file)) {
    return false;
  }
  const match = /^(\d+)_/.exec(file);
  return match !== null && Number(match[1]) > baselineTimestamp;
}

function hasSystemCollections(app: CollectionsApp): boolean {
  if (!hasTable(app.databases, "_collections") || !hasTable(app.databases, "_params")) {
    return false;
  }
  for (const [name, type] of systemCollections) {
    const rows = app.databases
      .db()
      .select("type")
      .from("_collections")
      .where(new HashExp({ name }))
      .limit(1)
      .column<unknown>();
    if (rows.length === 0 || String(rows[0]) !== type || !hasTable(app.databases, name)) {
      return false;
    }
  }
  return true;
}

// the Up of a fresh install: every system migration, in order, with its
// row recorded right after it
function createBaseline(app: CollectionsApp): void {
  initMigrationsTable(app.databases);

  auxRunInTransaction(app.databases, (auxDatabases) => {
    runInAppTransaction({ ...app, databases: auxDatabases }, (txApp) => {
      for (const m of systemMigrations) {
        if (m.up !== undefined) {
          try {
            m.up(txApp);
          } catch (err) {
            throw new Error(
              `failed to apply migration ${m.file}: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err },
            );
          }
        }
        saveApplied(txApp, m.file);
      }
    });
  });
}

// 1640988000_aux_init.go ReapplyCondition: reapply only if the _logs
// table doesn't exist
function reapplyAuxInit(app: CollectionsApp): void {
  if (auxHasTable(app.databases, "_logs")) {
    return;
  }

  auxRunInTransaction(app.databases, (auxDatabases) => {
    runInAppTransaction({ ...app, databases: auxDatabases }, (txApp) => {
      if (isMigrationApplied(txApp.databases, auxInitFile)) {
        // clear previous history stored entry
        // (it will be recreated after successful execution)
        saveRevertedMigration(txApp.databases, auxInitFile);
      }
      try {
        createLogsTable(txApp);
      } catch (err) {
        throw new Error(
          `failed to apply migration ${auxInitFile}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      saveApplied(txApp, auxInitFile);
    });
  });
}

function saveApplied(txApp: CollectionsApp, file: string): void {
  try {
    saveAppliedMigration(txApp.databases, txApp.clock, file);
  } catch (err) {
    throw new Error(
      `failed to save applied migration info for ${file}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
