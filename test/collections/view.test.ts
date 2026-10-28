// Upstream: core/view_test.go
//
// Left out: TestFindRecordByViewFile (FindRecordByViewFile is M1.8's; it
// needs records and file lookups).
//
// Each Go test function runs on its own copy of the vendored fixture
// (openTestApp, as tests.NewTestApp); its t.Run subtests run in order on
// that app. The ensureNoTempViews check runs after the last subtest.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { runInAppTransaction } from "@/collections/collection-query";
import { createViewFields, dryRunView, saveView } from "@/collections/view";
import { HashExp, newExp } from "@/db/dbx/expression";
import { deleteView, tableInfo } from "@/db/table";
import { NumberField } from "@/fields/number";

import { openTestApp, type TestCollectionsApp } from "@test/collections/app";

// the error a call throws, or null (Go's returned error)
function errorOf(fn: () => unknown): Error | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

// ensureNoTempViews fails if any "_temp_" view is left in the database
function ensureNoTempViews(app: TestCollectionsApp): void {
  const [total] = app.databases
    .db()
    .select("count(*)")
    .from("sqlite_schema")
    .andWhere(new HashExp({ type: "view" }))
    .andWhere(newExp(String.raw`[[name]] LIKE '%\_temp\_%' ESCAPE '\'`))
    .limit(1)
    .row();

  if (Number(total) > 0) {
    throw new Error(`Expected all temp views to be deleted, got ${Number(total)}`);
  }
}

describe("TestDeleteView", () => {
  let app: TestCollectionsApp;

  beforeAll(() => {
    app = openTestApp();
  });

  afterAll(() => {
    try {
      ensureNoTempViews(app);
    } finally {
      app.cleanup();
    }
  });

  test("delete view scenarios", () => {
    const scenarios: { viewName: string; expectError: boolean }[] = [
      { viewName: "", expectError: true },
      { viewName: "demo1", expectError: true }, // not a view table
      { viewName: "missing", expectError: false }, // missing or already deleted
      { viewName: "view1", expectError: false }, // existing
      { viewName: "VieW1", expectError: false }, // view names are case insensitives
    ];

    for (const [i, s] of scenarios.entries()) {
      const err = errorOf(() => deleteView(app.databases, s.viewName));

      const hasErr = err !== null;
      expect({ i, name: s.viewName, hasErr, err: err?.message }).toEqual({
        i,
        name: s.viewName,
        hasErr: s.expectError,
        err: err?.message,
      });
    }
  });
});

describe("TestSaveView", () => {
  let app: TestCollectionsApp;

  beforeAll(() => {
    app = openTestApp();
  });

  afterAll(() => {
    try {
      ensureNoTempViews(app);
    } finally {
      app.cleanup();
    }
  });

  const scenarios: {
    scenarioName: string;
    viewName: string;
    query: string;
    expectError: boolean;
    expectColumns: string[] | null;
  }[] = [
    {
      scenarioName: "empty name and query",
      viewName: "",
      query: "",
      expectError: true,
      expectColumns: null,
    },
    {
      scenarioName: "empty name",
      viewName: "",
      query: "select * from _superusers",
      expectError: true,
      expectColumns: null,
    },
    {
      scenarioName: "empty query",
      viewName: "123Test",
      query: "",
      expectError: true,
      expectColumns: null,
    },
    {
      scenarioName: "invalid query",
      viewName: "123Test",
      query: "123 456",
      expectError: true,
      expectColumns: null,
    },
    {
      scenarioName: "missing table",
      viewName: "123Test",
      query: "select id from missing",
      expectError: true,
      expectColumns: null,
    },
    {
      scenarioName: "non select query",
      viewName: "123Test",
      query: "drop table _superusers",
      expectError: true,
      expectColumns: null,
    },
    {
      scenarioName: "multiple select queries",
      viewName: "123Test",
      query: "select *, count(id) as c  from _superusers; select * from demo1;",
      expectError: true,
      expectColumns: null,
    },
    {
      scenarioName: "try to break the parent parenthesis",
      viewName: "123Test",
      query: "select *, count(id) as c  from `_superusers`)",
      expectError: true,
      expectColumns: null,
    },
    {
      scenarioName: "simple select query (+ trimmed semicolon)",
      viewName: "123Test",
      query: ";select *, count(id) as c  from _superusers;",
      expectError: false,
      expectColumns: [
        "id",
        "created",
        "updated",
        "password",
        "tokenKey",
        "email",
        "emailVisibility",
        "verified",
        "c",
      ],
    },
    {
      scenarioName: "update old view with new query",
      viewName: "123Test",
      query: "select 1 as test from _superusers",
      expectError: false,
      expectColumns: ["test"],
    },
  ];

  for (const s of scenarios) {
    test(s.scenarioName, () => {
      const err = errorOf(() => saveView(app, s.viewName, s.query));

      const hasErr = err !== null;
      if (hasErr !== s.expectError) {
        throw new Error(
          `Expected hasErr ${s.expectError}, got ${hasErr} (${err?.message ?? "nil"})`,
        );
      }

      if (hasErr) {
        return;
      }

      const infoRows = tableInfo(app.databases, s.viewName);

      const expectColumns = s.expectColumns ?? [];
      expect(infoRows).toHaveLength(expectColumns.length);

      for (const row of infoRows) {
        expect(expectColumns).toContain(row.name);
      }
    });
  }
});

