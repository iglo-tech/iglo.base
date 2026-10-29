// Upstream: tools/cron/schedule.go
//
// The cron expression parser. The settings validation (backups.cron, M1.3)
// needs NewSchedule's errors; the scheduler itself (tools/cron/cron.go) is
// M5.6. Go's map[int]struct{} slots are Sets here.

import { goQuote } from "@/fields/field";

// Moment represents a parsed single time moment.
export interface Moment {
  minute: number;
  hour: number;
  day: number;
  month: number;
  dayOfWeek: number;
}

// NewMoment creates a new Moment from the specified time (in UTC; Go uses
// the time's own location).
export function newMoment(t: Date): Moment {
  return {
    minute: t.getUTCMinutes(),
    hour: t.getUTCHours(),
    day: t.getUTCDate(),
    month: t.getUTCMonth() + 1,
    dayOfWeek: t.getUTCDay(),
  };
}

// Schedule stores parsed information for each time component when a cron job should run.
export class Schedule {
  constructor(
    readonly minutes: Set<number>,
    readonly hours: Set<number>,
    readonly days: Set<number>,
    readonly months: Set<number>,
    readonly daysOfWeek: Set<number>,
    readonly rawExpr: string,
  ) {}

  // IsDue checks whether the provided Moment satisfies the current Schedule.
  isDue(m: Moment): boolean {
    return (
      this.minutes.has(m.minute) &&
      this.hours.has(m.hour) &&
      this.days.has(m.day) &&
      this.daysOfWeek.has(m.dayOfWeek) &&
      this.months.has(m.month)
    );
  }
}

const macros = new Map<string, string>([
  ["@yearly", "0 0 1 1 *"],
  ["@annually", "0 0 1 1 *"],
  ["@monthly", "0 0 1 * *"],
  ["@weekly", "0 0 * * 0"],
  ["@daily", "0 0 * * *"],
  ["@midnight", "0 0 * * *"],
  ["@hourly", "0 * * * *"],
]);

// NewSchedule creates a new Schedule from a cron expression.
//
// A cron expression could be a macro OR 5 segments separated by space,
// representing: minute, hour, day of the month, month and day of the week.
//
// The following segment formats are supported:
//   - wildcard: *
//   - range:    1-30
//   - step:     */n or 1-30/n
//   - list:     1,2,3,10-20/n
//
// The following macros are supported:
//   - @yearly (or @annually)
//   - @monthly
//   - @weekly
//   - @daily (or @midnight)
//   - @hourly
//
// Throws the parse error.
export function newSchedule(cronExpr: string): Schedule {
  cronExpr = macros.get(cronExpr) ?? cronExpr;

  const segments = cronExpr.split(" ");
  if (segments.length !== 5) {
    throw new Error(
      "invalid cron expression - must be a valid macro or to have exactly 5 space separated segments",
    );
  }

  const [m, h, d, mo, dw] = segments as [string, string, string, string, string];
  const minutes = parseCronSegment(m, 0, 59);
  const hours = parseCronSegment(h, 0, 23);
  const days = parseCronSegment(d, 1, 31);
  const months = parseCronSegment(mo, 1, 12);
  const daysOfWeek = parseCronSegment(dw, 0, 6);

  return new Schedule(minutes, hours, days, months, daysOfWeek, cronExpr);
}

// parseCronSegment parses a single cron expression segment and
// returns its time schedule slots.
function parseCronSegment(segment: string, min: number, max: number): Set<number> {
  const slots = new Set<number>();

  const list = segment.split(",");
  for (const p of list) {
    const stepParts = p.split("/");

    // step (*/n, 1-30/n)
    let step: number;
    switch (stepParts.length) {
      case 1:
        step = 1;
        break;
      case 2: {
        const parsedStep = atoi(stepParts[1] as string);
        if (parsedStep < 1 || parsedStep > max) {
          throw new Error(
            `invalid segment step boundary - the step must be between 1 and the ${max}`,
          );
        }
        step = Number(parsedStep);
        break;
      }
      default:
        throw new Error("invalid segment step format - must be in the format */n or 1-30/n");
    }

    // find the min and max range of the segment part
    let rangeMin: number;
    let rangeMax: number;
    if (stepParts[0] === "*") {
      rangeMin = min;
      rangeMax = max;
    } else {
      // single digit (1) or range (1-30)
      const rangeParts = (stepParts[0] as string).split("-");
      switch (rangeParts.length) {
        case 1: {
          if (step !== 1) {
            throw new Error(
              "invalid segment step - step > 1 could be used only with the wildcard or range format",
            );
          }
          const parsed = atoi(rangeParts[0] as string);
          if (parsed < min || parsed > max) {
            throw new Error(
              "invalid segment value - must be between the min and max of the segment",
            );
          }
          rangeMin = Number(parsed);
          rangeMax = rangeMin;
          break;
        }
        case 2: {
          const parsedMin = atoi(rangeParts[0] as string);
          if (parsedMin < min || parsedMin > max) {
            throw new Error(`invalid segment range minimum - must be between ${min} and ${max}`);
          }
          rangeMin = Number(parsedMin);

          const parsedMax = atoi(rangeParts[1] as string);
          if (parsedMax < parsedMin || parsedMax > max) {
            throw new Error(
              `invalid segment range maximum - must be between ${rangeMin} and ${max}`,
            );
          }
          rangeMax = Number(parsedMax);
          break;
        }
        default:
          throw new Error("invalid segment range format - the range must have 1 or 2 parts");
      }
    }

    // fill the slots
    for (let i = rangeMin; i <= rangeMax; i += step) {
      slots.add(i);
    }
  }

  return slots;
}

const maxUint64 = 2n ** 64n - 1n;

// strconv.Atoi (int is 64 bits): an optional sign and decimal digits; the
// first problem met while reading the digits decides the error. The result
// is exact (bigint) so that out-of-range values compare as Go's do.
function atoi(s0: string): bigint {
  let s = s0;
  let neg = false;
  if (s[0] === "+" || s[0] === "-") {
    neg = s[0] === "-";
    s = s.slice(1);
  }
  if (s === "") {
    throw numError(s0, "invalid syntax");
  }
  let n = 0n;
  for (const c of s) {
    if (c < "0" || c > "9") {
      throw numError(s0, "invalid syntax");
    }
    n = n * 10n + BigInt(c.charCodeAt(0) - 0x30);
    if (n > maxUint64) {
      throw numError(s0, "value out of range");
    }
  }
  const cutoff = 2n ** 63n;
  if ((!neg && n >= cutoff) || (neg && n > cutoff)) {
    throw numError(s0, "value out of range");
  }
  return neg ? -n : n;
}

function numError(num: string, err: string): Error {
  return new Error(`strconv.Atoi: parsing ${goQuote(num)}: ${err}`);
}
