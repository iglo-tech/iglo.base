// Upstream: pocketbase/dbx v1.13.0 struct.go
//
// dbx maps Go structs to table columns with reflection and `db` struct tags.
// TypeScript has neither, so a model declares the same information itself:
// its table (TableModel), its persisted columns and their values
// (structValue.columns), its primary key columns (the `db:"pk"` tag, or the
// ID/Id field) and how a row populates it (Rows.ScanStruct). Column names
// are used everywhere dbx uses struct field names (Insert/Update attrs,
// Exclude).

import type { Params, Row } from "@/db/dbx/query";

// TableModel is the interface that should be implemented by models which have unconventional table names.
export interface TableModel {
  tableName(): string;
}

// PostScanner is an optional interface used by ScanStruct.
export interface PostScanner {
  // PostScan executes right after the struct has been populated
  // with the DB values, allowing you to further normalize or validate
  // the loaded data.
  postScan(): void;
}

export interface StructModel extends TableModel {
  // the persisted column values, keyed by column name
  dbColumns(): Params;
  // the primary key column names; defaults to ["id"] when dbColumns() has
  // an "id" column (dbx's ID/Id field fallback)
  dbPrimaryKey?(): string[];
  // populates the model from a row; a row may hold only some of the
  // columns (for example only the generated primary key after an insert)
  dbScan(row: Row): void;
}

export function isStructModel(value: unknown): value is StructModel {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<StructModel>).tableName === "function" &&
    typeof (value as Partial<StructModel>).dbColumns === "function" &&
    typeof (value as Partial<StructModel>).dbScan === "function"
  );
}

// pk returns the primary key column names of the model.
export function primaryKeyNames(model: StructModel): string[] {
  if (model.dbPrimaryKey) {
    return model.dbPrimaryKey();
  }
  return Object.hasOwn(model.dbColumns(), "id") ? ["id"] : [];
}

// pk returns the primary key values indexed by the corresponding primary key column names.
export function structPK(model: StructModel): Params | null {
  const names = primaryKeyNames(model);
  if (names.length === 0) {
    return null;
  }
  return structColumns(model, names, []);
}

// columns returns the model values indexed by their column names.
export function structColumns(model: StructModel, include: string[], exclude: string[]): Params {
  const all = model.dbColumns();
  let v: Params = {};
  if (include.length === 0) {
    v = { ...all };
  } else {
    for (const attr of include) {
      if (Object.hasOwn(all, attr)) {
        v[attr] = all[attr];
      }
    }
  }
  for (const name of exclude) {
    delete v[name];
  }
  return v;
}

// ScanStruct populates a model with a row and runs its PostScan.
export function scanStruct(model: StructModel, row: Row): void {
  model.dbScan(row);
  const ps = model as Partial<PostScanner>;
  if (typeof ps.postScan === "function") {
    ps.postScan();
  }
}
