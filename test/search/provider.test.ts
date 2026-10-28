// Upstream: tools/search/provider_test.go
//
// Upstream's tests read the provider's private fields (page, perPage,
// sort, filter, the limits); here the same settings are observed through
// Exec: the returned page fields and the SQL of the queries it runs.

// Provider.sort is upstream's setter, not Array#sort
/* oxlint-disable unicorn/no-array-sort */

import { describe, expect, test } from "bun:test";

import type { Clock } from "@/app/clock";
import { HashExp, not } from "@/db/dbx/expression";
import type { Row } from "@/db/dbx/query";
import type { SelectQuery } from "@/db/dbx/select";
import { marshalStruct } from "@/fields/field";
import type { FilterData } from "@/search/filter";
import {
  DefaultFilterExprLimit,
  DefaultPerPage,
  DefaultSortExprLimit,
  ErrEmptyQuery,
  ErrFilterExprLimit,
  ErrFilterLengthLimit,
  ErrSortExprLimit,
  ErrSortFieldLengthLimit,
  MaxFilterLength,
  MaxPerPage,
  MaxSortFieldLength,
  newProvider,
  type Provider,
  type Result,
} from "@/search/provider";
import type { FieldResolver, ResolverResult } from "@/search/simple-field-resolver";
import { type SortField, SortAsc, SortDesc } from "@/search/sort";
import { existInSliceWithRegex } from "@/tools/list/list";

import { createTestDB, type TestDB } from "@test/search/support";

const clock: Clock = { now: () => new Date(Date.UTC(2023, 1, 3, 4, 5, 6)) };

class TestFieldResolver implements FieldResolver {
  updateQueryCalls = 0;
  resolveCalls = 0;

  updateQuery(_query: SelectQuery): void {
    this.updateQueryCalls++;
  }

  resolve(field: string): ResolverResult {
    this.resolveCalls++;

    if (field === "unknown") {
      throw new Error("test error");
    }

    return { identifier: field };
  }
}

// json.Marshal of a Result of testTableStruct items
function encodeResult(result: Result<Row>): string {
  const items = result.items.map((row) =>
    marshalStruct([
      ["test1", row.test1],
      ["test2", row.test2],
      ["test3", row.test3],
    ]),
  );
  return marshalStruct([
    ["items", { marshalJSON: () => "[" + items.join(",") + "]" }],
    ["page", result.page],
    ["perPage", result.perPage],
    ["totalItems", result.totalItems],
    ["totalPages", result.totalPages],
  ]);
}

function baseQuery(testDB: TestDB): SelectQuery {
  return testDB.db
    .select("*")
    .from("test")
    .where(not(new HashExp({ test1: null })))
    .orderBy("test1 ASC");
}

function filterOf(n: number): FilterData {
  return Array(n).fill("1=1").join(" && ");
}

function sortOf(n: number): SortField[] {
  return Array.from({ length: n }, (): SortField => ({ name: "id", direction: SortAsc }));
}

async function execError(p: Provider): Promise<unknown> {
  try {
    await p.exec();
  } catch (err) {
    return err;
  }
  return undefined;
}

// the logged models query (the one with LIMIT)
function modelsQuery(testDB: TestDB): string {
  const q = testDB.calledQueries.find((sql) => sql.includes(" LIMIT "));
  expect(q).toBeDefined();
  return q as string;
}

describe("NewProvider", () => {
  test("defaults", async () => {
    const testDB = createTestDB();
    try {
      const p = newProvider(new TestFieldResolver(), { clock }).query(baseQuery(testDB));
      const result = await p.exec();
      expect(result.page).toBe(1);
      expect(result.perPage).toBe(DefaultPerPage);
      expect(DefaultFilterExprLimit).toBe(200);
      expect(DefaultSortExprLimit).toBe(8);
    } finally {
      testDB.close();
    }
  });

  test("default limits", async () => {
    const testDB = createTestDB();
    try {
      const p = (): Provider =>
        newProvider(new TestFieldResolver(), { clock }).query(baseQuery(testDB));
      expect(await execError(p().filter([filterOf(DefaultFilterExprLimit)]))).toBeUndefined();
      expect(await execError(p().filter([filterOf(DefaultFilterExprLimit + 1)]))).toBe(
        ErrFilterExprLimit,
      );
      expect(await execError(p().sort(sortOf(DefaultSortExprLimit)))).toBeUndefined();
      expect(await execError(p().sort(sortOf(DefaultSortExprLimit + 1)))).toBe(ErrSortExprLimit);
    } finally {
      testDB.close();
    }
  });
});

