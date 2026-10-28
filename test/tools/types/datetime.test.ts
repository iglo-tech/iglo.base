// Upstream: tools/types/datetime_test.go
//
// Upstream reads time.Now(); here the clock is injected. Go integer values
// (int, int32, int64, uint, ...) are bigints, a Go float64 is a number and a
// time.Time is a Date.

import { describe, expect, test } from "bun:test";

import type { Clock } from "@/app/clock";
import {
  DateTime,
  DefaultDateLayout,
  Hour,
  Minute,
  nowDateTime,
  parseDateTime,
} from "@/tools/types/datetime";

const fixedClock = (iso: string): Clock => ({ now: () => new Date(iso) });

const clock = fixedClock("2024-05-06T07:08:09.123Z");
const nowStr = "2024-05-06 07:08:09.123Z";

describe("NowDateTime", () => {
  test("formats the clock's time", () => {
    const now = "2024-05-06 07:08:09"; // without ms part, as upstream
    const dt = nowDateTime(clock);
    expect(dt.string()).toContain(now);
    expect(dt.string()).toBe(nowStr);
  });
});

describe("ParseDateTime", () => {
  const nowTime = clock.now();
  const nowDateTimeValue = parseDateTime(nowTime);

  const scenarios: [unknown, string][] = [
    [null, ""],
    ["", ""],
    ["invalid", ""],
    [nowDateTimeValue, nowStr],
    [nowTime, nowStr],
    [1641024040n, "2022-01-01 08:00:40.000Z"], // int
    [BigInt.asIntN(32, 1641024040n), "2022-01-01 08:00:40.000Z"], // int32
    [BigInt.asIntN(64, 1641024040n), "2022-01-01 08:00:40.000Z"], // int64
    [BigInt.asUintN(64, 1641024040n), "2022-01-01 08:00:40.000Z"], // uint
    [BigInt.asUintN(64, 1641024040n), "2022-01-01 08:00:40.000Z"], // uint64
    [BigInt.asUintN(32, 1641024040n), "2022-01-01 08:00:40.000Z"], // uint32
    ["2022-01-01 11:23:45.678", "2022-01-01 11:23:45.678Z"],
  ];

  scenarios.forEach(([value, expected], i) => {
    test(`${i}_${String(value)}`, () => {
      expect(parseDateTime(value).string()).toBe(expected);
    });
  });
});

describe("DateTimeTime", () => {
  test("returns the parsed instant", () => {
    const dt = parseDateTime("2022-01-01 11:23:45.678Z");
    expect(dt.time().getTime()).toBe(Date.UTC(2022, 0, 1, 11, 23, 45, 678));
  });
});

describe("DateTimeAdd", () => {
  test("returns a new DateTime", () => {
    const d1 = parseDateTime("2024-01-01 10:00:00.123Z");
    const d2 = d1.add(1 * Hour);
    expect(d1.string()).toBe("2024-01-01 10:00:00.123Z");
    expect(d2.string()).toBe("2024-01-01 11:00:00.123Z");
  });
});

describe("DateTimeSub", () => {
  test("returns the duration between two DateTimes", () => {
    const d1 = parseDateTime("2024-01-01 10:00:00.123Z");
    const d2 = parseDateTime("2024-01-01 10:30:00.123Z");
    expect(d2.sub(d1) / Minute).toBe(30);
  });
});

describe("DateTimeAddDate", () => {
  test("returns a new DateTime", () => {
    const d1 = parseDateTime("2024-01-01 10:00:00.123Z");
    const d2 = d1.addDate(1, 2, 3);
    expect(d1.string()).toBe("2024-01-01 10:00:00.123Z");
    expect(d2.string()).toBe("2025-03-04 10:00:00.123Z");
  });
});

const d1 = parseDateTime("2024-01-01 10:00:00.123Z");
const d2 = parseDateTime("2024-01-02 10:00:00.123Z");
const d3 = parseDateTime("2024-01-03 10:00:00.123Z");

