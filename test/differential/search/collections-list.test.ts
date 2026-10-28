// The search Provider and the simple field resolver (src/search/) against
// the reference PocketBase v0.41.0 binary. Not part of `bun test`: run
// `bun run test:reference`.
//
// Upstream's collections list endpoint (apis/collection.go collectionsList)
// runs search.NewProvider with
// search.NewSimpleFieldResolver("id", "created", "updated", "name",
// "system", "type") over CollectionQuery(), parsing
// e.Request.URL.Query().Encode(), and answers a failed parse or exec with
// e.BadRequestError("", err).
//
// On a fresh upstream install, the test creates collections through the
// API, then sends each case's query string to
// GET /api/collections as a superuser. After upstream stops, the same query
// string goes through the same steps in iglo.base (url.Values parsing that
// ignores errors, Encode, Provider.ParseAndExec over collectionQuery) on a
// copy of the pb_data directory, once on the main thread and once through
// the read worker pool. The returned ids in order, the page fields and the
// error bodies (status, message, data) must be equal.
//
// The record cases list the records of the base collection `texts` (a text
// field `value`) through upstream's records list endpoint as a superuser,
// and through Provider.ParseAndExec over `SELECT texts.* FROM texts` with a
// simple field resolver for id and value here. A number literal is a Go
// float64, which compares with TEXT as its REAL text ('5.0', not '5').

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Clock } from "@/app/clock";
import { collectionQuery } from "@/collections/collection-query";
import { Collection } from "@/collections/collection-model";
import { newBadRequestError } from "@/server/error";
import { parseQuery } from "@/server/request";
import { ParsedFilterCache } from "@/search/filter";
import { newProvider } from "@/search/provider";
import { newSimpleFieldResolver } from "@/search/simple-field-resolver";

import { openDataDir, type TestCollectionsApp } from "@test/collections/app";
import { runUpstream } from "@test/differential/db/fixture";
import { copyDataDir } from "@test/scenarios/fixture";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

const superEmail = "search@example.com";
const superPassword = "1234567890";

let root: string;
let dataDir: string;
let upstream: UpstreamServer | undefined;
let token: string;

const clock: Clock = { now: () => new Date() };

// base, auth and view collections; the names exercise `~` escaping (a_b
// against axb) and case-insensitive LIKE
const collections: object[] = [
  { name: "posts", type: "base" },
  { name: "posts_archive", type: "base" },
  { name: "a_b", type: "base" },
  { name: "axb", type: "base" },
  { name: "Authors", type: "auth" },
  { name: "members", type: "auth" },
  { name: "zeta", type: "base" },
  { name: "beta_items", type: "base" },
  { name: "Gamma", type: "base" },
  { name: "x1", type: "base" },
  { name: "x10", type: "base" },
  { name: "x2", type: "base" },
  // a numeric name: `name = 5` compares it with REAL 5 ('5.0')
  { name: "5", type: "base" },
  {
    name: "texts",
    type: "base",
    fields: [{ name: "value", type: "text" }],
  },
  { name: "posts_view", type: "view", viewQuery: "select id from posts" },
  { name: "authors_view", type: "view", viewQuery: "select id, email from Authors" },
];

function q(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
}

const f = (filter: string): string => q({ filter, sort: "name" });
const sortQuery = (sort: string): string => q({ sort });

function exprs(n: number): string {
  return Array.from({ length: n }, (_, i) => `name != 'n${i}'`).join(" && ");
}

