// The OAuth2 redirect endpoint (src/apis/record-auth-with-oauth2-redirect.ts)
// against the reference PocketBase v0.41.0 binary: each scenario of
// test/scenarios/record-auth-oauth2-redirect.ts runs on its own copy of the
// fixture per server, both must meet the expectations, and the two
// observations (status, Location, body, every SSE message) must be equal
// once client ids are normalized. Not part of `bun test`: run
// `bun run test:reference`.

import { describe, expect, test } from "bun:test";

import { observe } from "@test/realtime/run";
import { normalize } from "@test/realtime/scenario";
import { oauth2RedirectScenarios } from "@test/scenarios/record-auth-oauth2-redirect";
import { startServer } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";

describe("apis/record_auth_with_oauth2_redirect_test.go", () => {
  for (const scenario of oauth2RedirectScenarios) {
    test(`${scenario.func} ${scenario.name}`, async () => {
      const [upstream, igloBase] = await Promise.all([
        observe(scenario, (dataDir) => startUpstream({ dataDir })),
        observe(scenario, (dataDir) => startServer([], dataDir)),
      ]);
      // the expectations describe real upstream behavior
      scenario.check?.(upstream);
      scenario.check?.(igloBase);
      expect(normalize(igloBase, false)).toBe(normalize(upstream, false));
    }, 60_000);
  }
});
