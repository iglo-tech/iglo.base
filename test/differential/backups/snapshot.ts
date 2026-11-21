// What a restored pb_data must read back: the tables of both databases and
// the hashes of the storage files.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function tableRows(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    // oxlint-disable-next-line quality/no-known-value-widening -- one entry per table is added in a loop after this literal, under names known only at runtime; a literal type rejects those assignments and a typed builder would change the statements
    const result: Record<string, Array<unknown>> = {
      sqlite_schema: db
        .query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name")
        .all(),
    };
    const tables = db
      .query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    for (const { name } of tables) {
      result[name] = db.query(`SELECT * FROM "${name}" ORDER BY 1`).all();
    }
    return result;
  } finally {
    db.close();
  }
}

function fileHashes(dir: string) {
  const hashes: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const path = join(dir, entry);
    if (statSync(path).isFile()) {
      hashes[relative(dir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  return hashes;
}

export function snapshot(dataDir: string) {
  return {
    data: tableRows(join(dataDir, "data.db")),
    logs: tableRows(join(dataDir, "auxiliary.db"))["_logs"] ?? [],
    storage: fileHashes(join(dataDir, "storage")),
  };
}
