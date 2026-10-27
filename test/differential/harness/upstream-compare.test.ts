// The normalization rules on real upstream responses: the same request
// against two upstream PocketBase v0.41.0 servers, each on its own copy of
// the fixture, must compare equal (the generated values pair), and a changed
// byte that is not a generated value must be reported. The cases are the
// ones from Sol's council review of PR #6, plus the members upstream writes
// in a random order.

import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { compareResponses, readStartingData } from "@test/differential/harness/compare";
import { copyDataDir, preparedFixture } from "@test/scenarios/fixture";
import { sendScenarioRequest, type ScenarioResponse } from "@test/scenarios/request";
import type { Scenario } from "@test/scenarios/scenario";
import { startUpstream } from "@test/support/upstream";

// upstream's fixture superuser token (expiring in 2050): test data
const superuser =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoicGJjXzMxNDI2MzU4MjMiLCJleHAiOjI1MjQ2MDQ0NjEsInJlZnJlc2hhYmxlIjp0cnVlfQ.UXgO3j-0BumcugrFjbd7j0M4MQvbrLggLlcu_YNGjoY";

// The scenario's request against two upstream servers, and the comparison
// of a first response with a second one changed by `change`.
async function twice(
  request: Scenario,
  change: (body: string) => string,
): Promise<{ first: string; same: string[]; changed: string[] }> {
  const fixture = await preparedFixture(request);
  try {
    const dirs = ["a", "b"].map((name) => join(fixture.root, name, "pb_data"));
    for (const dir of dirs) {
      copyDataDir(fixture.dataDir, dir);
    }
    const servers = await Promise.all(dirs.map((dataDir) => startUpstream({ dataDir })));
    try {
      const [a, b] = (await Promise.all(
        servers.map((s) => sendScenarioRequest(s.url, request)),
      )) as [ScenarioResponse, ScenarioResponse];
      const context = { start: readStartingData(fixture.dataDir), request };
      const text = new TextDecoder().decode(b.body);
      const changedBody = change(text);
      expect(changedBody).not.toBe(text);
      return {
        first: new TextDecoder().decode(a.body),
        same: compareResponses(a, b, context),
        changed: compareResponses(
          a,
          { ...b, body: new TextEncoder().encode(changedBody) },
          context,
        ),
      };
    } finally {
      await Promise.allSettled(servers.map((s) => s.stop()));
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test("a new record's title that looks like an id compares exactly", async () => {
  const result = await twice(
    {
      name: "create",
      method: "POST",
      url: "/api/collections/demo2/records",
      body: '{"title":"abcdefghijklmno"}',
      headers: { Authorization: superuser },
      expectedStatus: 200,
    },
    (body) => body.replace('"title":"abcdefghijklmno"', '"title":"pqrstuvwxyzabcd"'),
  );
  // id, created and updated are generated, so the two runs differ in them
  expect(result.first).toContain('"title":"abcdefghijklmno"');
  expect(result.same).toEqual([]);
  expect(result.changed).toEqual([
    'body title: different strings: upstream "abcdefghijklmno", iglo.base "pqrstuvwxyzabcd"',
  ]);
});

test("a projected json field value compares as bytes", async () => {
  const result = await twice(
    {
      name: "list",
      method: "GET",
      url: "/api/collections/demo1/records?fields=json&perPage=1",
      headers: { Authorization: superuser },
      expectedStatus: 200,
    },
    (body) => body.replace('{"json":[1,2,3]}', '{"json":[1, 2, 3]}'),
  );
  expect(result.first).toContain('"items":[{"json":[1,2,3]}]');
  expect(result.same).toEqual([]);
  expect(result.changed).toHaveLength(1);
  expect(result.changed[0]).toStartWith("body: same JSON, different bytes at character ");
});

test("health data compares in any member order", async () => {
  const result = await twice(
    {
      name: "health",
      method: "GET",
      url: "/api/health",
      headers: { Authorization: superuser },
      expectedStatus: 200,
    },
    (body) => body.replace('"canBackup":true', '"canBackup":false'),
  );
  expect(result.same).toEqual([]);
  expect(result.changed).toEqual([
    "body data.canBackup: different kinds: upstream true, iglo.base false",
  ]);
});
