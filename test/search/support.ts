// Helpers of upstream's tools/search tests: createTestDB (provider_test.go)
// and testCompareResults (token_functions_test.go).

import { Database } from "bun:sqlite";
import { expect } from "bun:test";

import { type DB, newFromDB } from "@/db/dbx/db";
import { newExp } from "@/db/dbx/expression";
import type { Token, TokenType } from "@/search/fexpr/scanner";
import type { ResolverResult } from "@/search/simple-field-resolver";

export const MaxSortFieldLength = 255;

export interface TestDB {
  db: DB;
  // the SQL of every query that returned data (dbx's QueryLogFunc)
  calledQueries: string[];
  close(): void;
}

// an in-memory database with upstream's "test" table and its two rows
export function createTestDB(): TestDB {
  const conn = new Database(":memory:");
  const db = newFromDB(conn, "sqlite");
  db.createTable("test", {
    id: "int default 0",
    test1: "int default 0",
    test2: "text default ''",
    test3: "text default ''",
    ["a".repeat(MaxSortFieldLength)]: "text default ''",
    ["b".repeat(MaxSortFieldLength + 1)]: "text default ''",
  }).execute();
  db.insert("test", { id: 1, test1: 1, test2: "test2.1" }).execute();
  db.insert("test", { id: 2, test1: 2, test2: "test2.2" }).execute();
  const testDB: TestDB = {
    db,
    calledQueries: [],
    close: () => conn.close(),
  };
  db.queryLogFunc = (_ms, sql) => {
    testDB.calledQueries.push(sql);
  };
  return testDB;
}

export function tok(literal: string, type: TokenType): Token {
  return { meta: null, type, literal };
}

// fmt's %v of a param value
function printValue(v: unknown): string {
  return String(v);
}

// testCompareResults: a is the expected result, b the actual one (null
// for Go's nil)
export function compareResults(a: ResolverResult | null, b: ResolverResult | null): void {
  const testDB = createTestDB();
  try {
    expect(b === null).toBe(a === null);
    if (a === null || b === null) {
      return;
    }

    const aAfterBuild = a.afterBuild ?? null;
    const bAfterBuild = b.afterBuild ?? null;
    expect(bAfterBuild === null).toBe(aAfterBuild === null);
    const aBuilt = aAfterBuild?.(newExp("test")).build(testDB.db, a.params ?? {}) ?? "";
    const bBuilt = bAfterBuild?.(newExp("test")).build(testDB.db, a.params ?? {}) ?? "";
    expect(bBuilt).toBe(aBuilt);

    const aSubQuery = a.multiMatchSubQuery?.build(testDB.db, a.params ?? {}) ?? "";
    const bSubQuery = b.multiMatchSubQuery?.build(testDB.db, b.params ?? {}) ?? "";
    expect(bSubQuery).toBe(aSubQuery);

    expect(b.nullFallback ?? 0).toBe(a.nullFallback ?? 0);

    expect(Object.keys(b.params ?? {}).length).toBe(Object.keys(a.params ?? {}).length);

    // loose placeholders replacement
    let aResolved = a.identifier;
    for (const [k, v] of Object.entries(a.params ?? {})) {
      aResolved = aResolved.replaceAll("{:" + k + "}", printValue(v));
    }
    let bResolved = b.identifier;
    for (const [k, v] of Object.entries(b.params ?? {})) {
      bResolved = bResolved.replaceAll("{:" + k + "}", printValue(v));
    }
    expect(bResolved).toBe(aResolved);
  } finally {
    testDB.close();
  }
}
