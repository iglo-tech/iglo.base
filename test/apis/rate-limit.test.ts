// Upstream: apis/middlewares_rate_limit_test.go, and the limiters' cleanup
// and reset of apis/middlewares_rate_limit.go
//
// The cases of test/differential/rate-limit/cases.ts against iglo.base alone,
// in-process, with waits on an injected clock; `bun run test:reference` runs
// them against upstream too. The rest cannot run there: other client IPs, and
// the cleanup job, which only frees memory: no response shows it, so its
// tests read the limiters in the app store.

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { newRouter } from "@/apis/base";
import { saveSettings } from "@/settings/settings-query";

import { openFixtureApp, type TestApp } from "@test/app/app";
import {
  type Case,
  cases,
  prepareCase,
  type Step,
  tooManyRequestsBody,
} from "@test/differential/rate-limit/cases";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { startClock } from "@test/differential/rate-limit/clock";
import { tempDir } from "@test/support/executable";
import { serveTest } from "@test/support/router";

// a whole second near the real time, as the fixture's OTP rows are written then
const start = new Date(Math.floor(Date.now() / 1000) * 1000);

let opened: { app: TestApp; root: string }[] = [];

afterEach(async () => {
  for (const { app, root } of opened) {
    await app.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
  opened = [];
});

async function openCase(c: Case): Promise<{
  app: TestApp;
  mux: ReturnType<ReturnType<typeof newRouter>["buildMux"]>;
  clock: ReturnType<typeof startClock>;
}> {
  const root = tempDir();
  const dataDir = join(root, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  prepareCase(c, { dataDir });
  const clock = startClock(start);
  const app = await openFixtureApp({ clock, dataDir });
  opened.push({ app, root });
  return { app, mux: newRouter(app).buildMux(), clock };
}

function requestOf(step: Step): {
  method: string;
  target: string;
  headers: Record<string, string>;
  body?: string;
} {
  const headers = { ...step.headers };
  if (step.body === undefined) {
    return { method: step.method ?? "GET", target: step.url, headers };
  }
  return {
    method: step.method ?? "GET",
    target: step.url,
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof step.body === "string" ? step.body : JSON.stringify(step.body),
  };
}

describe("rate limit cases", () => {
  for (const c of cases) {
    test(c.name, async () => {
      const { mux, clock } = await openCase(c);
      for (const [i, step] of c.steps.entries()) {
        clock.advance(step.waitMs ?? 0);
        const res = await serveTest(mux, requestOf(step));
        const text = await res.text();
        expect(`step ${i + 1} ${step.url}: ${res.status}`).toBe(
          `step ${i + 1} ${step.url}: ${step.status}`,
        );
        if (step.status === 429) {
          expect(text.trimEnd()).toBe(
            step.message === undefined
              ? tooManyRequestsBody.trimEnd()
              : `{"data":{},"message":${JSON.stringify(step.message)},"status":429}`,
          );
        }
      }
    });
  }
});

const limitedPath = { target: "/rate/a" };

describe("the client key", () => {
  test("each client IP has its own window", async () => {
    const { mux } = await openCase({
      name: "",
      rules: [{ label: "/rate/a", maxRequests: 1, duration: 60 }],
      steps: [],
    });
    const statusOf = async (remoteAddr: string): Promise<number> =>
      (await serveTest(mux, { ...limitedPath, remoteAddr })).status;

    expect(await statusOf("10.0.0.1:1000")).toBe(404);
    expect(await statusOf("10.0.0.1:2000")).toBe(429);
    expect(await statusOf("10.0.0.2:1000")).toBe(404);
    expect(await statusOf("[::1]:1000")).toBe(404);
  });
});

interface LimiterView {
  clients: Map<string, unknown>;
  totalDeleted: number;
}

function limiter(app: TestApp, id: string): LimiterView {
  const store = app.store.get("__pbRateLimiters__") as { get(id: string): LimiterView };
  return store.get(id);
}

function cleanupJob(app: TestApp): { id: string; run(): void } | undefined {
  return app.cron.jobs().find((j) => j.id === "__pbRateLimitersCleanup__");
}

describe("the cleanup", () => {
  const rules = [{ label: "/rate/a", maxRequests: 1, duration: 60 }];

  async function withClients(n: number): Promise<Awaited<ReturnType<typeof openCase>>> {
    const app = await openCase({ name: "", rules, steps: [] });
    for (let i = 0; i < n; i++) {
      await serveTest(app.mux, {
        ...limitedPath,
        remoteAddr: `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}:1000`,
      });
    }
    return app;
  }

  test("the job exists from the first limiter, with upstream's schedule", async () => {
    const { app, mux } = await openCase({ name: "", rules, steps: [] });
    expect(cleanupJob(app)).toBeUndefined();

    await serveTest(mux, { target: "/norate" });
    expect(cleanupJob(app)).toBeUndefined();

    await serveTest(mux, limitedPath);
    expect(app.cron.jobs().at(-1)?.id).toBe("__pbRateLimitersCleanup__");
    expect(cleanupJob(app)?.schedule.rawExpr).toBe("2 * * * *");
  });

  test("a client is dropped more than 1800 s after its window ended", async () => {
    const { app, clock } = await withClients(2);
    const job = cleanupJob(app);

    clock.advance((60 + 1800) * 1000);
    job?.run();
    expect(limiter(app, "/rate/a").clients.size).toBe(2);

    clock.advance(1000);
    job?.run();
    expect(limiter(app, "/rate/a").clients.size).toBe(0);
    expect(limiter(app, "/rate/a").totalDeleted).toBe(2);
  });

  test("an active client stays, and keeps its allowance", async () => {
    const { app, clock, mux } = await withClients(1);
    clock.advance((60 + 1801) * 1000);
    await serveTest(mux, { ...limitedPath, remoteAddr: "10.0.9.9:1000" });

    cleanupJob(app)?.run();
    expect([...limiter(app, "/rate/a").clients.keys()]).toEqual(["10.0.9.9"]);
    expect((await serveTest(mux, { ...limitedPath, remoteAddr: "10.0.9.9:1000" })).status).toBe(
      429,
    );
  });

  test("a dropped client starts a new window", async () => {
    const { app, clock, mux } = await withClients(1);
    clock.advance((60 + 1801) * 1000);
    cleanupJob(app)?.run();
    expect((await serveTest(mux, { ...limitedPath, remoteAddr: "10.0.0.1:1000" })).status).toBe(
      404,
    );
  });

  test("300 deletions reset the shrink counter", async () => {
    const { app, clock } = await withClients(300);
    clock.advance((60 + 1801) * 1000);
    cleanupJob(app)?.run();
    expect(limiter(app, "/rate/a").clients.size).toBe(0);
    expect(limiter(app, "/rate/a").totalDeleted).toBe(0);
  });

  test("a settings save removes the job and the limiters, until the next check", async () => {
    const { app, mux } = await withClients(1);
    await saveSettings(app, app.settings);
    expect(cleanupJob(app)).toBeUndefined();
    expect(app.store.has("__pbRateLimiters__")).toBe(false);

    await serveTest(mux, limitedPath);
    expect(app.cron.jobs().filter((j) => j.id === "__pbRateLimitersCleanup__").length).toBe(1);
  });

  test("a job that outlives its store does nothing", async () => {
    const { app } = await withClients(1);
    const job = cleanupJob(app);
    await saveSettings(app, app.settings);
    expect(() => job?.run()).not.toThrow();
  });
});
