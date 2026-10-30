// POST /api/batch against the reference PocketBase v0.41.0 binary. Not part
// of `bun test`: run `bun run test:reference`.
//
// One data set (schema.ts) on a pair of servers. Every case (cases.ts) is
// sent to both in order and the responses are compared as the scenario
// harness compares them. After a case the collections it names are listed
// from both, and the files in storage counted, so a failed batch that left
// a row or a file on one side shows. Then iglo.base stops and upstream reads
// a copy of its pb_data: every list must equal upstream's own.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type BatchCase, batchCases } from "@test/differential/batch/cases";
import { createBatchCollections } from "@test/differential/batch/schema";
import {
  compareResponses,
  Pairing,
  readStartingData,
  type StartingData,
} from "@test/differential/harness/compare";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { superuserToken } from "@test/scenarios/record-crud";
import { send } from "@test/scenarios/runner";
import { changeSettings } from "@test/scenarios/settings-prepare";
import type { Scenario } from "@test/scenarios/scenario";
import type { ScenarioResponse } from "@test/scenarios/request";
import { type RunningServer, startServer } from "@test/support/executable";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

const root = mkdtempSync(join(tmpdir(), "iglo-base-batch-"));
const sourceDir = join(root, "source", "pb_data");
const upstreamDir = join(root, "upstream", "pb_data");
const igloBaseDir = join(root, "iglo-base", "pb_data");

let upstream: UpstreamServer;
let igloBase: RunningServer;
let start: StartingData;

beforeAll(async () => {
  copyDataDir(fixtureDir, sourceDir);
  const builder = await startUpstream({ dataDir: sourceDir });
  await createBatchCollections(builder.url);
  await builder.stop();
  copyDataDir(sourceDir, upstreamDir);
  copyDataDir(sourceDir, igloBaseDir);
  start = readStartingData(sourceDir);
  [upstream, igloBase] = await Promise.all([
    startUpstream({ dataDir: upstreamDir }),
    startServer([], igloBaseDir),
  ]);
}, 60_000);

afterAll(async () => {
  await Promise.allSettled([upstream.stop(), igloBase.stop()]);
  rmSync(root, { recursive: true, force: true });
});

async function sendOk(url: string, request: Scenario): Promise<ScenarioResponse> {
  const res = await send(url, request);
  if ("error" in res) {
    throw new Error(`${request.name}: ${res.error}`);
  }
  return res;
}

function batchRequest(c: BatchCase): Scenario {
  const multipartHeaders = c.multipart?.headers ?? {};
  return {
    name: c.name,
    method: "POST",
    url: `/api/batch${c.query ?? ""}`,
    headers: {
      ...(c.token === undefined ? {} : { Authorization: c.token }),
      ...c.headers,
      ...multipartHeaders,
    },
    body: c.multipart?.body ?? c.raw ?? JSON.stringify({ requests: c.items }),
    expectedStatus: 0,
  };
}

function settingsRequest(batch: Record<string, unknown>): Scenario {
  return {
    name: "settings",
    method: "PATCH",
    url: "/api/settings",
    headers: { Authorization: superuserToken },
    body: JSON.stringify({ batch }),
    expectedStatus: 200,
  };
}

// sets the batch settings on one server; returns the ones to restore
async function withSettings(url: string, batch: Record<string, unknown>): Promise<Scenario> {
  const current = await sendOk(url, {
    name: "settings",
    method: "GET",
    url: "/api/settings",
    headers: { Authorization: superuserToken },
    expectedStatus: 200,
  });
  const saved = (JSON.parse(new TextDecoder().decode(current.body)) as { batch: object }).batch;
  // a disabled batch with no limits does not pass the settings validation
  const next = { ...saved, ...batch };
  const res = await sendOk(url, settingsRequest(next));
  if (res.status !== 200) {
    throw new Error(`settings: ${new TextDecoder().decode(res.body)}`);
  }
  return settingsRequest({ ...saved });
}

