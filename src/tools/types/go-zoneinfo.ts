// Upstream: Go 1.27 time/zoneinfo.go (Location, FixedZone, lookup,
// lookupFirstZone, lookupName, tzset and its helpers), time/zoneinfo_read.go
// (LoadLocationFromTZData, loadTzinfo), time/zoneinfo_unix.go (initLocal,
// platformZoneSources), time/time.go (Date's lookup of the zone offset) and
// the end of time/format.go parse (the location of a parsed time).
//
// Go's locations are UTC, Local and fixed zones; Local is read as Go reads
// it: TZ unset is /etc/localtime, TZ="" and TZ="UTC" are UTC, TZ="foo" or
// ":foo" is the TZif file foo (absolute) or the system zoneinfo's foo, and
// a file that cannot be loaded is UTC. Offsets and abbreviations come from
// the same TZif data Go reads, not from JS Date or Intl, whose time zone
// data and abbreviations differ from the system's.
//
// Go reads Local once per process; localLocation keeps the location loaded
// for the current TZ value, so it is read again only when TZ changes. That
// cache only mirrors the environment (Go's time.Local), it is not state.
//
// Not ported: Go's embedded tzdata and $GOROOT/lib/time/zoneinfo.zip, which
// a server without Go installed does not have, and LoadLocation.

import { readFileSync } from "node:fs";

import {
  type Instant,
  type ParsedTime,
  atoi,
  civilFromDays,
  date,
  daysBefore,
  daysFromCivil,
  daysIn,
  isLeap,
} from "@/tools/types/go-time";

const secondsPerHour = 3600;
const secondsPerDay = 86400;

// the bounds of time (Go's alpha and omega)
const alpha = -Infinity;
const omega = Infinity;

interface Zone {
  name: string;
  offset: number; // seconds east of UTC
  isDST: boolean;
}

interface ZoneTrans {
  when: number; // Unix seconds of the transition
  index: number; // the zone in effect from then
}

// time.Location. UTC has no zones; a fixed zone has one zone and one
// transition at alpha.
export class Location {
  constructor(
    readonly name: string,
    readonly zone: Zone[],
    readonly tx: ZoneTrans[],
    // the TZ string for times after the last transition
    readonly extend = "",
  ) {}
}

export const UTC = new Location("UTC", [], []);

// time.FixedZone
export function fixedZone(name: string, offset: number): Location {
  return new Location(name, [{ name, offset, isDST: false }], [{ when: alpha, index: 0 }]);
}

export interface ZoneInfo {
  name: string;
  offset: number;
  start: number;
  end: number;
  isDST: boolean;
}

// Location.lookup: the zone in effect at the Unix time sec, and the range
// [start, end) of times it is known to be in effect.
export function lookup(l: Location, sec: number): ZoneInfo {
  if (l.zone.length === 0) {
    return { name: "UTC", offset: 0, start: alpha, end: omega, isDST: false };
  }
  const tx = l.tx;
  if (tx.length === 0 || sec < (tx[0] as ZoneTrans).when) {
    const zone = l.zone[lookupFirstZone(l)] as Zone;
    return {
      name: zone.name,
      offset: zone.offset,
      start: alpha,
      end: tx.length > 0 ? (tx[0] as ZoneTrans).when : omega,
      isDST: zone.isDST,
    };
  }
  // binary search for the entry with the largest time <= sec
  let end = omega;
  let lo = 0;
  let hi = tx.length;
  while (hi - lo > 1) {
    const m = (lo + hi) >>> 1;
    const lim = (tx[m] as ZoneTrans).when;
    if (sec < lim) {
      end = lim;
      hi = m;
    } else {
      lo = m;
    }
  }
  const zone = l.zone[(tx[lo] as ZoneTrans).index] as Zone;
  const start = (tx[lo] as ZoneTrans).when;
  // at the end of the known transitions, try the extend string
  if (lo === tx.length - 1 && l.extend !== "") {
    const z = tzset(l.extend, start, sec);
    if (z !== undefined) {
      return z;
    }
  }
  return { name: zone.name, offset: zone.offset, start, end, isDST: zone.isDST };
}

// lookupFirstZone: the zone for times before the first transition
function lookupFirstZone(l: Location): number {
  // case 1: the first zone is unused by transitions
  if (!l.tx.some((t) => t.index === 0)) {
    return 0;
  }
  // case 2: the first transition is to a DST zone; the first non-DST zone
  // before it
  const first = l.tx[0];
  if (first !== undefined && (l.zone[first.index] as Zone).isDST) {
    for (let zi = first.index - 1; zi >= 0; zi--) {
      if (!(l.zone[zi] as Zone).isDST) {
        return zi;
      }
    }
  }
  // case 3: the first non-DST zone
  const zi = l.zone.findIndex((z) => !z.isDST);
  // case 4: the first zone
  return zi === -1 ? 0 : zi;
}

