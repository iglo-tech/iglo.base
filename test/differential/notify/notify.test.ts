// P.8: iglo.base and upstream PocketBase v0.41.0 on the same pb_data notify
// each other about settings changes, in both directions.

import { describe, expect, test } from "bun:test";

import { appName, fixtureCopy, login, patchSettings, waitFor } from "@test/notify/support";
import { startServer } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";

describe("settings notify between iglo.base and upstream", () => {
  test("both directions", async () => {
    const dataDir = fixtureCopy();
    const upstream = await startUpstream({ dataDir });
    const igloBase = await startServer([], dataDir);
    try {
      const upToken = await login(upstream.url);
      const igToken = await login(igloBase.url);

      await patchSettings(igloBase.url, igToken, { meta: { appName: "from-iglo" } });
      await waitFor("upstream's settings", async () =>
        (await appName(upstream.url, upToken)) === "from-iglo" ? true : undefined,
      );

      await patchSettings(upstream.url, upToken, { meta: { appName: "from-upstream" } });
      await waitFor("iglo.base's settings", async () =>
        (await appName(igloBase.url, igToken)) === "from-upstream" ? true : undefined,
      );
      expect(await appName(upstream.url, upToken)).toBe("from-upstream");
    } finally {
      await Promise.all([igloBase.stop(), upstream.stop()]);
    }
  }, 60_000);
});
