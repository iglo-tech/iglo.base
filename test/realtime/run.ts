// Runs a realtime scenario (test/realtime/scenario.ts) against one server
// on a fresh copy of the vendored fixture.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { ScenarioContext } from "@test/realtime/scenario";
import type { Observation, RealtimeScenario } from "@test/realtime/scenario";

export interface StartedServer {
  url: string;
  stop(): Promise<unknown>;
}

// A new directory with a fresh copy of the fixture as <root>/pb_data.
export function freshFixture() {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-realtime-"));
  const dataDir = join(root, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  return { root, dataDir };
}

// The scenario's observation on a server started on a fresh fixture copy.
export async function observe(
  scenario: RealtimeScenario,
  start: (dataDir: string) => Promise<StartedServer>,
): Promise<Observation> {
  const fixture = freshFixture();
  try {
    const server = await start(fixture.dataDir);
    const ctx = new ScenarioContext(server.url);
    try {
      return await scenario.run(ctx);
    } finally {
      ctx.close();
      await server.stop();
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}