describe("MaxFilterExprLimit", () => {
  for (const val of [0, -10, 10]) {
    test(`max_${val}`, async () => {
      const testDB = createTestDB();
      try {
        const p = (filter: FilterData): Provider =>
          newProvider(new TestFieldResolver(), { clock })
            .query(baseQuery(testDB))
            .maxFilterExprLimit(val)
            .filter([filter]);
        const exprs = Math.max(val, 0);
        if (exprs > 0) {
          expect(await execError(p(Array(exprs).fill("1=1").join(" || ")))).toBeUndefined();
        }
        expect(
          await execError(
            p(
              Array(exprs + 1)
                .fill("1=1")
                .join(" || "),
            ),
          ),
        ).toBe(ErrFilterExprLimit);
      } finally {
        testDB.close();
      }
    });
  }
});

describe("MaxSortExprLimit", () => {
  for (const val of [0, -10, 10]) {
    test(`max_${val}`, async () => {
      const testDB = createTestDB();
      try {
        const p = (n: number): Provider =>
          newProvider(new TestFieldResolver(), { clock })
            .query(baseQuery(testDB))
            .maxSortExprLimit(val)
            .sort(Array.from({ length: n }, (): SortField => ({ name: "id", direction: SortAsc })));
        const exprs = Math.max(val, 0);
        expect(await execError(p(exprs))).toBe(val < 0 ? ErrSortExprLimit : undefined);
        expect(await execError(p(exprs + 1))).toBe(ErrSortExprLimit);
      } finally {
        testDB.close();
      }
    });
  }
});

test("Provider.Query", async () => {
  const testDB = createTestDB();
  try {
    const query = testDB.db.select("id").from("test");
    const querySql = query.build().sql();

    const p = newProvider(new TestFieldResolver(), { clock }).query(query);
    await p.exec();

    // the provider runs the query (with its page) and leaves it as it was
    expect(modelsQuery(testDB)).toBe("SELECT `id` FROM `test` LIMIT 30");
    expect(query.build().sql()).toBe(querySql);
  } finally {
    testDB.close();
  }
});

test("Provider.SkipTotal", async () => {
  const testDB = createTestDB();
  try {
    const p = newProvider(new TestFieldResolver(), { clock }).query(baseQuery(testDB));

    // the default skipTotal is false
    let result = await p.exec();
    expect([result.totalItems, testDB.calledQueries.length]).toEqual([2, 2]);

    testDB.calledQueries = [];
    p.skipTotal(true);
    result = await p.exec();
    expect([result.totalItems, result.totalPages, testDB.calledQueries.length]).toEqual([
      -1, -1, 1,
    ]);
  } finally {
    testDB.close();
  }
});

test("Provider.CountCol", async () => {
  const testDB = createTestDB();
  try {
    const p = newProvider(new TestFieldResolver(), { clock }).query(baseQuery(testDB));

    await p.exec();
    expect(testDB.calledQueries).toContain(
      "SELECT COUNT(DISTINCT [[test.id]]) FROM `test` WHERE NOT (`test1` IS NULL)",
    );

    testDB.calledQueries = [];
    p.countCol("test1");
    await p.exec();
    expect(testDB.calledQueries).toContain(
      "SELECT COUNT(DISTINCT [[test.test1]]) FROM `test` WHERE NOT (`test1` IS NULL)",
    );
  } finally {
    testDB.close();
  }
});

