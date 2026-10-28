// Upstream: core/collection_model_test.go (TestCollectionDelete,
// TestCollectionModelEventSync, TestCollectionSaveModel,
// TestCollectionSaveIndirectViewsUpdate, TestCollectionSaveViewWrapping,
// TestCollectionSaveIndexesTableNameNormalization)
//
// Each case runs on a fresh copy of the vendored fixture (openTestApp), as
// upstream's tests.NewTestApp does. app.Save and app.Delete are
// saveCollection and deleteCollection.
//
// Left out: TestCollectionModelEventSync checks that the model and
// collection hook events stay in sync; there is no hook system (D5), so
// only its four collection saves are kept.

import { describe, expect, test } from "bun:test";

import {
  type Collection,
  newAuthCollection,
  newBaseCollection,
  newViewCollection,
} from "@/collections/collection-model";
import {
  findCachedCollectionByNameOrId,
  findCollectionByNameOrId,
} from "@/collections/collection-query";
import { deleteCollection, saveCollection } from "@/collections/collection-save";
import { FileField } from "@/fields/file";
import { RelationField } from "@/fields/relation";
import { TextField } from "@/fields/text";
import { hasTable, tableColumns, tableIndexes } from "@/db/table";
import { parseIndex } from "@/tools/dbutils/index";

import { openTestApp, type TestCollectionsApp } from "@test/collections/app";

function withApp(fn: (app: TestCollectionsApp) => void): void {
  const app = openTestApp();
  try {
    fn(app);
  } finally {
    app.cleanup();
  }
}

function errorOf(fn: () => void): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

describe("TestCollectionDelete", () => {
  test("reports the raw dependent view error", () => {
    withApp((app) => {
      const parent = newBaseCollection("council_parent");
      saveCollection(app, parent);
      const view = newViewCollection("council_view");
      view.viewQuery = "select id from council_parent";
      saveCollection(app, view);
      expect(() => deleteCollection(app, parent)).toThrow(
        "[council_parent] failed to delete due to existing view dependency: [council_view] SQL logic error: no such table: main.council_parent (1)",
      );
      expect(hasTable(app.databases, "council_parent")).toBe(true);
    });
  });

  const scenarios: {
    name: string;
    collection: string;
    disableIntegrityChecks?: boolean;
    expectError: boolean;
  }[] = [
    { name: "unsaved", collection: "", expectError: true },
    { name: "system", collection: "_superusers", expectError: true },
    { name: "base with references", collection: "demo1", expectError: true },
    {
      name: "base with references with disabled integrity checks",
      collection: "demo1",
      disableIntegrityChecks: true,
      expectError: false,
    },
    { name: "base without references", collection: "demo1", expectError: true },
    { name: "view with reference", collection: "view1", expectError: true },
    {
      name: "view with references with disabled integrity checks",
      collection: "view1",
      disableIntegrityChecks: true,
      expectError: false,
    },
    {
      name: "view without references",
      collection: "view2",
      disableIntegrityChecks: true,
      expectError: false,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      withApp((app) => {
        const col =
          s.collection === ""
            ? newBaseCollection("test")
            : findCollectionByNameOrId(app, s.collection);

        if (s.disableIntegrityChecks) {
          col.integrityChecks(!s.disableIntegrityChecks);
        }

        const err = errorOf(() => deleteCollection(app, col));

        const hasErr = err !== null;
        expect({ hasErr, err: String(err) }).toEqual({ hasErr: s.expectError, err: String(err) });

        const exists = hasTable(app.databases, col.name);

        if (!col.isNew()) {
          expect(exists).toBe(hasErr);
        }

        if (!hasErr) {
          expect(() => findCachedCollectionByNameOrId(app, col.id)).toThrow();
        }
      });
    });
  }
});

