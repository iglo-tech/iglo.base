// Upstream: apis/logs_test.go
//
// tests.StubLogsData writes into the running app; here the rows are written
// before the server starts. A start clears logs past the settings' maxDays,
// so the fixture copy keeps its logs for long enough to hold the 2022 rows.
//
// The tokens are upstream's fixture tokens (test/fixtures/pocketbase,
// expiring in 2050): test data, not credentials.

import { Database } from "bun:sqlite";
import { join } from "node:path";

import type { AfterContext, PrepareContext, Scenario, Suite } from "@test/scenarios/scenario";

const userToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.ZT3F0Z3iM-xbGgSG3LEKiEzHrPHr8t8IuHLZGGNuxLo";
const superuserToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoicGJjXzMxNDI2MzU4MjMiLCJleHAiOjI1MjQ2MDQ0NjEsInJlZnJlc2hhYmxlIjp0cnVlfQ.UXgO3j-0BumcugrFjbd7j0M4MQvbrLggLlcu_YNGjoY";

const asUser = { Authorization: userToken };
const asSuperuser = { Authorization: superuserToken };

export function setLogsSettings(dataDir: string, logs: Record<string, unknown>): void {
  const db = new Database(join(dataDir, "data.db"));
  try {
    const row = db.query("SELECT value FROM _params WHERE id = 'settings'").get() as {
      value: string | Uint8Array;
    };
    const isBlob = row.value instanceof Uint8Array;
    const text = isBlob ? new TextDecoder().decode(row.value as Uint8Array) : (row.value as string);
    const settings = JSON.parse(text) as { logs: Record<string, unknown> };
    Object.assign(settings.logs, logs);
    const updated = JSON.stringify(settings);
    db.query("UPDATE _params SET value = ? WHERE id = 'settings'").run(
      isBlob ? new TextEncoder().encode(updated) : updated,
    );
  } finally {
    db.close();
  }
}

// tests.StubLogsData
export function stubLogsData(dataDir: string): void {
  setLogsSettings(dataDir, { maxDays: 100_000 });

  const db = new Database(join(dataDir, "auxiliary.db"));
  try {
    db.run(`
      delete from _logs;

      insert into _logs (id, level, message, data, created)
      values
      (
        '873f2133-9f38-44fb-bf82-c8f53b310d91',
        0,
        'test_message1',
        '{"status":200}',
        '2022-05-01 10:00:00.123Z'
      ),
      (
        'f2133873-44fb-9f38-bf82-c918f53b310d',
        8,
        'test_message2',
        '{"status":400}',
        '2022-05-02 10:00:00.123Z'
      );
    `);
  } finally {
    db.close();
  }
}

function prepare({ dataDir }: PrepareContext): void {
  stubLogsData(dataDir);
}

async function expectNoLogs({ url }: AfterContext): Promise<void> {
  const res = await fetch(`${url}/api/logs`, { headers: asSuperuser });
  const body = (await res.json()) as { totalItems: number };
  if (body.totalItems !== 0) {
    throw new Error(`expected all logs to be deleted, found ${body.totalItems}`);
  }
}

function guarded(method: string, url: string): Scenario[] {
  return [
    {
      name: "unauthorized",
      method,
      url,
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method,
      url,
      headers: asUser,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
  ];
}

export const logsList: Suite = {
  file: "apis/logs_test.go",
  func: "TestLogsList",
  scenarios: [
    ...guarded("GET", "/api/logs"),
    {
      name: "authorized as superuser",
      method: "GET",
      url: "/api/logs",
      headers: asSuperuser,
      prepare,
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalItems":2`,
        `"items":[{`,
        `"id":"873f2133-9f38-44fb-bf82-c8f53b310d91"`,
        `"id":"f2133873-44fb-9f38-bf82-c918f53b310d"`,
      ],
    },
    {
      name: "authorized as superuser + filter",
      method: "GET",
      url: "/api/logs?filter=data.status>200",
      headers: asSuperuser,
      prepare,
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalItems":1`,
        `"items":[{`,
        `"id":"f2133873-44fb-9f38-bf82-c918f53b310d"`,
      ],
    },
  ],
};

export const logView: Suite = {
  file: "apis/logs_test.go",
  func: "TestLogView",
  scenarios: [
    ...guarded("GET", "/api/logs/873f2133-9f38-44fb-bf82-c8f53b310d91"),
    {
      name: "authorized as superuser (nonexisting request log)",
      method: "GET",
      url: "/api/logs/missing1-9f38-44fb-bf82-c8f53b310d91",
      headers: asSuperuser,
      prepare,
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser (existing request log)",
      method: "GET",
      url: "/api/logs/873f2133-9f38-44fb-bf82-c8f53b310d91",
      headers: asSuperuser,
      prepare,
      expectedStatus: 200,
      expectedContent: [`"id":"873f2133-9f38-44fb-bf82-c8f53b310d91"`],
    },
  ],
};

export const logsStats: Suite = {
  file: "apis/logs_test.go",
  func: "TestLogsStats",
  scenarios: [
    ...guarded("GET", "/api/logs/stats"),
    {
      name: "authorized as superuser",
      method: "GET",
      url: "/api/logs/stats",
      headers: asSuperuser,
      prepare,
      expectedStatus: 200,
      expectedContent: [
        `[{"date":"2022-05-01 10:00:00.000Z","total":1},{"date":"2022-05-02 10:00:00.000Z","total":1}]`,
      ],
    },
    {
      name: "authorized as superuser + filter",
      method: "GET",
      url: "/api/logs/stats?filter=data.status>200",
      headers: asSuperuser,
      prepare,
      expectedStatus: 200,
      expectedContent: [`[{"date":"2022-05-02 10:00:00.000Z","total":1}]`],
    },
  ],
};

export const logsTruncate: Suite = {
  file: "apis/logs_test.go",
  func: "TestLogsTruncate",
  scenarios: [
    ...guarded("DELETE", "/api/logs"),
    {
      name: "authorized as superuser",
      method: "DELETE",
      url: "/api/logs",
      headers: asSuperuser,
      prepare,
      after: expectNoLogs,
      expectedStatus: 204,
    },
  ],
};
