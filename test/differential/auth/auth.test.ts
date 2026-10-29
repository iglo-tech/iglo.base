// Password auth, refresh, auth methods, impersonate and MFA
// (src/apis/record-auth*.ts) against the reference PocketBase v0.41.0
// binary, beyond upstream's scenarios: the cases of cases.ts, each on
// fresh copies of the prepared fixture, compared as the scenario harness
// compares. Not part of `bun test`: run `bun run test:reference`.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reloadCachedCollections } from "@/collections/collection-query";
import { findRecordById } from "@/records/record-query";
import { newAuthToken, newFileToken } from "@/records/record-tokens";

import { openDataDir } from "@test/collections/app";
import { authCases, type CaseTokens } from "@test/differential/auth/cases";
import { runDifferential } from "@test/differential/harness/run";
import { outcome } from "@test/scenarios/expectations";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";

// tokens signed with the keys of a copy of the fixture
function caseTokens(): CaseTokens {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-auth-tokens-"));
  const dataDir = join(root, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  const app = openDataDir(dataDir);
  try {
    reloadCachedCollections(app);
    const user = findRecordById(app, "users", "4q1xlclmfloku33");
    // issued a year ago, so it has expired
    const past = { now: () => new Date(Date.now() - 365 * 24 * 3600 * 1000) };
    return {
      usersExpired: newAuthToken(user, past),
      usersFile: newFileToken(user, app.clock),
    };
  } finally {
    app.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}

const cases = authCases(caseTokens());

test("at least 30 cases", () => {
  expect(cases.length).toBeGreaterThanOrEqual(30);
});

describe("auth cases", () => {
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
