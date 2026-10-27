// SQL texts with several statements run as upstream runs them through Go's
// SQLite driver (src/db/dbx/driver.ts): the rows come from the last
// statement and the affected-row count is the last statement's. The same
// queries go to the reference binary's superuser SQL API (apis/sql.go) and,
// on a second fixture copy, through the db layer the way apis/sql.go's
// executeQuery uses it. Not part of `bun test`: run `bun run test:reference`.

import { afterAll, beforeAll, expect, test } from "bun:test";

import { Databases } from "@/db/base";
import { runInTransaction } from "@/db/tx";
import {
  copyFixture,
  serveUpstream,
  superuserToken,
  type FixtureCopy,
  type UpstreamServer,
} from "@test/differential/db/fixture";

interface SQLResult {
  affectedRows: number;
  columns: string[];
  rows: unknown[][];
}

const writePrefixes = [
  "INSERT",
  "CREATE",
  "UPDATE",
  "DELETE",
  "DROP",
  "DETACH",
  "ALTER",
  "REPLACE",
];

// apis/sql.go executeQuery: write queries run in a transaction and report
// the affected rows, the others return the columns and rows (as text)
function igloSQL(app: Databases, query: string): SQLResult {
  query = query.trim();
  const uc = query.toUpperCase();
  const result: SQLResult = { affectedRows: 0, columns: [], rows: [] };
  if (!uc.startsWith("SELECT") && writePrefixes.some((prefix) => uc.startsWith(prefix))) {
    runInTransaction(app, (txApp) => {
      result.affectedRows = txApp.nonconcurrentDB().newQuery(query).execute().rowsAffected;
    });
    return result;
  }
  const rows = app.concurrentDB().newQuery(query).rows();
  result.columns = rows.columns();
  for (const values of rows) {
    result.rows.push(values.map((v) => (v === null ? null : String(v))));
  }
  return result;
}

async function upstreamSQL(server: UpstreamServer, query: string): Promise<SQLResult> {
  const res = await fetch(`${server.url}/api/sql`, {
    method: "POST",
    headers: { Authorization: superuserToken, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as {
    affectedRows: number;
    columns: { name: string }[];
    rows: unknown[][];
  };
  if (res.status !== 200) {
    throw new Error(`POST /api/sql ${query}: ${res.status} ${JSON.stringify(body)}`);
  }
  return {
    affectedRows: body.affectedRows,
    columns: body.columns.map((c) => c.name),
    rows: body.rows,
  };
}

const queries = [
  "CREATE TABLE script_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT); INSERT INTO script_probe (v) VALUES ('a'), ('b')",
  "SELECT 1 AS a; SELECT 2 AS b",
  "PRAGMA cache_size(-12345); PRAGMA cache_size",
  "UPDATE script_probe SET v='c'; DELETE FROM script_probe WHERE 0",
  "INSERT INTO script_probe (v) VALUES ('d'); INSERT INTO script_probe (v) VALUES ('e')",
  "UPDATE script_probe SET v='f'; CREATE TABLE script_probe2 (a)",
  "SELECT 1 AS a; SELECT 2 AS b WHERE 0",
  "SELECT 1 AS a; -- trailing comment",
  "SELECT 'x;y' AS a, \"v\" FROM script_probe ORDER BY id",
  "CREATE TRIGGER script_probe_t AFTER INSERT ON script_probe BEGIN UPDATE script_probe SET v = 'g' WHERE id = new.id; END; INSERT INTO script_probe (v) VALUES ('h')",
  "SELECT id, v FROM script_probe ORDER BY id",
];

let upstreamCopy: FixtureCopy;
let igloCopy: FixtureCopy;
const upstream: SQLResult[] = [];
const iglo: SQLResult[] = [];

beforeAll(async () => {
  upstreamCopy = copyFixture();
  igloCopy = copyFixture();

  const server = await serveUpstream(upstreamCopy);
  try {
    for (const query of queries) {
      upstream.push(await upstreamSQL(server, query));
    }
  } finally {
    await server.stop();
  }

  const app = Databases.open({ dataDir: igloCopy.dataDir });
  try {
    for (const query of queries) {
      iglo.push(igloSQL(app, query));
    }
  } finally {
    app.close();
  }
}, 60_000);

afterAll(() => {
  upstreamCopy?.remove();
  igloCopy?.remove();
});

test.each(queries.map((query, i) => [query, i] as const))("%s", (_query, i) => {
  expect(iglo[i]).toEqual(upstream[i]!);
});

test("the reference results are the last statement's", () => {
  expect(upstream[1]).toEqual({ affectedRows: 0, columns: ["b"], rows: [["2"]] });
  expect(upstream[2]).toEqual({ affectedRows: 0, columns: ["cache_size"], rows: [["-12345"]] });
  expect(upstream[3]!.affectedRows).toBe(0);
  expect(upstream[4]!.affectedRows).toBe(1);
});
