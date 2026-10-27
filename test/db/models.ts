// Models for the core db tests: one saved through the dbx model query
// (declared columns) and one through DBExporter, as upstream's Param and
// Record models are.

import type { Params, Row } from "@/db/dbx/query";
import type { DBExporter } from "@/db/db";
import { BaseModel } from "@/db/model";

export class Demo extends BaseModel {
  title = "";

  tableName(): string {
    return "demo";
  }

  override dbColumns(): Params {
    return { ...super.dbColumns(), title: this.title };
  }

  override dbScan(row: Row): void {
    super.dbScan(row);
    if ("title" in row) this.title = String(row.title);
  }
}

export class ExportedDemo extends Demo implements DBExporter {
  // the data saved instead of dbColumns()
  exported: Params | null = null;

  dbExport(): Params {
    return this.exported ?? { title: this.title };
  }
}

export class Log extends BaseModel {
  message = "";

  tableName(): string {
    return "logs";
  }

  override dbColumns(): Params {
    return { ...super.dbColumns(), message: this.message };
  }

  override dbScan(row: Row): void {
    super.dbScan(row);
    if ("message" in row) this.message = String(row.message);
  }
}
