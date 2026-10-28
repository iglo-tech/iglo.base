// Upstream: Go 1.27 time/format.go (nextStdChunk, parse, getnum, skip,
// lookup, parseTimeZone, parseNanoseconds, atoi), time/format_rfc3339.go
// (parseRFC3339, the RFC3339 fast path, which accepts a subset of what the
// general parser accepts with the same result) and time/time.go (Date's
// normalization, the proleptic Gregorian calendar).
//
// A parsed time is returned as its fields plus the zone information, so the
// caller decides the instant (cast relocates layouts without a numeric zone
// to UTC). Instants are Unix seconds plus nanoseconds, so nothing is lost
// to JS Date's millisecond precision.
//
// The location time.Parse gives the fields (UTC, Local or a fixed zone) is
// chosen by parsedTime in go-zoneinfo.ts, which knows time.Local.

// time.Time's instant: Unix seconds and nanoseconds in [0, 1e9).
export interface Instant {
  sec: number;
  nsec: number;
}

// seconds from 0001-01-01 00:00:00 UTC (Go's zero Time) to the Unix epoch
export const unixToInternal = 62135596800;

export interface ParsedTime {
  year: number;
  month: number; // 1..12
  day: number;
  hour: number;
  min: number;
  sec: number;
  nsec: number;
  // offset in seconds east of UTC when the value had one ("Z" and "UTC" are
  // 0), undefined when it had none or only a zone name
  zoneOffset: number | undefined;
  // whether the zone was "Z" or "UTC" (Go's z = UTC)
  utc: boolean;
  // the zone abbreviation, "" when there was none
  zoneName: string;
}

export class ParseError extends Error {
  constructor(layout: string, value: string, message = "") {
    super(
      `parsing time ${JSON.stringify(value)} as ${JSON.stringify(layout)}: cannot parse${message}`,
    );
    this.name = "ParseError";
  }
}

// std codes (format.go)
const stdLongMonth = 1;
const stdMonth = 2;
const stdNumMonth = 3;
const stdZeroMonth = 4;
const stdLongWeekDay = 5;
const stdWeekDay = 6;
const stdDay = 7;
const stdUnderDay = 8;
const stdZeroDay = 9;
const stdUnderYearDay = 10;
const stdZeroYearDay = 11;
const stdHour = 12;
const stdHour12 = 13;
const stdZeroHour12 = 14;
const stdMinute = 15;
const stdZeroMinute = 16;
const stdSecond = 17;
const stdZeroSecond = 18;
const stdLongYear = 19;
const stdYear = 20;
const stdPM = 21;
const stdpm = 22;
const stdTZ = 23;
const stdISO8601TZ = 24;
const stdISO8601SecondsTZ = 25;
const stdISO8601ShortTZ = 26;
const stdISO8601ColonTZ = 27;
const stdISO8601ColonSecondsTZ = 28;
const stdNumTZ = 29;
const stdNumSecondsTz = 30;
const stdNumShortTZ = 31;
const stdNumColonTZ = 32;
const stdNumColonSecondsTZ = 33;
const stdFracSecond0 = 34;
const stdFracSecond9 = 35;

interface Chunk {
  prefix: string;
  std: number; // 0 at the end of the layout
  digits: number; // fractional second digits
  suffix: string;
}

const std0x = [stdZeroMonth, stdZeroDay, stdZeroHour12, stdZeroMinute, stdZeroSecond, stdYear];

function startsWithLowerCase(s: string): boolean {
  return s.length > 0 && s[0] !== undefined && s[0] >= "a" && s[0] <= "z";
}

function isDigitAt(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return c >= 0x30 && c <= 0x39;
}

