// The record field resolver (src/resolver/), FindRecordsByFilter and
// CanAccessRecord (src/records/record-query-filter.ts) against the
// reference PocketBase v0.41.0 binary. Not part of `bun test`: run
// `bun run test:reference`.
//
// A fresh upstream install gets the collections and records of schema.ts
// through its API (a file is uploaded to one record). Then:
//
//   (a) each filter case (filter-cases.ts) goes to upstream's
//       GET /api/collections/{c}/records?filter=…&sort=…&perPage=200 as a
//       superuser. When upstream fails, the same filter is also sent as the
//       collection's listRule (PATCH /api/collections/{c}), which exposes
//       the resolver's raw error text ("Invalid rule. Raw error: …"); a
//       rule that passes is put back.
//   (b) each rules matrix case (rule-cases.ts) sets the target's listRule
//       and viewRule (PATCH), lists the target and views each of its
//       records as a guest, alice, bob, carol and a superuser (tokens from
//       auth-with-password), then puts the rules back.
//
// After upstream stops, iglo.base runs on a copy of the same pb_data, with
// a read worker pool. (a): records list's steps (apis/record_crud.go
// recordsList, as M2.4 will wire them) through the M2.1 Provider with the
// record field resolver, compared by ids in order, page fields and error
// body; FindRecordsByFilter (async) and FindRecordsByFilter (sync) with the
// same filter and sort must give upstream's ids (cases that use
// @request.* are Provider only: FindRecordsByFilter has no request info);
// a failed case's rule check (validateCollection) must give upstream's
// listRule error. (b): the list as above, with the rule expression on the
// list query (resolver UpdateQuery + rule) for a RequestInfo holding the
// same auth record, query and headers, and each record's view through
// CanAccessRecord (sync and async). The stored rules of the copy follow
// upstream's for each case.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Clock } from "@/app/clock";
import { RequestInfo, snakecase } from "@/app/event-request";
import type { Collection } from "@/collections/collection-model";
import {
  type CollectionsApp,
  findCachedCollectionByNameOrId,
  findCollectionByNameOrId,
  reloadCachedCollections,
} from "@/collections/collection-query";
import { validateCollection } from "@/collections/collection-validate";
import { Databases } from "@/db/base";
import type { Record } from "@/records/record-model";
import {
  findAuthRecordByEmail,
  findRecordById,
  recordQuery,
  recordsTarget,
} from "@/records/record-query";
import {
  canAccessRecord,
  canAccessRecordAsync,
  findRecordsByFilter,
  findRecordsByFilterAsync,
} from "@/records/record-query-filter";
import { newRecordFieldResolver } from "@/resolver/record-field-resolver";
import { newBadRequestError, newForbiddenError } from "@/server/error";
import { parseQuery } from "@/server/request";
import { filterBuildExpr, ParsedFilterCache } from "@/search/filter";
import { newProvider } from "@/search/provider";
import { Store } from "@/tools/store/store";
import { Errors } from "@/validation/error";

import { runUpstream } from "@test/differential/db/fixture";
import { type FilterCase, filterCases } from "@test/differential/resolver/filter-cases";
import { type RuleCase, ruleCases } from "@test/differential/resolver/rule-cases";
import {
  authUsers,
  collectionSteps,
  password,
  recordSteps,
  rid,
} from "@test/differential/resolver/schema";
import { copyDataDir } from "@test/scenarios/fixture";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

const superEmail = "resolver@example.com";
const clock: Clock = { now: () => new Date() };

const identities = ["guest", "alice", "bob", "carol", "superuser"] as const;
type Identity = (typeof identities)[number];

let root: string;
let dataDir: string;
let upstream: UpstreamServer | undefined;
const tokens = new Map<Identity, string>();
const collectionIds = new Map<string, string>();
// the rules as created (restored after each case)
const originalRules = new Map<string, { listRule: string | null; viewRule: string | null }>();
// the record ids of each rules matrix target
const targetIds = new Map<string, string[]>();

interface Outcome {
  status: number;
  body: unknown;
}

