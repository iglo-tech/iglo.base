// P.8: iglo.base and upstream PocketBase v0.41.0 on the same pb_data notify
// each other about settings changes, in both directions.
//
// On macOS upstream's fsnotify uses kqueue, which lists the directory after
// an event; a marker that upstream's own code creates and removes at once is
// then often not seen (this is upstream's behavior with its own markers
// too). The iglo.base to upstream direction is therefore checked on Linux
// only; the upstream to iglo.base direction runs everywhere.

import { describe, expect, test } from "bun:test";

import { appName, fixtureCopy, login, patchSettings, waitFor } from "@test/notify/support";
import { startServer } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";

async function withPair<T>(
  fn: (
    upstream: { url: string; token: string },
    igloBase: { url: string; token: string },
  ) => Promise<T>,
): Promise<T> {
  const dataDir = fixtureCopy();
  const upstream = await startUpstream({ dataDir });
  const igloBase = await startServer([], dataDir);
  try {
    return await fn(
      { url: upstream.url, token: await login(upstream.url) },
      { url: igloBase.url, token: await login(igloBase.url) },
    );
  } finally {
    await Promise.all([igloBase.stop(), upstream.stop()]);
  }
}

describe("settings notify between iglo.base and upstream", () => {
  test.skipIf(process.platform === "darwin")(
    "iglo.base saves, upstream reloads",
    async () => {
      await withPair(async (up, ig) => {
        await patchSettings(ig.url, ig.token, { meta: { appName: "from-iglo" } });
        await waitFor("upstream's settings", async () =>
          (await appName(up.url, up.token)) === "from-iglo" ? true : undefined,
        );
      });
    },
    60_000,
  );

  test("upstream saves, iglo.base reloads", async () => {
    await withPair(async (up, ig) => {
      await patchSettings(up.url, up.token, { meta: { appName: "from-upstream" } });
      await waitFor("iglo.base's settings", async () =>
        (await appName(ig.url, ig.token)) === "from-upstream" ? true : undefined,
      );
      expect(await appName(up.url, up.token)).toBe("from-upstream");
    });
  }, 60_000);
});
