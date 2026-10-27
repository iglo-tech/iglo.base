// Starts the reference PocketBase v0.41.0 binary (.upstream/bin/pocketbase,
// see scripts/upstream/prepare.ts) on a free 127.0.0.1 port with a new pb_data
// directory. The tests talk to it only through HTTP.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnChild, waitUntilReady } from "@test/support/child";
import { freePort } from "@test/support/executable";
import { defaultLayout, requireTool, type Layout } from "@test/support/reference-tools";

export interface UpstreamServer {
  url: string;
  dataDir: string;
  stop(): Promise<void>;
}

export async function startUpstream(layout: Layout = defaultLayout): Promise<UpstreamServer> {
  const binary = requireTool("pocketbase", layout);
  const root = mkdtempSync(join(tmpdir(), "iglo-base-upstream-"));
  const dataDir = join(root, "pb_data");
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawnChild([binary, "serve", "--http", `127.0.0.1:${port}`, "--dir", dataDir], {
    cwd: root,
  });

  try {
    await waitUntilReady(child, "upstream pocketbase", async () => {
      const res = await fetch(`${url}/api/health`);
      return res.ok;
    });
  } catch (error) {
    await child.stop();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  return {
    url,
    dataDir,
    async stop() {
      try {
        await child.stop();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
