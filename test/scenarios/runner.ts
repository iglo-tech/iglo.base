// Upstream: tests/api.go (ApiScenario.test)
//
// Runs a scenario against the compiled iglo.base executable alone, on a
// fresh copy of the vendored fixture, and checks the response against
// upstream's expectations (or the scenario's deliberate difference). This
// needs no network, so it runs in plain `bun test`.

import { rmSync } from "node:fs";

import { checkExpectations, igloBaseExpectations } from "@test/scenarios/expectations";
import { preparedFixture } from "@test/scenarios/fixture";
import { sendScenarioRequest, type ScenarioResponse } from "@test/scenarios/request";
import type { Expectations, Scenario } from "@test/scenarios/scenario";
import { startServer } from "@test/support/executable";

// The failures of one server's response: the expectation checks after the
// scenario's delay, then its `after` step.
export async function checkResponse(
  scenario: Scenario,
  expected: Expectations,
  server: { url: string; dataDir: string },
  res: ScenarioResponse,
): Promise<string[]> {
  if (scenario.delayMs) {
    await Bun.sleep(scenario.delayMs);
  }
  const failures = checkExpectations(expected, res.status, res.body);
  try {
    await scenario.after?.({ ...server, ...res });
  } catch (error) {
    failures.push(`after: ${error instanceof Error ? error.message : String(error)}`);
  }
  return failures;
}

// Sends the scenario's request; a request that gets no response is a
// failure of the server, not of the runner.
export async function send(
  url: string,
  scenario: Scenario,
): Promise<ScenarioResponse | { error: string }> {
  try {
    return await sendScenarioRequest(url, scenario);
  } catch (error) {
    return { error: `request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// iglo.base's failures for the scenario
export async function runAgainstIgloBase(scenario: Scenario): Promise<string[]> {
  const fixture = await preparedFixture(scenario);
  try {
    const server = await startServer([], fixture.dataDir);
    try {
      const res = await send(server.url, scenario);
      if ("error" in res) {
        return [res.error];
      }
      return await checkResponse(
        scenario,
        igloBaseExpectations(scenario),
        { url: server.url, dataDir: fixture.dataDir },
        res,
      );
    } finally {
      await server.stop();
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}