test("Provider.Page and PerPage", async () => {
  const testDB = createTestDB();
  try {
    const result = await newProvider(new TestFieldResolver(), { clock })
      .query(baseQuery(testDB))
      .page(10)
      .perPage(456)
      .exec();
    expect([result.page, result.perPage]).toEqual([10, 456]);
    expect(modelsQuery(testDB)).toEndWith(" LIMIT 456 OFFSET 4104");
  } finally {
    testDB.close();
  }
});

test("Provider.Sort and AddSort", async () => {
  const testDB = createTestDB();
  try {
    const initialSort: SortField[] = [
      { name: "test1", direction: SortAsc },
      { name: "test2", direction: SortAsc },
    ];
    await newProvider(new TestFieldResolver(), { clock })
      .query(baseQuery(testDB))
      .sort(initialSort)
      .addSort({ name: "test3", direction: SortDesc })
      .exec();
    expect(modelsQuery(testDB)).toBe(
      "SELECT * FROM `test` WHERE NOT (`test1` IS NULL) ORDER BY `test1` ASC, `test1` ASC, `test2` ASC, `test3` DESC LIMIT 30",
    );
    // AddSort does not change the given slice
    expect(initialSort.length).toBe(2);
  } finally {
    testDB.close();
  }
});

test("Provider.Filter and AddFilter", async () => {
  const testDB = createTestDB();
  try {
    await newProvider(new TestFieldResolver(), { clock })
      .query(baseQuery(testDB))
      .filter(["test1 > 0", "test2 > 0"])
      .addFilter("test3 > 0")
      .addFilter("") // ignored
      .exec();
    expect(modelsQuery(testDB)).toBe(
      "SELECT * FROM `test` WHERE (((NOT (`test1` IS NULL)) AND (test1 > 0)) AND (test2 > 0)) AND (test3 > 0) ORDER BY `test1` ASC LIMIT 30",
    );
  } finally {
    testDB.close();
  }
});

describe("Provider.Parse", () => {
  const initialPage = 2;
  const initialPerPage = 123;
  const initialSort: SortField[] = [
    { name: "test1", direction: SortAsc },
    { name: "test2", direction: SortAsc },
  ];
  // upstream's initial filters ("test1", "test2") are not valid filters,
  // which Exec would reject; these are
  const initialFilter: FilterData[] = ["test1 > 0", "test2 > 0"];
  const initialWhere = "((NOT (`test1` IS NULL)) AND (test1 > 0)) AND (test2 > 0)";

  // [query, expectError, expectPage, expectPerPage, expect ORDER BY, expect WHERE]
  const scenarios: [string, string | undefined, number, number, string, string][] = [
    // empty
    [
      "",
      undefined,
      initialPage,
      initialPerPage,
      "`test1` ASC, `test1` ASC, `test2` ASC",
      initialWhere,
    ],
    // invalid query
    [
      "invalid;",
      "invalid semicolon separator in query",
      initialPage,
      initialPerPage,
      "`test1` ASC, `test1` ASC, `test2` ASC",
      initialWhere,
    ],
    // invalid page
    [
      "page=a",
      'strconv.Atoi: parsing "a": invalid syntax',
      initialPage,
      initialPerPage,
      "`test1` ASC, `test1` ASC, `test2` ASC",
      initialWhere,
    ],
    // invalid perPage
    [
      "perPage=a",
      'strconv.Atoi: parsing "a": invalid syntax',
      initialPage,
      initialPerPage,
      "`test1` ASC, `test1` ASC, `test2` ASC",
      initialWhere,
    ],
    // valid query parameters
    [
      "page=3&perPage=456&filter=test3>0&sort=-test3,test2,+test1&other=123",
      undefined,
      3,
      456,
      "`test1` ASC, `test1` ASC, `test2` ASC, `test3` DESC, `test2` ASC, `test1` ASC",
      "(" + initialWhere + ") AND (test3 > 0)",
    ],
  ];

  for (const [
    i,
    [query, expectError, expectPage, expectPerPage, orderBy, where],
  ] of scenarios.entries()) {
    test(`${i}_${query}`, async () => {
      const testDB = createTestDB();
      try {
        const p = newProvider(new TestFieldResolver(), { clock })
          .query(
            testDB.db
              .select("*")
              .from("test")
              .where(not(new HashExp({ test1: null })))
              .orderBy("test1 ASC"),
          )
          .page(initialPage)
          .perPage(initialPerPage)
          .sort(initialSort)
          .filter(initialFilter);

        let err: unknown;
        try {
          p.parse(query);
        } catch (e) {
          err = e;
        }
        expect(err === undefined ? undefined : (err as Error).message).toBe(expectError);

        const result = await p.exec();
        expect([result.page, result.perPage]).toEqual([expectPage, expectPerPage]);

        const sql = modelsQuery(testDB).replace(/\{:t\w+\}/g, "0");
        expect(sql).toBe(
          `SELECT * FROM \`test\` WHERE ${where} ORDER BY ${orderBy} LIMIT ${expectPerPage} OFFSET ${expectPerPage * (expectPage - 1)}`,
        );
      } finally {
        testDB.close();
      }
    });
  }

  test("parse errors", () => {
    const cases: [string, string][] = [
      ["skipTotal=a", 'strconv.ParseBool: parsing "a": invalid syntax'],
      ["page=1.5", 'strconv.Atoi: parsing "1.5": invalid syntax'],
      ["page=%2B", 'strconv.Atoi: parsing "+": invalid syntax'],
      [
        "page=9223372036854775808",
        'strconv.Atoi: parsing "9223372036854775808": value out of range',
      ],
      [
        "page=99999999999999999999x",
        'strconv.Atoi: parsing "99999999999999999999x": value out of range',
      ],
      ["page=9999x", 'strconv.Atoi: parsing "9999x": invalid syntax'],
      ["perPage=%20", 'strconv.Atoi: parsing " ": invalid syntax'],
      ["page=%zz", 'invalid URL escape "%zz"'],
    ];
    for (const [query, message] of cases) {
      expect(() => newProvider(new TestFieldResolver(), { clock }).parse(query)).toThrow(message);
    }
  });
});

