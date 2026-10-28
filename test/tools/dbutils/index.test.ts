// Upstream: tools/dbutils/index_test.go

import { describe, expect, test } from "bun:test";
import {
  Index,
  findSingleColumnUniqueIndex,
  hasSingleColumnUniqueIndex,
  parseIndex,
} from "@/tools/dbutils/index";

describe("ParseIndex", () => {
  const scenarios: { name: string; index: string; expected: Index }[] = [
    {
      name: "invalid",
      index: `invalid`,
      expected: new Index(),
    },
    {
      name: "no names",
      index: `create index on ()`,
      expected: new Index(),
    },
    {
      name: "invalid index name",
      index: `create index a.b.c on ()`,
      expected: new Index(),
    },
    {
      name: "simple (multiple spaces as prefix, suffix, between the table and columns list)",
      index: `  create index indexname on tablename   (col1)  `,
      expected: new Index({
        indexName: "indexname",
        tableName: "tablename",
        columns: [{ name: "col1", collate: "", sort: "" }],
      }),
    },
    {
      name: "simple (no space between the table and the columns list)",
      index: `create index indexname on tablename(col1)`,
      expected: new Index({
        indexName: "indexname",
        tableName: "tablename",
        columns: [{ name: "col1", collate: "", sort: "" }],
      }),
    },
    {
      name: "all fields",
      index:
        'CREATE UNIQUE INDEX IF NOT EXISTS "schemaname".[indexname] on \'tablename\' (\n\t\t\t\tcol0,\n\t\t\t\t`col1`,\n\t\t\t\tjson_extract("col2_multiline",\n "$.a") asc,\n\t\t\t\t"col3" collate NOCASE,\n\t\t\t\t"col4" collate RTRIM desc\n\t\t\t) where cast(test1 as \nint) = 1 and test2 != \'\'',
      expected: new Index({
        unique: true,
        optional: true,
        schemaName: "schemaname",
        indexName: "indexname",
        tableName: "tablename",
        columns: [
          { name: "col0", collate: "", sort: "" },
          { name: "col1", collate: "", sort: "" },
          { name: 'json_extract("col2_multiline",\n "$.a")', collate: "", sort: "ASC" },
          { name: "col3", collate: "NOCASE", sort: "" },
          { name: "col4", collate: "RTRIM", sort: "DESC" },
        ],
        where: "cast(test1 as \nint) = 1 and test2 != ''",
      }),
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      expect(parseIndex(s.index)).toEqual(s.expected);
    });
  }
});

describe("IndexIsValid", () => {
  const scenarios: { name: string; index: Index; expected: boolean }[] = [
    {
      name: "empty",
      index: new Index(),
      expected: false,
    },
    {
      name: "no index name",
      index: new Index({
        tableName: "table",
        columns: [{ name: "col", collate: "", sort: "" }],
      }),
      expected: false,
    },
    {
      name: "no table name",
      index: new Index({
        indexName: "index",
        columns: [{ name: "col", collate: "", sort: "" }],
      }),
      expected: false,
    },
    {
      name: "no columns",
      index: new Index({
        indexName: "index",
        tableName: "table",
      }),
      expected: false,
    },
    {
      name: "min valid",
      index: new Index({
        indexName: "index",
        tableName: "table",
        columns: [{ name: "col", collate: "", sort: "" }],
      }),
      expected: true,
    },
    {
      name: "all fields",
      index: new Index({
        optional: true,
        unique: true,
        schemaName: "schema",
        indexName: "index",
        tableName: "table",
        columns: [{ name: "col", collate: "", sort: "" }],
        where: "test = 1 OR test = 2",
      }),
      expected: true,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      expect(s.index.isValid()).toBe(s.expected);
    });
  }
});

