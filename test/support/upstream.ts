// Starts the reference PocketBase v0.41.0 binary (.upstream/bin/pocketbase,
// see scripts/upstream/prepare.ts) on a free 127.0.0.1 port with a new pb_data
// directory. The tests talk to it only through HTTP.
//
// On a pb_data without superusers, upstream's serve runs its installer in the
// background (apis/serve.go, apis/installer.go): it creates the installer
// superuser and launches a browser on the /_/#/pbinstall/<token> URL with
// `open` (macOS) or `xdg-open` (tools/osutils/cmd.go). The helper puts no-op
// `open` and `xdg-open` first on the child's PATH, and waits for the
// installer's printed hint, so the starting data is settled before tests run.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const noBrowserDir = join(root, "no-browser");
  mkdirSync(noBrowserDir);
  for (const name of ["open", "xdg-open"]) {
    const path = join(noBrowserDir, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  }
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawnChild([binary, "serve", "--http", `127.0.0.1:${port}`, "--dir", dataDir], {
    cwd: root,
    env: { PATH: `${noBrowserDir}:${process.env.PATH ?? ""}` },
  });

  try {
    await waitUntilReady(child, "upstream pocketbase", async () => {
      const res = await fetch(`${url}/api/health`);
      return res.ok;
    });
    // the installer prints this hint after the installer superuser exists
    await waitUntilReady(child, "upstream pocketbase installer", async () =>
      child.output().includes("superuser upsert"),
    );
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