describe("TestCreateViewFieldsWithDiscardedNestedTransaction", () => {
  let app: TestCollectionsApp;

  beforeAll(() => {
    app = openTestApp();
  });

  afterAll(() => {
    try {
      ensureNoTempViews(app);
    } finally {
      app.cleanup();
    }
  });

  test("the nested error is discarded by the outer transaction", () => {
    runInAppTransaction(app, (txApp) => {
      const [, err] = createViewFields(txApp, "select id from missing");
      if (err === null) {
        throw new Error("Expected error, got nil");
      }
    });
  });
});

describe("TestCreateViewFields", () => {
  let app: TestCollectionsApp;

  beforeAll(() => {
    app = openTestApp();
  });

  afterAll(() => {
    try {
      ensureNoTempViews(app);
    } finally {
      app.cleanup();
    }
  });

  const scenarios: {
    name: string;
    query: string;
    expectError: boolean;
    expectFields: Record<string, string> | null; // name-type pairs
  }[] = [
    {
      name: "empty query",
      query: "",
      expectError: true,
      expectFields: null,
    },
    {
      name: "invalid query",
      query: "test 123456",
      expectError: true,
      expectFields: null,
    },
    {
      name: "missing table",
      query: "select id from missing",
      expectError: true,
      expectFields: null,
    },
    {
      name: "query with wildcard column",
      query: "select a.id, a.* from demo1 a",
      expectError: true,
      expectFields: null,
    },
    {
      name: "wrapped query with wildcard column",
      query: "select * from (select 1 as id)",
      expectError: true,
      expectFields: null,
    },
    {
      name: "query without id",
      query: "select text, url, created, updated from demo1",
      expectError: true,
      expectFields: null,
    },
    {
      name: "query with comments",
      query: `
				select
				-- test single line
				demo1.id,
				demo1.text,
				/* multi
				 * line comment block */
				demo1.url, demo1.created, demo1.updated from/* inline comment block with no spaces between the identifiers */demo1
				-- comment before join
				join demo2 ON (
					-- comment inside join
					demo2.id = demo1.id
				)
				-- comment before where
				where (
					-- comment inside where
					demo2.id = demo1.id
				)
			`,
      expectError: false,
      expectFields: {
        id: "text",
        text: "text",
        url: "url",
        created: "autodate",
        updated: "autodate",
      },
    },
    {
      name: "query with all fields and quoted identifiers",
      query: `
				select
					"id",
					"created",
					"updated",
					[text],
					\`bool\`,
					"url",
					"select_one",
					"select_many",
					"file_one",
					"demo1"."file_many",
					\`demo1\`.\`number\` number_alias,
					"email",
					"datetime",
					"json",
					"rel_one",
					"rel_many",
					'single_quoted_custom_literal' as 'single_quoted_column'
				from demo1
			`,
      expectError: false,
      expectFields: {
        id: "text",
        created: "autodate",
        updated: "autodate",
        text: "text",
        bool: "bool",
        url: "url",
        select_one: "select",
        select_many: "select",
        file_one: "file",
        file_many: "file",
        number_alias: "number",
        email: "email",
        datetime: "date",
        json: "json",
        rel_one: "relation",
        rel_many: "relation",
        single_quoted_column: "json",
      },
    },
    {
      name: "query with indirect relations fields",
      query: "select a.id, b.id as bid, b.created from demo1 as a left join demo2 b",
      expectError: false,
      expectFields: {
        id: "text",
        bid: "relation",
        created: "autodate",
      },
    },
    {
      name: "query with multiple froms, joins and style of aliases",
      query: `
				select
					a.id as id,
					b.id as bid,
					lj.id cid,
					ij.id as did,
					a.bool,
					_superusers.id as eid,
					_superusers.email
				from demo1 a, demo2 as b
				left join demo3 lj on lj.id = 123
				inner join demo4 as ij on ij.id = 123
				join _superusers
				where 1=1
				group by a.id
				limit 10
			`,
      expectError: false,
      expectFields: {
        id: "text",
        bid: "relation",
        cid: "relation",
        did: "relation",
        bool: "bool",
        eid: "relation",
        email: "email",
      },
    },
    {
      name: "query with casts",
      query: `select
				a.id,
				count(a.id) count,
				cast(a.id as int) cast_int,
				cast(a.id as integer) cast_integer,
				cast(a.id as real) cast_real,
				cast(a.id as decimal) cast_decimal,
				cast(a.id as numeric) cast_numeric,
				cast(a.id as text) cast_text,
				cast(a.id as bool) cast_bool,
				cast(a.id as boolean) cast_boolean,
				avg(a.id) avg,
				sum(a.id) sum,
				total(a.id) total,
				min(a.id) min,
				max(a.id) max
			from demo1 a`,
      expectError: false,
      expectFields: {
        id: "text",
        count: "number",
        total: "number",
        cast_int: "number",
        cast_integer: "number",
        cast_real: "number",
        cast_decimal: "number",
        cast_numeric: "number",
        cast_text: "text",
        cast_bool: "bool",
        cast_boolean: "bool",
        // json because they are nullable
        sum: "json",
        avg: "json",
        min: "json",
        max: "json",
      },
    },
    {
      name: "query with multiline cast",
      query: `select
				id,
				cast(
					(
						case
							when count(a.id) = 1 then 21
							when count(a.id) = 2 then 18
							else 0
						end
					) as int
				) as cast_int
			from demo1 a`,
      expectError: false,
      expectFields: {
        id: "text",
        cast_int: "number",
      },
    },
    {
      name: "query with case-insensitive and extra-spaced cast",
      query: `select
				id,
				CaSt( a.id  aS iNt ) as cast_int
			from demo1 a`,
      expectError: false,
      expectFields: {
        id: "text",
        cast_int: "number",
      },
    },
    {
      name: "query with reserved auth collection fields",
      query: `
				select
					a.id,
					a.username,
					a.email,
					a.emailVisibility,
					a.verified,
					demo1.id relid
				from users a
				left join demo1
			`,
      expectError: false,
      expectFields: {
        id: "text",
        username: "text",
        email: "email",
        emailVisibility: "bool",
        verified: "bool",
        relid: "relation",
      },
    },
    {
      name: "query with unknown fields and aliases",
      query: `select
				id,
				id as id2,
				text as text_alias,
				url as url_alias,
				"demo1"."bool" as bool_alias,
				number as number_alias,
				created created_alias,
				updated updated_alias,
				123 as custom
			from demo1`,
      expectError: false,
      expectFields: {
        id: "text",
        id2: "relation",
        text_alias: "text",
        url_alias: "url",
        bool_alias: "bool",
        number_alias: "number",
        created_alias: "autodate",
        updated_alias: "autodate",
        custom: "json",
      },
    },
    {
      name: "query with distinct and reordered id column",
      query: `select distinct
				id as id2,
				id,
				123 as custom
			from demo1`,
      expectError: false,
      expectFields: {
        id2: "relation",
        id: "text",
        custom: "json",
      },
    },
    {
      name: "query with aliasing the same field multiple times",
      query: `select
				a.id as id,
				a.text as alias1,
				a.text as alias2,
				b.text as alias3,
				b.text as alias4
			from demo1 a
			left join demo1 as b`,
      expectError: false,
      expectFields: {
        id: "text",
        alias1: "text",
        alias2: "text",
        alias3: "text",
        alias4: "text",
      },
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const [result, err] = createViewFields(app, s.query);

      const hasErr = err !== null;
      if (hasErr !== s.expectError) {
        throw new Error(
          `Expected hasErr ${s.expectError}, got ${hasErr} (${err?.message ?? "nil"})`,
        );
      }

      if (hasErr) {
        return;
      }

      const expectFields = s.expectFields ?? {};
      if (Object.keys(expectFields).length !== result.length) {
        throw new Error(
          `Expected ${Object.keys(expectFields).length} fields, got ${result.length}: \n${result.marshalJSON()}`,
        );
      }

      for (const [name, typ] of Object.entries(expectFields)) {
        const field = result.getByName(name);

        if (field === null) {
          throw new Error(`Expected to find field ${name}, got nil`);
        }

        if (field.type() !== typ) {
          throw new Error(`Expected field ${name} to be "${typ}", got "${field.type()}"`);
        }
      }
    });
  }
});