describe("IndexBuild", () => {
  const scenarios: { name: string; index: Index; expected: string }[] = [
    {
      name: "empty",
      index: new Index(),
      expected: "",
    },
    {
      name: "no index name",
      index: new Index({
        tableName: "table",
        columns: [{ name: "col", collate: "", sort: "" }],
      }),
      expected: "",
    },
    {
      name: "no table name",
      index: new Index({
        indexName: "index",
        columns: [{ name: "col", collate: "", sort: "" }],
      }),
      expected: "",
    },
    {
      name: "no columns",
      index: new Index({
        indexName: "index",
        tableName: "table",
      }),
      expected: "",
    },
    {
      name: "min valid",
      index: new Index({
        indexName: "index",
        tableName: "table",
        columns: [{ name: "col", collate: "", sort: "" }],
      }),
      expected: "CREATE INDEX `index` ON `table` (`col`)",
    },
    {
      name: "all fields",
      index: new Index({
        optional: true,
        unique: true,
        schemaName: "schema",
        indexName: "index",
        tableName: "table",
        columns: [
          { name: "col1", collate: "NOCASE", sort: "asc" },
          { name: "col2", collate: "", sort: "desc" },
          { name: 'json_extract("col3", "$.a")', collate: "NOCASE", sort: "" },
        ],
        where: "test = 1 OR test = 2",
      }),
      expected:
        'CREATE UNIQUE INDEX IF NOT EXISTS `schema`.`index` ON `table` (\n  `col1` COLLATE NOCASE ASC,\n  `col2` DESC,\n  json_extract("col3", "$.a") COLLATE NOCASE\n) WHERE test = 1 OR test = 2',
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      expect(s.index.build()).toBe(s.expected);
    });
  }
});

describe("HasSingleColumnUniqueIndex", () => {
  const scenarios: {
    name: string;
    column: string;
    indexes: string[];
    expected: boolean;
  }[] = [
    {
      name: "empty indexes",
      column: "test",
      indexes: [],
      expected: false,
    },
    {
      name: "empty column",
      column: "",
      indexes: ["CREATE UNIQUE INDEX `index1` ON `example` (`test`)"],
      expected: false,
    },
    {
      name: "mismatched column",
      column: "test",
      indexes: ["CREATE UNIQUE INDEX `index1` ON `example` (`test2`)"],
      expected: false,
    },
    {
      name: "non unique index",
      column: "test",
      indexes: ["CREATE INDEX `index1` ON `example` (`test`)"],
      expected: false,
    },
    {
      name: "matching columnd and unique index",
      column: "test",
      indexes: ["CREATE UNIQUE INDEX `index1` ON `example` (`test`)"],
      expected: true,
    },
    {
      name: "multiple columns",
      column: "test",
      indexes: ["CREATE UNIQUE INDEX `index1` ON `example` (`test`, `test2`)"],
      expected: false,
    },
    {
      name: "multiple indexes",
      column: "test",
      indexes: [
        "CREATE UNIQUE INDEX `index1` ON `example` (`test`, `test2`)",
        "CREATE UNIQUE INDEX `index2` ON `example` (`test`)",
      ],
      expected: true,
    },
    {
      name: "partial unique index",
      column: "test",
      indexes: ["CREATE UNIQUE INDEX `index` ON `example` (`test`) where test != ''"],
      expected: true,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      expect(hasSingleColumnUniqueIndex(s.column, s.indexes)).toBe(s.expected);
    });
  }
});

describe("FindSingleColumnUniqueIndex", () => {
  const scenarios: {
    name: string;
    column: string;
    indexes: string[];
    expected: boolean;
  }[] = [
    {
      name: "empty indexes",
      column: "test",
      indexes: [],
      expected: false,
    },
    {
      name: "empty column",
      column: "",
      indexes: ["CREATE UNIQUE INDEX `index1` ON `example` (`test`)"],
      expected: false,
    },
    {
      name: "mismatched column",
      column: "test",
      indexes: ["CREATE UNIQUE INDEX `index1` ON `example` (`test2`)"],
      expected: false,
    },
    {
      name: "non unique index",
      column: "test",
      indexes: ["CREATE INDEX `index1` ON `example` (`test`)"],
      expected: false,
    },
    {
      name: "matching columnd and unique index",
      column: "test",
      indexes: ["CREATE UNIQUE INDEX `index1` ON `example` (`test`)"],
      expected: true,
    },
    {
      name: "multiple columns",
      column: "test",
      indexes: ["CREATE UNIQUE INDEX `index1` ON `example` (`test`, `test2`)"],
      expected: false,
    },
    {
      name: "multiple indexes",
      column: "test",
      indexes: [
        "CREATE UNIQUE INDEX `index1` ON `example` (`test`, `test2`)",
        "CREATE UNIQUE INDEX `index2` ON `example` (`test`)",
      ],
      expected: true,
    },
    {
      name: "partial unique index",
      column: "test",
      indexes: ["CREATE UNIQUE INDEX `index` ON `example` (`test`) where test != ''"],
      expected: true,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const [index, exists] = findSingleColumnUniqueIndex(s.indexes, s.column);

      expect(exists).toBe(s.expected);

      if (!exists) {
        expect(index.columns.length).toBe(0);
      } else {
        // strings.EqualFold (ASCII fixtures here)
        expect(index.columns[0]?.name.toLowerCase()).toBe(s.column.toLowerCase());
      }
    });
  }
});