// [name, raw query string, compare ids as a set (random order)]
const cases: [string, string, boolean?][] = [
  ["no params", ""],
  // operators
  ["eq", f("name = 'posts'")],
  ["neq", f("name != 'posts'")],
  ["like", f("name ~ 'post'")],
  ["not like", f("name !~ 'post'")],
  ["like escapes _", f("name ~ 'a_b'")],
  ["like with an escaped _", f("name ~ 'a\\_b'")],
  ["like with a wildcard", f("name ~ 'po%'")],
  ["like with a leading wildcard", f("name ~ '%s'")],
  ["like with % and _", f("name ~ '%_%'")],
  ["like with only _", f("name ~ '_'")],
  ["like is case-insensitive", f("name ~ 'GAM'")],
  ["like empty", f("id ~ ''")],
  ["like with a backslash", f("name ~ '\\\\'")],
  ["gt", f("name > 'm'")],
  ["gte and lte", f("name >= 'posts' && name <= 'z'")],
  ["lt", f("name < 'b'")],
  ["any eq", f("name ?= 'posts'")],
  ["any like", f("name ?~ 'p'")],
  ["any neq", f("name ?!= 'posts'")],
  ["any not like", f("name ?!~ 'x'")],
  ["any lt", f("name ?< 'c'")],
  ["number vs text", f("name = 1")],
  ["number vs numeric name", f("name = 5")],
  ["real vs numeric name", f("name = 5.0")],
  ["number neq numeric name", f("name != 5")],
  ["number gt name", f("name > 5")],
  ["number lt name", f("name < 5")],
  ["number like name", f("name ~ 5")],
  ["number not like name", f("name !~ 5")],
  ["any eq number", f("name ?= 5")],
  ["any neq number", f("name ?!= 5")],
  ["double quotes", f(`name = "posts"`)],
  ["escaped quote", f("name = 'po\\'sts'")],
  // bools, null, empty
  ["system true", f("system = true")],
  ["system false", f("system = false")],
  ["system not true", f("system != true")],
  ["system TRUE", f("system = TRUE")],
  ["system 1", f("system = 1")],
  ["name null", f("name = null")],
  ["name not null", f("name != null")],
  ["null null", f("null = null")],
  ["empty vs null", f("'' = null")],
  ["id empty", f("id = ''")],
  ["id not empty", f("id != ''")],
  ["text vs text", f("'a' = 'a'")],
  ["number vs number", f("1 < 2")],
  // groups and joins
  ["type auth", f("type = 'auth'")],
  ["and", f("type = 'base' && system = false")],
  ["or", f("type = 'view' || type = 'auth'")],
  [
    "nested groups",
    f("(type = 'base' || type = 'auth') && (name ~ 'a' || (name ~ 'e' && system = false))"),
  ],
  ["and/or precedence", f("type = 'view' || type = 'auth' && name ~ 'm'")],
  ["comment", f("name = 'posts' // comment")],
  ["newlines", f("name = 'posts'\n||\nname = 'zeta'")],
  ["created text", f("created > '2000-01-01'")],
  // macros
  ["now", f("created < @now")],
  ["yesterday", f("created > @yesterday")],
  ["tomorrow", f("created <= @tomorrow")],
  ["yearEnd", f("updated < @yearEnd")],
  ["year", f("@year > 2000")],
  ["month", f("@month >= 1 && @month <= 12")],
  ["weekday", f("@weekday >= 0 && @weekday < 7")],
  ["time parts", f("@second >= 0 && @minute >= 0 && @hour >= 0 && @day >= 1")],
  ["monthStart", f("@monthStart <= @now && @yearStart <= @monthEnd")],
  // functions
  ["strftime year", f("strftime('%Y', created) = strftime('%Y', @now)")],
  ["strftime not empty", f("strftime('%Y-%m', created) != ''")],
  ["strftime format only", f("strftime('%s') > 0")],
  ["strftime modifiers", f("strftime('%Y', created, '+1 years') > strftime('%Y', created)")],
  ["geoDistance zero", f("geoDistance(0, 0, 0, 0) = 0")],
  ["geoDistance", f("geoDistance(10, 20, 30, 40) > 100")],
  ["geoDistance with null", f("geoDistance(null, 20, 30, 40) = null")],
  // errors
  ["unknown function", f("unknownfn() = 1")],
  ["unknown field", f("unknown = 1")],
  ["modifier", f("name:lower = 'posts'")],
  ["json path", f("name.x = 1")],
  ["request field", f("@request.auth.id != ''")],
  ["incomplete", f("name =")],
  ["missing bracket", f("(name = 'x'")],
  ["extra bracket", f("name = 'x')")],
  ["invalid sign", f("name =! 'x'")],
  ["empty filter", f("// only a comment")],
  ["empty group", f("()")],
  ["geoDistance arguments", f("geoDistance(1, 2) = 1")],
  ["strftime format", f("strftime(1) = 1")],
  // limits
  ["200 expressions", f(exprs(200))],
  ["201 expressions", f(exprs(201))],
  ["3500 bytes", f("name != '" + "a".repeat(3489) + "'")],
  ["3501 bytes", f("name != '" + "a".repeat(3490) + "'")],
  // sort
  ["sort name", sortQuery("name")],
  ["sort -name", sortQuery("-name")],
  ["sort created", sortQuery("-created,name")],
  ["sort rowid", sortQuery("@rowid")],
  ["sort -rowid", sortQuery("-@rowid")],
  ["sort random", sortQuery("@random"), true],
  ["sort unknown", sortQuery("unknown")],
  ["sort three", sortQuery("type,-name,+id")],
  ["sort 8", sortQuery("type,name,id,created,updated,system,-name,-type")],
  ["sort 9", sortQuery("type,name,id,created,updated,system,-name,-type,id")],
  ["sort spaces", sortQuery(" name , -type ")],
  ["sort empty name", sortQuery("-")],
  ["sort null", sortQuery("null")],
  ["sort empty item", sortQuery("name,,type")],
  ["sort long", sortQuery("a".repeat(256))],
  // pages
  ["page 2", q({ page: "2", perPage: "3", sort: "name" })],
  ["page 0", q({ page: "0", perPage: "4", sort: "name" })],
  ["page -1", q({ page: "-1", sort: "name" })],
  ["page abc", q({ page: "abc" })],
  ["page 1.5", q({ page: "1.5" })],
  ["page +3", q({ page: "+3", perPage: "2", sort: "name" })],
  ["page 007", q({ page: "007", perPage: "2", sort: "name" })],
  ["page past the end", q({ page: "100", sort: "name" })],
  ["page max int64", q({ page: "9223372036854775807", perPage: "1" })],
  ["page past int64", q({ page: "9223372036854775808" })],
  ["perPage 0", q({ perPage: "0", sort: "name" })],
  ["perPage 1001", q({ perPage: "1001", sort: "name" })],
  ["perPage -5", q({ perPage: "-5", sort: "name" })],
  ["perPage 1.5", q({ perPage: "1.5" })],
  ["skipTotal 1", q({ skipTotal: "1", sort: "name" })],
  ["skipTotal true with pages", q({ skipTotal: "true", page: "2", perPage: "2", sort: "name" })],
  ["skipTotal abc", q({ skipTotal: "abc" })],
  ["skipTotal 0", q({ skipTotal: "0", sort: "name" })],
  ["skipTotal empty", q({ skipTotal: "", sort: "name" })],
  // query string parsing (URL.Query drops what it cannot parse)
  ["semicolon pair", "filter=name%3D'posts';x&sort=name"],
  ["bad escape", "page=%zz&sort=name"],
  ["repeated key", "sort=name&sort=-name&filter=type%3D'base'&filter=type%3D'auth'"],
  ["plus is a space", "filter=name+%3D+'posts'"],
  ["empty key", "=x&&sort=name"],
];

