// Upstream: github.com/spf13/cast v1.10.0, the parts the ported tools use:
// time.go (ToTimeE, StringToDateInDefaultLocation with time.UTC),
// internal/time.go (TimeFormats, ParseDateWith), basic.go (ToStringE) and
// slice.go (ToStringSliceE).
//
// Go's static types become JS runtime types: number is float64, bigint is a
// Go integer (int, int64, ...), Uint8Array is []byte, Date is time.Time, an
// object with a string() method is a fmt.Stringer and an Error is an error.

import { bytesToText } from "@/tools/types/go-json";
import { type Instant, date, parse, unixToInternal } from "@/tools/types/go-time";

// how the time zone of a layout is applied (internal.TimeFormatType)
const noTimezone = 0;
const namedTimezone = 1;
const numericTimezone = 2;
const numericAndNamedTimezone = 3;
const timeOnly = 4;

// internal.TimeFormats, in cast's order
const timeFormats: [string, number][] = [
  ["2006-01-02", noTimezone],
  ["2006-01-02T15:04:05Z07:00", numericTimezone], // time.RFC3339
  ["2006-01-02T15:04:05", noTimezone], // iso8601 without timezone
  ["Mon, 02 Jan 2006 15:04:05 -0700", numericTimezone], // time.RFC1123Z
  ["Mon, 02 Jan 2006 15:04:05 MST", namedTimezone], // time.RFC1123
  ["02 Jan 06 15:04 -0700", numericTimezone], // time.RFC822Z
  ["02 Jan 06 15:04 MST", namedTimezone], // time.RFC822
  ["Monday, 02-Jan-06 15:04:05 MST", namedTimezone], // time.RFC850
  ["2006-01-02 15:04:05.999999999 -0700 MST", numericAndNamedTimezone], // Time.String()
  ["2006-01-02T15:04:05-0700", numericTimezone], // RFC3339 without timezone hh:mm colon
  ["2006-01-02 15:04:05Z0700", numericTimezone], // RFC3339 without T or timezone hh:mm colon
  ["2006-01-02 15:04:05", noTimezone],
  ["Mon Jan _2 15:04:05 2006", noTimezone], // time.ANSIC
  ["Mon Jan _2 15:04:05 MST 2006", namedTimezone], // time.UnixDate
  ["Mon Jan 02 15:04:05 -0700 2006", numericTimezone], // time.RubyDate
  ["2006-01-02 15:04:05Z07:00", numericTimezone],
  ["02 Jan 2006", noTimezone],
  ["2006-01-02 15:04:05 -07:00", numericTimezone],
  ["2006-01-02 15:04:05 -0700", numericTimezone],
  ["3:04PM", timeOnly], // time.Kitchen
  ["Jan _2 15:04:05", timeOnly], // time.Stamp
  ["Jan _2 15:04:05.000", timeOnly], // time.StampMilli
  ["Jan _2 15:04:05.000000", timeOnly], // time.StampMicro
  ["Jan _2 15:04:05.000000000", timeOnly], // time.StampNano
];

// Go's zero time.Time (0001-01-01 00:00:00 UTC)
export const zeroInstant: Instant = { sec: -unixToInternal, nsec: 0 };

export class CastError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CastError";
  }
}

// StringToDateInDefaultLocation(s, time.UTC): the first layout that
// parses. Layouts without a numeric zone keep the parsed wall clock in UTC
// (ParseDateWith relocates them); the others give the instant of their
// offset. Time-only layouts are in year 0.
export function stringToDate(s: string): Instant {
  return stringToDateLocated(s)[0];
}

// stringToDate with the offset (seconds east of UTC) of the time.Time's
// location: time.Parse keeps a numeric zone as a fixed zone (or Local, which
// is UTC here, when the offset is 0); relocated layouts are in UTC.
export function stringToDateLocated(s: string): [Instant, number] {
  for (const [layout, typ] of timeFormats) {
    let p;
    try {
      p = parse(layout, s);
    } catch {
      continue;
    }
    const t = date(p.year, p.month, p.day, p.hour, p.min, p.sec, p.nsec);
    let offset = 0;
    if (typ > namedTimezone) {
      offset = p.zoneOffset ?? 0;
      t.sec -= offset;
    }
    return [t, offset];
  }
  throw new CastError(`unable to parse date: ${s}`);
}

