// Upstream: apis/sql_test.go (TestSQLRun)
//
// The AfterTestFunc checks read the server's data.db after the response
// (app.HasTable, app.DB().NewQuery(...).Row).

import { Database } from "bun:sqlite";
import { join } from "node:path";

import { superuserToken } from "@test/scenarios/record-crud";
import type { AfterContext, Suite } from "@test/scenarios/scenario";

// users, test2@example.com
const users2Token =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6Im9hcDY0MGNvdDR5cnUycyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.GfJo6EHIobgas_AXt-M-tj5IoQendPnrkMSe9ExuSEY";

function query<T>(dataDir: string, sql: string): T {
  const db = new Database(join(dataDir, "data.db"), { readonly: true });
  try {
    return db.query(sql).get() as T;
  } finally {
    db.close();
  }
}

function hasTable(dataDir: string, name: string): boolean {
  return (
    query<{ n: number }>(
      dataDir,
      `SELECT count(*) AS n FROM sqlite_schema WHERE type IN ('table', 'view') AND name = '${name}'`,
    ).n > 0
  );
}

export const sqlRun: Suite = {
  file: "apis/sql_test.go",
  func: "TestSQLRun",
  scenarios: [
    {
      name: "guest",
      method: "POST",
      url: "/api/sql",
      body: `{"query":"select 1"}`,
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "regular user",
      method: "POST",
      url: "/api/sql",
      body: `{"query":"select 1"}`,
      headers: { Authorization: users2Token },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "superuser",
      method: "POST",
      url: "/api/sql",
      body: `{"query":"select 1"}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [
        `"execTime":`,
        `"affectedRows":0`,
        `"columns":[{"name":"1","type":"","nullable":true}]`,
        `"rows":[["1"]]`,
      ],
    },
    {
      name: "empty query",
      method: "POST",
      url: "/api/sql",
      body: `{"query":""}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"query":{`],
    },
    {
      name: "invalid query",
      method: "POST",
      url: "/api/sql",
      body: `{"query":"invalid"}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{}`, `Raw error:`, `SQL logic error`],
    },
    {
      name: "query with length above the limit",
      method: "POST",
      url: "/api/sql",
      body: `{"query":"${"a".repeat(5001)}"}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"query":{`],
    },
    {
      name: "query with length equal to the limit",
      method: "POST",
      url: "/api/sql",
      body: `{"query":"select '${"a".repeat(4985)}' as id"}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [
        `"execTime":`,
        `"affectedRows":0`,
        `"columns":[{"name":"id","type":"","nullable":true}]`,
        `"rows":[["aaa`,
      ],
    },
    {
      name: "single write query",
      method: "POST",
      url: "/api/sql",
      body: `{"query":"create table test_sql_table(id int primary key)"}`,
      headers: { Authorization: superuserToken },
      after: ({ dataDir }: AfterContext) => {
        if (!hasTable(dataDir, "test_sql_table")) {
          throw new Error(`Missing expected new "test_sql_table" table`);
        }
      },
      expectedStatus: 200,
      expectedContent: [`"execTime":`, `"affectedRows":0`, `"columns":[]`, `"rows":[]`],
    },
    {
      name: "multiple write queries",
      method: "POST",
      url: "/api/sql",
      body: `{"query":"create table test_sql_table(id int primary key);insert into test_sql_table(id)VALUES(1)"}`,
      headers: { Authorization: superuserToken },
      after: ({ dataDir }: AfterContext) => {
        const { total } = query<{ total: number }>(
          dataDir,
          "select count(*) AS total from test_sql_table",
        );
        if (total !== 1) {
          throw new Error(`Expected exactly 1 row, found: ${total}`);
        }
      },
      expectedStatus: 200,
      expectedContent: [`"execTime":`, `"affectedRows":1`, `"columns":[]`, `"rows":[]`],
    },
    {
      name: "multiple write queries (transaction rollback)",
      method: "POST",
      url: "/api/sql",
      body: `{"query":"create table test_sql_table(id int primary key);insert into test_sql_table(id)VALUES(1);invalid"}`,
      headers: { Authorization: superuserToken },
      after: ({ dataDir }: AfterContext) => {
        if (hasTable(dataDir, "test_sql_table")) {
          throw new Error(`Expected table "test_sql_table" to not be created`);
        }
      },
      expectedStatus: 400,
      expectedContent: [`"data":{}`, `Raw error:`, `SQL logic error`],
    },
    {
      name: "multiple read queries",
      method: "POST",
      url: "/api/sql",
      body: `{"query":"select 1;select 2"}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [
        `"execTime":`,
        `"affectedRows":0`,
        // only the result of the last query should be returned
        `"columns":[{"name":"2","type":"","nullable":true}]`,
        `"rows":[["2"]]`,
      ],
    },
  ],
};
