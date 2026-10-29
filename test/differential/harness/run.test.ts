// runDifferential on variations of a real scenario: upstream is held to the
// expectations, and the pending marker is enforced in differential mode too.

import { expect, test } from "bun:test";

import { runDifferential } from "@test/differential/harness/run";
import { outcome } from "@test/scenarios/expectations";
import { healthAPI } from "@test/scenarios/health";
import type { Scenario } from "@test/scenarios/scenario";

const [guest] = healthAPI.scenarios as [Scenario];

test("expectations upstream does not meet are upstream failures", async () => {
  const result = await runDifferential({ ...guest, expectedStatus: 201 });
  expect(result.upstreamFailures).toEqual(["Expected status code 201, got 200"]);
  expect(result.igloBaseFailures).toEqual(["Expected status code 201, got 200"]);
});

test("a pending scenario that passes against both servers fails", async () => {
  const scenario = { ...guest, pending: { task: "M9.9", reason: "test" } };
  const result = await runDifferential(scenario);
  expect(result).toEqual({ upstreamFailures: [], igloBaseFailures: [] });
  expect(outcome(scenario, result.igloBaseFailures).ok).toBe(false);
});

test("a deliberate difference checks iglo.base against its own expectations", async () => {
  const superuser = healthAPI.scenarios[2] as Scenario;
  const difference = (expectedContent: string[]) => ({
    ...superuser,
    difference: {
      name: "Hook side effects",
      igloBase: { expectedStatus: 200, expectedContent },
    },
  });
  expect(await runDifferential(difference(['"canBackup":true']))).toEqual({
    upstreamFailures: [],
    igloBaseFailures: [],
  });
  const result = await runDifferential(difference(['"data":{}']));
  expect(result.upstreamFailures).toEqual([]);
  expect(result.igloBaseFailures).toHaveLength(1);
});