// ToTimeE(i) with the default location time.UTC
export function toTimeE(i: unknown): Instant {
  if (i instanceof Date) {
    return fromDate(i);
  }
  switch (typeof i) {
    case "string":
      return stringToDate(i);
    case "bigint":
      // time.Unix(int64(v), 0); uint64 values wrap as in Go
      return { sec: Number(BigInt.asIntN(64, i)), nsec: 0 };
    case "undefined":
      return { ...zeroInstant };
  }
  if (i === null) {
    return { ...zeroInstant };
  }
  throw new CastError(`unable to cast ${String(i)} of type ${typeof i} to Time`);
}

// ToTime: ToTimeE without the error (the zero time instead)
export function toTime(i: unknown): Instant {
  try {
    return toTimeE(i);
  } catch {
    return { ...zeroInstant };
  }
}

// toTime with the offset of the time.Time's location (see
// stringToDateLocated); only strings can have a zone other than UTC
export function toTimeLocated(i: unknown): [Instant, number] {
  if (typeof i !== "string") {
    return [toTime(i), 0];
  }
  try {
    return stringToDateLocated(i);
  } catch {
    return [{ ...zeroInstant }, 0];
  }
}

export function fromDate(d: Date): Instant {
  const ms = d.getTime();
  const sec = Math.floor(ms / 1000);
  return { sec, nsec: (ms - sec * 1000) * 1e6 };
}

// strconv.FormatFloat(f, 'f', -1, 64): the shortest digits that round-trip,
// never in exponent form
export function formatFloatF(f: number): string {
  if (Number.isNaN(f)) {
    return "NaN";
  }
  if (!Number.isFinite(f)) {
    return f > 0 ? "+Inf" : "-Inf";
  }
  const neg = f < 0 || Object.is(f, -0);
  const [mantissa, expText] = Math.abs(f).toExponential().split("e") as [string, string];
  const digits = mantissa.replace(".", "");
  const exp = Number(expText);
  let out: string;
  if (exp < 0) {
    out = "0." + "0".repeat(-exp - 1) + digits;
  } else if (digits.length <= exp + 1) {
    out = digits + "0".repeat(exp + 1 - digits.length);
  } else {
    out = digits.slice(0, exp + 1) + "." + digits.slice(exp + 1);
  }
  return neg ? "-" + out : out;
}

// ToStringE
export function toStringE(i: unknown): string {
  switch (typeof i) {
    case "string":
      return i;
    case "boolean":
      return i ? "true" : "false";
    case "number":
      return formatFloatF(i);
    case "bigint":
      return i.toString();
    case "undefined":
      return "";
  }
  if (i === null) {
    return "";
  }
  if (i instanceof Uint8Array) {
    return bytesToText(i);
  }
  if (typeof i === "object" && typeof (i as { string?: unknown }).string === "function") {
    return String((i as { string(): unknown }).string());
  }
  if (i instanceof Error) {
    return i.message;
  }
  throw new CastError(`unable to cast ${String(i)} of type ${typeof i} to string`);
}

// ToString: ToStringE without the error ("" instead)
export function toString(i: unknown): string {
  try {
    return toStringE(i);
  } catch {
    return "";
  }
}

// ToStringSliceE: every element of an array cast with ToStringE (any
// failure fails the whole cast), a string split on whitespace
// (strings.Fields), any other non-nil value as a single element
export function toStringSliceE(i: unknown): string[] {
  if (i === null || i === undefined) {
    throw new CastError("unable to cast <nil> to []string");
  }
  if (Array.isArray(i)) {
    return i.map((item) => toStringE(item));
  }
  if (i instanceof Uint8Array) {
    // []byte is a slice of uint8 values
    return Array.from(i, (b) => String(b));
  }
  if (typeof i === "string") {
    return fields(i);
  }
  return [toStringE(i)];
}

// ToStringSlice: ToStringSliceE without the error (an empty slice instead)
export function toStringSlice(i: unknown): string[] {
  try {
    return toStringSliceE(i);
  } catch {
    return [];
  }
}

// unicode.IsSpace
const goSpace = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

// strings.Fields: s split around runs of unicode.IsSpace
function fields(s: string): string[] {
  return s.split(new RegExp(goSpace.source + "+")).filter((f) => f !== "");
}
