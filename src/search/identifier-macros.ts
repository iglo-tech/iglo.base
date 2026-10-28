// Upstream: tools/search/identifier_macros.go
//
// Upstream reads time.Now() through a package variable that its tests
// replace; here each macro is given the time the injected clock returns
// when the macro is resolved (filter.ts reads the clock at each macro, as
// upstream reads time.Now()).
//
// types.ParseDateTime of a time.Time never fails, so the macros' error
// branches are not ported.

import { fromDate } from "@/tools/types/cast";
import { DateTime } from "@/tools/types/datetime";
import { date, fieldsOf, type Instant } from "@/tools/types/go-time";

function dateTimeString(t: Instant): string {
  return DateTime.fromInstant(t).string();
}

export const identifierMacros: ReadonlyMap<string, (now: Date) => unknown> = new Map<
  string,
  (now: Date) => unknown
>([
  ["@now", (now) => dateTimeString(fromDate(now))],
  ["@yesterday", (now) => DateTime.fromInstant(fromDate(now)).addDate(0, 0, -1).string()],
  ["@tomorrow", (now) => DateTime.fromInstant(fromDate(now)).addDate(0, 0, 1).string()],
  ["@second", (now) => fieldsOf(fromDate(now)).sec],
  ["@minute", (now) => fieldsOf(fromDate(now)).min],
  ["@hour", (now) => fieldsOf(fromDate(now)).hour],
  ["@day", (now) => fieldsOf(fromDate(now)).day],
  ["@month", (now) => fieldsOf(fromDate(now)).month],
  ["@weekday", (now) => weekday(fromDate(now))],
  ["@year", (now) => fieldsOf(fromDate(now)).year],
  [
    "@todayStart",
    (now) => {
      const today = fieldsOf(fromDate(now));
      return dateTimeString(date(today.year, today.month, today.day, 0, 0, 0, 0));
    },
  ],
  [
    "@todayEnd",
    (now) => {
      const today = fieldsOf(fromDate(now));
      return dateTimeString(date(today.year, today.month, today.day, 23, 59, 59, 999999999));
    },
  ],
  [
    "@monthStart",
    (now) => {
      const today = fieldsOf(fromDate(now));
      return dateTimeString(date(today.year, today.month, 1, 0, 0, 0, 0));
    },
  ],
  [
    "@monthEnd",
    (now) => {
      const today = fieldsOf(fromDate(now));
      const start = date(today.year, today.month, 1, 23, 59, 59, 999999999);
      return DateTime.fromInstant(start).addDate(0, 1, -1).string();
    },
  ],
  [
    "@yearStart",
    (now) => {
      const today = fieldsOf(fromDate(now));
      return dateTimeString(date(today.year, 1, 1, 0, 0, 0, 0));
    },
  ],
  [
    "@yearEnd",
    (now) => {
      const today = fieldsOf(fromDate(now));
      return dateTimeString(date(today.year, 12, 31, 23, 59, 59, 999999999));
    },
  ],
]);

// time.Weekday: 0 is Sunday (January 1, 1970 was a Thursday)
function weekday(t: Instant): number {
  const days = Math.floor(t.sec / 86400);
  return (((days + 4) % 7) + 7) % 7;
}
