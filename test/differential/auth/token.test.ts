// Verification, password reset and email change
// (src/apis/record-auth-verification-*.ts, -password-reset-*.ts,
// -email-change-*.ts) against the reference PocketBase v0.41.0 binary,
// beyond upstream's scenarios: the cases of token-cases.ts, each on fresh
// copies of the prepared fixture, compared as the scenario harness compares.
// Not part of `bun test`: run `bun run test:reference`.

import { describe, expect, test } from "bun:test";

import { tokenCases } from "@test/differential/auth/token-cases";
import { runDifferential } from "@test/differential/harness/run";
import { outcome } from "@test/scenarios/expectations";

const cases = tokenCases();

test("at least 15 cases", () => {
  expect(cases.length).toBeGreaterThanOrEqual(15);
});

describe("verification, password reset and email change cases", () => {
  for (const scenario of cases) {
    test(scenario.name, async () => {
      const { upstreamFailures, igloBaseFailures } = await runDifferential(scenario);
      // the expectations describe real upstream behavior
      expect(upstreamFailures).toEqual([]);
      const result = outcome(scenario, igloBaseFailures);
      if (!result.ok) {
        throw new Error(result.message);
      }
    });
  }
});
