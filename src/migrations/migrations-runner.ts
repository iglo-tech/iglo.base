// Upstream: core/migrations_runner.go and core/migrations_list.go
//
// up, down and removeMissingAppliedMigrations run a list of migrations;
// the interactive Run is the `migrate` command (src/cli/migrate.ts).
//
// The system migrations are in such a list by file name only: they are not
// run here (src/migrations/system-migrations.ts checks them on open, and
// every one is recorded by then). See SystemMigrationDown for how `down`
// treats them.
//
// `applied` is time.Now().UnixMicro(): microseconds from the app clock.

import type { App } from "@/app/app";
import type { Clock } from "@/app/clock";
import { wrapError } from "@/collections/view";
import type { Databases } from "@/db/base";
import type { Builder } from "@/db/dbx/builder";
import { HashExp, newExp, not } from "@/db/dbx/expression";
import { isNoRowsError } from "@/db/dbx/rows";
import { auxRunInTransaction, runInTransaction } from "@/db/tx";

export const DefaultMigrationsTable = "_migrations";

export type MigrationFunc = (txApp: App) => void;

// What `down` does with a system migration, which is never run here.
//   - "keep": upstream's has no down: it removes the row and the next open
//     applies the migration again, which here leaves the data as it is, so
//     the row stays;
//   - "refuse": upstream's has a down that changes the system schema or
//     data, which iglo.base does not port (a listed deliberate difference).
export type SystemMigrationDown = "keep" | "refuse";

export interface Migration {
  file: string;
  up: MigrationFunc | null;
  down: MigrationFunc | null;
  system?: SystemMigrationDown;
}

// MigrationsList.Register: the list stays sorted by file name, byte-wise
// and stable.
export function addMigration(list: Migration[], m: Migration): void {
  list.push(m);
  list.sort((a, b) => Buffer.compare(Buffer.from(a.file), Buffer.from(b.file)));
}

function txAppOf(app: App, txDatabases: Databases): App {
  return txDatabases === app.databases ? app : { ...app, databases: txDatabases };
}

// Up executes all unapplied migrations of the list, in one transaction on
// data.db inside one on auxiliary.db. It returns the applied file names.
export function up(app: App, list: readonly Migration[]): string[] {
  initMigrationsTable(app.databases);

  const applied: string[] = [];

  auxRunInTransaction(app.databases, (auxTxDatabases) => {
    runInTransaction(auxTxDatabases, (txDatabases) => {
      const txApp = txAppOf(app, txDatabases);

      for (const m of list) {
        // applied migrations check
        if (isMigrationApplied(txDatabases, m.file)) {
          continue; // no need to reapply
        }

        // ignore empty Up action
        if (m.up !== null) {
          try {
            m.up(txApp);
          } catch (err) {
            throw wrapError(`failed to apply migration ${m.file}`, err);
          }
        }

        try {
          saveAppliedMigration(txDatabases, app.clock, m.file);
        } catch (err) {
          throw wrapError(`failed to save applied migration info for ${m.file}`, err);
        }

        applied.push(m.file);
      }
    });
  });

  return applied;
}

// Down reverts the last toRevertCount applied migrations (in the order they
// were applied). It returns the reverted file names.
export function down(app: App, list: readonly Migration[], toRevertCount: number): string[] {
  initMigrationsTable(app.databases);

  const reverted: string[] = [];

  const names = lastAppliedMigrations(app.databases, list, toRevertCount);

  for (const m of list) {
    if (m.system === "refuse" && names.includes(m.file)) {
      throw new Error(
        `failed to revert migration ${m.file}: iglo.base does not revert system migrations that change the schema`,
      );
    }
  }

  auxRunInTransaction(app.databases, (auxTxDatabases) => {
    runInTransaction(auxTxDatabases, (txDatabases) => {
      const txApp = txAppOf(app, txDatabases);

      for (const name of names) {
        for (const m of list) {
          if (m.file !== name) {
            continue;
          }

          // revert limit reached
          if (toRevertCount - reverted.length <= 0) {
            return;
          }

          // ignore empty Down action
          if (m.down !== null) {
            try {
              m.down(txApp);
            } catch (err) {
              throw wrapError(`failed to revert migration ${m.file}`, err);
            }
          }

          if (m.system === undefined) {
            try {
              saveRevertedMigration(txDatabases, m.file);
            } catch (err) {
              throw wrapError(`failed to save reverted migration info for ${m.file}`, err);
            }
          }

          reverted.push(m.file);
        }
      }
    });
  });

  return reverted;
}

