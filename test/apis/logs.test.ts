// Upstream: core/base.go (initLogger), core/log_printer_test.go,
// apis/middlewares.go (activityLogger). What a running app stores in `_logs`,
// through its HTTP routes and the auxiliary.db rows. The queue timer is
// fired by hand, never slept for.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { newRouter } from "@/apis/base";
import { clearBootstrap } from "@/app/bootstrap";
import { runInTransaction } from "@/db/tx";
import type { LogAttrs } from "@/logs/batch-handler";
import { formatLog } from "@/logs/log-printer";
import { reloadSettings } from "@/settings/settings-query";

import { openFixtureApp, type TestApp, type TestAppOptions } from "@test/app/app";
import { superuserToken } from "@test/scenarios/cron";
import { serveTest } from "@test/support/router";

interface Row {
  id: string;
  level: number;
  message: string;
  data: string;
  created: string;
}

let opened: TestApp[] = [];

afterEach(async () => {
  for (const app of opened) {
    await app.cleanup();
  }
  opened = [];
});

interface Harness {
  app: TestApp;
  tick(): void;
  resets(): number;
  send(method: string, target: string, headers?: Record<string, string>): Promise<Response>;
  rows(): Row[];
  settle(): Promise<void>;
}

async function open(options: TestAppOptions = {}): Promise<Harness> {
  let fire = (): void => {};
  let resets = 0;
  const app = await openFixtureApp({
    ownLogger: true,
    logTicker: (tick) => {
      fire = tick;
      return { reset: () => void resets++, stop: () => {} };
    },
    ...options,
  });
  opened.push(app);
  app.databases.auxNonconcurrentDB().newQuery("DELETE FROM _logs").execute();
  const mux = newRouter(app).buildMux();

  return {
    app,
    tick: () => fire(),
    resets: () => resets,
    send: (method, target, headers = {}) => serveTest(mux, { method, target, headers }),
    rows: () => {
      const db = new Database(join(app.dataDir, "auxiliary.db"), { readonly: true });
      try {
        return db.query("SELECT * FROM _logs ORDER BY rowid").all() as Row[];
      } finally {
        db.close();
      }
    },
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

const asSuperuser = { Authorization: superuserToken };

describe("the buffered writer", () => {
  test("a tick writes the queue; each log restarts the wait", async () => {
    const h = await open();
    const before = h.resets();
    h.app.logger.warn("first", { a: 1 });
    h.app.logger.warn("second");
    expect(h.resets()).toBe(before + 2);
    expect(h.rows()).toEqual([]);

    h.tick();
    await h.settle();

    expect(h.rows().map((r) => [r.level, r.message, r.data])).toEqual([
      [4, "first", `{"a":1}`],
      [4, "second", "{}"],
    ]);
  });

  test("the batch size writes without a tick, off the caller", async () => {
    const h = await open();
    for (let i = 0; i < 200; i++) {
      h.app.logger.info(`log ${i}`);
    }
    expect(h.rows()).toEqual([]);
    await h.settle();
    expect(h.rows()).toHaveLength(200);
  });

  test("closing writes the queue and the batches on their way", async () => {
    const h = await open();
    for (let i = 0; i < 201; i++) {
      h.app.logger.info(`log ${i}`);
    }
    h.app.logger.close();
    expect(h.rows()).toHaveLength(201);

    // a late log and a second close change nothing
    h.app.logger.error("late");
    h.app.logger.close();
    expect(h.rows()).toHaveLength(201);
  });

  test("clearBootstrap writes the queue before the databases close", async () => {
    const h = await open();
    h.app.logger.error("last entry");
    await clearBootstrap(h.app);

    const db = new Database(join(h.app.dataDir, "auxiliary.db"), { readonly: true });
    const rows = db.query("SELECT message FROM _logs").all();
    db.close();
    expect(rows).toEqual([{ message: "last entry" }]);
  });

  test("a log inside a rolled back transaction stays, and writes after it ended", async () => {
    const h = await open();
    expect(() =>
      runInTransaction(h.app.databases, () => {
        for (let i = 0; i < 200; i++) {
          h.app.logger.warn("inside");
        }
        expect(h.rows()).toEqual([]);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");

    await h.settle();
    expect(h.rows()).toHaveLength(200);
  });

  test("a failed write reaches stderr, not the logger, and the others are kept", async () => {
    const lines: string[] = [];
    const h = await open({ stderrLog: (line) => lines.push(line) });
    h.app.logger.warn("good");
    h.app.logger.warn("bad", { value: Number.NaN });
    h.app.logger.close();

    expect(h.rows().map((r) => r.message)).toEqual(["good"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("Failed to write log bad");
  });

  test("a table that cannot be written does not throw or recurse", async () => {
    const lines: string[] = [];
    const h = await open({ stderrLog: (line) => lines.push(line) });
    h.app.databases.auxNonconcurrentDB().newQuery("ALTER TABLE _logs RENAME TO _gone").execute();
    h.app.logger.warn("lost");
    h.app.logger.close();
    h.app.databases.auxNonconcurrentDB().newQuery("ALTER TABLE _gone RENAME TO _logs").execute();
    expect(lines).toHaveLength(1);
  });
});

describe("the logs settings", () => {
  test("maxDays 0 stores nothing", async () => {
    const h = await open();
    h.app.settings.Logs.MaxDays = 0;
    h.app.logger.error("dropped");
    await h.send("GET", "/api/health");
    h.tick();
    await h.settle();
    expect(h.rows()).toEqual([]);
  });

  test("maxDays reaching 0 after a log was queued stores nothing", async () => {
    const h = await open();
    h.app.logger.error("queued");
    h.app.settings.Logs.MaxDays = 0;
    h.tick();
    await h.settle();
    expect(h.rows()).toEqual([]);
  });

  test("minLevel takes effect on a settings reload and clears lower logs", async () => {
    const h = await open();
    h.app.logger.info("kept for now");
    h.tick();
    await h.settle();
    expect(h.rows()).toHaveLength(1);

    const res = await serveTestPatch(h, { logs: { minLevel: 4 } });
    expect(res.status).toBe(200);
    expect(h.rows()).toEqual([]);

    h.app.logger.info("below the level");
    h.app.logger.warn("at the level");
    h.tick();
    await h.settle();
    expect(h.rows().map((r) => r.message)).toEqual(["at the level"]);
  });

  test("the reload clears the logs past maxDays", async () => {
    const h = await open({ clock: { now: () => new Date("2030-01-10T00:00:00Z") } });
    const db = h.app.databases.auxNonconcurrentDB();
    db.newQuery(
      "INSERT INTO _logs (id, created) VALUES ('old', '2030-01-01 00:00:00.000Z'), ('new', '2030-01-09 00:00:00.000Z')",
    ).execute();
    await reloadSettings(h.app);
    expect(h.rows().map((r) => r.id)).toEqual(["new"]);
  });

  test("logIP and logAuthId", async () => {
    const h = await open();
    h.app.settings.Logs.LogIP = false;
    h.app.settings.Logs.LogAuthId = true;
    await h.send("GET", "/api/collections", asSuperuser);
    h.tick();
    await h.settle();

    const data = JSON.parse(h.rows()[0]!.data) as LogAttrs;
    expect(data.auth).toBe("_superusers");
    expect(data.authId).toBe("sywbhecnh46rhm0");
    expect(data.userIP).toBeUndefined();
    expect(data.remoteIP).toBeUndefined();
  });

  test("maxDataSize is read when the batch is written", async () => {
    const h = await open();
    h.app.logger.warn("big", { text: "x".repeat(100) });
    h.app.settings.Logs.MaxDataSize = 10;
    h.tick();
    await h.settle();
    expect(h.rows()[0]!.data).toBe(`{"__pb_truncated__":true,"text":null}`);
  });
});

describe("request logs", () => {
  test("a success", async () => {
    const h = await open();
    h.app.settings.Logs.LogIP = true;
    await h.send("GET", "/api/health?a=%20b", {
      Referer: "http://example.com",
      "User-Agent": "test-agent",
    });
    h.tick();
    await h.settle();

    const [row] = h.rows();
    expect(row!.level).toBe(0);
    expect(row!.message).toBe("GET /api/health?a= b");
    const data = JSON.parse(row!.data) as LogAttrs;
    expect(typeof data.execTime).toBe("number");
    expect(row!.data).toBe(
      `{"auth":"","execTime":${String(data.execTime)},"method":"GET","referer":"http://example.com","remoteIP":"127.0.0.1","status":200,"type":"request","url":"/api/health?a=%20b","userAgent":"test-agent","userIP":"127.0.0.1"}`,
    );
  });

  test("a malformed escape keeps the raw message", async () => {
    const h = await open();
    await h.send("GET", "/api/health?a=%zz");
    h.tick();
    await h.settle();
    expect(h.rows()[0]!.message).toBe("GET /api/health?a=%zz");
  });

  test("a failure", async () => {
    const h = await open();
    await h.send("GET", "/api/logs/missing", asSuperuser);
    h.tick();
    await h.settle();

    const [row] = h.rows();
    expect(row!.level).toBe(8);
    const data = JSON.parse(row!.data) as LogAttrs;
    expect(data).toMatchObject({
      auth: "_superusers",
      details: "sql: no rows in result set",
      error: "The requested resource wasn't found.",
      status: 404,
    });
  });

  test("long values are cut", async () => {
    const h = await open();
    await h.send("GET", `/api/health?a=${"x".repeat(4000)}`, {
      Referer: "r".repeat(3000),
      "User-Agent": "u".repeat(3000),
    });
    h.tick();
    await h.settle();
    const data = JSON.parse(h.rows()[0]!.data) as { [key: string]: string };
    expect(data.url).toHaveLength(3003);
    expect(data.referer).toBe("r".repeat(2000) + "...");
    expect(data.userAgent).toBe("u".repeat(2000) + "...");
  });

  test("the logs routes skip their successes and keep their failures", async () => {
    const h = await open();
    await h.send("GET", "/api/logs", asSuperuser);
    await h.send("GET", "/api/logs/stats", asSuperuser);
    await h.send("GET", "/api/logs");
    await h.send("GET", "/api/logs/stats?filter=(", asSuperuser);
    h.tick();
    await h.settle();
    expect(h.rows().map((r) => [r.message, JSON.parse(r.data).status as number])).toEqual([
      ["GET /api/logs", 401],
      ["GET /api/logs/stats?filter=(", 400],
    ]);
  });

  test("an oauth2 redirect success is skipped and a failure logged", async () => {
    const h = await open();
    const res = await h.send("GET", "/api/oauth2-redirect?state=missing&code=secret");
    expect(res.status).toBe(307);
    h.tick();
    await h.settle();
    expect(h.rows()).toEqual([]);
  });
});

describe("--dev", () => {
  test("prints every level and stores from minLevel", async () => {
    const printed: string[] = [];
    const h = await open({ isDev: true, logPrint: (text) => printed.push(text) });
    h.app.settings.Logs.MinLevel = 4;
    h.app.logger.debug("debug");
    h.app.logger.warn("warn", { a: 1 });
    h.tick();
    await h.settle();

    expect(printed).toEqual(["DEBUG debug\n", `WARN warn\n└─ {"a":1}\n`]);
    expect(h.rows().map((r) => r.message)).toEqual(["warn"]);
  });
});

describe("the printer", () => {
  const log = (level: number, data: LogAttrs): Parameters<typeof formatLog>[0] => ({
    time: new Date(),
    level,
    message: "POST /api/x",
    data,
  });

  test("request logs print their error and details", () => {
    const data = { type: "request", error: "Failed.", details: { name: "must be valid", a: 1 } };
    expect(formatLog(log(8, data), false)).toBe(
      "ERROR POST /api/x\n└─ Failed.\n   └─ map[a:1 name:must be valid]\n",
    );
  });

  test("colors, as upstream on a terminal", () => {
    expect(formatLog(log(8, { type: "request", error: "Failed.", details: null }), true)).toBe(
      "\x1b[1;31mERROR \x1b[22;0m\x1b[31mPOST /api/x\x1b[0m\n\x1b[91m└─ Failed.\x1b[0m\n",
    );
    expect(formatLog(log(0, {}), true)).toBe(
      "\x1b[1;37mINFO \x1b[22;0m\x1b[37mPOST /api/x\x1b[0m\n",
    );
  });

  test("other levels print their number", () => {
    expect(formatLog(log(2, {}), false)).toBe("[2] POST /api/x\n");
  });
});

async function serveTestPatch(h: Harness, body: unknown): Promise<Response> {
  const mux = newRouter(h.app).buildMux();
  return serveTest(mux, {
    method: "PATCH",
    target: "/api/settings",
    headers: { ...asSuperuser, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
