// Upstream: apis/sql.go, and the value conversions of the Go SQLite driver
// (modernc.org/sqlite v1.60.1: ColumnTypeDatabaseTypeName,
// ColumnTypeNullable, the DATE/DATETIME/TIMESTAMP text parsing of rows.Next)
// and database/sql's convertAssign into *string, which runSQL scans into.
//
// The statements run as upstream's: a possible write query in a write
// transaction on the write connection, anything else on a connection of
// its own, opened for the request with upstream's pragmas and closed after
// it: upstream's concurrent connections may write too ("select 1; vacuum"),
// so the read-only read pool cannot run them, and a `BEGIN`, `PRAGMA` or
// `ATTACH` must not reach the app's write connection, as upstream's never
// reach its nonconcurrent pool. The multi-statement handling is the driver's
// (src/db/dbx/driver.ts). The 3-minute deadline is checked as the rows are
// read; a single statement is not interrupted (the --queryTimeout row of
// docs/design/04-api-compatibility.md).

import type { App } from "@/app/app";
import type { RequestEvent } from "@/app/event-request";
import { firstApiError } from "@/apis/record-helpers";
import { driverError } from "@/collections/driver-error";
import { Deadline } from "@/db/dbx/query";
import { dataDBFilename } from "@/db/base";
import { defaultDBConnect } from "@/db/connect";
import { runInTransaction } from "@/db/tx";
import { requireSuperuserAuth } from "@/middlewares/require-auth";
import type { RouterGroup } from "@/server/group";
import type { HandlerResult } from "@/server/handler";
import { structOf } from "@/server/unmarshal-request-data";
import { bytesToText } from "@/tools/types/go-json";
import { Length } from "@/validation/length";
import { Required } from "@/validation/required";
import { Field, ValidateStruct } from "@/validation/struct";
import { formatFloatV } from "@/validation/error";
import { join } from "node:path";

const runSQLMaxRows = 1000;
const runSQLMaxTimeout = 3 * 60 * 1000;

// bindSQLApi registers the SQL api endpoints.
export function bindSQLApi(_app: App, rg: RouterGroup<RequestEvent>): void {
  const subGroup = rg.group("/sql").bind(requireSuperuserAuth());
  subGroup.POST("", runSQL);
}

const runSQLFormType = structOf([
  { name: "Query", type: "string", tags: { form: "query", json: "query" } },
]);

interface RunSQLForm {
  Query: string;
}

async function runSQL(e: RequestEvent): Promise<HandlerResult> {
  // extra precaution in case manually invoked from somewhere else
  if (!e.hasSuperuserAuth()) {
    return e.forbiddenError("", null);
  }

  const form: RunSQLForm = { Query: "" };

  const bindErr = await e.bindBody(form as unknown as Record<string, unknown>, runSQLFormType);
  if (bindErr) {
    return firstApiError(
      bindErr,
      e.badRequestError("An error occurred while loading the submitted data.", bindErr),
    );
  }

  const validateErr = ValidateStruct(Field("query", form.Query, Required, Length(0, 5000)));
  if (validateErr !== null) {
    return firstApiError(
      validateErr,
      e.badRequestError("An error occurred while validating the submitted data.", validateErr),
    );
  }

  let result: RunSQLResult;
  try {
    result = executeQuery(e.app, form.Query, runSQLMaxRows);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return firstApiError(
      err,
      e.badRequestError("Failed to execute query. Raw error:\n" + text, null),
    );
  }

  return e.json(200, result);
}

interface RunSQLResultColumn {
  name: string;
  type: string;
  nullable: boolean;
}

interface RunSQLResult {
  execTime: number;
  affectedRows: number;
  columns: RunSQLResultColumn[];
  rows: (string | null)[][];
}

const knownWriteQueryPrefixes = [
  "INSERT",
  "CREATE",
  "UPDATE",
  "DELETE",
  "DROP",
  "DETACH",
  "ALTER",
  "REPLACE",
];

