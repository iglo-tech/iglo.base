// Smoke test for the reference PocketBase v0.41.0 binary that
// `bun run upstream:prepare` puts in .upstream/bin. The differential suite
// (M0.5) runs the same requests against upstream and iglo.base. Not part of
// `bun test`: run `bun run test:reference`.

import { afterAll, beforeAll, expect, test } from "bun:test";

import { startUpstream, type UpstreamServer } from "@test/support/upstream";

let upstream: UpstreamServer;

beforeAll(async () => {
  upstream = await startUpstream();
});

afterAll(async () => {
  await upstream?.stop();
});

test("GET /api/health answers 200 with the upstream body", async () => {
  const res = await fetch(`${upstream.url}/api/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ message: "API is healthy.", code: 200, data: {} });
});