// Location.lookupName: the offset of the zone abbreviated name, preferring
// one in effect at about the Unix time unix
export function lookupName(l: Location, name: string, unix: number): number | undefined {
  for (const zone of l.zone) {
    if (zone.name === name) {
      const z = lookup(l, unix - zone.offset);
      if (z.name === zone.name) {
        return z.offset;
      }
    }
  }
  for (const zone of l.zone) {
    if (zone.name === name) {
      return zone.offset;
    }
  }
  return undefined;
}

// tzset: the zone of the TZ string s at sec, after the last transition at
// lastTxSec; undefined when s is invalid
function tzset(s: string, lastTxSec: number, sec: number): ZoneInfo | undefined {
  let r = tzsetName(s);
  if (r === undefined) {
    return undefined;
  }
  let stdName = r[0];
  s = r[1];
  const so = tzsetOffset(s);
  if (so === undefined) {
    return undefined;
  }
  // TZ offsets are added to local time to get UTC
  let stdOffset = -so[0];
  s = so[1];
  if (s.length === 0 || s[0] === ",") {
    // no daylight saving time
    return { name: stdName, offset: stdOffset, start: lastTxSec, end: omega, isDST: false };
  }

  r = tzsetName(s);
  if (r === undefined) {
    return undefined;
  }
  let dstName = r[0];
  s = r[1];
  let dstOffset: number;
  if (s.length === 0 || s[0] === ",") {
    dstOffset = stdOffset + secondsPerHour;
  } else {
    const d = tzsetOffset(s);
    if (d === undefined) {
      return undefined;
    }
    dstOffset = -d[0];
    s = d[1];
  }

  if (s.length === 0) {
    // the default DST rules per tzcode
    s = ",M3.2.0,M11.1.0";
  }
  // the TZ definition does not mention ';' here but tzcode accepts it
  if (s[0] !== "," && s[0] !== ";") {
    return undefined;
  }
  const sr = tzsetRule(s.slice(1));
  if (sr === undefined || sr[1][0] !== ",") {
    return undefined;
  }
  const er = tzsetRule(sr[1].slice(1));
  if (er === undefined || er[1].length > 0) {
    return undefined;
  }

  // the start of the year in Unix seconds, and the seconds since then
  const [year, yday] = yearYday(sec);
  const ysec = (yday - 1) * secondsPerDay + (sec % secondsPerDay);
  const ystart = sec - ysec;

  let startSec = tzruleTime(year, sr[0], stdOffset);
  let endSec = tzruleTime(year, er[0], dstOffset);
  let dstIsDST = true;
  let stdIsDST = false;
  // southern hemisphere: the labels are flipped, as in Go
  if (endSec < startSec) {
    [startSec, endSec] = [endSec, startSec];
    [stdName, dstName] = [dstName, stdName];
    [stdOffset, dstOffset] = [dstOffset, stdOffset];
    [stdIsDST, dstIsDST] = [dstIsDST, stdIsDST];
  }

  // start and end are accurate close to a transition, otherwise the start
  // and end of the year, as Go returns them
  if (ysec < startSec) {
    return {
      name: stdName,
      offset: stdOffset,
      start: ystart,
      end: startSec + ystart,
      isDST: stdIsDST,
    };
  }
  if (ysec >= endSec) {
    return {
      name: stdName,
      offset: stdOffset,
      start: endSec + ystart,
      end: ystart + 365 * secondsPerDay,
      isDST: stdIsDST,
    };
  }
  return {
    name: dstName,
    offset: dstOffset,
    start: startSec + ystart,
    end: endSec + ystart,
    isDST: dstIsDST,
  };
}

// the year and the day of the year (1-based) of the Unix time sec
function yearYday(sec: number): [number, number] {
  const days = Math.floor(sec / secondsPerDay);
  const [year] = civilFromDays(days);
  return [year, days - daysFromCivil(year, 1, 1) + 1];
}