// nextStdChunk: the prefix before the first std chunk, the chunk and the
// rest of the layout
function nextStdChunk(layout: string): Chunk {
  const chunk = (i: number, std: number, end: number, digits = 0): Chunk => ({
    prefix: layout.slice(0, i),
    std,
    digits,
    suffix: layout.slice(end),
  });
  for (let i = 0; i < layout.length; i++) {
    const c = layout[i];
    switch (c) {
      case "J":
        if (layout.startsWith("Jan", i)) {
          if (layout.startsWith("January", i)) {
            return chunk(i, stdLongMonth, i + 7);
          }
          if (!startsWithLowerCase(layout.slice(i + 3))) {
            return chunk(i, stdMonth, i + 3);
          }
        }
        break;
      case "M":
        if (layout.length >= i + 3) {
          if (layout.startsWith("Mon", i)) {
            if (layout.startsWith("Monday", i)) {
              return chunk(i, stdLongWeekDay, i + 6);
            }
            if (!startsWithLowerCase(layout.slice(i + 3))) {
              return chunk(i, stdWeekDay, i + 3);
            }
          }
          if (layout.startsWith("MST", i)) {
            return chunk(i, stdTZ, i + 3);
          }
        }
        break;
      case "0": {
        const next = layout[i + 1];
        if (next !== undefined && next >= "1" && next <= "6") {
          return chunk(i, std0x[Number(next) - 1] as number, i + 2);
        }
        if (layout.startsWith("002", i)) {
          return chunk(i, stdZeroYearDay, i + 3);
        }
        break;
      }
      case "1":
        if (layout[i + 1] === "5") {
          return chunk(i, stdHour, i + 2);
        }
        return chunk(i, stdNumMonth, i + 1);
      case "2":
        if (layout.startsWith("2006", i)) {
          return chunk(i, stdLongYear, i + 4);
        }
        return chunk(i, stdDay, i + 1);
      case "_":
        if (layout[i + 1] === "2") {
          if (layout.startsWith("2006", i + 1)) {
            // "_2006" is a literal underscore followed by the year
            return {
              prefix: layout.slice(0, i + 1),
              std: stdLongYear,
              digits: 0,
              suffix: layout.slice(i + 5),
            };
          }
          return chunk(i, stdUnderDay, i + 2);
        }
        if (layout.startsWith("__2", i)) {
          return chunk(i, stdUnderYearDay, i + 3);
        }
        break;
      case "3":
        return chunk(i, stdHour12, i + 1);
      case "4":
        return chunk(i, stdMinute, i + 1);
      case "5":
        return chunk(i, stdSecond, i + 1);
      case "P":
        if (layout[i + 1] === "M") {
          return chunk(i, stdPM, i + 2);
        }
        break;
      case "p":
        if (layout[i + 1] === "m") {
          return chunk(i, stdpm, i + 2);
        }
        break;
      case "-":
        if (layout.startsWith("-070000", i)) {
          return chunk(i, stdNumSecondsTz, i + 7);
        }
        if (layout.startsWith("-07:00:00", i)) {
          return chunk(i, stdNumColonSecondsTZ, i + 9);
        }
        if (layout.startsWith("-0700", i)) {
          return chunk(i, stdNumTZ, i + 5);
        }
        if (layout.startsWith("-07:00", i)) {
          return chunk(i, stdNumColonTZ, i + 6);
        }
        if (layout.startsWith("-07", i)) {
          return chunk(i, stdNumShortTZ, i + 3);
        }
        break;
      case "Z":
        if (layout.startsWith("Z070000", i)) {
          return chunk(i, stdISO8601SecondsTZ, i + 7);
        }
        if (layout.startsWith("Z07:00:00", i)) {
          return chunk(i, stdISO8601ColonSecondsTZ, i + 9);
        }
        if (layout.startsWith("Z0700", i)) {
          return chunk(i, stdISO8601TZ, i + 5);
        }
        if (layout.startsWith("Z07:00", i)) {
          return chunk(i, stdISO8601ColonTZ, i + 6);
        }
        if (layout.startsWith("Z07", i)) {
          return chunk(i, stdISO8601ShortTZ, i + 3);
        }
        break;
      case ".":
      case ",": {
        const ch = layout[i + 1];
        if (ch === "0" || ch === "9") {
          let j = i + 1;
          while (j < layout.length && layout[j] === ch) {
            j++;
          }
          if (!isDigitAt(layout, j)) {
            return chunk(i, ch === "0" ? stdFracSecond0 : stdFracSecond9, j, j - (i + 1));
          }
        }
        break;
      }
    }
  }
  return { prefix: layout, std: 0, digits: 0, suffix: "" };
}

const longDayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const shortDayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const shortMonthNames = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const longMonthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

class BadValue extends Error {}

