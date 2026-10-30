// The realtime scenarios (test/scenarios/realtime.ts, upstream's
// apis/realtime_test.go) against the iglo.base executable alone, each on a
// fresh copy of the vendored fixture, checked against upstream's
// expectations. test/differential/realtime/ runs them against upstream too.

import { describe, test } from "bun:test";

import { observe } from "@test/realtime/run";
import { realtimeScenarios } from "@test/scenarios/realtime";
import { startServer } from "@test/support/executable";

describe("apis/realtime_test.go", () => {
  for (const scenario of realtimeScenarios) {
    test(`${scenario.func} ${scenario.name}`, async () => {
      const o = await observe(scenario, (dataDir) => startServer([], dataDir));
      scenario.check?.(o);
    }, 30_000);
  }
});
