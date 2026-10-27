// Upstream: tests/api.go (ApiScenario.test, the status and content checks)
//
// Checks a response against a scenario's upstream expectations exactly as
// tests/api.go does, and turns a runner's failures into the scenario's
// outcome, including its pending marker.

import { goNormalizedBody } from "@test/scenarios/json";
import type { Expectations, Scenario } from "@test/scenarios/scenario";

// The failures tests/api.go would report with t.Errorf, in its order: the
// status, then either the empty body check (when neither content list is
// set) or the first missing ExpectedContent item and the first present
// NotExpectedContent item.
export function checkExpectations(
  expected: Expectations,
  status: number,
  body: Uint8Array,
): string[] {
  const failures: string[] = [];
  if (status !== expected.expectedStatus) {
    failures.push(`Expected status code ${expected.expectedStatus}, got ${status}`);
  }

  const content = expected.expectedContent ?? [];
  const notContent = expected.notExpectedContent ?? [];
  if (content.length === 0 && notContent.length === 0) {
    if (body.length !== 0) {
      failures.push(`Expected empty body, got \n${text(body)}`);
    }
    return failures;
  }

  const normalized = Buffer.from(goNormalizedBody(body));
  const missing = content.find((item) => !normalized.includes(item));
  if (missing !== undefined) {
    failures.push(`Cannot find ${missing} in response body \n${text(normalized)}`);
  }
  const present = notContent.find((item) => normalized.includes(item));
  if (present !== undefined) {
    failures.push(`Didn't expect ${present} in response body \n${text(normalized)}`);
  }
  return failures;
}

// The expectations iglo.base is checked against.
export function igloBaseExpectations(scenario: Scenario): Expectations {
  return scenario.difference?.igloBase ?? scenario;
}

export type Outcome = { ok: true; report?: string } | { ok: false; message: string };

// A scenario passes when iglo.base had no failures. A pending scenario
// passes while it still fails, with a report of why; once it has no
// failures it fails, so that the task that fixed it removes the marker.
export function outcome(scenario: Scenario, failures: string[]): Outcome {
  const { pending } = scenario;
  if (!pending) {
    return failures.length === 0 ? { ok: true } : { ok: false, message: failures.join("\n") };
  }
  if (failures.length === 0) {
    return {
      ok: false,
      message: `"${scenario.name}" passes now: remove its pending marker (${pending.task})`,
    };
  }
  const first = failures[0]?.split("\n")[0];
  return {
    ok: true,
    report: `pending on ${pending.task} (${pending.reason}): "${scenario.name}", ${failures.length} failure(s), first: ${first}`,
  };
}

function text(body: Uint8Array): string {
  return new TextDecoder().decode(body);
}
