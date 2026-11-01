// What a restored pb_data must read back: the tables of both databases and
// the hashes of the storage files.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function tableRows(path: string): Record<string, unknown[]> {
  const db = new Database(path, { readonly: true });
  try {
    const result: Record<string, unknown[]> = {
      sqlite_schema: db
        .query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name")
        .all(),
    };
    const tables = db
      .query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      result[name] = db.query(`SELECT * FROM "${name}" ORDER BY 1`).all();
    }
    return result;
  } finally {
    db.close();
  }
}

function fileHashes(dir: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const path = join(dir, entry);
    if (statSync(path).isFile()) {
      hashes[relative(dir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  return hashes;
}

export function snapshot(dataDir: string): {
  data: Record<string, unknown[]>;
  logs: unknown[];
  storage: Record<string, string>;
} {
  return {
    data: tableRows(join(dataDir, "data.db")),
    logs: tableRows(join(dataDir, "auxiliary.db"))["_logs"] ?? [],
    storage: fileHashes(join(dataDir, "storage")),
  };
}
