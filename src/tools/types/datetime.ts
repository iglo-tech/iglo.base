// Upstream: tools/types/datetime.go
//
// A DateTime keeps Go's precision: Unix seconds plus nanoseconds, not only a
// JS Date. Durations are Go time.Duration values: integer nanoseconds as a
// number (exact up to 2^53 ns, about 104 days, and for larger multiples of
// a second; see the constants below).
//
// Go's Scan switches on static types; here the JS type decides: a bigint is
// a Go integer (Unix seconds), a number a float64 (cast to a string first,
// which never parses as a date, as upstream), a string is parsed, a Date is a
// time.Time.
//
// Like Go's time.Time, a DateTime also keeps the location it was parsed in:
// UTC, Local (the process time zone, read as Go reads it, see
// go-zoneinfo.ts) or a fixed zone. NowDateTime, clock Dates and Go integers
// (time.Unix) are Local; time.Parse picks the location as Go does (a
// numeric offset or abbreviation that Local has at that instant is Local).
// Only AddDate depends on it (calendar arithmetic is done in the location,
// following its DST rules as time.Date does); comparisons are on the
// instant and String is in UTC.

import type { Clock } from "@/app/clock";
import {
  toString as castToString,
  toTimeLocated as castToTimeLocated,
  fromDate,
  zeroInstant,
} from "@/tools/types/cast";
import { stringType, unmarshal } from "@/tools/types/go-json";
import { type Instant, appendInt, fieldsOf, parse, unixToInternal } from "@/tools/types/go-time";
import {
  type Location,
  UTC,
  dateIn,
  localLocation,
  lookup,
  parsedTime,
} from "@/tools/types/go-zoneinfo";

// DefaultDateLayout specifies the default app date strings layout.
export const DefaultDateLayout = "2006-01-02 15:04:05.000Z";

// time.Duration units, in nanoseconds
export const Nanosecond = 1;
export const Microsecond = 1000 * Nanosecond;
export const Millisecond = 1000 * Microsecond;
export const Second = 1000 * Millisecond;
export const Minute = 60 * Second;
export const Hour = 60 * Minute;

const maxDuration = 2 ** 63 - 1;
const minDuration = -(2 ** 63);

// NowDateTime (nowDateTime) returns a new DateTime with the clock's current
// time, in Local (time.Now).
export function nowDateTime(clock: Clock): DateTime {
  return DateTime.fromDate(clock.now());
}

// ParseDateTime (parseDateTime) creates a new DateTime from the provided value (a
// cast.ToTime supported string, a DateTime, a Date, a bigint of Unix
// seconds, etc.).
export function parseDateTime(value: unknown): DateTime {
  const d = new DateTime();
  d.scan(value);
  return d;
}

// DateTime represents an instant in UTC that is serialized using the app
// default date layout.
export class DateTime {
  // Unix seconds and nanoseconds in [0, 1e9); Go's zero time by default
  private sec = zeroInstant.sec;
  private nsec = 0;
  // the location (time.Time's loc)
  private loc: Location = UTC;

  // the instant in loc (UTC by default)
  static fromInstant(t: Instant, loc: Location = UTC): DateTime {
    const d = new DateTime();
    d.sec = t.sec + Math.floor(t.nsec / 1e9);
    d.nsec = ((t.nsec % 1e9) + 1e9) % 1e9;
    d.loc = loc;
    return d;
  }

  // a time from the clock (time.Now), in Local
  static fromDate(t: Date): DateTime {
    return DateTime.fromInstant(fromDate(t), localLocation());
  }

  // Time returns the instant as a JS Date (millisecond precision).
  time(): Date {
    return new Date(this.sec * 1000 + Math.floor(this.nsec / 1e6));
  }

  // the instant with its full precision
  instant(): Instant {
    return { sec: this.sec, nsec: this.nsec };
  }

  // the offset in seconds east of UTC of the location at the instant
  // (Time().Zone())
  zoneOffset(): number {
    return lookup(this.loc, this.sec).offset;
  }

  // Add returns a new DateTime based on the current DateTime + the
  // duration (nanoseconds).
  add(duration: number): DateTime {
    const sec = Math.trunc(duration / 1e9);
    return DateTime.fromInstant(
      { sec: this.sec + sec, nsec: this.nsec + (duration - sec * 1e9) },
      this.loc,
    );
  }