describe("TestCollectionModelEventSync", () => {
  test("saves the test collections", () => {
    withApp((app) => {
      for (let i = 0; i < 4; i++) {
        saveCollection(app, newBaseCollection("sync_test_" + String(i)));
      }
      for (let i = 0; i < 4; i++) {
        expect(hasTable(app.databases, "sync_test_" + String(i))).toBe(true);
      }
    });
  });
});

describe("TestCollectionSaveModel", () => {
  const scenarios: {
    name: string;
    collection: (app: TestCollectionsApp) => Collection;
    expectError: boolean;
    expectColumns?: string[];
  }[] = [
    // trigger validators
    {
      name: "create - trigger validators",
      collection: () => {
        const c = newBaseCollection("!invalid");
        c.fields.add(new TextField({ name: "example" }));
        c.addIndex("test_save_idx", false, "example", "");
        return c;
      },
      expectError: true,
    },
    {
      name: "update - trigger validators",
      collection: (app) => {
        const c = findCollectionByNameOrId(app, "demo5");
        c.name = "demo1";
        c.fields.add(new TextField({ name: "example" }));
        c.fields.removeByName("file");
        c.addIndex("test_save_idx", false, "example", "");
        return c;
      },
      expectError: true,
    },

    // create
    {
      name: "create base collection",
      collection: () => {
        const c = newBaseCollection("new");
        c.type = ""; // should be auto set to "base"
        c.fields.removeByName("id"); // ensure that the default fields will be loaded
        c.fields.add(new TextField({ name: "example" }));
        c.addIndex("test_save_idx", false, "example", "");
        return c;
      },
      expectError: false,
      expectColumns: ["id", "example"],
    },
    {
      name: "create auth collection",
      collection: () => {
        const c = newAuthCollection("new");
        c.fields.removeByName("id"); // ensure that the default fields will be loaded
        c.fields.removeByName("email"); // ensure that the default fields will be loaded
        c.fields.add(new TextField({ name: "example" }));
        c.addIndex("test_save_idx", false, "example", "");
        return c;
      },
      expectError: false,
      expectColumns: [
        "id",
        "email",
        "tokenKey",
        "password",
        "verified",
        "emailVisibility",
        "example",
      ],
    },
    {
      name: "create view collection",
      collection: () => {
        const c = newViewCollection("new");
        c.fields.add(new TextField({ name: "ignored" })); // should be ignored
        c.viewQuery = "select 1 as id, 2 as example";
        return c;
      },
      expectError: false,
      expectColumns: ["id", "example"],
    },

    // update
    {
      name: "update base collection",
      collection: (app) => {
        const c = findCollectionByNameOrId(app, "demo5");
        c.fields.add(new TextField({ name: "example" }));
        c.fields.removeByName("file");
        c.fields.getByName("total")!.setName("total_updated");
        c.addIndex("test_save_idx", false, "example", "");
        return c;
      },
      expectError: false,
      expectColumns: [
        "id",
        "select_one",
        "select_many",
        "rel_one",
        "rel_many",
        "total_updated",
        "created",
        "updated",
        "example",
      ],
    },
    {
      name: "update auth collection",
      collection: (app) => {
        const c = findCollectionByNameOrId(app, "clients");
        c.fields.add(new TextField({ name: "example" }));
        c.fields.removeByName("file");
        c.fields.getByName("name")!.setName("name_updated");
        c.addIndex("test_save_idx", false, "example", "");
        return c;
      },
      expectError: false,
      expectColumns: [
        "id",
        "email",
        "emailVisibility",
        "password",
        "tokenKey",
        "verified",
        "username",
        "name_updated",
        "created",
        "updated",
        "example",
      ],
    },
    {
      name: "update view collection",
      collection: (app) => {
        const c = findCollectionByNameOrId(app, "view2");
        c.fields.add(new TextField({ name: "example" })); // should be ignored
        c.viewQuery = "select 1 as id, 2 as example";
        return c;
      },
      expectError: false,
      expectColumns: ["id", "example"],
    },

    // auth normalization
    {
      name: "unset missing oauth2 mapped fields",
      collection: () => {
        const c = newAuthCollection("new");
        c.oauth2.enabled = true;
        // shouldn't fail
        c.oauth2.mappedFields.id = "missing";
        c.oauth2.mappedFields.name = "missing";
        c.oauth2.mappedFields.username = "missing";
        c.oauth2.mappedFields.avatarURL = "missing";
        return c;
      },
      expectError: false,
      expectColumns: ["id", "email", "emailVisibility", "password", "tokenKey", "verified"],
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      withApp((app) => {
        const collection = s.collection(app);

        const saveErr = errorOf(() => saveCollection(app, collection));

        const hasErr = saveErr !== null;
        expect({ hasErr, err: String(saveErr) }).toEqual({
          hasErr: s.expectError,
          err: String(saveErr),
        });

        if (hasErr) {
          return;
        }

        // the collection should always have an id after successful Save
        expect(collection.id).not.toBe("");

        // the timestamp fields should be non-empty after successful Save
        expect(collection.created.string()).not.toBe("");
        expect(collection.updated.string()).not.toBe("");

        // check if the records table was synced
        expect(hasTable(app.databases, collection.name)).toBe(true);

        // check if the records table has the fields fields
        const columns = tableColumns(app.databases, collection.name);
        expect(columns.toSorted()).toEqual([...(s.expectColumns ?? [])].toSorted());

        // make sure that all collection indexes exists
        const indexes = tableIndexes(app.databases, collection.name);
        expect(Object.keys(indexes).length).toBe(collection.indexes.length);
        for (const idx of collection.indexes) {
          const parsed = parseIndex(idx);
          expect(Object.hasOwn(indexes, parsed.indexName)).toBe(true);
        }

        // nothing was logged
        expect(app.logged).toEqual([]);
      });
    });
  }
});