test("Provider.Exec empty query", async () => {
  const p = newProvider(new TestFieldResolver(), { clock }).query(null);

  expect(await execError(p)).toBe(ErrEmptyQuery);
});

describe("Provider.Exec non-empty query", () => {
  // [name, page, perPage, sort, filter, skipTotal, expectError, expectResult, expectQueries]
  const scenarios: [
    string,
    number,
    number,
    SortField[],
    FilterData[],
    boolean,
    boolean,
    string,
    string[] | null,
  ][] = [
    [
      "page normalization",
      -1,
      10,
      [],
      [],
      false,
      false,
      `{"items":[{"test1":1,"test2":"test2.1","test3":""},{"test1":2,"test2":"test2.2","test3":""}],"page":1,"perPage":10,"totalItems":2,"totalPages":1}`,
      [
        "SELECT COUNT(DISTINCT [[test.id]]) FROM `test` WHERE NOT (`test1` IS NULL)",
        "SELECT * FROM `test` WHERE NOT (`test1` IS NULL) ORDER BY `test1` ASC LIMIT 10",
      ],
    ],
    [
      "perPage normalization",
      10,
      0, // fallback to default
      [],
      [],
      false,
      false,
      `{"items":[],"page":10,"perPage":30,"totalItems":2,"totalPages":1}`,
      [
        "SELECT COUNT(DISTINCT [[test.id]]) FROM `test` WHERE NOT (`test1` IS NULL)",
        "SELECT * FROM `test` WHERE NOT (`test1` IS NULL) ORDER BY `test1` ASC LIMIT 30 OFFSET 270",
      ],
    ],
    [
      "invalid sort field",
      1,
      10,
      [{ name: "unknown", direction: SortAsc }],
      [],
      false,
      true,
      "",
      null,
    ],
    ["invalid filter", 1, 10, [], ["test2 = 'test2.1'", "invalid"], false, true, "", null],
    [
      "valid sort and filter fields",
      1,
      5555, // will be limited by MaxPerPage
      [{ name: "test2", direction: SortDesc }],
      ["test2 != null", "test1 >= 2"],
      false,
      false,
      `{"items":[{"test1":2,"test2":"test2.2","test3":""}],"page":1,"perPage":${MaxPerPage},"totalItems":1,"totalPages":1}`,
      [
        "SELECT COUNT(DISTINCT [[test.id]]) FROM `test` WHERE ((NOT (`test1` IS NULL)) AND (((test2 IS NOT '' AND test2 IS NOT NULL)))) AND (test1 >= 2)",
        "SELECT * FROM `test` WHERE ((NOT (`test1` IS NULL)) AND (((test2 IS NOT '' AND test2 IS NOT NULL)))) AND (test1 >= 2) ORDER BY `test1` ASC, `test2` DESC LIMIT " +
          MaxPerPage,
      ],
    ],
    [
      "valid sort and filter fields (skipTotal=1)",
      1,
      5555, // will be limited by MaxPerPage
      [{ name: "test2", direction: SortDesc }],
      ["test2 != null", "test1 >= 2"],
      true,
      false,
      `{"items":[{"test1":2,"test2":"test2.2","test3":""}],"page":1,"perPage":${MaxPerPage},"totalItems":-1,"totalPages":-1}`,
      [
        "SELECT * FROM `test` WHERE ((NOT (`test1` IS NULL)) AND (((test2 IS NOT '' AND test2 IS NOT NULL)))) AND (test1 >= 2) ORDER BY `test1` ASC, `test2` DESC LIMIT " +
          MaxPerPage,
      ],
    ],
    [
      "valid sort and filter fields (zero results)",
      1,
      10,
      [{ name: "test3", direction: SortAsc }],
      ["test3 != ''"],
      false,
      false,
      `{"items":[],"page":1,"perPage":10,"totalItems":0,"totalPages":0}`,
      [
        "SELECT COUNT(DISTINCT [[test.id]]) FROM `test` WHERE (NOT (`test1` IS NULL)) AND (((test3 IS NOT '' AND test3 IS NOT NULL)))",
        "SELECT * FROM `test` WHERE (NOT (`test1` IS NULL)) AND (((test3 IS NOT '' AND test3 IS NOT NULL))) ORDER BY `test1` ASC, `test3` ASC LIMIT 10",
      ],
    ],
    [
      "valid sort and filter fields (zero results; skipTotal=1)",
      1,
      10,
      [{ name: "test3", direction: SortAsc }],
      ["test3 != ''"],
      true,
      false,
      `{"items":[],"page":1,"perPage":10,"totalItems":-1,"totalPages":-1}`,
      [
        "SELECT * FROM `test` WHERE (NOT (`test1` IS NULL)) AND (((test3 IS NOT '' AND test3 IS NOT NULL))) ORDER BY `test1` ASC, `test3` ASC LIMIT 10",
      ],
    ],
    [
      "pagination test",
      2,
      1,
      [],
      [],
      false,
      false,
      `{"items":[{"test1":2,"test2":"test2.2","test3":""}],"page":2,"perPage":1,"totalItems":2,"totalPages":2}`,
      [
        "SELECT COUNT(DISTINCT [[test.id]]) FROM `test` WHERE NOT (`test1` IS NULL)",
        "SELECT * FROM `test` WHERE NOT (`test1` IS NULL) ORDER BY `test1` ASC LIMIT 1 OFFSET 1",
      ],
    ],
    [
      "pagination test (skipTotal=1)",
      2,
      1,
      [],
      [],
      true,
      false,
      `{"items":[{"test1":2,"test2":"test2.2","test3":""}],"page":2,"perPage":1,"totalItems":-1,"totalPages":-1}`,
      ["SELECT * FROM `test` WHERE NOT (`test1` IS NULL) ORDER BY `test1` ASC LIMIT 1 OFFSET 1"],
    ],
  ];

  const testDB = createTestDB();
  const query = baseQuery(testDB);

  for (const [
    name,
    page,
    perPage,
    sortFields,
    filter,
    skipTotal,
    expectError,
    expectResult,
    expectQueries,
  ] of scenarios) {
    test(name, async () => {
      testDB.calledQueries = []; // reset

      const testResolver = new TestFieldResolver();
      const p = newProvider(testResolver, { clock })
        .query(query)
        .page(page)
        .perPage(perPage)
        .sort(sortFields)
        .skipTotal(skipTotal)
        .filter(filter);

      let result: Result<Row> | undefined;
      let err: unknown;
      try {
        result = await p.exec();
      } catch (e) {
        err = e;
      }

      expect(err !== undefined).toBe(expectError);
      if (result === undefined) {
        return;
      }

      expect(testResolver.updateQueryCalls).toBe(1);

      expect(encodeResult(result)).toBe(expectResult);

      expect(testDB.calledQueries.length).toBe((expectQueries ?? []).length);

      for (const q of testDB.calledQueries) {
        expect([q, existInSliceWithRegex(q, expectQueries ?? [])]).toEqual([q, true]);
      }
    });
  }
});