// tzsetName: a zone abbreviation and the rest of s
function tzsetName(s: string): [string, string] | undefined {
  if (s.length === 0) {
    return undefined;
  }
  if (s[0] !== "<") {
    for (let i = 0; i < s.length; i++) {
      if (/[0-9,+-]/.test(s[i] as string)) {
        return i < 3 ? undefined : [s.slice(0, i), s.slice(i)];
      }
    }
    return s.length < 3 ? undefined : [s, ""];
  }
  const i = s.indexOf(">");
  return i === -1 ? undefined : [s.slice(1, i), s.slice(i + 1)];
}

// tzsetOffset: a [+-]hh[:mm[:ss]] offset in seconds and the rest of s
function tzsetOffset(s: string): [number, string] | undefined {
  if (s.length === 0) {
    return undefined;
  }
  let neg = false;
  if (s[0] === "+") {
    s = s.slice(1);
  } else if (s[0] === "-") {
    s = s.slice(1);
    neg = true;
  }
  // tzdata permits up to 24 * 7 hours, although POSIX does not
  const hours = tzsetNum(s, 0, 24 * 7);
  if (hours === undefined) {
    return undefined;
  }
  let off = hours[0] * secondsPerHour;
  s = hours[1];
  if (s[0] === ":") {
    const mins = tzsetNum(s.slice(1), 0, 59);
    if (mins === undefined) {
      return undefined;
    }
    off += mins[0] * 60;
    s = mins[1];
    if (s[0] === ":") {
      const secs = tzsetNum(s.slice(1), 0, 59);
      if (secs === undefined) {
        return undefined;
      }
      off += secs[0];
      s = secs[1];
    }
  }
  return [neg ? -off : off, s];
}

const ruleJulian = 0;
const ruleDOY = 1;
const ruleMonthWeekDay = 2;

interface Rule {
  kind: number;
  day: number;
  week: number;
  mon: number;
  time: number; // the transition time, seconds after midnight
}

// tzsetRule: a Jn, n or Mm.w.d rule with an optional /time, and the rest
function tzsetRule(s: string): [Rule, string] | undefined {
  const r: Rule = { kind: ruleDOY, day: 0, week: 0, mon: 0, time: 0 };
  if (s.length === 0) {
    return undefined;
  }
  if (s[0] === "J") {
    const jday = tzsetNum(s.slice(1), 1, 365);
    if (jday === undefined) {
      return undefined;
    }
    r.kind = ruleJulian;
    [r.day, s] = jday;
  } else if (s[0] === "M") {
    const mon = tzsetNum(s.slice(1), 1, 12);
    if (mon === undefined || mon[1][0] !== ".") {
      return undefined;
    }
    const week = tzsetNum(mon[1].slice(1), 1, 5);
    if (week === undefined || week[1][0] !== ".") {
      return undefined;
    }
    const day = tzsetNum(week[1].slice(1), 0, 6);
    if (day === undefined) {
      return undefined;
    }
    r.kind = ruleMonthWeekDay;
    r.mon = mon[0];
    r.week = week[0];
    [r.day, s] = day;
  } else {
    const day = tzsetNum(s, 0, 365);
    if (day === undefined) {
      return undefined;
    }
    [r.day, s] = day;
  }
  if (s[0] !== "/") {
    // 2am is the default
    r.time = 2 * secondsPerHour;
    return [r, s];
  }
  const offset = tzsetOffset(s.slice(1));
  if (offset === undefined) {
    return undefined;
  }
  [r.time, s] = offset;
  return [r, s];
}

// tzsetNum: a number in [min, max] and the rest of s
function tzsetNum(s: string, min: number, max: number): [number, string] | undefined {
  if (s.length === 0) {
    return undefined;
  }
  let num = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x30 || c > 0x39) {
      if (i === 0 || num < min) {
        return undefined;
      }
      return [num, s.slice(i)];
    }
    num = num * 10 + (c - 0x30);
    if (num > max) {
      return undefined;
    }
  }
  return num < min ? undefined : [num, ""];
}

// tzruleTime: the seconds since the start of year at which rule r takes
// effect, in a zone with offset off
function tzruleTime(year: number, r: Rule, off: number): number {
  let s: number;
  if (r.kind === ruleJulian) {
    s = (r.day - 1) * secondsPerDay;
    if (isLeap(year) && r.day >= 60) {
      s += secondsPerDay;
    }
  } else if (r.kind === ruleDOY) {
    s = r.day * secondsPerDay;
  } else {
    // Zeller's congruence: the weekday of the first day of r.mon
    const m1 = ((r.mon + 9) % 12) + 1;
    const yy0 = r.mon <= 2 ? year - 1 : year;
    const yy1 = Math.trunc(yy0 / 100);
    const yy2 = yy0 % 100;
    let dow =
      (Math.trunc((26 * m1 - 2) / 10) +
        1 +
        yy2 +
        Math.trunc(yy2 / 4) +
        Math.trunc(yy1 / 4) -
        2 * yy1) %
      7;
    if (dow < 0) {
      dow += 7;
    }
    // the day of the month of the first `dow` day, then the r.week'th
    let d = r.day - dow;
    if (d < 0) {
      d += 7;
    }
    for (let i = 1; i < r.week; i++) {
      if (d + 7 >= daysIn(r.mon, year)) {
        break;
      }
      d += 7;
    }
    d += daysBefore[r.mon - 1] as number;
    if (isLeap(year) && r.mon > 2) {
      d++;
    }
    s = d * secondsPerDay;
  }
  return s + r.time - off;
}