describe("DateTimeAfter", () => {
  const scenarios: [DateTime, DateTime, boolean][] = [
    // d1
    [d1, d1, false],
    [d1, d2, false],
    [d1, d3, false],
    // d2
    [d2, d1, true],
    [d2, d2, false],
    [d2, d3, false],
    // d3
    [d3, d1, true],
    [d3, d2, true],
    [d3, d3, false],
  ];

  scenarios.forEach(([a, b, expected], i) => {
    test(`after_${i}`, () => {
      expect(a.after(b)).toBe(expected);
    });
  });
});

describe("DateTimeBefore", () => {
  const scenarios: [DateTime, DateTime, boolean][] = [
    // d1
    [d1, d1, false],
    [d1, d2, true],
    [d1, d3, true],
    // d2
    [d2, d1, false],
    [d2, d2, false],
    [d2, d3, true],
    // d3
    [d3, d1, false],
    [d3, d2, false],
    [d3, d3, false],
  ];

  scenarios.forEach(([a, b, expected], i) => {
    test(`before_${i}`, () => {
      expect(a.before(b)).toBe(expected);
    });
  });
});

describe("DateTimeCompare", () => {
  const scenarios: [DateTime, DateTime, number][] = [
    // d1
    [d1, d1, 0],
    [d1, d2, -1],
    [d1, d3, -1],
    // d2
    [d2, d1, 1],
    [d2, d2, 0],
    [d2, d3, -1],
    // d3
    [d3, d1, 1],
    [d3, d2, 1],
    [d3, d3, 0],
  ];

  scenarios.forEach(([a, b, expected], i) => {
    test(`compare_${i}`, () => {
      expect(a.compare(b)).toBe(expected);
    });
  });
});

describe("DateTimeEqual", () => {
  const e1 = parseDateTime("2024-01-01 10:00:00.123Z");
  const e2 = parseDateTime("2024-01-01 10:00:00.123Z");
  const e3 = parseDateTime("2024-01-01 10:00:00.124Z");

  const scenarios: [DateTime, DateTime, boolean][] = [
    [e1, e1, true],
    [e1, e2, true],
    [e1, e3, false],
  ];

  scenarios.forEach(([a, b, expected], i) => {
    test(`equal_${i}`, () => {
      expect(a.equal(b)).toBe(expected);
    });
  });
});

describe("DateTimeUnix", () => {
  const scenarios: [string, number][] = [
    ["", -62135596800],
    ["2022-01-01 11:23:45.678Z", 1641036225],
  ];

  scenarios.forEach(([date, expected], i) => {
    test(`${i}_${date}`, () => {
      expect(parseDateTime(date).unix()).toBe(expected);
    });
  });
});

describe("DateTimeIsZero", () => {
  test("zero and non-zero", () => {
    expect(new DateTime().isZero()).toBe(true);
    expect(nowDateTime(clock).isZero()).toBe(false);
  });
});

describe("DateTimeString", () => {
  test("zero value and a parsed value", () => {
    expect(new DateTime().string()).toBe("");
    const expected = "2022-01-01 11:23:45.678Z";
    expect(parseDateTime(expected).string()).toBe(expected);
  });
});

describe("DateTimeMarshalJSON", () => {
  const scenarios: [string, string][] = [
    ["", `""`],
    ["2022-01-01 11:23:45.678", `"2022-01-01 11:23:45.678Z"`],
  ];

  scenarios.forEach(([date, expected], i) => {
    test(`${i}_${date}`, () => {
      expect(parseDateTime(date).marshalJSON()).toBe(expected);
    });
  });
});

describe("DateTimeUnmarshalJSON", () => {
  const scenarios: [string, string][] = [
    ["", ""],
    ["invalid_json", ""],
    ["'123'", ""],
    ["2022-01-01 11:23:45.678", ""],
    [`"2022-01-01 11:23:45.678"`, "2022-01-01 11:23:45.678Z"],
  ];

  scenarios.forEach(([date, expected], i) => {
    test(`${i}_${date}`, () => {
      const dt = new DateTime();
      try {
        dt.unmarshalJSON(date);
      } catch {
        // upstream ignores the error and checks the value
      }
      expect(dt.string()).toBe(expected);
    });
  });
});