describe("TestCreateViewFieldsWithNumberOnlyInt", () => {
  let app: TestCollectionsApp;

  beforeAll(() => {
    app = openTestApp();
  });

  afterAll(() => {
    try {
      ensureNoTempViews(app);
    } finally {
      app.cleanup();
    }
  });

  test("only the integer aggregations and casts are integer number fields", () => {
    const sql = `select
		a.id,
		count(a.id) count,
		total(a.id) total,
		cast(a.id as int) cast_int,
		cast(a.id as integer) cast_integer,
		cast(a.id as real) cast_real,
		cast(a.id as decimal) cast_decimal,
		cast(a.id as numeric) cast_numeric
	from demo1 a`;

    const [result, err] = createViewFields(app, sql);
    if (err !== null) {
      throw err;
    }

    const onlyInts: Record<string, boolean> = {
      count: true,
      total: false,
      cast_int: true,
      cast_integer: true,
      cast_real: false,
      cast_decimal: false,
      cast_numeric: false,
    };

    const totalExpected = Object.keys(onlyInts).length + 1;
    expect(result.length).toBe(totalExpected);

    for (const f of result) {
      if (f.getName() === "id") {
        continue;
      }

      expect(f).toBeInstanceOf(NumberField);
      const nf = f as NumberField;
      expect({ name: nf.name, onlyInt: nf.onlyInt }).toEqual({
        name: nf.name,
        onlyInt: onlyInts[nf.name] ?? false, // Go map lookup gives the zero value
      });
    }
  });
});

