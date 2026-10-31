// Upstream: apis/middlewares_rate_limit_test.go. Each case of cases.ts runs
// against upstream PocketBase v0.41.0 and iglo.base, each on its own copy of
// the prepared fixture: the same steps at the same time, with the same
// statuses, Content-Type and error bodies. Not part of `bun test`: run
// `bun run test:reference`.
//
// Upstream's window tests run in a fake-time bubble; the reference binary
// runs on the wall clock, so a `timed` case waits for real: it starts just
// after a whole second, and if a step misses the second it was planned for
// (a busy host), the case starts again on fresh servers.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { type Case, cases, prepareCase, type Step } from "@test/differential/rate-limit/cases";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { startServer, tempDir } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";

const timeout = 120_000;
const timedAttempts = 5;
// where in its second a timed case starts
const startOffsetMs = 20;

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Reply {
  status: number;
  contentType: string | null;
  body: string;
}

async function send(baseURL: string, step: Step): Promise<Reply> {
  const headers: Record<string, string> = { ...step.headers };
  let body: string | undefined;
  if (step.body !== undefined) {
    headers["Content-Type"] ??= "application/json";
    body = typeof step.body === "string" ? step.body : JSON.stringify(step.body);
  }
  const res = await fetch(baseURL + step.url, {
    method: step.method ?? "GET",
    headers,
    redirect: "manual",
    ...(body === undefined ? {} : { body }),
  });
  return {
    status: res.status,
    contentType: res.headers.get("Content-Type"),
    body: await res.text(),
  };
}

function failures(step: Step, index: number, upstream: Reply, igloBase: Reply): string[] {
  const at = `step ${index + 1} ${step.method ?? "GET"} ${step.url}`;
  const out: string[] = [];
  if (upstream.status !== step.status) {
    out.push(`${at}: upstream answered ${upstream.status}, expected ${step.status}`);
  }
  if (igloBase.status !== upstream.status) {
    out.push(`${at}: iglo.base answered ${igloBase.status}, upstream ${upstream.status}`);
  }
  if (igloBase.contentType !== upstream.contentType) {
    out.push(`${at}: Content-Type ${igloBase.contentType}, upstream ${upstream.contentType}`);
  }
  if ((upstream.status >= 400 || step.compareBody) && igloBase.body !== upstream.body) {
    out.push(`${at}: iglo.base body ${igloBase.body}, upstream body ${upstream.body}`);
  }
  return out;
}

// the case on two fresh servers; null when a timed step missed its second
async function runCase(c: Case): Promise<string[] | null> {
  const root = tempDir();
  roots.push(root);
  const prepared = join(root, "pb_data");
  copyDataDir(fixtureDir, prepared);
  prepareCase(c, { dataDir: prepared });
  const upstreamDir = join(root, "upstream", "pb_data");
  const igloBaseDir = join(root, "iglo-base", "pb_data");
  copyDataDir(prepared, upstreamDir);
  copyDataDir(prepared, igloBaseDir);

  const upstream = await startUpstream({ dataDir: upstreamDir });
  try {
    const igloBase = await startServer([], igloBaseDir);
    try {
      const out: string[] = [];
      const startSecond = Math.floor(Date.now() / 1000) + 1;
      if (c.timed) {
        await Bun.sleep(startSecond * 1000 + startOffsetMs - Date.now());
      }
      let planned = startSecond * 1000 + startOffsetMs;
      for (const [i, step] of c.steps.entries()) {
        planned += step.waitMs ?? 0;
        if (c.timed && step.waitMs) {
          await Bun.sleep(Math.max(0, planned - Date.now()));
        }
        const sentAt = Date.now();
        const [up, ig] = await Promise.all([send(upstream.url, step), send(igloBase.url, step)]);
        if (c.timed) {
          const second = Math.floor(planned / 1000);
          if (Math.floor(sentAt / 1000) !== second || Math.floor(Date.now() / 1000) !== second) {
            return null;
          }
        }
        out.push(...failures(step, i, up, ig));
      }
      return out;
    } finally {
      await igloBase.stop();
    }
  } finally {
    await upstream.stop();
  }
}

describe("rate limit cases against both servers", () => {
  for (const c of cases) {
    test(
      c.name,
      async () => {
        for (let attempt = 0; attempt < (c.timed ? timedAttempts : 1); attempt++) {
          const result = await runCase(c);
          if (result !== null) {
            expect(result).toEqual([]);
            return;
          }
        }
        throw new Error(`no attempt of "${c.name}" kept to its seconds`);
      },
      timeout * 2,
    );
  }
});
