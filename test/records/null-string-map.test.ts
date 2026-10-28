// newRecordFromNullStringMap on rows read withExactIntegers: each column is
// converted as Go's SQLite driver and database/sql scan it into a
// NullString, by its storage class (INTEGER in decimal, REAL with
// FormatFloat 'g'). The records reference test compares the same against
// upstream (test/differential/records/).

import { expect, test } from "bun:test";

import { newBaseCollection } from "@/collections/collection-model";
import { HashExp } from "@/db/dbx/expression";
import { JSONField } from "@/fields/json";
import { newRecordFromNullStringMap, nullStringMapFromRow } from "@/records/record-model";
import type { JSONRaw } from "@/tools/types/json-raw";

import { getDB } from "@test/db/support";

// stored SQL literal -> [typeof, the json field's JSON]
const cases: [string, string, string][] = [
  ["1234567", "integer", "1234567"],
  ["-1000000", "integer", "-1000000"],
  ["999999", "integer", "999999"],
  ["9007199254740991", "integer", "9007199254740991"],
  ["-9007199254740991", "integer", "-9007199254740991"],
  ["9223372036854775807", "integer", "9223372036854775807"],
  ["-9223372036854775808", "integer", "-9223372036854775808"],
  ["0", "integer", "0"],
  // a NUMERIC column stores an integral real as INTEGER
  ["123456789.0", "integer", "123456789"],
  ["1e21", "real", "1e+21"],
  ["1.5e-7", "real", "1.5e-07"],
  ["0.5", "real", "0.5"],
  ["'[1234567,1.5]'", "text", "[1234567,1.5]"],
];

test("a json column's INTEGER and REAL values", () => {
  const db = getDB();
  db.newQuery("CREATE TABLE test (id TEXT PRIMARY KEY NOT NULL, j JSON DEFAULT NULL)").execute();
  for (const [i, [literal]] of cases.entries()) {
    db.newQuery(`INSERT INTO test (id, j) VALUES ('r${i}', ${literal})`).execute();
  }

  const collection = newBaseCollection("test");
  collection.fields.add(new JSONField({ name: "j" }));

  const got = cases.map((_, i) => {
    const row = db
      .select("typeof(j) AS t", "test.*")
      .from("test")
      .where(new HashExp({ id: `r${i}` }))
      .build()
      .withExactIntegers()
      .one();
    const record = newRecordFromNullStringMap(collection, nullStringMapFromRow(row));
    return [
      row.t,
      record.marshalJSON().replace(/^\{"collectionId":"\w+","collectionName":"test",/, "{"),
      String((record.dbExport().j as JSONRaw).value()),
    ];
  });
  expect(got).toEqual(cases.map(([, t, json], i) => [t, `{"id":"r${i}","j":${json}}`, json]));
});

test("REAL values, integral ones included, use Go's float formatting", () => {
  const db = getDB();
  // an expression column has no affinity: integral reals stay REAL
  const row = db
    .newQuery(
      "SELECT 5.0 AS a, 123456789.0 AS b, -0.0 AS c, 1e21 AS d, 1.5e-7 AS e, 1000000.0 AS f, 999999.0 AS g, 5 AS h, x'6869' AS i, NULL AS j",
    )
    .withExactIntegers()
    .one();
  expect(nullStringMapFromRow(row)).toEqual({
    a: "5",
    b: "1.23456789e+08",
    c: "-0",
    d: "1e+21",
    e: "1.5e-07",
    f: "1e+06",
    g: "999999",
    h: "5",
    i: "hi",
    j: null,
  });
});
