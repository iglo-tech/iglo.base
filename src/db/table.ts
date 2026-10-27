// Upstream: core/db_table.go, and DeleteView from core/view.go

import type { Databases } from "@/db/base";
import type { Builder } from "@/db/dbx/builder";
import { HashExp, newExp } from "@/db/dbx/expression";

// TableColumns returns all column names of a single table by its name.
export function tableColumns(app: Databases, tableName: string): string[] {
  return app
    .concurrentDB()
    .newQuery("SELECT name FROM PRAGMA_TABLE_INFO({:tableName})")
    .bind({ tableName })
    .column<string>();
}

export interface TableInfoRow {
  pk: number;
  index: number;
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
}

// TableInfo returns the "table_info" pragma result for the specified table.
export function tableInfo(app: Databases, tableName: string): TableInfoRow[] {
  const rows = app
    .concurrentDB()
    .newQuery("SELECT * FROM PRAGMA_TABLE_INFO({:tableName})")
    .bind({ tableName })
    .all<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>();

  // mattn/go-sqlite3 doesn't throw an error on invalid or missing table
  // so we additionally have to check whether the loaded info result is nonempty
  if (rows.length === 0) {
    throw new Error(`empty table info probably due to invalid or missing table ${tableName}`);
  }

  return rows.map((row) => ({
    pk: row.pk,
    index: row.cid,
    name: row.name,
    type: row.type,
    notNull: row.notnull !== 0,
    defaultValue: row.dflt_value,
  }));
}

// TableIndexes returns a name grouped map with all non empty index of the specified table.
//
// Note: This method doesn't return an error on nonexisting table.
export function tableIndexes(app: Databases, tableName: string): Record<string, string> {
  const indexes = app
    .concurrentDB()
    .select("name", "sql")
    .from("sqlite_master")
    .andWhere(newExp("sql is not null"))
    .andWhere(
      new HashExp({
        type: "index",
        tbl_name: tableName,
      }),
    )
    .all<{ name: string; sql: string }>();

  const result: Record<string, string> = {};

  for (const idx of indexes) {
    result[idx.name] = idx.sql;
  }

  return result;
}

// DeleteTable drops the specified table.
//
// This method is a no-op if a table with the provided name doesn't exist.
//
// NB! Be aware that this method is vulnerable to SQL injection and the
// "dangerousTableName" argument must come only from trusted input!
export function deleteTable(app: Databases, dangerousTableName: string): void {
  app.nonconcurrentDB().newQuery(`DROP TABLE IF EXISTS {{${dangerousTableName}}}`).execute();
}

// DeleteView drops the specified view name.
//
// This method is a no-op if a view with the provided name doesn't exist.
//
// NB! Be aware that this method is vulnerable to SQL injection and the
// "dangerousViewName" argument must come only from trusted input!
export function deleteView(app: Databases, dangerousViewName: string): void {
  app.db().newQuery(`DROP VIEW IF EXISTS {{${dangerousViewName}}}`).execute();
}

// HasTable checks if a table (or view) with the provided name exists (case insensitive).
// in the data.db.
export function hasTable(app: Databases, tableName: string): boolean {
  return hasTableIn(app.concurrentDB(), tableName);
}

// AuxHasTable checks if a table (or view) with the provided name exists (case insensitive)
// in the auixiliary.db.
export function auxHasTable(app: Databases, tableName: string): boolean {
  return hasTableIn(app.auxConcurrentDB(), tableName);
}

function hasTableIn(db: Builder, tableName: string): boolean {
  try {
    const [exists] = db
      .select("(1)")
      .from("sqlite_schema")
      .andWhere(new HashExp({ type: ["table", "view"] }))
      .andWhere(newExp("LOWER([[name]])=LOWER({:tableName})", { tableName }))
      .limit(1)
      .row();
    return typeof exists === "number" && exists > 0;
  } catch {
    return false;
  }
}

// Vacuum executes VACUUM on the data.db in order to reclaim unused data db disk space.
export function vacuum(app: Databases): void {
  vacuumDB(app.nonconcurrentDB());
}

// AuxVacuum executes VACUUM on the auxiliary.db in order to reclaim unused auxiliary db disk space.
export function auxVacuum(app: Databases): void {
  vacuumDB(app.auxNonconcurrentDB());
}

function vacuumDB(db: Builder): void {
  db.newQuery("VACUUM").execute();
}
