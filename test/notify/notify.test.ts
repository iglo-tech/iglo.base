// P.8: the notify watcher through the release executable. A CLI command or
// another server instance on the same pb_data changes the settings or the
// collections; the running server picks it up without a restart.

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appName, fixtureCopy, login, patchSettings, waitFor } from "@test/notify/support";
import { run, startServer } from "@test/support/executable";

async function status(url: string, token: string, path: string): Promise<number> {
  const res = await fetch(`${url}${path}`, { headers: { Authorization: token } });
  await res.arrayBuffer();
  return res.status;
}

setDefaultTimeout(60_000);

describe("superuser ips from the CLI", () => {
  test("set and cleared while the server runs", async () => {
    const dataDir = fixtureCopy();
    const server = await startServer([], dataDir);
    try {
      const token = await login(server.url);
      expect(await status(server.url, token, "/api/settings")).toBe(200);

      const set = await run(["--dir", dataDir, "superuser", "ips", "10.9.8.7"]);
      expect(set.exitCode).toBe(0);
      await waitFor("403 after the ips were set", async () =>
        (await status(server.url, token, "/api/settings")) === 403 ? true : undefined,
      );

      const cleared = await run(["--dir", dataDir, "superuser", "ips"]);
      expect(cleared.exitCode).toBe(0);
      await waitFor("200 after the ips were cleared", async () =>
        (await status(server.url, token, "/api/settings")) === 200 ? true : undefined,
      );
    } finally {
      await server.stop();
    }
  });
});

describe("migrate up while the server runs", () => {
  test("a new collection and a changed rule are served without a restart", async () => {
    const dataDir = fixtureCopy();
    const migrationsDir = join(dataDir, "..", "pb_migrations");
    mkdirSync(migrationsDir, { recursive: true });
    const server = await startServer([], dataDir);
    try {
      const token = await login(server.url);
      const list = async (): Promise<number> =>
        status(server.url, "", "/api/collections/notify_demo/records");
      expect(await list()).toBe(404);

      writeFileSync(
        join(migrationsDir, "1900000001_create.js"),
        `migrate((app) => {
          app.save(new Collection({ type: "base", name: "notify_demo", listRule: null,
            fields: [{ type: "text", name: "title" }] }));
        })`,
      );
      const up1 = await run(["--dir", dataDir, "migrate", "up"], { cwd: join(dataDir, "..") });
      expect(up1.exitCode).toBe(0);
      // the collection exists; its list rule is null: superusers only
      await waitFor("the new collection", async () =>
        (await status(server.url, "", "/api/collections/notify_demo/records")) === 403
          ? true
          : undefined,
      );
      expect(await status(server.url, token, "/api/collections/notify_demo/records")).toBe(200);

      writeFileSync(
        join(migrationsDir, "1900000002_rule.js"),
        `migrate((app) => {
          const c = app.findCollectionByNameOrId("notify_demo");
          c.listRule = "";
          app.save(c);
        })`,
      );
      const up2 = await run(["--dir", dataDir, "migrate", "up"], { cwd: join(dataDir, "..") });
      expect(up2.exitCode).toBe(0);
      await waitFor("the changed rule", async () => ((await list()) === 200 ? true : undefined));
    } finally {
      await server.stop();
    }
  });
});

describe("two iglo.base servers on one pb_data", () => {
  test("a settings and a collection change reach the other server", async () => {
    const dataDir = fixtureCopy();
    const a = await startServer([], dataDir);
    const b = await startServer([], dataDir);
    try {
      const tokenA = await login(a.url);
      const tokenB = await login(b.url);

      await patchSettings(a.url, tokenA, { meta: { appName: "from-a" } });
      await waitFor("B's settings", async () =>
        (await appName(b.url, tokenB)) === "from-a" ? true : undefined,
      );

      const created = await fetch(`${a.url}/api/collections`, {
        method: "POST",
        headers: { Authorization: tokenA, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "notify_two", type: "base", listRule: "" }),
      });
      expect(created.status).toBe(200);
      await waitFor("B's collection", async () =>
        (await status(b.url, "", "/api/collections/notify_two/records")) === 200 ? true : undefined,
      );
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
  });

  test("the markers are written in .notify and removed", async () => {
    const dataDir = fixtureCopy();
    const server = await startServer([], dataDir);
    try {
      const notifyDir = join(dataDir, ".notify");
      await waitFor(".notify dir", async () => (existsSync(notifyDir) ? true : undefined));
      const token = await login(server.url);
      await patchSettings(server.url, token, { meta: { appName: "marker" } });
      await waitFor("the marker to be removed", async () =>
        readdirSync(notifyDir).length === 0 ? true : undefined,
      );
    } finally {
      await server.stop();
    }
    expect(readdirSync(join(dataDir, ".notify"))).toEqual([]);
  });

  test("a burst of 100 saves causes a bounded number of reloads", async () => {
    const dataDir = fixtureCopy();
    const a = await startServer([], dataDir);
    const b = await startServer([], dataDir);
    try {
      const tokenA = await login(a.url);
      const tokenB = await login(b.url);
      // debug logs are stored, so that B's reloads can be counted
      await patchSettings(b.url, tokenB, { logs: { minLevel: -4, maxDays: 5 } });
      await waitFor("B's settings", async () =>
        (await appName(b.url, tokenB)) !== "" ? true : undefined,
      );

      const reloads = async (): Promise<number> => {
        const res = await fetch(
          `${b.url}/api/logs?perPage=1&filter=${encodeURIComponent(`message~"Reloading settings after notify event"`)}`,
          { headers: { Authorization: tokenB } },
        );
        return ((await res.json()) as { totalItems: number }).totalItems;
      };
      const before = await waitFor("log stored", async () =>
        (await reloads()) >= 0 ? await reloads() : undefined,
      );

      const saves = 100;
      await Promise.all(
        Array.from({ length: saves }, (_, i) =>
          patchSettings(a.url, tokenA, { meta: { appName: `burst-${i}` } }),
        ),
      );
      // B ends on the value A ended on
      const final = await appName(a.url, tokenA);
      await waitFor("B converged", async () =>
        (await appName(b.url, tokenB)) === final ? true : undefined,
      );
      // let the log queue flush
      await Bun.sleep(3500);
      const count = (await reloads()) - before;
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThan(saves / 2);
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
  }, 60_000);
});
