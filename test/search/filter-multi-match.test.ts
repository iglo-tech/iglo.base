// The multi-match expressions of tools/search/filter.go (manyVsOneExpr,
// manyVsManyExpr) for a resolver that returns multi-match subqueries, as
// the record field resolver does. Upstream covers them through
// core/record_field_resolver_test.go (M2.2); the expected SQL here follows
// buildResolversExpr, dbx's And/Enclose/Not and MultiMatchSubquery.Build.

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import type { Clock } from "@/app/clock";
import { newFromDB } from "@/db/dbx/db";
import type { Params } from "@/db/dbx/query";
import { filterBuildExpr } from "@/search/filter";
import { MultiMatchSubquery } from "@/search/multi-match-subquery";
import type { FieldResolver, ResolverResult } from "@/search/simple-field-resolver";

const clock: Clock = { now: () => new Date(0) };

const resolver: FieldResolver = {
  updateQuery: () => {},
  resolve(field: string): ResolverResult {
    const [table, column] = field.split(".") as [string, string];
    return {
      identifier: `[[${table}.${column}]]`,
      multiMatchSubQuery: new MultiMatchSubquery({
        targetTableAlias: table,
        fromTableName: "t",
        fromTableAlias: `__mm_${table}`,
        valueIdentifier: `__mm_${table}.${column}`,
        params: { [`mm_${table}`]: table },
      }),
    };
  },
};

// the built SQL with its random names numbered in order of appearance
function build(filter: string): { sql: string; params: Params } {
  const params: Params = {};
  const expr = filterBuildExpr(filter, resolver, { clock });
  const sql = expr.build(newFromDB(new Database(":memory:"), "sqlite"), params);
  const names = new Map<string, string>();
  const normalized = sql.replace(/\{:(t\w{8})\}|__(sm|ml|mr)\w{8}/g, (m: string) => {
    if (!names.has(m)) {
      names.set(m, m.startsWith("{:") ? `{:p${names.size}}` : m.slice(0, 4) + names.size);
    }
    return names.get(m) as string;
  });
  return { sql: normalized, params };
}

const subA =
  "SELECT `__mm_a`.`x` as [[multiMatchValue]] FROM `t` `__mm_a`  WHERE `__mm_a`.`id` = `a`.`id`";
const subB =
  "SELECT `__mm_b`.`y` as [[multiMatchValue]] FROM `t` `__mm_b`  WHERE `__mm_b`.`id` = `b`.`id`";

test("many vs one", () => {
  const { sql, params } = build("a.x = 'v'");
  expect(sql).toBe(
    `((([[a.x]] = {:p0}) AND (NOT EXISTS (SELECT 1 FROM (${subA}) {{__sm1}} WHERE NOT ([[__sm1.multiMatchValue]] = {:p0})))))`,
  );
  // the subquery params are merged into the root params
  expect(Object.values(params).toSorted()).toEqual(["a", "v"]);
});

test("one vs many (inverse)", () => {
  expect(build("'v' != a.x").sql).toBe(
    `((({:p0} IS NOT [[a.x]]) AND (NOT EXISTS (SELECT 1 FROM (${subA}) {{__sm1}} WHERE NOT ({:p0} IS NOT [[__sm1.multiMatchValue]])))))`,
  );
});

test("many vs many", () => {
  expect(build("a.x = b.y").sql).toBe(
    `(((COALESCE([[a.x]], '') = COALESCE([[b.y]], '')) AND (NOT EXISTS (SELECT 1 FROM (${subA}) {{__ml0}} LEFT JOIN (${subB}) {{__mr1}} WHERE NOT (COALESCE([[__ml0.multiMatchValue]], '') = COALESCE([[__mr1.multiMatchValue]], ''))))))`,
  );
});

test("any-of operators skip the multi-match subquery", () => {
  expect(build("a.x ?= 'v' && a.x ?~ b.y").sql).toBe(
    "([[a.x]] = {:p0} AND [[a.x]] LIKE ('%' || [[b.y]] || '%') ESCAPE '\\')",
  );
});

test("strftime moves the time-value into the subquery", () => {
  expect(build("strftime('%Y', a.x) = '2024'").sql).toBe(
    `(((strftime({:p0},[[a.x]]) = {:p1}) AND (NOT EXISTS (SELECT 1 FROM (SELECT strftime({:p0},__mm_a.x) as [[multiMatchValue]] FROM \`t\` \`__mm_a\`  WHERE \`__mm_a\`.\`id\` = \`a\`.\`id\`) {{__sm2}} WHERE NOT ([[__sm2.multiMatchValue]] = {:p1})))))`,
  );
});
