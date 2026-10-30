// Realtime against the reference PocketBase v0.41.0 binary: upstream's
// realtime tests (test/scenarios/realtime.ts) and the extra cases
// (test/differential/realtime/cases.ts). Each runs on its own fresh copy of
// the vendored fixture per server, both servers at once; both must meet
// the scenario's expectations, and the two observations (statuses, bodies,
// every SSE event) must be equal once client ids and timestamps are
// normalized (test/realtime/scenario.ts). Not part of `bun test`: run
// `bun run test:reference`.

import { describe, expect, test } from "bun:test";

import { realtimeCases } from "@test/differential/realtime/cases";
import { observe } from "@test/realtime/run";
import { normalize, type RealtimeScenario } from "@test/realtime/scenario";
import { realtimeScenarios } from "@test/scenarios/realtime";
import { startServer } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";

function differential(scenario: RealtimeScenario): void {
  test(`${scenario.func} ${scenario.name}`, async () => {
    const [upstream, igloBase] = await Promise.all([
      observe(scenario, (dataDir) => startUpstream({ dataDir })),
      observe(scenario, (dataDir) => startServer([], dataDir)),
    ]);
    // the expectations describe real upstream behavior
    scenario.check?.(upstream);
    scenario.check?.(igloBase);
    const unordered = scenario.unorderedData === true;
    expect(normalize(igloBase, unordered)).toBe(normalize(upstream, unordered));
  }, 60_000);
}

describe("apis/realtime_test.go", () => {
  for (const scenario of realtimeScenarios) {
    differential(scenario);
  }
});

describe("realtime differential cases", () => {
  for (const scenario of realtimeCases) {
    differential(scenario);
  }
});
