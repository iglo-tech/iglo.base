// Upstream: apis/sql.go, with the Go SQLite driver's statement handling
// and value conversions (modernc.org/sqlite: several statements in one
// query, the declared column types, DATE/DATETIME/TIMESTAMP text parsed as
// times) and database/sql's Scan into *string. The queries run one after
// the other against upstream PocketBase v0.41.0 and the compiled iglo.base
// executable, each on its own fixture copy, so the writes of one query are
// seen by the next. Only execTime is not compared. Not part of `bun test`:
// run `bun run test:reference`.

import { afterAll, beforeAll, expect, test } from "bun:test";

import { startPair, type Pair } from "@test/differential/serve/pair";
import { superuserToken } from "@test/scenarios/record-crud";

let pair: Pair;

beforeAll(async () => {
  pair = await startPair();
}, 60_000);

afterAll(() => pair?.stop());

// a string is the query; an object is sent as the body as it is
const queries: (string | Record<string, unknown>)[] = [
  "select 1",
  "select 1.5, 1234567.0, 1e-7, 1e21, null, x'00ff41', 'a', 9007199254740993, -0.0, 1e300*1e300, 100000.0, 0.000001, x'e28241', '<a>&b', char(8232)",
  "select id, created, email, verified from users limit 2",
  "  sElect 1; select 2",
  "select 1; create table x(a)",
  "pragma table_info(_params)",
  "select name from sqlite_master where name='x'",
  "select 1; select * from nonexisting",
  "select * from nonexisting; select 1",
  "insert into x values(1); select * from x",
  "create table y(a); insert into y values(1),(2); update y set a=3",
  "delete from y",
  "update y set a=1 where 0",
  "  insert into y values (5)  ",
  "explain select 1",
  "values(1,2)",
  "drop table y",
  "select 'a' as x, 2 as x",
  "select 1 where 0",
  "select ''",
  "   ",
  "",
  "invalid",
  { query: 5 },
  { query: null },
  {},
  "create table test_sql_table(id int primary key);insert into test_sql_table(id)VALUES(1);invalid",
  "create table dt(a date, b timestamp, c time, d timestamptz, e DATETIME2, f datetime)",
  "insert into dt values('2024-01-02','2024-01-02 03:04','2024-01-02','2024-01-02','2024-01-02','2024-01-02 3:04:05')",
  "insert into dt(f) values('2024-01-02 03:04:05.120+02:00'),('2024-01-02T03:04:05.000-00:00'),('2024-01-02 03:04:05.1234567891'),('2024-02-30'),('2024-01-02 03:04:05 +0000 UTC'),('2024-01-02 03:04:05.5 +0100 CET m=+0.1'),('2024-01-02 24:00:00'),('2024-01-02T03:04Z'),(' 2024-01-02'),('2024-01-02 03:04:05,5'),('2024-1-02'),('2024-01-02 03:04:05+24:00'), (1700000000), (1.5), ('2024-01-02 03:04:05ZZ'),('2024-01-02 03:04:60'),('2024-02-29'),('2023-02-29'),('2024-01-02  03:04'),('2024-01-02 03:04:05 +0100 UTC'),('2024-01-02 03:04:05 +0100 WITA'),('2024-01-02 03:04:05 +0100 ABCDT'),('2024-01-02 03:04:05 +0100 AB')",
  "select * from dt",
  "select [[id]] from {{users}} limit 1",
  "select {:a}",
  "select ?",
  "vacuum",
  "select 1; vacuum",
  "with a as (select 1) insert into x select * from a",
  "select count(*) from x",
  "REPLACE into x values(3)",
  "detach foo",
  "alter table x add column b",
  "select * from x",
  "select 1 -- c",
  "-- c\nselect 1",
  "/* x */ select 2",
  "select 1;",
  "select 1;;",
  ";",
  "select abs(-9223372036854775808)",
  "select 1 union select 2",
  "select cast(1 as real)",
  "select 2.5e-5, 123456.789, 0.1+0.2",
];

async function run(base: string, q: string | Record<string, unknown>): Promise<string> {
  const res = await fetch(`${base}/api/sql`, {
    method: "POST",
    headers: { Authorization: superuserToken, "Content-Type": "application/json" },
    body: JSON.stringify(typeof q === "string" ? { query: q } : q),
  });
  const text = (await res.text()).replace(/"execTime":\d+/, `"execTime":0`);
  return `${res.status} ${res.headers.get("content-type")} ${text}`;
}

test("the same queries give the same responses", async () => {
  const differences: string[] = [];
  for (const q of queries) {
    const [up, ig] = await Promise.all([run(pair.upstream.url, q), run(pair.igloBase.url, q)]);
    if (up !== ig) {
      differences.push(`${JSON.stringify(q)}\n  upstream: ${up}\n  iglo.base: ${ig}`);
    }
  }
  expect(differences).toEqual([]);
}, 60_000);