describe("DateTimeValue", () => {
  const scenarios: [unknown, string][] = [
    ["", ""],
    ["invalid", ""],
    [1641024040n, "2022-01-01 08:00:40.000Z"],
    ["2022-01-01 11:23:45.678", "2022-01-01 11:23:45.678Z"],
    [nowDateTime(clock), nowDateTime(clock).string()],
  ];

  scenarios.forEach(([value, expected], i) => {
    test(`${i}_${String(value)}`, () => {
      expect(parseDateTime(value).value()).toBe(expected);
    });
  });
});

describe("DateTimeScan", () => {
  const now = "2024-05-06 07:08:09"; // without ms part, as upstream

  const scenarios: [unknown, string][] = [
    [null, ""],
    ["", ""],
    ["invalid", ""],
    [nowDateTime(clock), now],
    [clock.now(), now],
    [1.0, ""],
    [1641024040n, "2022-01-01 08:00:40.000Z"],
    ["2022-01-01 11:23:45.678", "2022-01-01 11:23:45.678Z"],
  ];

  scenarios.forEach(([value, expected], i) => {
    test(`${i}_${String(value)}`, () => {
      const dt = new DateTime();
      dt.scan(value);
      expect(dt.string()).toContain(expected);
    });
  });

  // upstream's Contains check passes for "" whatever the value; a Go
  // float64 never parses (cast.ToString gives "1", which matches no layout)
  test("a float64 gives the zero time", () => {
    const dt = new DateTime();
    dt.scan(1641024040);
    expect(dt.isZero()).toBe(true);
  });
});