// a list of the collection's records, in an order generated ids cannot change
function readRequest(collection: string): Scenario {
  const sort = { b_auth: "email", b_json: "id" }[collection] ?? "title";
  const fields = collection === "b_auth" ? "&fields=id,email,verified,name,secret" : "";
  return {
    name: `read ${collection}`,
    method: "GET",
    url: `/api/collections/${collection}/records?perPage=500&sort=${sort}${fields}`,
    headers: { Authorization: superuserToken },
    expectedStatus: 0,
  };
}

function storedFiles(dataDir: string): string[] {
  // file names without their random parts
  const out: string[] = [];
  const storage = join(dataDir, "storage");
  for (const collection of readdirSync(storage)) {
    for (const record of readdirSync(join(storage, collection))) {
      for (const name of readdirSync(join(storage, collection, record))) {
        out.push(
          `${collection}/${record}/${name.replace(/_[a-z0-9]{10}/g, "").replace(/[0-9]{5,}/g, "")}`,
        );
      }
    }
  }
  return out.toSorted();
}

describe("POST /api/batch", () => {
  for (const c of batchCases) {
    test(
      c.name,
      async () => {
        const restore =
          c.settings === undefined
            ? null
            : await Promise.all([
                withSettings(upstream.url, c.settings),
                withSettings(igloBase.url, c.settings),
              ]);

        const request = batchRequest(c);
        const up = await sendOk(upstream.url, request);
        const ig = await sendOk(igloBase.url, request);

        if (restore !== null) {
          await sendOk(upstream.url, restore[0]);
          await sendOk(igloBase.url, restore[1]);
        }

        const pairing = new Pairing();
        const differences = compareResponses(up, ig, { start, request }, pairing);

        for (const collection of c.reads ?? []) {
          const read = readRequest(collection);
          const [upRead, igRead] = await Promise.all([
            sendOk(upstream.url, read),
            sendOk(igloBase.url, read),
          ]);
          differences.push(...compareResponses(upRead, igRead, { start, request: read }, pairing));
        }

        expect(differences).toEqual([]);
        expect(storedFiles(igloBaseDir)).toEqual(storedFiles(upstreamDir));
      },
      30_000,
    );
  }

  test("maxRequests 0 on an enabled batch", async () => {
    // not a state the settings API accepts
    const dirs = [join(root, "max-up", "pb_data"), join(root, "max-ig", "pb_data")] as const;
    for (const dir of dirs) {
      copyDataDir(sourceDir, dir);
      changeSettings(dir, (settings) => {
        Object.assign(settings["batch"] as object, { enabled: true, maxRequests: 0 });
      });
    }
    const [up, ig] = await Promise.all([
      startUpstream({ dataDir: dirs[0] }),
      startServer([], dirs[1]),
    ]);
    try {
      const request = batchRequest({ name: "maxRequests 0", raw: `{"requests":[]}` });
      const responses = await Promise.all([sendOk(up.url, request), sendOk(ig.url, request)]);
      expect(responses[0].status).toBe(403);
      expect(compareResponses(responses[0], responses[1], { start, request })).toEqual([]);
    } finally {
      await Promise.allSettled([up.stop(), ig.stop()]);
    }
  }, 30_000);

  test("a changed password signs in", async () => {
    const request: Scenario = {
      name: "auth",
      method: "POST",
      url: "/api/collections/b_auth/auth-with-password",
      body: JSON.stringify({ identity: "u1@example.com", password: "abcdefghij" }),
      expectedStatus: 200,
    };
    const up = await sendOk(upstream.url, request);
    const ig = await sendOk(igloBase.url, request);
    expect([up.status, ig.status]).toEqual([200, 200]);
  });

  test("upstream reads what iglo.base stored", async () => {
    await igloBase.stop();
    const rtDir = join(root, "round-trip", "pb_data");
    copyDataDir(igloBaseDir, rtDir);
    const rt = await startUpstream({ dataDir: rtDir });
    try {
      for (const collection of [
        "b_parents",
        "b_children",
        "b_required",
        "b_rules",
        "b_method",
        "b_files",
        "b_json",
        "b_auth",
      ]) {
        const read = readRequest(collection);
        const fromIglo = await sendOk(rt.url, read);
        const own = await sendOk(upstream.url, read);
        expect(compareResponses(own, fromIglo, { start, request: read })).toEqual([]);
      }
    } finally {
      await rt.stop();
    }
  }, 60_000);
});