// match: equal ignoring ASCII letter case (s1 and s2 have the same length)
function match(s1: string, s2: string): boolean {
  for (let i = 0; i < s1.length; i++) {
    let c1 = s1.charCodeAt(i);
    let c2 = s2.charCodeAt(i);
    if (c1 !== c2) {
      c1 |= 0x20;
      c2 |= 0x20;
      if (c1 !== c2 || c1 < 0x61 || c1 > 0x7a) {
        return false;
      }
    }
  }
  return true;
}

function lookup(tab: string[], val: string): [number, string] {
  for (let i = 0; i < tab.length; i++) {
    const v = tab[i] as string;
    if (val.length >= v.length && match(val.slice(0, v.length), v)) {
      return [i, val.slice(v.length)];
    }
  }
  throw new BadValue();
}

// getnum: one or two digits (fixed forces two)
function getnum(s: string, fixed: boolean): [number, string] {
  if (!isDigitAt(s, 0)) {
    throw new BadValue();
  }
  if (!isDigitAt(s, 1)) {
    if (fixed) {
      throw new BadValue();
    }
    return [s.charCodeAt(0) - 0x30, s.slice(1)];
  }
  return [(s.charCodeAt(0) - 0x30) * 10 + (s.charCodeAt(1) - 0x30), s.slice(2)];
}

// getnum3: one to three digits (fixed forces three)
function getnum3(s: string, fixed: boolean): [number, string] {
  let n = 0;
  let i = 0;
  for (; i < 3 && isDigitAt(s, i); i++) {
    n = n * 10 + (s.charCodeAt(i) - 0x30);
  }
  if (i === 0 || (fixed && i !== 3)) {
    throw new BadValue();
  }
  return [n, s.slice(i)];
}

function cutspace(s: string): string {
  let i = 0;
  while (i < s.length && s[i] === " ") {
    i++;
  }
  return s.slice(i);
}

// skip removes prefix from value, treating runs of spaces as equal
function skip(value: string, prefix: string): string {
  while (prefix.length > 0) {
    if (prefix[0] === " ") {
      if (value.length > 0 && value[0] !== " ") {
        throw new BadValue();
      }
      prefix = cutspace(prefix);
      value = cutspace(value);
      continue;
    }
    if (value.length === 0 || value[0] !== prefix[0]) {
      throw new BadValue();
    }
    prefix = prefix.slice(1);
    value = value.slice(1);
  }
  return value;
}

// leadingInt: the leading [0-9]* of s; overflow past 2^63 is an error
function leadingInt(s: string): [bigint, string] {
  let x = 0n;
  let i = 0;
  for (; i < s.length && isDigitAt(s, i); i++) {
    if (x > (1n << 63n) / 10n) {
      throw new BadValue();
    }
    x = x * 10n + BigInt(s.charCodeAt(i) - 0x30);
    if (x > 1n << 63n) {
      throw new BadValue();
    }
  }
  return [x, s.slice(i)];
}

// atoi: an optional sign and digits, nothing else
export function atoi(s: string): number {
  let neg = false;
  if (s.length > 0 && (s[0] === "-" || s[0] === "+")) {
    neg = s[0] === "-";
    s = s.slice(1);
  }
  const [q, rem] = leadingInt(s);
  if (rem.length > 0) {
    throw new BadValue();
  }
  // int(q) wraps like Go for 2^63; the time fields never get that large
  const x = Number(BigInt.asIntN(64, q));
  return neg ? -x : x;
}

function parseNanoseconds(value: string, nbytes: number): number {
  if (value[0] !== "." && value[0] !== ",") {
    throw new BadValue();
  }
  if (nbytes > 10) {
    value = value.slice(0, 10);
    nbytes = 10;
  }
  let ns = atoi(value.slice(1, nbytes));
  if (ns < 0) {
    throw new BadValue(); // "fractional second" out of range
  }
  for (let i = 0; i < 10 - nbytes; i++) {
    ns *= 10;
  }
  return ns;
}

function parseSignedOffset(value: string): number {
  const sign = value[0];
  if (sign !== "-" && sign !== "+") {
    return 0;
  }
  let x: bigint;
  let rem: string;
  try {
    [x, rem] = leadingInt(value.slice(1));
  } catch {
    return 0;
  }
  if (value.slice(1) === rem || x > 23n) {
    return 0;
  }
  return value.length - rem.length;
}