// the `value` of each record in `texts`
const textValues = ["1", "1.0", "5", "5.0", "5.5", "10", "-1", "-1.0", "0", "0.0", "1e1", "a", ""];

const r = (filter: string): string => q({ filter, perPage: "100" });

// [name, raw query string] against the texts records; ids compared as a set
const recordCases: [string, string][] = [
  ["eq 1", r("value = 1")],
  ["eq 1.0", r("value = 1.0")],
  ["eq 5.5", r("value = 5.5")],
  ["eq 10", r("value = 10")],
  ["eq -1", r("value = -1")],
  ["eq 0", r("value = 0")],
  ["eq reversed", r("1 = value")],
  ["neq 1", r("value != 1")],
  ["neq 5.5", r("value != 5.5")],
  ["neq 0", r("value != 0")],
  ["gt 1", r("value > 1")],
  ["gte 5", r("value >= 5")],
  ["lt 5", r("value < 5")],
  ["lte 1.0", r("value <= 1.0")],
  ["like 1", r("value ~ 1")],
  ["like 1.0", r("value ~ 1.0")],
  ["like 5.5", r("value ~ 5.5")],
  ["not like 5", r("value !~ 5")],
  ["any eq 1", r("value ?= 1")],
  ["any eq 5.5", r("value ?= 5.5")],
  ["any neq 5", r("value ?!= 5")],
  ["any gt 1", r("value ?> 1")],
  ["any like 0", r("value ?~ 0")],
  ["text or number vs number", r("value = 'a' || 1 = 1.0")],
  ["geoDistance with integers", r("geoDistance(0, 0, 0, 1) > 111 && value = 1")],
  ["strftime with a number", r("strftime('%Y', 0) = '-4713' && value = 5")],
];