describe("Provider filter and sort limits", () => {
  // [name, filter, sort, maxFilterExprLimit, maxSortExprLimit, expectError]
  const scenarios: [string, FilterData[], SortField[], number, number, Error | undefined][] = [
    // filter
    [
      "<= max filter length",
      ["1=2", "1='" + "a".repeat(MaxFilterLength - 4) + "'"],
      [],
      1,
      0,
      undefined,
    ],
    [
      "> max filter length",
      ["1=2", "1='" + "a".repeat(MaxFilterLength - 3) + "'"],
      [],
      1,
      0,
      ErrFilterLengthLimit,
    ],
    [
      "<= max filter exprs",
      ["1=2", "(1=1 || 1=1) && (1=1 || (1=1 || 1=1)) && (1=1)"],
      [],
      6,
      0,
      undefined,
    ],
    [
      "> max filter exprs",
      ["1=2", "(1=1 || 1=1) && (1=1 || (1=1 || 1=1)) && (1=1)"],
      [],
      5,
      0,
      ErrFilterExprLimit,
    ],

    // sort
    [
      "<= max sort field length",
      [],
      [
        { name: "id", direction: SortAsc },
        { name: "test1", direction: SortDesc },
        { name: "a".repeat(MaxSortFieldLength), direction: SortDesc },
      ],
      0,
      10,
      undefined,
    ],
    [
      "> max sort field length",
      [],
      [
        { name: "id", direction: SortAsc },
        { name: "test1", direction: SortDesc },
        { name: "b".repeat(MaxSortFieldLength + 1), direction: SortDesc },
      ],
      0,
      10,
      ErrSortFieldLengthLimit,
    ],
    [
      "<= max sort exprs",
      [],
      [
        { name: "id", direction: SortAsc },
        { name: "test1", direction: SortDesc },
      ],
      0,
      2,
      undefined,
    ],
    [
      "> max sort exprs",
      [],
      [
        { name: "id", direction: SortAsc },
        { name: "test1", direction: SortDesc },
      ],
      0,
      1,
      ErrSortExprLimit,
    ],

    // the lengths are UTF-8 bytes (Go's len)
    [
      "> max filter length in bytes",
      ["1='" + "é".repeat((MaxFilterLength - 2) / 2) + "'"],
      [],
      1,
      0,
      ErrFilterLengthLimit,
    ],
    [
      "> max sort field length in bytes",
      [],
      [{ name: "é".repeat(128), direction: SortDesc }],
      0,
      10,
      ErrSortFieldLengthLimit,
    ],
  ];

  const testDB = createTestDB();
  const query = baseQuery(testDB);

  for (const [
    name,
    filter,
    sortFields,
    maxFilterExprLimit,
    maxSortExprLimit,
    expectError,
  ] of scenarios) {
    test(name, async () => {
      const p = newProvider(new TestFieldResolver(), { clock })
        .query(query)
        .sort(sortFields)
        .filter(filter)
        .maxFilterExprLimit(maxFilterExprLimit)
        .maxSortExprLimit(maxSortExprLimit);

      expect(await execError(p)).toBe(expectError);
    });
  }
});

