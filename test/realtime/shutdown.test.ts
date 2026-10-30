// Graceful shutdown (docs/design/02-architecture.md): SIGTERM closes the
// open realtime streams, so the server stops at once instead of waiting
// for them.

import { rmSync } from "node:fs";

import { expect, test } from "bun:test";

import { RealtimeStream } from "@test/realtime/client";
import { freshFixture } from "@test/realtime/run";
import { startServer } from "@test/support/executable";

test("SIGTERM closes the realtime streams and the server exits", async () => {
  const fixture = freshFixture();
  try {
    const server = await startServer([], fixture.dataDir);
    const streams = await Promise.all([1, 2, 3].map(() => RealtimeStream.open(server.url)));

    const started = Date.now();
    const result = await server.stop();
    const elapsed = Date.now() - started;

    expect(result.exitCode).toBe(0);
    // well below upstream's 1 second graceful shutdown limit, which only
    // runs out when requests stay open
    expect(elapsed).toBeLessThan(900);
    for (const stream of streams) {
      expect(await stream.waitClosed(1000)).toBe(true);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}, 30_000);
