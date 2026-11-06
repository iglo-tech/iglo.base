// P.6: the harness lets a write draw a record's `updated` again (two writes
// within a millisecond share a value on one server and not on the other), so
// this checks the other half through HTTP on both servers: an update made
// some milliseconds after the create gives a later `updated` and keeps
// `created`, and a read-back shows the update's value.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { superuserToken } from "@test/scenarios/record-crud";
import { startServer } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";

const roots: string[] = [];
const stops: (() => Promise<unknown>)[] = [];

afterAll(async () => {
  await Promise.allSettled(stops.map((stop) => stop()));
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function api(url: string, method: string, path: string, body?: object): Promise<any> {
  const res = await fetch(url + path, {
    method,
    headers: { Authorization: superuserToken, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function check(url: string): Promise<void> {
  const created = await api(url, "POST", "/api/collections/demo2/records", {
    title: `abc${Math.random().toString(36).slice(2, 8)}`,
  });
  await Bun.sleep(25);
  const updated = await api(url, "PATCH", `/api/collections/demo2/records/${created.id}`, {
    title: `def${Math.random().toString(36).slice(2, 8)}`,
  });
  const read = await api(url, "GET", `/api/collections/demo2/records/${created.id}`);
  expect(updated.created).toBe(created.created);
  expect(Date.parse(updated.updated.replace(" ", "T"))).toBeGreaterThan(
    Date.parse(created.updated.replace(" ", "T")),
  );
  expect(read.updated).toBe(updated.updated);
}

describe("a record's updated advances on an update", () => {
  for (const kind of ["upstream", "iglo.base"] as const) {
    test(
      kind,
      async () => {
        const root = mkdtempSync(join(tmpdir(), "iglo-base-updated-"));
        roots.push(root);
        const dataDir = join(root, "pb_data");
        copyDataDir(fixtureDir, dataDir);
        const server =
          kind === "upstream" ? await startUpstream({ dataDir }) : await startServer([], dataDir);
        stops.push(() => server.stop());
        await check(server.url);
      },
      60_000,
    );
  }
});
