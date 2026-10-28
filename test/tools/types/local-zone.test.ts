// Not in upstream's tests: Go's time.Local. Each TZ value runs
// local-zone-probe.ts in its own process, since Go (and this port) read
// the local zone from the environment. The expected values follow Go's
// time.Parse, time.Date and AddDate in that zone.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const probe = join(import.meta.dir, "local-zone-probe.ts");

function run(tz: string | undefined): Record<string, string | number> {
  const env: Record<string, string | undefined> = { ...process.env, TZ: tz };
  if (tz === undefined) {
    delete env["TZ"];
  }
  const result = Bun.spawnSync([process.execPath, probe], { env, stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return JSON.parse(result.stdout.toString()) as Record<string, string | number>;
}

// what every zone without DST changes on these dates gives (UTC, fixed
// offsets and the wall clock read as UTC)
const base: Record<string, string | number> = {
  "parsed +01:00, +1 day over the spring change": "2024-03-31 11:00:00.000Z",
  "parsed +02:00, +1 day over the autumn change": "2024-10-27 10:00:00.000Z",
  "parsed -04:00, +1 day over the autumn change": "2024-11-03 16:00:00.000Z",
  "parsed +01:00, offset after 6 months": 3600,
  "now, +1 day over the spring change (Europe)": "2024-03-31 12:00:00.000Z",
  "now, +1 day over the spring change (US)": "2024-03-10 17:00:00.000Z",
  "now, -30 days over the autumn change (log retention)": "2024-10-16 12:00:00.000Z",
  "unix seconds, +1 day": "2024-03-31 12:00:00.000Z",
  "now, zone offset": 0,
  "now, -1 day into the Europe spring gap": "2024-03-31 00:30:00.000Z",
  "now, +1 day into the Europe autumn overlap": "2024-10-27 00:30:00.000Z",
  "now, +1 day into the US spring gap": "2024-03-10 07:30:00.000Z",
  "now, -1 day into the US autumn overlap": "2024-11-03 06:30:00.000Z",
  "now, +1 day over the 2040 Europe spring change": "2040-03-25 11:00:00.000Z",
  "now, +1 day over the 2040 US spring change": "2040-03-11 17:00:00.000Z",
  "now, +1 day over the 2040 Sydney spring change": "2040-10-07 02:00:00.000Z",
  "CEST in January": "2024-01-15 12:00:00.000Z",
  "CET in July": "2024-07-15 12:00:00.000Z",
  "EST in July": "2024-07-15 12:00:00.000Z",
  // Go keeps the wall clock as UTC and records the offset: 15:00 in GMT+3
  "GMT+3": "2024-01-15 15:00:00.000Z",
  "offset and abbreviation, +3 months": "2024-04-15 11:00:00.000Z",
  "offset and another abbreviation, +3 months": "2024-04-15 11:00:00.000Z",
  "Z, +1 day": "2024-03-31 12:00:00.000Z",
};

const warsaw = {
  ...base,
  "parsed +01:00, +1 day over the spring change": "2024-03-31 10:00:00.000Z",
  "parsed +02:00, +1 day over the autumn change": "2024-10-27 11:00:00.000Z",
  "parsed +01:00, offset after 6 months": 7200,
  "now, +1 day over the spring change (Europe)": "2024-03-31 11:00:00.000Z",
  "now, -30 days over the autumn change (log retention)": "2024-10-16 11:00:00.000Z",
  "unix seconds, +1 day": "2024-03-31 11:00:00.000Z",
  "now, zone offset": 7200,
  // 02:30 on March 31 does not exist: 03:30 CEST
  "now, -1 day into the Europe spring gap": "2024-03-31 01:30:00.000Z",
  // 02:30 on October 27 exists twice: Go picks CET (east of UTC)
  "now, +1 day into the Europe autumn overlap": "2024-10-27 01:30:00.000Z",
  "now, +1 day over the 2040 Europe spring change": "2040-03-25 10:00:00.000Z",
  // CEST is not in effect in January: its offset, then the CET wall clock
  "CEST in January": "2024-01-15 11:00:00.000Z",
  "CET in July": "2024-07-15 13:00:00.000Z",
  "offset and abbreviation, +3 months": "2024-04-15 10:00:00.000Z",
};

const newYork = {
  ...base,
  "parsed -04:00, +1 day over the autumn change": "2024-11-03 17:00:00.000Z",
  "now, +1 day over the spring change (US)": "2024-03-10 16:00:00.000Z",
  "now, -30 days over the autumn change (log retention)": "2024-10-16 11:00:00.000Z",
  "now, zone offset": -14400,
  // 02:30 on March 10 does not exist: Go gives 01:30 EST (west of UTC)
  "now, +1 day into the US spring gap": "2024-03-10 06:30:00.000Z",
  // 01:30 on November 3 exists twice: Go picks EDT (west of UTC)
  "now, -1 day into the US autumn overlap": "2024-11-03 05:30:00.000Z",
  "now, +1 day over the 2040 US spring change": "2040-03-11 16:00:00.000Z",
  "EST in July": "2024-07-15 13:00:00.000Z",
};

const kolkata = { ...base, "now, zone offset": 19800 };

const sydney = {
  ...base,
  "now, zone offset": 36000,
  "now, +1 day over the 2040 Sydney spring change": "2040-10-07 01:00:00.000Z",
};

// a TZif file with no transitions, only zones and a TZ rule (EST5EDT)
function ruleOnlyTZif(): string {
  const abbrev = Buffer.from("EST\0EDT\0");
  const counts = Buffer.alloc(24);
  counts.writeUInt32BE(2, 16); // zones
  counts.writeUInt32BE(abbrev.length, 20); // abbreviation characters
  const zones = Buffer.alloc(12);
  zones.writeInt32BE(-18000, 0);
  zones.writeUInt8(0, 4);
  zones.writeUInt8(0, 5);
  zones.writeInt32BE(-14400, 6);
  zones.writeUInt8(1, 10);
  zones.writeUInt8(4, 11);
  const header = Buffer.concat([Buffer.from("TZif2"), Buffer.alloc(15)]);
  const block = Buffer.concat([header, counts, zones, abbrev]);
  const file = join(mkdtempSync(join(tmpdir(), "tzif-")), "EST5EDT-rule");
  writeFileSync(file, Buffer.concat([block, block, Buffer.from("\nEST5EDT,M3.2.0,M11.1.0\n")]));
  return file;
}

describe("time.Local", () => {
  const scenarios: [string, string | undefined, Record<string, string | number>][] = [
    ["UTC", "UTC", base],
    ["Europe/Warsaw", "Europe/Warsaw", warsaw],
    ["America/New_York", "America/New_York", newYork],
    ["Asia/Kolkata", "Asia/Kolkata", kolkata],
    ["Australia/Sydney", "Australia/Sydney", sydney],
    ["an empty TZ is UTC", "", base],
    ["a leading colon is dropped", ":Europe/Warsaw", warsaw],
    ["an absolute path", "/usr/share/zoneinfo/America/New_York", newYork],
    ["an unknown zone is UTC", "Foo/Bar", base],
  ];

  for (const [name, tz, expected] of scenarios) {
    test(name, () => {
      expect(run(tz)).toEqual(expected);
    });
  }

  test("a TZ rule after the last transition", () => {
    expect(run(ruleOnlyTZif())).toEqual(newYork);
  });
});