// indirect update of a field used in view should cause view(s) update
test("TestCollectionSaveIndirectViewsUpdate", () => {
  withApp((app) => {
    const collection = findCollectionByNameOrId(app, "demo1");

    // update MaxSelect fields
    {
      const relMany = collection.fields.getByName("rel_many") as RelationField;
      relMany.maxSelect = 1;

      const fileOne = collection.fields.getByName("file_one") as FileField;
      fileOne.maxSelect = 10;

      saveCollection(app, collection);
    }

    // check view1 fields
    {
      const view1 = findCollectionByNameOrId(app, "view1");

      const relMany = view1.fields.getByName("rel_many") as RelationField;
      expect(Number(relMany.maxSelect)).toBe(1);

      const fileOne = view1.fields.getByName("file_one") as FileField;
      expect(Number(fileOne.maxSelect)).toBe(10);
    }

    // check view2 fields
    {
      const view2 = findCollectionByNameOrId(app, "view2");

      const relMany = view2.fields.getByName("rel_many") as RelationField;
      expect(Number(relMany.maxSelect)).toBe(1);
    }

    expect(app.logged).toEqual([]);
  });
});

describe("TestCollectionSaveViewWrapping", () => {
  const viewName = "test_wrapping";

  // note: some of the queries use "limit 0" because the tested field value could be empty
  // which will trigger the extra sample records validation that are not important for this test
  const scenarios: [name: string, query: string, expected: string][] = [
    [
      "no wrapping - id field",
      "select id, bool from demo1",
      "CREATE VIEW `test_wrapping` AS SELECT * FROM (select id, bool from demo1)",
    ],
    [
      "no wrapping - text field",
      "select text as id, bool from demo1 limit 0",
      "CREATE VIEW `test_wrapping` AS SELECT * FROM (select text as id, bool from demo1 limit 0)",
    ],
    [
      "no wrapping - relation field",
      "select rel_one as id, bool from demo1 limit 0",
      "CREATE VIEW `test_wrapping` AS SELECT * FROM (select rel_one as id, bool from demo1 limit 0)",
    ],
    [
      "no wrapping - select field",
      "select select_many as id, bool from demo1 limit 0",
      "CREATE VIEW `test_wrapping` AS SELECT * FROM (select select_many as id, bool from demo1 limit 0)",
    ],
    [
      "no wrapping - email field",
      "select email as id, bool from demo1 limit 0",
      "CREATE VIEW `test_wrapping` AS SELECT * FROM (select email as id, bool from demo1 limit 0)",
    ],
    [
      "no wrapping - datetime field",
      "select datetime as id, bool from demo1 limit 0",
      "CREATE VIEW `test_wrapping` AS SELECT * FROM (select datetime as id, bool from demo1 limit 0)",
    ],
    [
      "no wrapping - url field",
      "select url as id, bool from demo1 limit 0",
      "CREATE VIEW `test_wrapping` AS SELECT * FROM (select url as id, bool from demo1 limit 0)",
    ],
    [
      "wrapping - bool field",
      "select bool as id, text as txt, url from demo1 limit 0",
      "CREATE VIEW `test_wrapping` AS SELECT * FROM (SELECT CAST(`id` as TEXT) `id`,`txt`,`url` FROM (select bool as id, text as txt, url from demo1 limit 0))",
    ],
    [
      "wrapping - bool field (different order)",
      "select text as txt, url, bool as id from demo1 limit 0",
      "CREATE VIEW `test_wrapping` AS SELECT * FROM (SELECT `txt`,`url`,CAST(`id` as TEXT) `id` FROM (select text as txt, url, bool as id from demo1 limit 0))",
    ],
    [
      "wrapping - json field",
      "select json as id, text, url from demo1 limit 0",
      "CREATE VIEW `test_wrapping` AS SELECT * FROM (SELECT CAST(`id` as TEXT) `id`,`text`,`url` FROM (select json as id, text, url from demo1 limit 0))",
    ],
    [
      "wrapping - numeric id",
      "select 1 as id",
      "CREATE VIEW `test_wrapping` AS SELECT * FROM (SELECT CAST(`id` as TEXT) `id` FROM (select 1 as id))",
    ],
    [
      "wrapping - expresion",
      "select ('test') as id",
      "CREATE VIEW `test_wrapping` AS SELECT * FROM (SELECT CAST(`id` as TEXT) `id` FROM (select ('test') as id))",
    ],
    [
      "no wrapping - cast as text",
      "select cast('test' as text) as id",
      "CREATE VIEW `test_wrapping` AS SELECT * FROM (select cast('test' as text) as id)",
    ],
  ];

  for (const [name, query, expected] of scenarios) {
    test(name, () => {
      withApp((app) => {
        const collection = newViewCollection(viewName);
        collection.viewQuery = query;

        saveCollection(app, collection);

        const [sql] = app.databases
          .concurrentDB()
          .newQuery("SELECT sql FROM sqlite_master WHERE type='view' AND name={:name}")
          .bind({ name: viewName })
          .row();

        expect(sql).toBe(expected);
      });
    });
  }
});

test("TestCollectionSaveIndexesTableNameNormalization", () => {
  withApp((app) => {
    let dummyCollection = newBaseCollection("new_test");
    dummyCollection.fields.add(new TextField({ name: "test" }));
    dummyCollection.indexes = [
      "create index `new_test_idx1` on `` (`test`) where 1=1",
      "create index `new_test_idx2` on `test` (`test`) where 1=2",
      "create index `new_test_idx3` on `someting_else` (`test`) where 1=3",
    ];

    saveCollection(app, dummyCollection);

    // refetch a clean state
    dummyCollection = findCollectionByNameOrId(app, dummyCollection.name);

    expect(dummyCollection.indexes.length).toBe(3);

    for (const raw of dummyCollection.indexes) {
      expect(parseIndex(raw).tableName).toBe(dummyCollection.name);
    }
  });
});
