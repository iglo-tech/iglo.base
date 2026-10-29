// Upstream: core/migrations_runner.go (DefaultMigrationsTable,
// initMigrationsTable, isMigrationApplied, saveAppliedMigration,
// saveRevertedMigration)
//
// Only the parts the system migrations check uses. Up, Down, history-sync
// and the interactive Run belong to the `migrate` command and the user
// JavaScript migrations (M3.7), which extend this file.
//
// `applied` is time.Now().UnixMicro(): microseconds from the app clock.

import type { Clock } from "@/app/clock";
import type { Databases } from "@/db/base";
import { HashExp } from "@/db/dbx/expression";
import { hasTable } from "@/db/table";

export const DefaultMigrationsTable = "_migrations";

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
// migrations table does not exist (read only: the table is not created)
export function appliedMigrationFiles(app: Databases): string[] {
  if (!hasTable(app, DefaultMigrationsTable)) {
    return [];
  }
  return app
    .db()
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
