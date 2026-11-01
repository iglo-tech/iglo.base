// Upstream: tests/api.go (ApiScenario.test), tests/app.go (NewTestApp)
//
// Differential mode: runs one scenario against upstream PocketBase v0.41.0
// and iglo.base, each on its own fresh copy of the scenario's prepared
// fixture, checks both responses against the scenario's expectations and
// compares them (test/differential/harness/compare.ts).
//
// Layout of one scenario's temporary directory:
//
//   <root>/pb_data            the fixture copy after `prepare`; only read
//   <root>/upstream/pb_data   upstream's copy
//   <root>/iglo-base/pb_data  iglo.base's copy

import { rmSync } from "node:fs";
import { join } from "node:path";

import { compareResponses, readStartingData } from "@test/differential/harness/compare";
import { igloBaseExpectations } from "@test/scenarios/expectations";
import { copyDataDir, preparedFixture } from "@test/scenarios/fixture";
import type { ScenarioResponse } from "@test/scenarios/request";
import { checkResponse, send } from "@test/scenarios/runner";
import type { Scenario } from "@test/scenarios/scenario";
import { startServer } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";

export interface DifferentialResult {
  // upstream against the scenario's expectations; always expected empty,
  // pending or not: the ported expectations must describe upstream
  upstreamFailures: string[];
  // iglo.base against its expectations, then every difference from
  // upstream's response (not compared for a deliberate difference)
  igloBaseFailures: string[];
}

// A raw error text may name a file in the server's own pb_data directory.
function hideDataDir(res: ScenarioResponse, dataDir: string): ScenarioResponse {
  const body = Buffer.from(res.body);
  if (!body.includes(dataDir)) {
    return res;
  }
  return { ...res, body: Buffer.from(body.toString().replaceAll(dataDir, "<pb_data>")) };
}

export async function runDifferential(scenario: Scenario): Promise<DifferentialResult> {
  const fixture = await preparedFixture(scenario);
  try {
    const upstreamDir = join(fixture.root, "upstream", "pb_data");
    const igloBaseDir = join(fixture.root, "iglo-base", "pb_data");
    copyDataDir(fixture.dataDir, upstreamDir);
    copyDataDir(fixture.dataDir, igloBaseDir);
    const start = readStartingData(fixture.dataDir);

    const started = await Promise.allSettled([
      startUpstream({ dataDir: upstreamDir }),
      startServer([], igloBaseDir),
    ]);
    const [upStart, igStart] = started;
    if (upStart.status === "rejected" || igStart.status === "rejected") {
      await Promise.allSettled(started.map((s) => s.status === "fulfilled" && s.value.stop()));
      throw upStart.status === "rejected"
        ? upStart.reason
        : (igStart as PromiseRejectedResult).reason;
    }
    const upstream = upStart.value;
    const igloBase = igStart.value;
    try {
      const [upRes, igRes] = await Promise.all([
        send(upstream.url, scenario),
        send(igloBase.url, scenario),
      ]);
      const [upstreamFailures, igloBaseFailures] = await Promise.all([
        "error" in upRes
          ? [upRes.error]
          : checkResponse(scenario, scenario, { url: upstream.url, dataDir: upstreamDir }, upRes),
        "error" in igRes
          ? [igRes.error]
          : checkResponse(
              scenario,
              igloBaseExpectations(scenario),
              { url: igloBase.url, dataDir: igloBaseDir },
              igRes,
            ),
      ]);
      if (!scenario.difference && !("error" in upRes) && !("error" in igRes)) {
        igloBaseFailures.push(
          ...compareResponses(hideDataDir(upRes, upstreamDir), hideDataDir(igRes, igloBaseDir), {
            start,
            request: scenario,
          }).map((d) => `differs from upstream: ${d}`),
        );
      }
      return { upstreamFailures, igloBaseFailures };
    } finally {
      await Promise.allSettled([upstream.stop(), igloBase.stop()]);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}