// parseTimeZone: the length of a zone name at the start of value
function parseTimeZone(value: string): number | undefined {
  if (value.length < 3) {
    return undefined;
  }
  if (value.startsWith("ChST") || value.startsWith("MeST")) {
    return 4;
  }
  if (value.startsWith("GMT")) {
    return value.length === 3 ? 3 : 3 + parseSignedOffset(value.slice(3));
  }
  if (value[0] === "+" || value[0] === "-") {
    const n = parseSignedOffset(value);
    return n > 0 ? n : undefined;
  }
  let nUpper = 0;
  for (; nUpper < 6; nUpper++) {
    if (nUpper >= value.length) {
      break;
    }
    const c = value.charCodeAt(nUpper);
    if (c < 0x41 || c > 0x5a) {
      break;
    }
  }
  switch (nUpper) {
    case 5:
      return value[4] === "T" ? 5 : undefined;
    case 4:
      return value[3] === "T" || value.startsWith("WITA") ? 4 : undefined;
    case 3:
      return 3;
    default:
      return undefined;
  }
}

export function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export const daysBefore = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];

export function daysIn(month: number, year: number): number {
  if (month === 2 && isLeap(year)) {
    return 29;
  }
  return (daysBefore[month] as number) - (daysBefore[month - 1] as number);
}

