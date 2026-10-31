// Upstream: core/base.go, __pbLogsCleanup__ (time.Now().AddDate(0, 0, -MaxDays)).
// The retention days are calendar days in the server's zone, with a wall clock
// in a DST gap or overlap resolved as time.Date does. The cutoffs were read
// from Go's rules and the upstream binary (M5.6 review); each zone runs in its
// own process.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const probe = join(import.meta.dir, "cron-logs-zone-probe.ts");

function left(tz: string, now: string, cutoff: string, afterCutoff: string): string[] {
  const result = Bun.spawnSync(
    [process.execPath, probe, now, "7", `probe-at=${cutoff}`, `probe-after=${afterCutoff}`],
    { env: { ...process.env, TZ: tz }, stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return JSON.parse(result.stdout.toString()) as string[];
}

describe("__pbLogsCleanup__ cutoff", () => {
  for (const [name, tz, now, cutoff, afterCutoff] of [
    [
      "New York, into the spring gap",
      "America/New_York",
      "2026-03-15T06:00:00Z",
      "2026-03-08 06:00:00.000Z",
      "2026-03-08 06:00:00.001Z",
    ],
    [
      "Berlin, into the autumn overlap",
      "Europe/Berlin",
      "2026-11-01T01:30:00Z",
      "2026-10-25 01:30:00.000Z",
      "2026-10-25 01:30:00.001Z",
    ],
  ] as const) {
    test(name, () => {
      expect(left(tz, now, cutoff, afterCutoff)).toEqual(["probe-after"]);
    });
  }
});
