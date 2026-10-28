// Upstream: core/collection_record_table_sync_test.go
//
// Nothing is left out. Each Go test function runs on its own copy of the
// vendored fixture (openTestApp, as tests.NewTestApp).

import { describe, expect, test } from "bun:test";

import {
  newAuthCollection,
  newBaseCollection,
  type Collection,
} from "@/collections/collection-model";
import { findCollectionByNameOrId, reloadCachedCollections } from "@/collections/collection-query";
import { saveCollection } from "@/collections/collection-save";
import { syncRecordTableSchema } from "@/collections/collection-record-table-sync";
import { HashExp, newExp } from "@/db/dbx/expression";
import { hasTable, tableColumns, tableIndexes, tableInfo } from "@/db/table";
import { EmailField } from "@/fields/email";
import { SelectField } from "@/fields/select";
import { FileField } from "@/fields/file";
import { RelationField } from "@/fields/relation";
import { TextField } from "@/fields/text";

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

describe("TestSyncRecordTableSchema", () => {
  test("sync scenarios", () => {
    const app: TestCollectionsApp = openTestApp();

    try {
      const oldCollection = findCollectionByNameOrId(app, "demo2");
      const updatedCollection = findCollectionByNameOrId(app, "demo2");
      updatedCollection.name = "demo_renamed";
      updatedCollection.fields.removeByName("active");
      updatedCollection.fields.add(
        new EmailField({
          name: "new_field",
        }),
      );
      updatedCollection.fields.add(
        new EmailField({
          id: updatedCollection.fields.getByName("title")?.getId(),
          name: "title_renamed",
        }),
      );
      updatedCollection.indexes = ["create index idx_title_renamed on anything (title_renamed)"];

      const baseCol = newBaseCollection("new_base");
      baseCol.fields.add(new TextField({ name: "test" }));

      const authCol = newAuthCollection("new_auth");
      authCol.fields.add(new TextField({ name: "test" }));
      authCol.addIndex("idx_auth_test", false, "email, id", "");

      const scenarios: {
        name: string;
        newCollection: Collection;
        oldCollection: Collection | null;
        expectedColumns: string[];
        expectedIndexesCount: number;
      }[] = [
        {
          name: "new base collection",
          newCollection: baseCol,
          oldCollection: null,
          expectedColumns: ["id", "test"],
          expectedIndexesCount: 0,
        },
        {
          name: "new auth collection",
          newCollection: authCol,
          oldCollection: null,
          expectedColumns: [
            "id",
            "test",
            "email",
            "verified",
            "emailVisibility",
            "tokenKey",
            "password",
          ],
          expectedIndexesCount: 3,
        },
        {
          name: "no changes",
          newCollection: oldCollection,
          oldCollection: oldCollection,
          expectedColumns: ["id", "created", "updated", "title", "active"],
          expectedIndexesCount: 3,
        },
        {
          name: "renamed table, deleted column, renamed columnd and new column",
          newCollection: updatedCollection,
          oldCollection: oldCollection,
          expectedColumns: ["id", "created", "updated", "title_renamed", "new_field"],
          expectedIndexesCount: 1,
        },
      ];

      for (const s of scenarios) {
        const err = errorOf(() => syncRecordTableSchema(app, s.newCollection, s.oldCollection));
        if (err !== null) {
          throw err;
        }

        expect({
          table: s.newCollection.name,
          exists: hasTable(app.databases, s.newCollection.name),
        }).toEqual({ table: s.newCollection.name, exists: true });

        const cols = tableColumns(app.databases, s.newCollection.name);
        expect({ scenario: s.name, count: cols.length }).toEqual({
          scenario: s.name,
          count: s.expectedColumns.length,
        });

        for (const col of cols) {
          expect(s.expectedColumns).toContain(col);
        }

        const indexes = tableIndexes(app.databases, s.newCollection.name);
        expect({ scenario: s.name, count: Object.keys(indexes).length }).toEqual({
          scenario: s.name,
          count: s.expectedIndexesCount,
        });
      }
    } finally {
      app.cleanup();
    }
  });
});

// getTotalViews counts the views in the database
function getTotalViews(app: TestCollectionsApp): number {
  const [total] = app.databases
    .db()
    .select("count(*)")
    .from("sqlite_master")
    .andWhere(newExp("sql is not null"))
    .andWhere(new HashExp({ type: "view" }))
    .row();

  return Number(total);
}