// Not in upstream's tests: the cast.ToTime layouts Scan falls back to, with
// the results Go's time.Parse and cast v1.10.0 give.
describe("DateTimeScan cast layouts", () => {
  const scenarios: [string, string, string][] = [
    ["default layout", "2022-01-01 11:23:45.678Z", "2022-01-01 11:23:45.678Z"],
    // the default layout needs exactly 3 fraction digits; cast's
    // "2006-01-02 15:04:05Z0700" then takes any fraction and the Z
    [
      "two fraction digits fall back to cast",
      "2022-01-01 11:23:45.67Z",
      "2022-01-01 11:23:45.670Z",
    ],
    ["date only", "2022-01-02", "2022-01-02 00:00:00.000Z"],
    ["RFC3339 Z", "2022-01-02T03:04:05Z", "2022-01-02 03:04:05.000Z"],
    ["RFC3339 offset", "2022-01-02T03:04:05+02:00", "2022-01-02 01:04:05.000Z"],
    ["RFC3339 fraction", "2022-01-02T03:04:05.123456789-01:30", "2022-01-02 04:34:05.123Z"],
    ["RFC3339 comma fraction", "2022-01-02T03:04:05,5Z", "2022-01-02 03:04:05.500Z"],
    ["RFC3339 offset hour 24", "2022-01-02T03:04:05+24:00", "2022-01-01 03:04:05.000Z"],
    ["RFC3339 lower t", "2022-01-02t03:04:05Z", ""],
    ["iso8601 without zone", "2022-01-02T03:04:05", "2022-01-02 03:04:05.000Z"],
    ["RFC1123Z", "Sun, 02 Jan 2022 03:04:05 +0100", "2022-01-02 02:04:05.000Z"],
    [
      "RFC1123 named zone keeps the wall clock",
      "Sun, 02 Jan 2022 03:04:05 PST",
      "2022-01-02 03:04:05.000Z",
    ],
    ["RFC1123 weekday is not checked", "Mon, 02 Jan 2022 03:04:05 GMT", "2022-01-02 03:04:05.000Z"],
    ["RFC1123 case-insensitive names", "sun, 02 JAN 2022 03:04:05 UTC", "2022-01-02 03:04:05.000Z"],
    ["RFC822Z", "02 Jan 22 03:04 -0700", "2022-01-02 10:04:00.000Z"],
    ["RFC822 two-digit year 69 is 1969", "02 Jan 69 03:04 MST", "1969-01-02 03:04:00.000Z"],
    ["RFC822 two-digit year 68 is 2068", "02 Jan 68 03:04 MST", "2068-01-02 03:04:00.000Z"],
    ["RFC850", "Sunday, 02-Jan-22 03:04:05 CET", "2022-01-02 03:04:05.000Z"],
    ["Time.String", "2022-01-02 03:04:05.123456789 +0200 EET", "2022-01-02 01:04:05.123Z"],
    ["Time.String without fraction", "2022-01-02 03:04:05 +0000 UTC", "2022-01-02 03:04:05.000Z"],
    ["RFC3339 without colon", "2022-01-02T03:04:05-0700", "2022-01-02 10:04:05.000Z"],
    ["space and Z0700", "2022-01-02 03:04:05+0100", "2022-01-02 02:04:05.000Z"],
    ["space and Z", "2022-01-02 03:04:05Z", "2022-01-02 03:04:05.000Z"],
    ["DateTime", "2022-01-02 03:04:05", "2022-01-02 03:04:05.000Z"],
    ["DateTime one-digit hour", "2022-01-02 3:04:05", "2022-01-02 03:04:05.000Z"],
    [
      "DateTime fraction beyond nanoseconds",
      "2022-01-02 03:04:05.1234567891",
      "2022-01-02 03:04:05.123Z",
    ],
    ["ANSIC", "Sun Jan  2 03:04:05 2022", "2022-01-02 03:04:05.000Z"],
    ["ANSIC two-digit day", "Sun Jan 12 03:04:05 2022", "2022-01-12 03:04:05.000Z"],
    ["UnixDate", "Sun Jan  2 03:04:05 MST 2022", "2022-01-02 03:04:05.000Z"],
    ["RubyDate", "Sun Jan 02 03:04:05 -0700 2022", "2022-01-02 10:04:05.000Z"],
    ["space and Z07:00", "2022-01-02 03:04:05-07:00", "2022-01-02 10:04:05.000Z"],
    ["date with month name", "02 Jan 2022", "2022-01-02 00:00:00.000Z"],
    ["space -07:00", "2022-01-02 03:04:05 -07:00", "2022-01-02 10:04:05.000Z"],
    ["space -0700", "2022-01-02 03:04:05 -0700", "2022-01-02 10:04:05.000Z"],
    ["Kitchen is year 0", "3:04PM", "0000-01-01 15:04:00.000Z"],
    ["Kitchen 12AM is midnight", "12:04AM", "0000-01-01 00:04:00.000Z"],
    ["Stamp", "Jan  2 15:04:05", "0000-01-02 15:04:05.000Z"],
    ["StampMilli", "Jan  2 15:04:05.123", "0000-01-02 15:04:05.123Z"],
    ["leap day", "2024-02-29", "2024-02-29 00:00:00.000Z"],
    ["no leap day", "2023-02-29", ""],
    ["month out of range", "2022-13-01", ""],
    ["hour out of range", "2022-01-02 24:00:00", ""],
    ["second 60", "2022-01-02 23:59:60", ""],
    ["extra text", "2022-01-02 extra", ""],
    ["leading space", " 2022-01-02", ""],
    ["digits only", "1641024040", ""],
  ];

  for (const [name, value, expected] of scenarios) {
    test(name, () => {
      expect(parseDateTime(value).string()).toBe(expected);
    });
  }
});

describe("DateTime precision", () => {
  test("keeps nanoseconds through Add and comparisons", () => {
    const a = parseDateTime("2022-01-02T03:04:05.123456789Z");
    const b = parseDateTime("2022-01-02T03:04:05.123456788Z");
    expect(a.instant()).toEqual({ sec: 1641092645, nsec: 123456789 });
    expect(a.after(b)).toBe(true);
    expect(a.equal(b)).toBe(false);
    expect(a.sub(b)).toBe(1);
    expect(b.add(1).equal(a)).toBe(true);
    // String truncates to milliseconds, as Go's .000
    expect(a.string()).toBe("2022-01-02 03:04:05.123Z");
  });

  test("AddDate normalizes like time.AddDate", () => {
    expect(parseDateTime("2024-10-31 00:00:00.000Z").addDate(0, 1, 0).string()).toBe(
      "2024-12-01 00:00:00.000Z",
    );
    expect(parseDateTime("2024-02-29 00:00:00.000Z").addDate(1, 0, 0).string()).toBe(
      "2025-03-01 00:00:00.000Z",
    );
  });

  test("DefaultDateLayout", () => {
    expect(DefaultDateLayout).toBe("2006-01-02 15:04:05.000Z");
  });
});