const filterOutcomes = new Map<string, Outcome>();
// the listRule error of a failed filter (null when the rule is valid)
const ruleErrors = new Map<string, unknown>();
const sentFilterQueries = new Map<string, string>();

interface RuleOutcome {
  list: Outcome;
  views: { [id: string]: number };
}
const ruleOutcomes = new Map<string, RuleOutcome>();
const sentRuleQueries = new Map<string, string>();

function ids(name: string): string {
  const id = collectionIds.get(name);
  if (id === undefined) {
    throw new Error(`unknown collection ${name}`);
  }
  return id;
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  auth: string = tokens.get("superuser") ?? "",
  headers: { [key: string]: string } = {},
): Promise<{ status: number; json: unknown }> {
  if (upstream === undefined) {
    throw new Error("upstream is not running");
  }
  const init: RequestInit = { method, headers: { ...headers } };
  if (auth !== "") {
    (init.headers as { [key: string]: string }).authorization = auth;
  }
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    (init.headers as { [key: string]: string })["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${upstream.url}${path}`, init);
  const text = await res.text();
  return { status: res.status, json: text === "" ? null : (JSON.parse(text) as unknown) };
}

async function ok(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await api(method, path, body);
  if (res.status !== 200 && res.status !== 204) {
    throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(res.json)}`);
  }
  return res.json;
}

async function signIn(collection: string, email: string): Promise<string> {
  const res = await api(
    "POST",
    `/api/collections/${collection}/auth-with-password`,
    { identity: email, password },
    "",
  );
  expect(res.status).toBe(200);
  return (res.json as { token: string }).token;
}

function qs(params: { [key: string]: string }): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function filterQuery(fc: FilterCase): string {
  const params: { [key: string]: string } = { perPage: "200" };
  if (fc.filter !== "") {
    params.filter = fc.filter;
  }
  if (fc.sort !== "") {
    params.sort = fc.sort;
  }
  return qs(params);
}

function ruleText(rule: string | null | undefined): string | null {
  if (rule === null || rule === undefined) {
    return null;
  }
  return rule.replaceAll(/\{id:(\w+)\}/g, (_m, name: string) => ids(name));
}

function caseRules(rc: RuleCase): { listRule: string | null; viewRule: string | null } {
  const listRule = ruleText(rc.listRule);
  const viewRule = rc.viewRule === undefined ? listRule : ruleText(rc.viewRule);
  return { listRule, viewRule };
}

function listQueryParams(rc: RuleCase): { [key: string]: string } {
  const params: { [key: string]: string } = { perPage: "200", sort: "id", ...rc.query };
  if (rc.filter !== undefined) {
    params.filter = rc.filter;
  }
  return params;
}

function listOutcome(status: number, json: unknown, asSet: boolean): Outcome {
  if (status === 200) {
    const list = json as {
      items: { id: string }[];
      page: number;
      perPage: number;
      totalItems: number;
      totalPages: number;
    };
    const itemIds = list.items.map((item) => item.id);
    return {
      status,
      body: {
        ids: asSet ? itemIds.toSorted() : itemIds,
        page: list.page,
        perPage: list.perPage,
        totalItems: list.totalItems,
        totalPages: list.totalPages,
      },
    };
  }
  const err = json as { status: number; message: string; data: unknown };
  return { status, body: { status: err.status, message: err.message, data: err.data } };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "iglo-base-resolver-ref-"));
  dataDir = join(root, "pb_data");
  const upsert = await runUpstream(
    ["superuser", "upsert", superEmail, password, "--dir", dataDir],
    root,
  );
  expect(upsert.exitCode).toBe(0);
  upstream = await startUpstream({ dataDir });

  tokens.set("superuser", await signIn("_superusers", superEmail));

  const readIds = async (): Promise<void> => {
    const list = (await ok("GET", "/api/collections?perPage=200")) as {
      items: { id: string; name: string }[];
    };
    for (const item of list.items) {
      collectionIds.set(item.name, item.id);
    }
  };
  await readIds();

  for (const step of collectionSteps) {
    if (step.create !== undefined) {
      await ok("POST", "/api/collections", step.create(ids));
    } else if (step.addFields !== undefined) {
      const current = (await ok("GET", `/api/collections/${step.addFields.collection}`)) as {
        fields: object[];
      };
      await ok("PATCH", `/api/collections/${step.addFields.collection}`, {
        fields: [...current.fields, ...step.addFields.fields(ids)],
      });
    }
    await readIds();
  }

  for (const step of recordSteps) {
    const body = step.body as { id: string };
    if (step.update === true) {
      await ok("PATCH", `/api/collections/${step.collection}/records/${body.id}`, body);
    } else {
      await ok("POST", `/api/collections/${step.collection}/records`, body);
    }
  }

  // a file in one record
  const form = new FormData();
  form.append("attachments", new File(["hello"], "a.txt", { type: "text/plain" }));
  await ok("PATCH", `/api/collections/posts/records/${rid("p1")}`, form);

  // the planner statistics of the final data: upstream's table sync runs
  // PRAGMA optimize, which would otherwise refresh them in the middle of
  // the cases (the rule PATCHes), and a sort by a multi-row relation with
  // DISTINCT picks its rows by the plan
  await ok("POST", "/api/sql", { query: "ANALYZE" });

  for (const name of ["alice", "bob", "carol"] as const) {
    tokens.set(name, await signIn(authUsers[name].collection, authUsers[name].email));
  }

  const all = (await ok("GET", "/api/collections?perPage=200")) as {
    items: { name: string; listRule: string | null; viewRule: string | null }[];
  };
  for (const item of all.items) {
    originalRules.set(item.name, { listRule: item.listRule, viewRule: item.viewRule });
  }

  // (a) filters as a superuser
  for (const fc of filterCases) {
    const raw = filterQuery(fc);
    const url = new URL(`${upstream.url}/api/collections/${fc.collection}/records?${raw}`);
    sentFilterQueries.set(fc.name, url.search.slice(1));
    const res = await api("GET", `/api/collections/${fc.collection}/records?${raw}`);
    filterOutcomes.set(fc.name, listOutcome(res.status, res.json, fc.sort === ""));

    if (res.status !== 200 && fc.filter !== "") {
      const patch = await api("PATCH", `/api/collections/${fc.collection}`, {
        listRule: fc.filter,
      });
      if (patch.status === 200) {
        ruleErrors.set(fc.name, null);
        await ok("PATCH", `/api/collections/${fc.collection}`, {
          listRule: originalRules.get(fc.collection)?.listRule ?? null,
        });
      } else {
        ruleErrors.set(fc.name, (patch.json as { data: { listRule?: unknown } }).data.listRule);
      }
    }
  }

  // (b) the rules matrix
  for (const target of new Set(ruleCases.map((rc) => rc.target))) {
    const list = (await ok("GET", `/api/collections/${target}/records?perPage=200&sort=id`)) as {
      items: { id: string }[];
    };
    targetIds.set(
      target,
      list.items.map((item) => item.id),
    );
  }
  for (const rc of ruleCases) {
    await ok("PATCH", `/api/collections/${rc.target}`, caseRules(rc));
    const raw = qs(listQueryParams(rc));
    const viewRaw = qs(rc.query ?? {});
    const listUrl = new URL(`${upstream.url}/api/collections/${rc.target}/records?${raw}`);
    sentRuleQueries.set(rc.name, listUrl.search.slice(1));
    for (const who of identities) {
      const token = tokens.get(who as Identity) ?? "";
      const res = await api(
        "GET",
        `/api/collections/${rc.target}/records?${raw}`,
        undefined,
        token,
        rc.headers,
      );
      const views: { [id: string]: number } = {};
      for (const id of targetIds.get(rc.target) ?? []) {
        const view = await api(
          "GET",
          `/api/collections/${rc.target}/records/${id}${viewRaw === "" ? "" : "?" + viewRaw}`,
          undefined,
          token,
          rc.headers,
        );
        views[id] = view.status;
      }
      ruleOutcomes.set(`${rc.name} / ${who}`, {
        list: listOutcome(res.status, res.json, false),
        views,
      });
    }
    await ok("PATCH", `/api/collections/${rc.target}`, originalRules.get(rc.target));
  }

  await upstream.stop();
  upstream = undefined;
}, 300_000);

afterAll(async () => {
  await upstream?.stop();
  rmSync(root, { recursive: true, force: true });
});

// -------------------------------------------------------------------

interface TestApp extends CollectionsApp {
  cleanup(): Promise<void>;
}

// an app on a copy of upstream's pb_data, with a read worker pool and the
// collections cache loaded (as upstream's serve)
function openCopy(name: string): TestApp {
  const copyDir = join(root, name);
  copyDataDir(dataDir, copyDir);
  const databases = Databases.open({ dataDir: copyDir, readWorkers: 2 });
  const app: TestApp = {
    databases,
    store: new Store<string, unknown>(),
    clock,
    logger: { error: () => {} },
    async cleanup() {
      databases.close();
      await databases.closed();
    },
  };
  reloadCachedCollections(app);
  return app;
}

// Go's url.QueryEscape
function queryEscape(s: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(s)) {
    const ch = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.~]/.test(ch)) {
      out += ch;
    } else if (ch === " ") {
      out += "+";
    } else {
      out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

// e.Request.URL.Query().Encode()
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

// the first value of each query param (RequestInfo.query)
function firstValues(rawQuery: string): { [key: string]: string } {
  const result: { [key: string]: string } = {};
  for (const [k, v] of parseQuery(rawQuery).values) {
    if (v.length > 0) {
      result[k] = v[0] as string;
    }
  }
  return result;
}

function apiErrorOutcome(err: unknown): Outcome {
  const apiErr =
    err instanceof Error && "status" in err && "toJSON" in err
      ? (err as ReturnType<typeof newBadRequestError>)
      : newBadRequestError("", err);
  const body = JSON.parse(JSON.stringify(apiErr.toJSON())) as {
    status: number;
    message: string;
    data: unknown;
  };
  return {
    status: apiErr.status,
    body: { status: body.status, message: body.message, data: body.data },
  };
}

function authRecord(app: CollectionsApp, who: Identity): Record | undefined {
  switch (who) {
    case "guest":
      return undefined;
    case "superuser":
      return findAuthRecordByEmail(app, "_superusers", superEmail);
    default:
      return findRecordById(app, authUsers[who].collection, authUsers[who].id);
  }
}

function requestInfo(
  auth: Record | undefined,
  query: { [key: string]: string },
  headers: { [key: string]: string } = {},
): RequestInfo {
  const info = new RequestInfo();
  info.method = "GET";
  info.context = "default";
  info.query = query;
  for (const [k, v] of Object.entries(headers)) {
    info.headers[snakecase(k)] = v;
  }
  info.auth = auth;
  return info;
}

const superuserOnlyRuleFields = ["@collection.", "@request."];

// apis/record_crud.go recordsList, from the rule check to ParseAndExec
async function igloList(
  app: CollectionsApp,
  cache: ParsedFilterCache,
  collection: Collection,
  info: RequestInfo,
  rawQuery: string,
  asSet: boolean,
): Promise<Outcome> {
  try {
    if (collection.listRule === null && !info.hasSuperuserAuth()) {
      throw newForbiddenError("Only superusers can perform this action.", null);
    }

    // checkForSuperuserOnlyRuleFields
    if (Object.keys(info.query).length > 0 && !info.hasSuperuserAuth()) {
      for (const param of ["filter", "sort"]) {
        const v = info.query[param] ?? "";
        if (v === "") {
          continue;
        }
        for (const field of superuserOnlyRuleFields) {
          if (v.includes(field)) {
            throw newForbiddenError("Only superusers can filter by " + field, null);
          }
        }
      }
    }

    const query = recordQuery(app, collection);

    const fieldsResolver = newRecordFieldResolver(app, collection, info, true);
    fieldsResolver.filterCache = cache;

    if (!info.hasSuperuserAuth() && collection.listRule !== null && collection.listRule !== "") {
      query.andWhere(
        filterBuildExpr(collection.listRule, fieldsResolver, { clock: app.clock, cache }),
      );
    }

    // hidden fields are searchable only by superusers
    fieldsResolver.setAllowHiddenFields(info.hasSuperuserAuth());

    const provider = newProvider(fieldsResolver, { clock: app.clock, cache }).query(query);
    if (!collection.isView()) {
      provider.countCol("_rowid_");
    }

    const result = await provider.parseAndExec<Record>(queryEncode(rawQuery), recordsTarget);
    const itemIds = result.items.map((record) => record.id);
    return {
      status: 200,
      body: {
        ids: asSet ? itemIds.toSorted() : itemIds,
        page: Number(result.page),
        perPage: result.perPage,
        totalItems: result.totalItems,
        totalPages: result.totalPages,
      },
    };
  } catch (err) {
    return apiErrorOutcome(err);
  }
}

// the listRule error of validateCollection for the filter as the rule
function igloRuleError(app: CollectionsApp, collectionName: string, rule: string): unknown {
  const collection = findCollectionByNameOrId(app, collectionName);
  collection.listRule = rule;
  const result = validateCollection(app, collection);
  if (result === null) {
    return null;
  }
  expect(result).toBeInstanceOf(Errors);
  // the error data as upstream's API body has it
  const body = JSON.parse(
    JSON.stringify(newBadRequestError("Failed to update collection.", result).toJSON()),
  ) as { data: { listRule?: unknown } };
  expect(Object.keys(body.data)).toEqual(["listRule"]);
  return body.data.listRule;
}

function setStoredRules(
  app: CollectionsApp,
  collection: string,
  rules: { listRule: string | null; viewRule: string | null } | undefined,
): void {
  app.databases
    .db()
    .newQuery(
      "UPDATE {{_collections}} SET [[listRule]] = {:l}, [[viewRule]] = {:v} WHERE [[name]] = {:n}",
    )
    .bind({ l: rules?.listRule ?? null, v: rules?.viewRule ?? null, n: collection })
    .execute();
  reloadCachedCollections(app);
}

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

describe("filters as a superuser", () => {
  test("cases", () => {
    expect(filterCases.length).toBeGreaterThanOrEqual(120);
    expect(new Set(filterCases.map((fc) => fc.name)).size).toBe(filterCases.length);
    const statuses = [...filterOutcomes.values()].map((o) => o.status);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThan(110);
    expect(statuses.filter((s) => s === 400).length).toBeGreaterThan(15);
    // the matches are not trivial
    const sizes = [...filterOutcomes.values()]
      .filter((o) => o.status === 200)
      .map((o) => (o.body as { ids: string[] }).ids.length);
    expect(sizes.filter((n) => n === 0).length).toBeLessThan(sizes.length / 4);
  });

  test("Provider, FindRecordsByFilter and the rule check", async () => {
    const app = openCopy("copy-filters");
    const cache = new ParsedFilterCache();
    try {
      const superuser = authRecord(app, "superuser");
      const mismatches: unknown[] = [];
      for (const fc of filterCases) {
        const expected = filterOutcomes.get(fc.name);
        const raw = sentFilterQueries.get(fc.name) ?? "";
        const collection = findCachedCollectionByNameOrId(app, fc.collection);
        const info = requestInfo(superuser, firstValues(raw));
        const got = await igloList(app, cache, collection, info, raw, fc.sort === "");
        if (!Bun.deepEquals(got, expected)) {
          mismatches.push({ case: fc.name, via: "provider", expected, got });
        }

        const usesRequest = fc.filter.includes("@request") || fc.sort.includes("@request");
        if (!usesRequest && expected !== undefined) {
          const expectedIds =
            expected.status === 200 ? (expected.body as { ids: string[] }).ids : null;
          const asIds = (records: Record[]): string[] => {
            const list = records.map((record) => record.id);
            return fc.sort === "" ? list.toSorted() : list;
          };
          let asyncIds: string[] | null = null;
          try {
            asyncIds = asIds(
              await findRecordsByFilterAsync(app, collection, fc.filter, fc.sort, 0, 0),
            );
          } catch {
            asyncIds = null;
          }
          let syncIds: string[] | null = null;
          const err = errorOf(() => {
            syncIds = asIds(findRecordsByFilter(app, collection, fc.filter, fc.sort, 0, 0));
          });
          if (err !== null) {
            syncIds = null;
          }
          if (!Bun.deepEquals(asyncIds, expectedIds) || !Bun.deepEquals(syncIds, expectedIds)) {
            mismatches.push({
              case: fc.name,
              via: "findRecordsByFilter",
              expected: expectedIds,
              async: asyncIds,
              sync: syncIds,
            });
          }
        }

        if (ruleErrors.has(fc.name)) {
          const expectedRule = ruleErrors.get(fc.name);
          const gotRule = igloRuleError(app, fc.collection, fc.filter);
          if (!Bun.deepEquals(gotRule, expectedRule)) {
            mismatches.push({
              case: fc.name,
              via: "rule check",
              expected: expectedRule,
              got: gotRule,
            });
          }
        }
      }
      expect(mismatches).toEqual([]);
    } finally {
      await app.cleanup();
    }
  }, 120_000);
});

describe("rules matrix", () => {
  test("cases", () => {
    expect(ruleCases.length).toBeGreaterThanOrEqual(60);
    expect(new Set(ruleCases.map((rc) => rc.name)).size).toBe(ruleCases.length);
    // the identities see different records
    let differing = 0;
    for (const rc of ruleCases) {
      const seen = new Set(
        identities.map((who) => JSON.stringify(ruleOutcomes.get(`${rc.name} / ${who}`))),
      );
      if (seen.size > 1) {
        differing++;
      }
    }
    expect(differing).toBeGreaterThan(ruleCases.length / 2);
  });

  test("list query and CanAccessRecord", async () => {
    const app = openCopy("copy-rules");
    const cache = new ParsedFilterCache();
    try {
      const auths = new Map(identities.map((who) => [who, authRecord(app, who)] as const));
      const mismatches: unknown[] = [];
      for (const rc of ruleCases) {
        const rules = caseRules(rc);
        setStoredRules(app, rc.target, rules);
        const collection = findCachedCollectionByNameOrId(app, rc.target);
        const raw = sentRuleQueries.get(rc.name) ?? "";

        for (const who of identities) {
          const key = `${rc.name} / ${who}`;
          const expected = ruleOutcomes.get(key);
          const auth = auths.get(who);

          const list = await igloList(
            app,
            cache,
            collection,
            requestInfo(auth, firstValues(raw), rc.headers),
            raw,
            false,
          );

          const views: { [id: string]: number } = {};
          const viewInfo = requestInfo(auth, { ...rc.query }, rc.headers);
          for (const id of targetIds.get(rc.target) ?? []) {
            if (rules.viewRule === null && !viewInfo.hasSuperuserAuth()) {
              views[id] = 403;
              continue;
            }
            const record = findRecordById(app, collection, id);
            let syncResult = false;
            const syncErr = errorOf(() => {
              syncResult = canAccessRecord(app, record, viewInfo, rules.viewRule);
            });
            let asyncResult = false;
            let asyncErr: unknown = null;
            try {
              asyncResult = await canAccessRecordAsync(app, record, viewInfo, rules.viewRule);
            } catch (err) {
              asyncErr = err;
            }
            if (syncErr !== null || asyncErr !== null || syncResult !== asyncResult) {
              mismatches.push({ case: key, id, syncErr, asyncErr, syncResult, asyncResult });
            }
            views[id] = syncResult ? 200 : 404;
          }

          const got: RuleOutcome = { list, views };
          if (!Bun.deepEquals(got, expected)) {
            mismatches.push({ case: key, expected, got });
          }
        }

        setStoredRules(app, rc.target, originalRules.get(rc.target));
      }
      expect(mismatches).toEqual([]);
    } finally {
      await app.cleanup();
    }
  }, 180_000);
});