// LoadLocationFromTZData: the location of TZif data; undefined when the
// data is not valid
export function loadLocationFromTZData(name: string, data: Uint8Array): Location | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 0;
  const need = (n: number): boolean => pos + n <= data.length;
  const big4 = (): number => {
    const v = view.getUint32(pos);
    pos += 4;
    return v;
  };

  // "TZif", a version byte and 15 bytes of padding
  if (!need(20) || new TextDecoder().decode(data.subarray(0, 4)) !== "TZif") {
    return undefined;
  }
  const versionByte = data[4];
  let version: number;
  if (versionByte === 0) {
    version = 1;
  } else if (versionByte === 0x32 || versionByte === 0x33) {
    version = versionByte - 0x30;
  } else {
    return undefined;
  }
  pos = 20;

  // the counts of UTC/local indicators, standard/wall indicators, leap
  // seconds, transition times, zones and abbreviation characters
  const readCounts = (): number[] | undefined => {
    if (!need(24)) {
      return undefined;
    }
    return [big4(), big4(), big4(), big4(), big4(), big4()];
  };
  let n = readCounts();
  if (n === undefined) {
    return undefined;
  }
  let [nUTCLocal, nStdWall, nLeap, nTime, nZone, nChar] = n as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  // version 2 and 3 repeat the data in a 64-bit format after the 32-bit
  // one: skip the 32-bit data and the second header, read the 64-bit data
  let size = 4;
  if (version > 1) {
    pos += nTime * 4 + nTime + nZone * 6 + nChar + nLeap * 8 + nStdWall + nUTCLocal + 4 + 16;
    n = readCounts();
    if (n === undefined) {
      return undefined;
    }
    [nUTCLocal, nStdWall, nLeap, nTime, nZone, nChar] = n as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    size = 8;
  }

  const total =
    nTime * size + nTime + nZone * 6 + nChar + nLeap * (size + 4) + nStdWall + nUTCLocal;
  if (!need(total)) {
    return undefined;
  }
  const txtimes = pos;
  const txzones = txtimes + nTime * size;
  const zonedata = txzones + nTime;
  const abbrev = data.subarray(zonedata + nZone * 6, zonedata + nZone * 6 + nChar);
  pos += total;

  let extend = "";
  const rest = data.subarray(pos);
  if (rest.length > 2 && rest[0] === 0x0a && rest[rest.length - 1] === 0x0a) {
    extend = new TextDecoder().decode(rest.subarray(1, rest.length - 1));
  }

  // tzdata files without zones are rejected
  if (nZone === 0) {
    return undefined;
  }
  const zones: Zone[] = [];
  for (let i = 0; i < nZone; i++) {
    const at = zonedata + i * 6;
    const nameIndex = data[at + 5] as number;
    if (nameIndex >= abbrev.length) {
      return undefined;
    }
    let nameEnd = abbrev.indexOf(0, nameIndex);
    if (nameEnd === -1) {
      nameEnd = abbrev.length;
    }
    zones.push({
      offset: view.getInt32(at),
      isDST: data[at + 4] !== 0,
      name: new TextDecoder().decode(abbrev.subarray(nameIndex, nameEnd)),
    });
  }

  const tx: ZoneTrans[] = [];
  for (let i = 0; i < nTime; i++) {
    const when =
      size === 4 ? view.getInt32(txtimes + i * 4) : Number(view.getBigInt64(txtimes + i * 8));
    const index = data[txzones + i] as number;
    if (index >= zones.length) {
      return undefined;
    }
    tx.push({ when, index });
  }
  if (tx.length === 0) {
    // a fake transition to cover all time, as in fixed locations
    tx.push({ when: alpha, index: 0 });
  }
  return new Location(name, zones, tx, extend);
}

