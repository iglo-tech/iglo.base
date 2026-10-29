// M0.8 multipart spike: request bodies above Bun.serve's default 128 MiB
// maxRequestBodySize. Upstream has no server-wide cap; the body limit
// middleware (32 MiB plus the collection's file field limits) answers a
// too large Content-Length with a 413 before reading the body. Bun's
// default closed such connections without a response. Not part of
// `bun test`: run `bun run test:reference`.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";

import { startServer, tempDir, type RunningServer } from "@test/support/executable";
import { rawRequest, type RawResponse } from "@test/support/raw-http";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

let upstream: UpstreamServer;
let iglo: RunningServer;

beforeAll(async () => {
  [upstream, iglo] = await Promise.all([
    startUpstream(),
    startServer([], join(tempDir(), "pb_data")),
  ]);
});

afterAll(async () => {
  await Promise.all([upstream?.stop(), iglo?.stop()]);
});

function normalize(res: RawResponse): unknown {
  return { status: res.status, type: res.headers.get("content-type"), body: JSON.parse(res.body) };
}

test.each([
  ["just over the 32 MiB limit", 32 * 1024 * 1024 + 1],
  ["over Bun's default 128 MiB", 200 * 1024 * 1024],
  ["4 GiB", 4 * 1024 * 1024 * 1024],
])("Content-Length %s gets the 413 response", async (_name, length) => {
  const send = (url: string) =>
    rawRequest(url, "POST", "/api/collections/_superusers/auth-with-password", {
      "Content-Type": "application/json",
      "Content-Length": String(length),
    });
  const [want, got] = await Promise.all([send(upstream.url), send(iglo.url)]);
  expect(want.status).toBe(413);
  expect(normalize(got)).toEqual(normalize(want));
});