// time.Parse(layout, value), returning the parsed fields. Throws
// ParseError when value does not match layout.
export function parse(layout: string, value: string): ParsedTime {
  const alayout = layout;
  const avalue = value;
  let amSet = false;
  let pmSet = false;
  let year = 0;
  let month = -1;
  let day = -1;
  let yday = -1;
  let hour = 0;
  let min = 0;
  let sec = 0;
  let nsec = 0;
  let utc = false;
  let zoneOffset = -1;
  let zoneName = "";

  for (;;) {
    const { prefix, std, digits, suffix } = nextStdChunk(layout);
    try {
      value = skip(value, prefix);
    } catch {
      throw new ParseError(alayout, avalue);
    }
    if (std === 0) {
      if (value.length !== 0) {
        throw new ParseError(alayout, avalue, ": extra text: " + JSON.stringify(value));
      }
      break;
    }
    layout = suffix;
    let rangeErr = "";
    try {
      switch (std) {
        case stdYear: {
          if (value.length < 2) {
            throw new BadValue();
          }
          const p = value.slice(0, 2);
          value = value.slice(2);
          year = atoi(p);
          year += year >= 69 ? 1900 : 2000;
          break;
        }
        case stdLongYear: {
          if (value.length < 4 || !isDigitAt(value, 0)) {
            throw new BadValue();
          }
          const p = value.slice(0, 4);
          value = value.slice(4);
          year = atoi(p);
          break;
        }
        case stdMonth:
          [month, value] = lookup(shortMonthNames, value);
          month++;
          break;
        case stdLongMonth:
          [month, value] = lookup(longMonthNames, value);
          month++;
          break;
        case stdNumMonth:
        case stdZeroMonth:
          [month, value] = getnum(value, std === stdZeroMonth);
          if (month <= 0 || month > 12) {
            rangeErr = "month";
          }
          break;
        case stdWeekDay:
          value = lookup(shortDayNames, value)[1];
          break;
        case stdLongWeekDay:
          value = lookup(longDayNames, value)[1];
          break;
        case stdDay:
        case stdUnderDay:
        case stdZeroDay:
          if (std === stdUnderDay && value[0] === " ") {
            value = value.slice(1);
          }
          [day, value] = getnum(value, std === stdZeroDay);
          break;
        case stdUnderYearDay:
        case stdZeroYearDay:
          for (let i = 0; i < 2; i++) {
            if (std === stdUnderYearDay && value[0] === " ") {
              value = value.slice(1);
            }
          }
          [yday, value] = getnum3(value, std === stdZeroYearDay);
          break;
        case stdHour:
          [hour, value] = getnum(value, false);
          if (hour < 0 || hour >= 24) {
            rangeErr = "hour";
          }
          break;
        case stdHour12:
        case stdZeroHour12:
          [hour, value] = getnum(value, std === stdZeroHour12);
          if (hour < 0 || hour > 12) {
            rangeErr = "hour";
          }
          break;
        case stdMinute:
        case stdZeroMinute:
          [min, value] = getnum(value, std === stdZeroMinute);
          if (min < 0 || min >= 60) {
            rangeErr = "minute";
          }
          break;
        case stdSecond:
        case stdZeroSecond: {
          [sec, value] = getnum(value, std === stdZeroSecond);
          if (sec < 0 || sec >= 60) {
            rangeErr = "second";
            break;
          }
          // a fractional second in the value but not in the layout
          if (value.length >= 2 && (value[0] === "." || value[0] === ",") && isDigitAt(value, 1)) {
            const next = nextStdChunk(layout).std;
            if (next === stdFracSecond0 || next === stdFracSecond9) {
              break;
            }
            let n = 2;
            while (n < value.length && isDigitAt(value, n)) {
              n++;
            }
            nsec = parseNanoseconds(value, n);
            value = value.slice(n);
          }
          break;
        }
        case stdPM:
        case stdpm: {
          if (value.length < 2) {
            throw new BadValue();
          }
          const p = value.slice(0, 2);
          value = value.slice(2);
          const [pm, am] = std === stdPM ? ["PM", "AM"] : ["pm", "am"];
          if (p === pm) {
            pmSet = true;
          } else if (p === am) {
            amSet = true;
          } else {
            throw new BadValue();
          }
          break;
        }
        case stdISO8601TZ:
        case stdISO8601ShortTZ:
        case stdISO8601ColonTZ:
        case stdISO8601SecondsTZ:
        case stdISO8601ColonSecondsTZ:
        case stdNumTZ:
        case stdNumShortTZ:
        case stdNumColonTZ:
        case stdNumSecondsTz:
        case stdNumColonSecondsTZ: {
          if (std <= stdISO8601ColonSecondsTZ && value[0] === "Z") {
            value = value.slice(1);
            utc = true;
            break;
          }
          let sign: string;
          let hh: string;
          let mm: string;
          let ss = "00";
          if (std === stdISO8601ColonTZ || std === stdNumColonTZ) {
            if (value.length < 6 || value[3] !== ":") {
              throw new BadValue();
            }
            [sign, hh, mm, value] = [
              value.slice(0, 1),
              value.slice(1, 3),
              value.slice(4, 6),
              value.slice(6),
            ];
          } else if (std === stdNumShortTZ || std === stdISO8601ShortTZ) {
            if (value.length < 3) {
              throw new BadValue();
            }
            [sign, hh, mm, value] = [value.slice(0, 1), value.slice(1, 3), "00", value.slice(3)];
          } else if (std === stdISO8601ColonSecondsTZ || std === stdNumColonSecondsTZ) {
            if (value.length < 9 || value[3] !== ":" || value[6] !== ":") {
              throw new BadValue();
            }
            [sign, hh, mm, ss, value] = [
              value.slice(0, 1),
              value.slice(1, 3),
              value.slice(4, 6),
              value.slice(7, 9),
              value.slice(9),
            ];
          } else if (std === stdISO8601SecondsTZ || std === stdNumSecondsTz) {
            if (value.length < 7) {
              throw new BadValue();
            }
            [sign, hh, mm, ss, value] = [
              value.slice(0, 1),
              value.slice(1, 3),
              value.slice(3, 5),
              value.slice(5, 7),
              value.slice(7),
            ];
          } else {
            if (value.length < 5) {
              throw new BadValue();
            }
            [sign, hh, mm, value] = [
              value.slice(0, 1),
              value.slice(1, 3),
              value.slice(3, 5),
              value.slice(5),
            ];
          }
          const hr = getnum(hh, true)[0];
          const mi = getnum(mm, true)[0];
          const se = getnum(ss, true)[0];
          // > rather than >=: some write offsets of 24 hours or 60 minutes
          if (hr > 24) {
            rangeErr = "time zone offset hour";
          }
          if (mi > 60) {
            rangeErr = "time zone offset minute";
          }
          if (se > 60) {
            rangeErr = "time zone offset second";
          }
          zoneOffset = (hr * 60 + mi) * 60 + se;
          if (sign === "-") {
            zoneOffset = -zoneOffset;
          } else if (sign !== "+") {
            throw new BadValue();
          }
          break;
        }
        case stdTZ: {
          if (value.startsWith("UTC")) {
            utc = true;
            value = value.slice(3);
            break;
          }
          const n = parseTimeZone(value);
          if (n === undefined) {
            throw new BadValue();
          }
          zoneName = value.slice(0, n);
          value = value.slice(n);
          break;
        }
        case stdFracSecond0: {
          // exactly the layout's number of digits
          const ndigit = 1 + digits;
          if (value.length < ndigit) {
            throw new BadValue();
          }
          nsec = parseNanoseconds(value, ndigit);
          value = value.slice(ndigit);
          break;
        }
        case stdFracSecond9: {
          if (value.length < 2 || (value[0] !== "." && value[0] !== ",") || !isDigitAt(value, 1)) {
            break; // fractional second omitted
          }
          let i = 0;
          while (i + 1 < value.length && isDigitAt(value, i + 1)) {
            i++;
          }
          nsec = parseNanoseconds(value, 1 + i);
          value = value.slice(1 + i);
          break;
        }
      }
    } catch (err) {
      if (err instanceof BadValue) {
        throw new ParseError(alayout, avalue);
      }
      throw err;
    }
    if (rangeErr !== "") {
      throw new ParseError(alayout, avalue, ": " + rangeErr + " out of range");
    }
  }
  if (pmSet && hour < 12) {
    hour += 12;
  } else if (amSet && hour === 12) {
    hour = 0;
  }

  if (yday >= 0) {
    let d = 0;
    let m = 0;
    if (isLeap(year)) {
      if (yday === 31 + 29) {
        m = 2;
        d = 29;
      } else if (yday > 31 + 29) {
        yday--;
      }
    }
    if (yday < 1 || yday > 365) {
      throw new ParseError(alayout, avalue, ": day-of-year out of range");
    }
    if (m === 0) {
      m = Math.floor((yday - 1) / 31) + 1;
      if ((daysBefore[m] as number) < yday) {
        m++;
      }
      d = yday - (daysBefore[m - 1] as number);
    }
    if (month >= 0 && month !== m) {
      throw new ParseError(alayout, avalue, ": day-of-year does not match month");
    }
    month = m;
    if (day >= 0 && day !== d) {
      throw new ParseError(alayout, avalue, ": day-of-year does not match day");
    }
    day = d;
  } else {
    if (month < 0) {
      month = 1;
    }
    if (day < 0) {
      day = 1;
    }
  }

  if (day < 1 || day > daysIn(month, year)) {
    throw new ParseError(alayout, avalue, ": day out of range");
  }

  let offset: number | undefined;
  if (utc) {
    offset = 0;
  } else if (zoneOffset !== -1) {
    offset = zoneOffset;
  }
  return { year, month, day, hour, min, sec, nsec, zoneOffset: offset, utc, zoneName };
}

