// OTP auth and OTP-based MFA (src/apis/record-auth-otp-request.ts,
// src/apis/record-auth-with-otp.ts) against the reference PocketBase v0.41.0
// binary, beyond upstream's scenarios: the cases of otp-cases.ts, each on
// fresh copies of the prepared fixture, compared as the scenario harness
// compares. Not part of `bun test`: run `bun run test:reference`.

import { describe, expect, test } from "bun:test";

import { otpCases } from "@test/differential/auth/otp-cases";
import { runDifferential } from "@test/differential/harness/run";
import { outcome } from "@test/scenarios/expectations";

const cases = otpCases();

test("at least 20 cases", () => {
  expect(cases.length).toBeGreaterThanOrEqual(20);
});

describe("otp cases", () => {
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