describe("Provider.ParseAndExec", () => {
  // [name, queryString, expectError, expectResult]
  const scenarios: [string, string, boolean, string][] = [
    [
      "no extra query params (aka. use the provider presets)",
      "",
      false,
      `{"items":[],"page":2,"perPage":123,"totalItems":2,"totalPages":1}`,
    ],
    ["invalid query", "invalid;", true, ""],
    ["invalid page", "page=a", true, ""],
    ["invalid perPage", "perPage=a", true, ""],
    ["invalid skipTotal", "skipTotal=a", true, ""],
    ["invalid sorting field", "sort=-unknown", true, ""],
    ["invalid filter field", "filter=unknown>1", true, ""],
    [
      "page > existing",
      "page=3&perPage=9999",
      false,
      `{"items":[],"page":3,"perPage":1000,"totalItems":2,"totalPages":1}`,
    ],
    [
      "valid query params",
      "page=1&perPage=9999&filter=test1>1&sort=-test2,test3",
      false,
      `{"items":[{"test1":2,"test2":"test2.2","test3":""}],"page":1,"perPage":1000,"totalItems":1,"totalPages":1}`,
    ],
    [
      "valid query params with skipTotal=1",
      "page=1&perPage=9999&filter=test1>1&sort=-test2,test3&skipTotal=1",
      false,
      `{"items":[{"test1":2,"test2":"test2.2","test3":""}],"page":1,"perPage":1000,"totalItems":-1,"totalPages":-1}`,
    ],
  ];

  const testDB = createTestDB();
  const query = baseQuery(testDB);

  for (const [name, queryString, expectError, expectResult] of scenarios) {
    test(name, async () => {
      testDB.calledQueries = []; // reset

      const testResolver = new TestFieldResolver();
      const provider = newProvider(testResolver, { clock })
        .query(query)
        .page(2)
        .perPage(123)
        .sort([{ name: "test2", direction: SortAsc }])
        .filter(["test1 > 0"]);

      let result: Result<Row> | undefined;
      let err: unknown;
      try {
        result = await provider.parseAndExec(queryString);
      } catch (e) {
        err = e;
      }

      expect(err !== undefined).toBe(expectError);
      if (result === undefined) {
        return;
      }

      expect(testResolver.updateQueryCalls).toBe(1);

      expect(testDB.calledQueries.length).toBe(result.totalItems === -1 ? 1 : 2);

      expect(encodeResult(result)).toBe(expectResult);
    });
  }
});

