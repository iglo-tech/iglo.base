// M0.6 spike (D8): generates a pb_data directory whose data.db has a
// records-like "posts" table with 1,000,000 rows: a 15-character text id,
// indexed created/status/author columns and unindexed title/score/body
// columns, as a PocketBase base collection stores them. Not shipped.
//
//   bun test/perf/read-path/gen.ts <dir> [rows]

import { existsSync, mkdirSync } from "node:fs";

import { Databases } from "@/db/base";
import type { DB } from "@/db/dbx/db";

const dir = process.argv[2];
const total = Number(process.argv[3] ?? 1_000_000);
if (dir === undefined) {
  throw new Error("usage: gen.ts <dir> [rows]");
}
if (existsSync(`${dir}/data.db`)) {
  throw new Error(`${dir}/data.db exists`);
}
mkdirSync(dir, { recursive: true });

const app = Databases.open({ dataDir: dir });
const conn = (app.nonconcurrentDB() as DB).conn();
conn.run(`CREATE TABLE \`posts\` (
  \`id\` TEXT PRIMARY KEY DEFAULT ('r'||lower(hex(randomblob(7)))) NOT NULL,
  \`created\` TEXT DEFAULT '' NOT NULL,
  \`updated\` TEXT DEFAULT '' NOT NULL,
  \`title\` TEXT DEFAULT '' NOT NULL,
  \`status\` TEXT DEFAULT '' NOT NULL,
  \`author\` TEXT DEFAULT '' NOT NULL,
  \`score\` NUMERIC DEFAULT 0 NOT NULL,
  \`body\` TEXT DEFAULT '' NOT NULL
)`);

// a deterministic generator, so every run creates the same data
let seed = 42;
// mulberry32
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
const words =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua".split(
    " ",
  );
const statuses = ["draft", "review", "published", "archived", "deleted"];

const ins = conn.prepare(
  "INSERT INTO posts (id, created, updated, title, status, author, score, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
);
const start = Date.UTC(2024, 0, 1);
const batch = 50_000;
for (let done = 0; done < total; done += batch) {
  conn.transaction(() => {
    for (let i = done; i < Math.min(total, done + batch); i++) {
      let id = "";
      for (let j = 0; j < 15; j++) id += alphabet[Math.floor(rand() * alphabet.length)];
      const created = new Date(start + i * 30_000).toISOString().replace("T", " ");
      let body = "";
      while (body.length < 200) body += words[Math.floor(rand() * words.length)] + " ";
      ins.run(
        id,
        created,
        created,
        `Post ${i}`,
        statuses[Math.floor(rand() * statuses.length)]!,
        `author${Math.floor(rand() * 1000)}`,
        Math.floor(rand() * 10_000) / 100,
        body,
      );
    }
  })();
}
ins.finalize();
conn.run("CREATE INDEX `idx_posts_created` ON `posts` (`created`)");
conn.run("CREATE INDEX `idx_posts_status` ON `posts` (`status`)");
conn.run("CREATE INDEX `idx_posts_author` ON `posts` (`author`)");
// what a pb_data that served queries has (upstream's tests/data does too)
conn.run("ANALYZE");
conn.run("PRAGMA wal_checkpoint(TRUNCATE)");
app.close();
console.log(`${total} rows in ${dir}/data.db`);