// RemoveMissingAppliedMigrations removes the db entries of all applied
// migrations that are not listed in the list.
export function removeMissingAppliedMigrations(app: Databases, list: readonly Migration[]): void {
  const names = list.map((m) => m.file);

  app
    .db()
    .delete(DefaultMigrationsTable, not(new HashExp({ file: names })))
    .execute();
}

export function lastAppliedMigrations(
  app: Databases,
  list: readonly Migration[],
  limit: number,
): string[] {
  const names = list.map((m) => m.file);

  return (
    app
      .db()
      .select("file")
      .from(DefaultMigrationsTable)
      .where(not(new HashExp({ applied: null })))
      .andWhere(new HashExp({ file: names }))
      // unify microseconds and seconds applied time for backward compatibility
      .orderBy("substr(applied||'0000000000000000', 0, 17) DESC")
      .andOrderBy("file DESC")
      .limit(limit)
      .column<unknown>()
      .map(String)
  );
}

// initMigrationsTable creates the migrations table, if it does not exist.
export function initMigrationsTable(app: Databases): void {
  app
    .db()
    .newQuery(
      `CREATE TABLE IF NOT EXISTS {{${DefaultMigrationsTable}}} (file VARCHAR(255) PRIMARY KEY NOT NULL, applied INTEGER NOT NULL)`,
    )
    .execute();
}

// the recorded migration file names, in rowid order; none when the
// migrations table does not exist (read only: the table is not created).
// It takes a builder so the read-only open check can use it too.
export function appliedMigrationFiles(db: Builder): string[] {
  if (!builderHasTable(db, DefaultMigrationsTable)) {
    return [];
  }
  return db
    .select("file")
    .from(DefaultMigrationsTable)
    .orderBy("rowid ASC")
    .column<unknown>()
    .map(String);
}

export function isMigrationApplied(txApp: Databases, file: string): boolean {
  try {
    const row = txApp
      .db()
      .select("(1)")
      .from(DefaultMigrationsTable)
      .where(new HashExp({ file }))
      .limit(1)
      .row();
    return Number(row[0]) > 0;
  } catch {
    return false;
  }
}

export function saveAppliedMigration(txApp: Databases, clock: Clock, file: string): void {
  txApp
    .db()
    .insert(DefaultMigrationsTable, {
      file,
      applied: clock.now().getTime() * 1000,
    })
    .execute();
}

export function saveRevertedMigration(txApp: Databases, file: string): void {
  txApp.db().delete(DefaultMigrationsTable, new HashExp({ file })).execute();
}

// hasTable (core/db_table.go) on a builder: whether a table (or view)
// with the name exists, case insensitive. Unlike upstream, which reads
// any query error as "no table", only an empty result is false; other
// errors are thrown, so the open check never takes an unreadable data.db
// for a fresh one.
export function builderHasTable(db: Builder, tableName: string): boolean {
  try {
    const [exists] = db
      .select("(1)")
      .from("sqlite_schema")
      .andWhere(new HashExp({ type: ["table", "view"] }))
      .andWhere(newExp("LOWER([[name]])=LOWER({:tableName})", { tableName }))
      .limit(1)
      .row();
    return typeof exists === "number" && exists > 0;
  } catch (err) {
    if (isNoRowsError(err)) {
      return false;
    }
    throw err;
  }
}