interface Outcome {
  status: number;
  // the list fields or the error body
  body: unknown;
}

function listBody(
  ids: string[],
  page: unknown,
  perPage: unknown,
  totalItems: unknown,
  totalPages: unknown,
  asSet: boolean,
): unknown {
  return {
    ids: asSet ? ids.toSorted() : ids,
    page: String(page),
    perPage: String(perPage),
    totalItems: String(totalItems),
    totalPages: String(totalPages),
  };
}

const upstreamOutcomes = new Map<string, Outcome>();

// an upstream list body
function upstreamList(name: string): { ids: string[] } {
  return upstreamOutcomes.get(name)?.body as { ids: string[] };
}
// the raw query strings as fetch sent them
const sentQueries = new Map<string, string>();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "iglo-base-search-ref-"));
  dataDir = join(root, "pb_data");
  const upsert = await runUpstream(
    ["superuser", "upsert", superEmail, superPassword, "--dir", dataDir],
    root,
  );
  expect(upsert.exitCode).toBe(0);
  upstream = await startUpstream({ dataDir });
  let res = await fetch(`${upstream.url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: superEmail, password: superPassword }),
  });
  expect(res.status).toBe(200);
  token = ((await res.json()) as { token: string }).token;

  for (const body of collections) {
    res = await fetch(`${upstream.url}/api/collections`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: token },
      body: JSON.stringify(body),
    });
    expect({ status: res.status, body: res.status === 200 ? "" : await res.text() }).toEqual({
      status: 200,
      body: "",
    });
  }

  for (const value of textValues) {
    res = await fetch(`${upstream.url}/api/collections/texts/records`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: token },
      body: JSON.stringify({ value }),
    });
    expect(res.status).toBe(200);
  }

  const all: (readonly [string, string, boolean | undefined, string])[] = [
    ...cases.map(([name, raw, asSet]) => [name, raw, asSet, "collections"] as const),
    ...recordCases.map(
      ([name, raw]) => ["records " + name, raw, true, "collections/texts/records"] as const,
    ),
  ];
  for (const [name, raw, asSet, path] of all) {
    const url = new URL(`${upstream.url}/api/${path}?${raw}`);
    sentQueries.set(name, url.search.slice(1));
    res = await fetch(url, { headers: { authorization: token } });
    // the body is parsed with integers kept as text (page can be past 2^53)
    const text = await res.text();
    const json = JSON.parse(text.replace(/:(-?\d+)([,}])/g, ':"$1"$2')) as {
      items?: { id: string }[];
      page?: string;
      perPage?: string;
      totalItems?: string;
      totalPages?: string;
      status?: string;
      message?: string;
      data?: unknown;
    };
    upstreamOutcomes.set(
      name,
      res.status === 200
        ? {
            status: 200,
            body: listBody(
              (json.items ?? []).map((item) => item.id),
              json.page,
              json.perPage,
              json.totalItems,
              json.totalPages,
              asSet === true,
            ),
          }
        : {
            status: res.status,
            body: { status: json.status, message: json.message, data: json.data },
          },
    );
  }

  await upstream.stop();
  upstream = undefined;
}, 120_000);

afterAll(async () => {
  await upstream?.stop();
  rmSync(root, { recursive: true, force: true });
});

// Go's url.QueryEscape
function queryEscape(s: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(s)) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.~]/.test(c)) {
      out += c;
    } else if (c === " ") {
      out += "+";
    } else {
      out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

// e.Request.URL.Query().Encode(): the parsed values (errors ignored),
// sorted by key
function queryEncode(rawQuery: string): string {
  const { values } = parseQuery(rawQuery);
  const parts: string[] = [];
  for (const key of [...values.keys()].toSorted()) {
    for (const v of values.get(key) ?? []) {
      parts.push(queryEscape(key) + "=" + queryEscape(v));
    }
  }
  return parts.join("&");
}

async function igloOutcome(
  app: TestCollectionsApp,
  cache: ParsedFilterCache,
  rawQuery: string,
  asSet: boolean,
  records = false,
): Promise<Outcome> {
  const fieldResolver = records
    ? newSimpleFieldResolver("id", "value")
    : newSimpleFieldResolver("id", "created", "updated", "name", "system", "type");
  try {
    const result = records
      ? await newProvider(fieldResolver, { clock, cache })
          .query(app.databases.concurrentDB().select("texts.*").from("texts"))
          .parseAndExec<{ id: string }>(queryEncode(rawQuery))
      : await newProvider(fieldResolver, { clock, cache })
          .query(collectionQuery(app))
          .parseAndExec<Collection>(queryEncode(rawQuery), () => new Collection());
    return {
      status: 200,
      body: listBody(
        result.items.map((c) => c.id),
        result.page,
        result.perPage,
        result.totalItems,
        result.totalPages,
        asSet,
      ),
    };
  } catch (err) {
    const apiErr = newBadRequestError("", err);
    return {
      status: apiErr.status,
      body: JSON.parse(JSON.stringify(apiErr.toJSON()), (_k, v: unknown) =>
        typeof v === "number" ? String(v) : v,
      ) as unknown,
    };
  }
}

describe("collections list", () => {
  test("cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(80);
    expect(new Set(cases.map(([name]) => name)).size).toBe(cases.length);
  });

  for (const [mode, queryTimeout] of [
    ["main thread", undefined],
    ["read pool", 5000],
  ] as const) {
    test(
      mode,
      async () => {
        const copyDir = join(root, `copy-${mode.replace(" ", "-")}`);
        copyDataDir(dataDir, copyDir);
        const app = openDataDir(copyDir, clock, () => {}, undefined, queryTimeout);
        const cache = new ParsedFilterCache();
        try {
          const mismatches: unknown[] = [];
          const all: (readonly [string, boolean, boolean])[] = [
            ...cases.map(([name, , asSet]) => [name, asSet === true, false] as const),
            ...recordCases.map(([name]) => ["records " + name, true, true] as const),
          ];
          for (const [name, asSet, records] of all) {
            const expected = upstreamOutcomes.get(name);
            // twice: the second run reads the parsed filter from the cache
            for (let i = 0; i < 2; i++) {
              const got = await igloOutcome(
                app,
                cache,
                sentQueries.get(name) ?? "",
                asSet,
                records,
              );
              if (!Bun.deepEquals(got, expected)) {
                mismatches.push({ name, run: i, expected, got });
              }
            }
          }
          expect(mismatches).toEqual([]);
        } finally {
          app.cleanup();
        }
      },
      60_000,
    );
  }

  // the REAL comparisons pick other rows than INTEGER ones would
  test("number literals compare as REAL", () => {
    expect(upstreamList("number vs numeric name").ids).toEqual([]);
    expect(upstreamList("records eq 1").ids.length).toBe(1);
    expect(upstreamList("records eq 5.5").ids.length).toBe(1);
  });

  test("the cases cover lists and errors", () => {
    const statuses = [...upstreamOutcomes.values()].map((o) => o.status);
    expect(statuses.filter((st) => st === 200).length).toBeGreaterThan(60);
    expect(statuses.filter((st) => st === 400).length).toBeGreaterThan(20);
  });
});
