// Run by local-zone.test.ts in a child process with the TZ under test:
// prints what each case gives as JSON (case name → result).

import { type DateTime, nowDateTime, parseDateTime } from "@/tools/types/datetime";

const at = (iso: string): DateTime => nowDateTime({ now: () => new Date(iso) });

const cases: Record<string, () => string | number> = {
  // a parsed numeric offset that matches Local is Local
  "parsed +01:00, +1 day over the spring change": () =>
    parseDateTime("2024-03-30T12:00:00+01:00").addDate(0, 0, 1).string(),
  "parsed +02:00, +1 day over the autumn change": () =>
    parseDateTime("2024-10-26T12:00:00+02:00").addDate(0, 0, 1).string(),
  "parsed -04:00, +1 day over the autumn change": () =>
    parseDateTime("2024-11-02T12:00:00-04:00").addDate(0, 0, 1).string(),
  "parsed +01:00, offset after 6 months": () =>
    parseDateTime("2024-01-15T12:00:00+01:00").addDate(0, 6, 0).zoneOffset(),
  // the clock and Go integers (time.Unix) are Local
  "now, +1 day over the spring change (Europe)": () =>
    at("2024-03-30T12:00:00Z").addDate(0, 0, 1).string(),
  "now, +1 day over the spring change (US)": () =>
    at("2024-03-09T17:00:00Z").addDate(0, 0, 1).string(),
  "now, -30 days over the autumn change (log retention)": () =>
    at("2024-11-15T12:00:00Z").addDate(0, 0, -30).string(),
  "unix seconds, +1 day": () =>
    parseDateTime(BigInt(Date.UTC(2024, 2, 30, 12) / 1000))
      .addDate(0, 0, 1)
      .string(),
  "now, zone offset": () => at("2024-07-01T00:00:00Z").zoneOffset(),
  // wall times in a gap or an overlap, resolved as time.Date does
  "now, -1 day into the Europe spring gap": () =>
    at("2024-04-01T00:30:00Z").addDate(0, 0, -1).string(),
  "now, +1 day into the Europe autumn overlap": () =>
    at("2024-10-26T00:30:00Z").addDate(0, 0, 1).string(),
  "now, +1 day into the US spring gap": () => at("2024-03-09T07:30:00Z").addDate(0, 0, 1).string(),
  "now, -1 day into the US autumn overlap": () =>
    at("2024-11-04T06:30:00Z").addDate(0, 0, -1).string(),
  // after the last transition of the TZif data: its TZ rule
  "now, +1 day over the 2040 Europe spring change": () =>
    at("2040-03-24T11:00:00Z").addDate(0, 0, 1).string(),
  "now, +1 day over the 2040 US spring change": () =>
    at("2040-03-10T17:00:00Z").addDate(0, 0, 1).string(),
  "now, +1 day over the 2040 Sydney spring change": () =>
    at("2040-10-06T02:00:00Z").addDate(0, 0, 1).string(),
  // abbreviations: Local's zone of that name, else a zero offset; the
  // named-zone layouts keep the wall clock time.Parse gave
  "CEST in January": () => parseDateTime("Mon, 15 Jan 2024 12:00:00 CEST").string(),
  "CET in July": () => parseDateTime("Mon, 15 Jul 2024 12:00:00 CET").string(),
  "EST in July": () => parseDateTime("Mon, 15 Jul 2024 12:00:00 EST").string(),
  "GMT+3": () => parseDateTime("Mon, 15 Jan 2024 12:00:00 GMT+3").string(),
  // an offset and an abbreviation (Time.String) are Local when both match
  "offset and abbreviation, +3 months": () =>
    parseDateTime("2024-01-15 12:00:00 +0100 CET").addDate(0, 3, 0).string(),
  "offset and another abbreviation, +3 months": () =>
    parseDateTime("2024-01-15 12:00:00 +0100 XYZ").addDate(0, 3, 0).string(),
  // "Z" is UTC whatever Local is
  "Z, +1 day": () => parseDateTime("2024-03-30 12:00:00.000Z").addDate(0, 0, 1).string(),
};

const results: Record<string, string | number> = {};
for (const [name, run] of Object.entries(cases)) {
  results[name] = run();
}
console.log(JSON.stringify(results));
