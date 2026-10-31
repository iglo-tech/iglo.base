// The redirect scenarios (test/scenarios/record-auth-oauth2-redirect.ts,
// upstream's apis/record_auth_with_oauth2_redirect_test.go) against the
// iglo.base executable alone, each on a fresh copy of the vendored fixture.
// test/differential/auth/oauth2-redirect.test.ts runs them against upstream too.

import { describe, test } from "bun:test";

import { observe } from "@test/realtime/run";
import { oauth2RedirectScenarios } from "@test/scenarios/record-auth-oauth2-redirect";
import { startServer } from "@test/support/executable";

describe("apis/record_auth_with_oauth2_redirect_test.go", () => {
  for (const scenario of oauth2RedirectScenarios) {
    test(`${scenario.func} ${scenario.name}`, async () => {
      const o = await observe(scenario, (dataDir) => startServer([], dataDir));
      scenario.check?.(o);
    }, 30_000);
  }
});
