// Upstream: tests/app.go (NewTestApp, TempDirClone)
//
// Fixture copies for scenarios. The vendored fixture in test/fixtures/pocketbase
// is upstream's tests/data; it is only ever copied, never opened, so that no
// SQLite -shm or -wal file appears next to it.

import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { Scenario } from "@test/scenarios/scenario";

export const fixtureDir = resolve(import.meta.dir, "../fixtures/pocketbase");

// files of the vendored directory that are not part of upstream's tests/data
const vendoredOnly = new Set(["README.md"]);

// Copies srcDir to destDir, as TempDirClone does with tests/data. Applied to
// the vendored fixture, leaves out vendoredOnly.
export function copyDataDir(srcDir: string, destDir: string): void {
  cpSync(srcDir, destDir, {
    recursive: true,
    // both servers of a differential run see the same mod times
    preserveTimestamps: true,
    filter: (src) => !(srcDir === fixtureDir && vendoredOnly.has(src.slice(srcDir.length + 1))),
  });
}

export function vendoredOnlyFile(name: string): boolean {
  return vendoredOnly.has(name);
}

// A new scenario directory with a fresh copy of the fixture as
// <root>/pb_data, after the scenario's prepare step.
export async function preparedFixture(
  scenario: Scenario,
): Promise<{ root: string; dataDir: string }> {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-scenario-"));
  const dataDir = join(root, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  await scenario.prepare?.({ dataDir });
  return { root, dataDir };
}
