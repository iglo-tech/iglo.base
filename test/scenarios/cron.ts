// Upstream: apis/cron_test.go
//
// The scenarios that run against both servers. Upstream's binary cannot
// register a custom job, so "existing job" runs each built-in one, and the
// expired rows it deletes are read back over HTTP. The custom job and empty
// list scenarios are in test/apis/cron.test.ts.
//
// The tokens are upstream's fixture tokens (test/fixtures/pocketbase,
// expiring in 2050): test data, not credentials.

import { Database } from "bun:sqlite";
import { join } from "node:path";

import type { AfterContext, PrepareContext, Scenario, Suite } from "@test/scenarios/scenario";

const userToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.ZT3F0Z3iM-xbGgSG3LEKiEzHrPHr8t8IuHLZGGNuxLo";
export const superuserToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoicGJjXzMxNDI2MzU4MjMiLCJleHAiOjI1MjQ2MDQ0NjEsInJlZnJlc2hhYmxlIjp0cnVlfQ.UXgO3j-0BumcugrFjbd7j0M4MQvbrLggLlcu_YNGjoY";

const asUser = { Authorization: userToken };
const asSuperuser = { Authorization: superuserToken };

const usersCollection = "_pb_users_auth_";
const userId = "4q1xlclmfloku33";

// the rows of an OTP or MFA cleanup: long expired and not yet expired
export const expiredRow = "expired00000000";
export const liveRow = "liverow00000000";

export function writeOTPs(dataDir: string): void {
  const db = new Database(join(dataDir, "data.db"));
  try {
    for (const [id, created] of [
      [expiredRow, "2020-01-01 00:00:00.000Z"],
      [liveRow, "2099-01-01 00:00:00.000Z"],
    ]) {
      db.query(
        `INSERT INTO _otps (id, collectionRef, recordRef, password, sentTo, created, updated)
         VALUES (?, ?, ?, 'unused', '', ?, ?)`,
      ).run(id!, usersCollection, userId, created!, created!);
    }
  } finally {
    db.close();
  }
}

export function writeMFAs(dataDir: string): void {
  const db = new Database(join(dataDir, "data.db"));
  try {
    for (const [id, created] of [
      [expiredRow, "2020-01-01 00:00:00.000Z"],
      [liveRow, "2099-01-01 00:00:00.000Z"],
    ]) {
      db.query(
        `INSERT INTO _mfas (id, collectionRef, recordRef, method, created, updated)
         VALUES (?, ?, ?, 'test', ?, ?)`,
      ).run(id!, usersCollection, userId, created!, created!);
    }
  } finally {
    db.close();
  }
}

// a job runs off the request, so its result shows up shortly after the 204
export async function eventually(check: () => boolean | Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }
    await Bun.sleep(10);
  }
  return check();
}

async function rowIds(url: string, collection: string): Promise<string[]> {
  const res = await fetch(`${url}/api/collections/${collection}/records?fields=id&sort=id`, {
    headers: asSuperuser,
  });
  const body = (await res.json()) as { items: { id: string }[] };
  return body.items.map((item) => item.id);
}

function onlyLiveRowLeft(collection: string): (result: AfterContext) => Promise<void> {
  return async ({ url }) => {
    const deleted = await eventually(
      async () => !(await rowIds(url, collection)).includes(expiredRow),
    );
    const left = await rowIds(url, collection);
    if (!deleted || left.join() !== liveRow) {
      throw new Error(`expected only ${liveRow} in ${collection}, got ${left.join()}`);
    }
  };
}

function runBuiltIn(id: string, extra: Partial<Scenario> = {}): Scenario {
  return {
    name: `authorized as superuser (existing job ${id})`,
    method: "POST",
    url: `/api/crons/${id}`,
    headers: asSuperuser,
    expectedStatus: 204,
    ...extra,
  };
}

export const cronsList: Suite = {
  file: "apis/cron_test.go",
  func: "TestCronsList",
  scenarios: [
    {
      name: "unauthorized",
      method: "GET",
      url: "/api/crons",
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method: "GET",
      url: "/api/crons",
      headers: asUser,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser",
      method: "GET",
      url: "/api/crons",
      headers: asSuperuser,
      expectedStatus: 200,
      expectedContent: [
        `{"id":"__pbLogsCleanup__","expression":"0 */6 * * *"}`,
        `{"id":"__pbDBOptimize__","expression":"0 0 * * *"}`,
        `{"id":"__pbMFACleanup__","expression":"0 * * * *"}`,
        `{"id":"__pbOTPCleanup__","expression":"0 * * * *"}`,
      ],
    },
  ],
};

export const cronsRun: Suite = {
  file: "apis/cron_test.go",
  func: "TestCronsRun",
  scenarios: [
    {
      name: "unauthorized",
      method: "POST",
      url: "/api/crons/__pbOTPCleanup__",
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method: "POST",
      url: "/api/crons/__pbOTPCleanup__",
      headers: asUser,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser (missing job)",
      method: "POST",
      url: "/api/crons/missing",
      headers: asSuperuser,
      expectedStatus: 404,
      expectedContent: [`"data":{}`, `"message":"Missing or invalid cron job."`],
    },
    runBuiltIn("__pbOTPCleanup__", {
      prepare: ({ dataDir }: PrepareContext) => writeOTPs(dataDir),
      after: onlyLiveRowLeft("_otps"),
    }),
    runBuiltIn("__pbMFACleanup__", {
      prepare: ({ dataDir }: PrepareContext) => writeMFAs(dataDir),
      after: onlyLiveRowLeft("_mfas"),
    }),
    runBuiltIn("__pbLogsCleanup__"),
    runBuiltIn("__pbDBOptimize__"),
  ],
};
