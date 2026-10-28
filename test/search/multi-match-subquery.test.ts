// Upstream: tools/search/multi_match_subquery_test.go

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { newFromDB } from "@/db/dbx/db";
import { newExp } from "@/db/dbx/expression";
import type { Params } from "@/db/dbx/query";
import { MultiMatchSubquery } from "@/search/multi-match-subquery";
import { marshal } from "@/tools/types/go-json";

test("MultiMatchSubquery.Build", () => {
  const db = newFromDB(new Database(":memory:"), "sqlite");

  const mm = new MultiMatchSubquery({
    targetTableAlias: "test_TargetTableAlias",
    fromTableName: "test_FromTableName",
    fromTableAlias: "test_FromTableAlias",
    valueIdentifier: "({:mm},{:external})",
    joins: [
      { tableName: "join_table1", tableAlias: "join_alias1" },
      {
        tableName: "join_table2",
        tableAlias: "join_alias2",
        on: newExp("123={:join}", { join: "test_join" }),
      },
    ],
    params: { mm: "test_mm" },
  });

  const params: Params = { external: "test_external" };

  const result = mm.build(db, params);

  const expectedResult =
    "SELECT ({:mm},{:external}) as [[multiMatchValue]] FROM `test_FromTableName` `test_FromTableAlias` LEFT JOIN `join_table1` `join_alias1` LEFT JOIN `join_table2` `join_alias2` ON 123={:join} WHERE `test_FromTableAlias`.`id` = `test_TargetTableAlias`.`id`";
  expect(result).toBe(expectedResult);

  // the params from all expressions should be merged in the root
  expect(marshal(params)).toBe(`{"external":"test_external","join":"test_join","mm":"test_mm"}`);
});

test("MultiMatchSubquery.Build without the required aliases", () => {
  const db = newFromDB(new Database(":memory:"), "sqlite");
  for (const init of [
    { fromTableName: "a", fromTableAlias: "b" },
    { targetTableAlias: "a", fromTableAlias: "b" },
    { targetTableAlias: "a", fromTableName: "b" },
  ]) {
    expect(new MultiMatchSubquery(init).build(db, {})).toBe("0=1");
  }
});