function executeQuery(app: App, rawQuery: string, maxRows: number): RunSQLResult {
  const query = goTrimSpace(rawQuery);
  if (query === "") {
    // see https://github.com/mattn/go-sqlite3/issues/950
    throw new Error("empty query");
  }

  let isPossibleWriteQuery = false;

  // loosely check the query type
  const ucQuery = goToUpper(query);
  if (!ucQuery.startsWith("SELECT")) {
    isPossibleWriteQuery = knownWriteQueryPrefixes.some((prefix) => ucQuery.startsWith(prefix));
  }

  const databases = app.databases;
  const deadline = new Deadline(runSQLMaxTimeout, () => databases.now());

  const result: RunSQLResult = {
    execTime: 0,
    affectedRows: 0,
    // init empty arrays to ensure "[]" serialization
    columns: [],
    rows: [],
  };

  const start = performance.now();
  try {
    // assume write/mutation query
    if (isPossibleWriteQuery) {
      // auto wrap in transaction in case there are multiple inline queries
      runInTransaction(databases, (txApp) => {
        const execResult = withDriverError(() =>
          txApp.nonconcurrentDB().newQuery(query).withDeadline(deadline).execute(),
        );
        result.affectedRows = execResult.rowsAffected;
      });
      return result;
    }

    // assume query returning rows
    const conn = defaultDBConnect(join(app.dataDir, dataDBFilename));
    try {
      withDriverError(() => {
        const rows = conn.newQuery(query).withDeadline(deadline).withExactIntegers().rows();
        try {
          // populate columns info
          const names = rows.columns();
          const types = rows.declaredTypes();
          for (let i = 0; i < names.length; i++) {
            result.columns.push({
              name: names[i] as string,
              type: goToUpper(types[i] ?? ""),
              nullable: true,
            });
          }

          // populate rows
          for (const values of rows) {
            if (result.rows.length >= maxRows) {
              break;
            }
            result.rows.push(values.map((v, i) => scanString(v, result.columns[i]?.type ?? "")));
          }
        } finally {
          rows.close();
        }
      });
    } finally {
      // rolls back a transaction the query left open
      conn.close();
    }
    return result;
  } finally {
    result.execTime = Math.trunc(performance.now() - start);
  }
}

function withDriverError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw driverError(err);
  }
}

// -------------------------------------------------------------------
// The value a column gives database/sql's Scan into a *string: NULL is
// nil, an integer its decimal text, a float strconv.FormatFloat(f, 'g',
// -1, 64), a blob its bytes as a string (each invalid UTF-8 byte becomes
// U+FFFD when the JSON is written), and a text of a DATE, DATETIME or
// TIMESTAMP column that the driver parses as a time is that time in
// time.RFC3339Nano.

function scanString(v: unknown, declType: string): string | null {
  if (v === null || v === undefined) {
    return null;
  }
  if (typeof v === "bigint") {
    return v.toString();
  }
  if (typeof v === "number") {
    // a REAL value: the rows read every INTEGER value as a bigint
    return formatFloatV(v);
  }
  if (v instanceof Uint8Array) {
    // unpaired U+DC80..U+DCFF stand for invalid bytes (bytesToText)
    return bytesToText(v).replace(/(?<![\ud800-\udbff])[\udc80-\udcff]/g, "�");
  }
  const text = String(v);
  if (declType === "DATE" || declType === "DATETIME" || declType === "TIMESTAMP") {
    return parseDriverTime(text) ?? text;
  }
  return text;
}

// strings.TrimSpace: Unicode White_Space at both ends
function goTrimSpace(s: string): string {
  // \s without U+FEFF, plus U+0085
  return s.replace(/^(?:[^\S\ufeff]|\u0085)+|(?:[^\S\ufeff]|\u0085)+$/g, "");
}

// strings.ToUpper: each rune's simple upper case mapping (no expansions
// such as "ß" to "SS")
function goToUpper(s: string): string {
  if (/^\p{ASCII}*$/u.test(s)) {
    return s.toUpperCase();
  }
  let out = "";
  for (const ch of s) {
    const up = ch.toUpperCase();
    out += [...up].length === 1 ? up : ch;
  }
  return out;
}