// days from 1970-01-01 to y-m-d in the proleptic Gregorian calendar
// (month 1..12, any day; out of range days roll over as in time.Date)
export function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5);
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468 + (d - 1);
}

export function civilFromDays(z: number): [number, number, number] {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

// time.Date(year, month, day, hour, min, sec, nsec, UTC), with Go's
// normalization of out of range values
export function date(
  year: number,
  month: number,
  day: number,
  hour: number,
  min: number,
  sec: number,
  nsec: number,
): Instant {
  // month overflow goes into the year
  const m0 = month - 1;
  year += Math.floor(m0 / 12);
  month = (((m0 % 12) + 12) % 12) + 1;
  // nanosecond overflow into seconds
  sec += Math.floor(nsec / 1e9);
  nsec = ((nsec % 1e9) + 1e9) % 1e9;
  const days = daysFromCivil(year, month, day);
  return { sec: days * 86400 + hour * 3600 + min * 60 + sec, nsec };
}

// the UTC calendar fields of an instant
export function fieldsOf(t: Instant): {
  year: number;
  month: number;
  day: number;
  hour: number;
  min: number;
  sec: number;
} {
  const days = Math.floor(t.sec / 86400);
  const secOfDay = t.sec - days * 86400;
  const [year, month, day] = civilFromDays(days);
  return {
    year,
    month,
    day,
    hour: Math.floor(secOfDay / 3600),
    min: Math.floor((secOfDay % 3600) / 60),
    sec: secOfDay % 60,
  };
}

// appendInt: x zero padded to width, with a leading "-" when negative
export function appendInt(x: number, width: number): string {
  const digits = String(Math.abs(x)).padStart(width, "0");
  return x < 0 ? "-" + digits : digits;
}