describe("TestSingleVsMultipleValuesNormalization", () => {
  test("values and defaults are normalized on save", () => {
    const app = openTestApp();

    try {
      const collection = findCollectionByNameOrId(app, "demo1");

      const beforeTotalViews = getTotalViews(app);

      // mock field changes
      (collection.fields.getByName("select_one") as SelectField).maxSelect = 2;
      (collection.fields.getByName("select_many") as SelectField).maxSelect = 1;
      (collection.fields.getByName("file_one") as FileField).maxSelect = 2;
      (collection.fields.getByName("file_many") as FileField).maxSelect = 1;
      (collection.fields.getByName("rel_one") as RelationField).maxSelect = 2;
      (collection.fields.getByName("rel_many") as RelationField).maxSelect = 1;

      // new multivaluer field to check whether the array normalization
      // will be applied for already inserted data
      collection.fields.add(
        new SelectField({
          name: "new_multiple",
          values: ["a", "b", "c"],
          maxSelect: 3,
        }),
      );

      saveCollection(app, collection);

      // ensure that the views were reinserted
      const afterTotalViews = getTotalViews(app);
      expect(afterTotalViews).toBe(beforeTotalViews);

      // check whether the columns DEFAULT definition was updated
      // ---------------------------------------------------------------
      const info = tableInfo(app.databases, collection.name);

      const tableInfoExpectations: Record<string, string> = {
        select_one: `'[]'`,
        select_many: `''`,
        file_one: `'[]'`,
        file_many: `''`,
        rel_one: `'[]'`,
        rel_many: `''`,
        new_multiple: `'[]'`,
      };
      for (const [col, dflt] of Object.entries(tableInfoExpectations)) {
        const row = info.find((r) => r.name === col);
        if (row === undefined) {
          throw new Error(`Missing info for column "${col}"`);
        }

        expect({ col, dflt: row.defaultValue ?? "" }).toEqual({ col, dflt });
      }

      // check whether the values were normalized
      // ---------------------------------------------------------------
      const selectedColumns = [
        "select_one",
        "select_many",
        "file_one",
        "file_many",
        "rel_one",
        "rel_many",
        "new_multiple",
      ];

      const fieldsScenarios: { recordId: string; expected: Record<string, string> }[] = [
        {
          recordId: "imy661ixudk5izi",
          expected: {
            select_one: `[]`,
            select_many: ``,
            file_one: `[]`,
            file_many: ``,
            rel_one: `[]`,
            rel_many: ``,
            new_multiple: `[]`,
          },
        },
        {
          recordId: "al1h9ijdeojtsjy",
          expected: {
            select_one: `["optionB"]`,
            select_many: `optionB`,
            file_one: `["300_Jsjq7RdBgA.png"]`,
            file_many: ``,
            rel_one: `["84nmscqy84lsi1t"]`,
            rel_many: `oap640cot4yru2s`,
            new_multiple: `[]`,
          },
        },
        {
          recordId: "84nmscqy84lsi1t",
          expected: {
            select_one: `["optionB"]`,
            select_many: `optionC`,
            file_one: `["test_d61b33QdDU.txt"]`,
            file_many: `test_tC1Yc87DfC.txt`,
            rel_one: `[]`,
            rel_many: `oap640cot4yru2s`,
            new_multiple: `[]`,
          },
        },
      ];

      for (const s of fieldsScenarios) {
        const result = app.databases
          .db()
          .select(...selectedColumns)
          .from(collection.name)
          .where(new HashExp({ id: s.recordId }))
          .one<Record<string, unknown>>();

        expect({ recordId: s.recordId, row: result }).toEqual({
          recordId: s.recordId,
          row: s.expected,
        });
      }
    } finally {
      app.cleanup();
    }
  });
});

describe("TestDropIndexWithoutTableName", () => {
  test("an index without a table name is normalized on resave", () => {
    const app = openTestApp();

    try {
      const properIndex = "CREATE INDEX `new_test_idx2` ON `new_test` (`test`)";
      const indexWithoutTableName = "CREATE INDEX `new_test_idx2` ON `` (`test`)";

      let dummyCollection = newBaseCollection("new_test");
      dummyCollection.fields.add(new TextField({ name: "test" }));
      dummyCollection.indexes = [properIndex];

      saveCollection(app, dummyCollection);

      // resave without table name but without hooks to avoid the normalizations
      dummyCollection.indexes[0] = indexWithoutTableName;
      // stands in for app.UnsafeWithoutHooks().Save: a raw row write that
      // skips the collection save logic
      app.databases
        .nonconcurrentDB()
        .update(
          "_collections",
          { indexes: JSON.stringify(dummyCollection.indexes) },
          new HashExp({ id: dummyCollection.id }),
        )
        .execute();
      reloadCachedCollections(app);

      dummyCollection = findCollectionByNameOrId(app, dummyCollection.name);

      // resave should normalize the index
      saveCollection(app, dummyCollection);

      dummyCollection = findCollectionByNameOrId(app, dummyCollection.name);

      expect(dummyCollection.indexes).toEqual([properIndex]);
    } finally {
      app.cleanup();
    }
  });
});
