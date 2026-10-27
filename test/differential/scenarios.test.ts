// Differential mode: every ported scenario against upstream PocketBase
// v0.41.0 and iglo.base, each server on its own fresh copy of the vendored
// fixture. Upstream must meet the scenario's expectations; iglo.base must
// meet them too and answer like upstream after normalization
// (test/differential/harness/compare.ts). Not part of `bun test`: run
// `bun run test:reference`.

import { describe, expect, test } from "bun:test";

import { runDifferential } from "@test/differential/harness/run";
import { outcome } from "@test/scenarios/expectations";
import { suites } from "@test/scenarios/suites";

for (const suite of suites) {
  describe(`${suite.file} ${suite.func}`, () => {
    for (const scenario of suite.scenarios) {
      test(scenario.name, async () => {
        const { upstreamFailures, igloBaseFailures } = await runDifferential(scenario);
        // the ported expectations describe real upstream behavior
        expect(upstreamFailures).toEqual([]);
        const result = outcome(scenario, igloBaseFailures);
        if (!result.ok) {
          throw new Error(result.message);
        }
        if (result.report) {
          console.log(result.report);
        }
      });
    }
  });
}