// loadLocation: the TZif file name in the first source that has a valid one
function loadLocation(name: string, sources: string[]): Location | undefined {
  for (const source of sources) {
    let data: Uint8Array;
    try {
      data = readFileSync(source === "" ? name : source + "/" + name);
    } catch {
      continue;
    }
    const l = loadLocationFromTZData(name, data);
    if (l !== undefined) {
      return l;
    }
  }
  return undefined;
}

const platformZoneSources = [
  "/usr/share/zoneinfo/",
  "/usr/share/lib/zoneinfo/",
  "/usr/lib/locale/TZ/",
  "/etc/zoneinfo/",
];

// initLocal: time.Local for the TZ value tz (undefined when TZ is unset)
function initLocal(tz: string | undefined): Location {
  if (tz === undefined) {
    const z = loadLocation("localtime", ["/etc"]);
    if (z !== undefined) {
      return new Location("Local", z.zone, z.tx, z.extend);
    }
  } else if (tz !== "") {
    if (tz[0] === ":") {
      tz = tz.slice(1);
    }
    if (tz !== "" && tz[0] === "/") {
      const z = loadLocation(tz, [""]);
      if (z !== undefined) {
        return new Location(tz === "/etc/localtime" ? "Local" : tz, z.zone, z.tx, z.extend);
      }
    } else if (tz !== "" && tz !== "UTC") {
      const z = loadLocation(tz, platformZoneSources);
      if (z !== undefined) {
        return z;
      }
    }
  }
  // fall back to UTC
  return new Location("UTC", [], []);
}

let localCache: { tz: string | undefined; loc: Location } | undefined;

// the TZ environment variable, undefined when it is unset. Bun reads an
// empty TZ as undefined but keeps it enumerable, and an unset TZ is a
// non-enumerable accessor.
function envTZ(): string | undefined {
  if (!Object.prototype.propertyIsEnumerable.call(process.env, "TZ")) {
    return undefined;
  }
  return process.env["TZ"] ?? "";
}

// time.Local
export function localLocation(): Location {
  const tz = envTZ();
  if (localCache === undefined || localCache.tz !== tz) {
    localCache = { tz, loc: initLocal(tz) };
  }
  return localCache.loc;
}

// time.Date(year, month, day, hour, min, sec, nsec, loc): the fields are
// normalized as date does, then taken as wall time in loc. The offset is
// the one in effect at the wall time read as UTC, or, when the instant it
// gives is outside that zone's range, the one in effect at that instant. A
// wall time in a gap or an overlap is therefore resolved by which side of
// UTC the zone is on, exactly as in Go.
export function dateIn(
  year: number,
  month: number,
  day: number,
  hour: number,
  min: number,
  sec: number,
  nsec: number,
  loc: Location,
): Instant {
  const t = date(year, month, day, hour, min, sec, nsec);
  const z = lookup(loc, t.sec);
  let offset = z.offset;
  if (offset !== 0) {
    const utc = t.sec - offset;
    if (utc < z.start || utc >= z.end) {
      offset = lookup(loc, utc).offset;
    }
    t.sec -= offset;
  }
  return t;
}

// the end of time.Parse: the instant and location of parsed fields. "Z"
// and "UTC" are UTC; a numeric offset is Local when Local has that offset
// (and the parsed abbreviation, if any) at that instant, else a fixed
// zone; an abbreviation alone is Local's zone of that name, else a fixed
// zone of offset 0 (GMT±h: its hours) with the wall clock taken as UTC; no
// zone is UTC.
export function parsedTime(p: ParsedTime, local: Location = localLocation()): [Instant, Location] {
  const t = date(p.year, p.month, p.day, p.hour, p.min, p.sec, p.nsec);
  if (p.utc) {
    return [t, UTC];
  }
  if (p.zoneOffset !== undefined) {
    t.sec -= p.zoneOffset;
    const z = lookup(local, t.sec);
    if (z.offset === p.zoneOffset && (p.zoneName === "" || z.name === p.zoneName)) {
      return [t, local];
    }
    return [t, fixedZone(p.zoneName, p.zoneOffset)];
  }
  if (p.zoneName !== "") {
    const offset = lookupName(local, p.zoneName, t.sec);
    if (offset !== undefined) {
      t.sec -= offset;
      return [t, local];
    }
    let fixed = 0;
    if (p.zoneName.length > 3 && p.zoneName.startsWith("GMT")) {
      fixed = atoi(p.zoneName.slice(3)) * secondsPerHour;
    }
    return [t, fixedZone(p.zoneName, fixed)];
  }
  return [t, UTC];
}