describe("TestDryRunView", () => {
  let app: TestCollectionsApp;

  beforeAll(() => {
    app = openTestApp();
  });

  afterAll(() => {
    try {
      ensureNoTempViews(app);
    } finally {
      app.cleanup();
    }
  });

  const scenarios: {
    name: string;
    query: string;
    sampleSize: number;
    expectError: boolean;
    expectFields: Record<string, string> | null; // name-type pairs
    expectSampleIds: string[] | null; // record ids of the resulting sample
  }[] = [
    {
      name: "empty query",
      query: "",
      sampleSize: 10,
      expectError: true,
      expectFields: null,
      expectSampleIds: null,
    },
    {
      name: "non-select query",
      query: "CREATE TABLE t1(x INT)",
      sampleSize: 10,
      expectError: true,
      expectFields: null,
      expectSampleIds: null,
    },
    {
      name: "multiple inline select statements",
      query: "select 'a' as id; select 'b' as id",
      sampleSize: 10,
      expectError: true,
      expectFields: null,
      expectSampleIds: null,
    },
    {
      name: "select with invalid formatted field name",
      query: "select 'a' as id, count(*)", // missing field alias
      sampleSize: 10,
      expectError: true,
      expectFields: null,
      expectSampleIds: null,
    },
    {
      name: "select resolving to records with missing id",
      query:
        "select id from (select 'a' as id UNION ALL select null as id UNION ALL select 'c' as id)",
      sampleSize: 10,
      expectError: true,
      expectFields: null,
      expectSampleIds: null,
    },
    {
      name: "select resolving to records with duplicated ids",
      query:
        "select id from (select 'a' as id UNION ALL select 'a' as id UNION ALL select 'c' as id)",
      sampleSize: 10,
      expectError: true,
      expectFields: null,
      expectSampleIds: null,
    },
    {
      name: "no sample size and valid select query but with invalid records result",
      query:
        "select id from (select 'a' as id UNION ALL select 'a' as id UNION ALL select 'c' as id)",
      sampleSize: 0,
      expectError: false, // still "valid" because there is no sample to check
      expectFields: { id: "text" },
      expectSampleIds: null,
    },
    {
      name: "sample size < total select records",
      query:
        "select id from (select 'a' as id UNION ALL select 'b' as id UNION ALL select 'c' as id UNION ALL select 'd' as id)",
      sampleSize: 3,
      expectError: false,
      expectFields: { id: "text" },
      expectSampleIds: ["a", "b", "c"],
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      let result: ReturnType<typeof dryRunView>;
      try {
        result = dryRunView(app, s.query, s.sampleSize);
      } catch (err) {
        if (!s.expectError) {
          throw err;
        }
        return;
      }

      if (s.expectError) {
        throw new Error("Expected hasErr true, got false");
      }

      // check fields
      // ---
      const expectFields = s.expectFields ?? {};
      if (Object.keys(expectFields).length !== result.fields.length) {
        throw new Error(
          `Expected ${Object.keys(expectFields).length} fields, got ${result.fields.length}: \n${result.fields.marshalJSON()}`,
        );
      }
      for (const [name, typ] of Object.entries(expectFields)) {
        const field = result.fields.getByName(name);
        if (field === null) {
          throw new Error(`Expected to find field ${name}, got nil`);
        }

        if (field.type() !== typ) {
          throw new Error(`Expected field ${name} to be "${typ}", got "${field.type()}"`);
        }
      }

      // check sample ids
      // ---
      const expectSampleIds = s.expectSampleIds ?? [];
      expect(result.sample).toHaveLength(expectSampleIds.length);
      for (const [i, r] of result.sample.entries()) {
        expect({ i, id: r.id }).toEqual({ i, id: expectSampleIds[i] as string });
      }
    });
  }
});

test("dry run reports query errors and timeouts", () => {
  const app = openTestApp(undefined, undefined, 1);
  try {
    const malformed = errorOf(() =>
      dryRunView(app, "select 'a' as id, json('invalid') as value", 10),
    );
    expect(malformed?.message).toMatch(
      /SQL logic error: malformed JSON \(1\); failed query: SELECT/,
    );
    const timeout = errorOf(() =>
      dryRunView(
        app,
        "SELECT 'a' as id, (WITH RECURSIVE t(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM t WHERE n<1000000) SELECT sum(n) FROM t) as total",
        10,
      ),
    );
    expect(timeout?.message).toContain("context deadline exceeded; failed query: SELECT");
  } finally {
    app.cleanup();
  }
});