describe("Provider page arithmetic", () => {
  // Go ints: pages past 2^53 stay exact, and the offset wraps as int64
  test("large pages", async () => {
    const testDB = createTestDB();
    try {
      const p = newProvider(new TestFieldResolver(), { clock }).query(baseQuery(testDB));
      p.parse("page=9223372036854775807&perPage=1");
      let result = await p.exec();
      expect(result.page).toBe(9223372036854775807n);
      expect(result.items.length).toBe(0);
      // (an offset past 2^53 rows is given as 2^53 - 1: no table is near either)
      expect(modelsQuery(testDB)).toEndWith(" LIMIT 1 OFFSET 9007199254740991");

      // 1000 * (2^62 - 1) wraps to a negative int64: no OFFSET, the first page
      testDB.calledQueries = [];
      p.parse("page=4611686018427387904&perPage=1000");
      result = await p.exec();
      expect(result.page).toBe(4611686018427387904n);
      expect(result.items.length).toBe(2);
      expect(modelsQuery(testDB)).toEndWith(" LIMIT 1000");

      testDB.calledQueries = [];
      p.parse("page=-9223372036854775808&perPage=-5");
      result = await p.exec();
      expect([result.page, result.perPage]).toEqual([1, DefaultPerPage]);
    } finally {
      testDB.close();
    }
  });
});