  // Sub returns the duration (nanoseconds) between the current DateTime and
  // u, clamped to the time.Duration range.
  sub(u: DateTime): number {
    const d = BigInt(this.sec - u.sec) * 1_000_000_000n + BigInt(this.nsec - u.nsec);
    return Math.min(maxDuration, Math.max(minDuration, Number(d)));
  }

  // AddDate returns a new DateTime with the years, months and days added,
  // normalized as time.AddDate does (October 31 + 1 month is December 1),
  // on the calendar of the DateTime's location: the wall clock is kept
  // across DST changes, and a wall clock in a gap or overlap is resolved as
  // time.Date does.
  addDate(years: number, months: number, days: number): DateTime {
    const f = fieldsOf({ sec: this.sec + this.zoneOffset(), nsec: 0 });
    const t = dateIn(
      f.year + years,
      f.month + months,
      f.day + days,
      f.hour,
      f.min,
      f.sec,
      this.nsec,
      this.loc,
    );
    return DateTime.fromInstant(t, this.loc);
  }

  after(u: DateTime): boolean {
    return this.compare(u) > 0;
  }

  before(u: DateTime): boolean {
    return this.compare(u) < 0;
  }

  // Compare returns -1 when the current DateTime is before u, +1 when after
  // and 0 when they are the same instant.
  compare(u: DateTime): number {
    if (this.sec !== u.sec) {
      return this.sec < u.sec ? -1 : 1;
    }
    if (this.nsec !== u.nsec) {
      return this.nsec < u.nsec ? -1 : 1;
    }
    return 0;
  }

  equal(u: DateTime): boolean {
    return this.compare(u) === 0;
  }

  // Unix returns the number of seconds elapsed since January 1, 1970 UTC.
  unix(): number {
    return this.sec;
  }

  isZero(): boolean {
    return this.sec === -unixToInternal && this.nsec === 0;
  }

  // String formats the DateTime in UTC with DefaultDateLayout; the zero
  // value is "".
  string(): string {
    if (this.isZero()) {
      return "";
    }
    const f = fieldsOf(this.instant());
    return (
      appendInt(f.year, 4) +
      "-" +
      appendInt(f.month, 2) +
      "-" +
      appendInt(f.day, 2) +
      " " +
      appendInt(f.hour, 2) +
      ":" +
      appendInt(f.min, 2) +
      ":" +
      appendInt(f.sec, 2) +
      "." +
      appendInt(Math.floor(this.nsec / 1e6), 3) +
      "Z"
    );
  }

  toString(): string {
    return this.string();
  }

  marshalJSON(): string {
    return '"' + this.string() + '"';
  }

  // UnmarshalJSON: b must be a JSON string (null is ""), which is scanned.
  unmarshalJSON(b: string | Uint8Array): void {
    this.scan(unmarshal(b, stringType) as string);
  }

  // Value implements the db driver Valuer: the String form.
  value(): string {
    return this.string();
  }

  // Scan sets the DateTime from value; it never fails (unparsable values
  // give the zero time, as cast.ToTime does).
  scan(value: unknown): void {
    let t: Instant;
    let loc: Location = UTC;
    if (value instanceof DateTime) {
      t = value.instant();
      loc = value.loc;
    } else if (value instanceof Date) {
      t = fromDate(value);
      loc = localLocation();
    } else if (typeof value === "string") {
      [t, loc] = value === "" ? [{ ...zeroInstant }, UTC] : parseDefaultOrCast(value);
    } else if (typeof value === "bigint") {
      [t, loc] = castToTimeLocated(value);
    } else {
      const str = castToString(value);
      [t, loc] = str === "" ? [{ ...zeroInstant }, UTC] : castToTimeLocated(str);
    }
    const d = DateTime.fromInstant(t, loc);
    this.sec = d.sec;
    this.nsec = d.nsec;
    this.loc = d.loc;
  }
}

// DefaultDateLayout ends in a literal "Z", so it parses in UTC
function parseDefaultOrCast(v: string): [Instant, Location] {
  try {
    return parsedTime(parse(DefaultDateLayout, v));
  } catch {
    // other common date layouts
    return castToTimeLocated(v);
  }
}