// -------------------------------------------------------------------
// The driver's parseTime: time.Parse with its layouts, in order, on the
// text without one trailing "Z", after the t.String() form
// ("2006-01-02 15:04:05.999999999 -0700 MST", up to an "m=" monotonic
// clock reading). Returns the time in RFC3339Nano, or undefined when no
// layout matches.

type Token =
  | "year"
  | "month"
  | "day"
  | "hour"
  | "minute"
  | "second"
  | "frac"
  | "numColonTZ"
  | "numTZ"
  | "tzName"
  | { lit: string };

const lit = (s: string): Token => ({ lit: s });

const date: Token[] = ["year", lit("-"), "month", lit("-"), "day"];
const clock = (sep: string, seconds: boolean): Token[] => [
  ...date,
  lit(sep),
  "hour",
  lit(":"),
  "minute",
  ...(seconds ? [lit(":"), "second" as Token, "frac" as Token] : []),
];

const timeStringLayout: Token[] = [...clock(" ", true), lit(" "), "numTZ", lit(" "), "tzName"];

const parseTimeLayouts: Token[][] = [
  [...clock(" ", true), "numColonTZ"],
  [...clock("T", true), "numColonTZ"],
  clock(" ", true),
  clock("T", true),
  clock(" ", false),
  clock("T", false),
  date,
];

function parseDriverTime(s: string): string | undefined {
  // parseTimeString
  const x = s.indexOf("m=");
  const ts0 = goTrimSpace(x > 0 ? s.slice(0, x) : s);
  const parsed = goParseTime(timeStringLayout, ts0);
  if (parsed !== undefined) {
    return parsed;
  }

  const ts = s.endsWith("Z") ? s.slice(0, -1) : s;
  for (const layout of parseTimeLayouts) {
    const t = goParseTime(layout, ts);
    if (t !== undefined) {
      return t;
    }
  }
  return undefined;
}

const isDigit = (s: string, i: number): boolean => i < s.length && s[i]! >= "0" && s[i]! <= "9";

// getnum: one or two digits (exactly two when fixed)
function getnum(s: string, fixed: boolean): [number, string] | undefined {
  if (!isDigit(s, 0)) {
    return undefined;
  }
  if (!isDigit(s, 1)) {
    return fixed ? undefined : [Number(s[0]), s.slice(1)];
  }
  return [Number(s.slice(0, 2)), s.slice(2)];
}

