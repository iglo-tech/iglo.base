// P.3: a pb_data of realistic size for start-up measurements: a superuser, 20
// collections (base and auth; text, number, bool, select, date, json, editor,
// file and relation fields, indexes and rules) and about 10,000 records with
// relation ids and file names. Not shipped; needs `bun run upstream:prepare`.
// The collections are made through upstream's API (so the schema is exactly
// what PocketBase writes); the records are then inserted with bun:sqlite,
// because only the stored shape matters for start-up. Report:
// docs/perf/P.3-second-pass.md.
//
//   bun test/perf/compare/startup-db.ts <empty dir>/pb_data

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

import {
  apiClient,
  repoRoot,
  startUpstreamServer,
  upsertSuperuser,
} from "@/../scripts/spikes/M0.8/common";

const dataDir = process.argv[2];
if (!dataDir) {
  throw new Error("usage: startup-db.ts <dir>/pb_data");
}
mkdirSync(dataDir, { recursive: true });
await upsertSuperuser(dataDir, repoRoot, "bench@example.com", "1234567890");
const server = await startUpstreamServer(dataDir, repoRoot);
const names: string[] = [];
const ids: Record<string, string> = {};
try {
  const api = apiClient(server.url);
  await api.loginSuperuser("bench@example.com", "1234567890");
  for (let i = 0; i < 20; i++) {
    const name = `coll${i}`;
    const fields: Record<string, unknown>[] = [
      { name: "title", type: "text", required: true, max: 200 },
      { name: "body", type: "editor" },
      { name: "views", type: "number" },
      { name: "active", type: "bool" },
      { name: "kind", type: "select", values: ["a", "b", "c"], maxSelect: 1 },
      { name: "meta", type: "json" },
      { name: "due", type: "date" },
      { name: "files", type: "file", maxSelect: 5, maxSize: 5242880 },
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ];
    if (i > 0) {
      fields.push({
        name: "parent",
        type: "relation",
        collectionId: ids[names[i - 1]!],
        maxSelect: 1,
      });
      fields.push({ name: "refs", type: "relation", collectionId: ids[names[0]!], maxSelect: 10 });
    }
    const col = (await api.must("POST", "/api/collections", {
      name,
      type: i % 5 === 0 ? "auth" : "base",
      listRule: i % 2 ? "" : "@request.auth.id != ''",
      viewRule: "",
      createRule: i % 3 ? null : "",
      fields,
      indexes: [
        `CREATE INDEX idx_${name}_views ON ${name} (views)`,
        `CREATE INDEX idx_${name}_kind ON ${name} (kind, active)`,
      ],
    })) as { id: string };
    names.push(name);
    ids[name] = col.id;
  }
} finally {
  await server.stop();
}

const db = new Database(`${dataDir}/data.db`);
db.run("PRAGMA journal_mode = WAL");
const now = "2026-11-01 12:00:00.000Z";
let total = 0;
db.transaction(() => {
  for (let i = 0; i < 20; i++) {
    const name = names[i]!;
    const cols = (
      db.query(`PRAGMA table_info(${name})`).all() as { name: string; type: string }[]
    ).map((c) => c.name);
    const ph = cols.map(() => "?").join(",");
    const stmt = db.prepare(
      `INSERT INTO ${name} (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${ph})`,
    );
    const n = i === 0 ? 1000 : 500; // 1000 + 19 * 500 = 10,500
    for (let r = 0; r < n; r++) {
      const row: Record<string, unknown> = {
        id: `r${String(i).padStart(2, "0")}${String(r).padStart(12, "0")}`,
        title: `Record ${i}/${r}`,
        body: `<p>Body ${r}</p>`.repeat(3),
        views: r * 3,
        active: r % 2,
        kind: "abc"[r % 3],
        meta: JSON.stringify({ n: r, tags: ["x", "y"] }),
        due: now,
        files: JSON.stringify([`file_${r}_a1b2c3d4e5.png`, `doc_${r}_f6g7h8i9j0.pdf`]),
        created: now,
        updated: now,
        parent:
          i > 0 ? `r${String(i - 1).padStart(2, "0")}${String(r % 500).padStart(12, "0")}` : "",
        refs: i > 0 ? JSON.stringify([`r00${String(r % 1000).padStart(12, "0")}`]) : "[]",
        email: `u${i}_${r}@example.com`,
        tokenKey: `${i}-${r}-${"k".repeat(40)}`,
        password: "$2a$10$" + "x".repeat(53),
        emailVisibility: 0,
        verified: 0,
      };
      stmt.run(...cols.map((c) => (row[c] ?? "") as string));
      total++;
    }
  }
})();
db.run("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();
console.error(`records: ${total}`);
