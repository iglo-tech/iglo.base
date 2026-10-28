// Upstream-expectation mode: every ported scenario against the compiled
// iglo.base executable alone, each on its own copy of the vendored fixture,
// checked against upstream's expectations as tests/api.go checks them.
// `bun run test:reference` runs the same scenarios against both servers
// (test/differential/scenarios.test.ts).

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { outcome } from "@test/scenarios/expectations";
import { fixtureDir } from "@test/scenarios/fixture";
import { runAgainstIgloBase } from "@test/scenarios/runner";
import { suites } from "@test/scenarios/suites";

// every path and file of the vendored fixture
function fixtureHash(): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(fixtureDir, { recursive: true, encoding: "utf8" }).toSorted()) {
    const path = join(fixtureDir, name);
    hash.update(`${name}\0`);
    if (statSync(path).isFile()) {
      hash.update(readFileSync(path));
    }
  }
  return hash.digest("hex");
}

const fixtureBefore = fixtureHash();

for (const suite of suites) {
  describe(`${suite.file} ${suite.func}`, () => {
    for (const scenario of suite.scenarios) {
      test(scenario.name, async () => {
        const result = outcome(scenario, await runAgainstIgloBase(scenario));
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

test("the vendored fixture is never written", () => {
  expect(fixtureHash()).toBe(fixtureBefore);
});