// parseTimeZone: the length of a time zone abbreviation at the start of s
function parseTimeZone(s: string): number | undefined {
  if (s.length < 3) {
    return undefined;
  }
  if (s.startsWith("ChST") || s.startsWith("MeST")) {
    return 4;
  }
  if (s.startsWith("GMT")) {
    const m = /^[+-](\d+)/.exec(s.slice(3));
    if (m === null) {
      return 3;
    }
    const n = Number(m[1]);
    return n === 0 || n < -23 || n > 23 ? 3 : 3 + m[0].length;
  }
  if (s[0] === "+" || s[0] === "-") {
    const m = /^[+-](\d+)/.exec(s);
    return m === null ? undefined : m[0].length;
  }
  let nUpper = 0;
  while (nUpper < 6 && nUpper < s.length && s[nUpper]! >= "A" && s[nUpper]! <= "Z") {
    nUpper++;
  }
  switch (nUpper) {
    case 3:
      return 3;
    case 4:
      return s[3] === "T" || s.startsWith("WITA") ? 4 : undefined;
    case 5:
      return s[4] === "T" ? 5 : undefined;
    default:
      return undefined;
  }
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

function daysIn(month: number, year: number): number {
  if (month === 2) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// time.Parse with a layout of the tokens above, formatted as RFC3339Nano.
function goParseTime(layout: Token[], value: string): string | undefined {
  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let nsec = 0;
  let offset: number | undefined;
  let utcName = false;

  const fraction = (n: number): void => {
    // parseNanoseconds: up to 9 digits count
    const digits = value.slice(1, Math.min(n, 10));
    nsec = Number(digits.padEnd(9, "0"));
    value = value.slice(n);
  };

  for (let i = 0; i < layout.length; i++) {
    const token = layout[i]!;
    if (typeof token === "object") {
      // skip: a space matches one or more spaces
      for (const c of token.lit) {
        if (c === " ") {
          if (value.length > 0 && value[0] !== " ") {
            return undefined;
          }
          value = value.replace(/^ +/, "");
          continue;
        }
        if (value[0] !== c) {
          return undefined;
        }
        value = value.slice(1);
      }
      continue;
    }
    let got: [number, string] | undefined;
    switch (token) {
      case "year":
        if (!/^\d{4}/.test(value)) {
          return undefined;
        }
        year = Number(value.slice(0, 4));
        value = value.slice(4);
        break;
      case "month":
        got = getnum(value, true);
        if (got === undefined || got[0] < 1 || got[0] > 12) {
          return undefined;
        }
        [month, value] = got;
        break;
      case "day":
        got = getnum(value, true);
        if (got === undefined) {
          return undefined;
        }
        [day, value] = got;
        break;
      case "hour":
        got = getnum(value, false);
        if (got === undefined || got[0] >= 24) {
          return undefined;
        }
        [hour, value] = got;
        break;
      case "minute":
        got = getnum(value, true);
        if (got === undefined || got[0] >= 60) {
          return undefined;
        }
        [minute, value] = got;
        break;
      case "second": {
        got = getnum(value, true);
        if (got === undefined || got[0] >= 60) {
          return undefined;
        }
        [second, value] = got;
        // a fractional second the layout does not have
        if (
          layout[i + 1] !== "frac" &&
          value.length >= 2 &&
          (value[0] === "." || value[0] === ",") &&
          isDigit(value, 1)
        ) {
          let n = 2;
          while (isDigit(value, n)) {
            n++;
          }
          fraction(n);
        }
        break;
      }
      case "frac": {
        if (value.length < 2 || (value[0] !== "." && value[0] !== ",") || !isDigit(value, 1)) {
          break; // fractional second omitted
        }
        let n = 1;
        while (isDigit(value, n)) {
          n++;
        }
        fraction(n);
        break;
      }
      case "numColonTZ":
      case "numTZ": {
        const colon = token === "numColonTZ";
        if (value.length < (colon ? 6 : 5) || (colon && value[3] !== ":")) {
          return undefined;
        }
        const sign = value[0];
        const hh = getnum(value.slice(1, 3), true);
        const mm = getnum(value.slice(colon ? 4 : 3, colon ? 6 : 5), true);
        if ((sign !== "+" && sign !== "-") || hh === undefined || mm === undefined) {
          return undefined;
        }
        if (hh[0] > 24 || mm[0] > 60) {
          return undefined;
        }
        offset = (hh[0] * 60 + mm[0]) * 60 * (sign === "-" ? -1 : 1);
        value = value.slice(colon ? 6 : 5);
        break;
      }
      case "tzName": {
        if (value.startsWith("UTC")) {
          utcName = true;
          value = value.slice(3);
          break;
        }
        const n = parseTimeZone(value);
        if (n === undefined) {
          return undefined;
        }
        value = value.slice(n);
        break;
      }
    }
  }
  if (value.length > 0 || day < 1 || day > daysIn(month, year)) {
    return undefined;
  }
  if (utcName) {
    offset = 0;
  }

  let text = `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
  if (nsec > 0) {
    text += "." + pad(nsec, 9).replace(/0+$/, "");
  }
  if (offset === undefined || offset === 0) {
    return text + "Z";
  }
  const abs = Math.abs(offset) / 60;
  return `${text}${offset < 0 ? "-" : "+"}${pad(Math.trunc(abs / 60))}:${pad(abs % 60)}`;
}
