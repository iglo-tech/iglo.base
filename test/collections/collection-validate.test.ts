// Upstream: core/collection_validate_test.go (TestCollectionValidate)
//
// Each case runs on a fresh copy of the vendored fixture (openTestApp), as
// upstream's tests.NewTestApp does, and validates with validateCollection
// (app.Validate → onCollectionValidate).

import { describe } from "bun:test";

import {
  Collection,
  newAuthCollection,
  newBaseCollection,
  newViewCollection,
} from "@/collections/collection-model";
import { findCollectionByNameOrId } from "@/collections/collection-query";
import { saveCollection } from "@/collections/collection-save";
import { validateCollection } from "@/collections/collection-validate";
import { FieldsList, newFieldsList } from "@/collections/fields-list";
import { BoolField } from "@/fields/bool";
import { EmailField } from "@/fields/email";
import { PasswordField } from "@/fields/password";
import { TextField } from "@/fields/text";

import { openTestApp, type TestCollectionsApp } from "@test/collections/app";
import { type Pending, caseTest, expectValidationErrors } from "@test/collections/validation";

interface Scenario {
  name: string;
  collection: (app: TestCollectionsApp) => Collection;
  expectedErrors: string[];
  pending?: Pending;
}

const scenarios: Scenario[] = [
  {
    name: "empty collection",
    collection: () => new Collection(),
    expectedErrors: [
      "id",
      "name",
      "type",
      "fields", // no default fields because the type is unknown
    ],
  },
  {
    name: "unknown type with all invalid fields",
    collection: () => {
      const c = new Collection();
      c.id = "invalid_id ?!@#$";
      c.name = "invalid_name ?!@#$";
      c.type = "invalid_type";
      c.listRule = "missing = '123'";
      c.viewRule = "missing = '123'";
      c.createRule = "missing = '123'";
      c.updateRule = "missing = '123'";
      c.deleteRule = "missing = '123'";
      c.indexes = ["create index '' on '' ()"];

      // type specific fields
      c.viewQuery = "invalid"; // should be ignored
      c.authRule = "missing = '123'"; // should be ignored

      return c;
    },
    expectedErrors: [
      "id",
      "name",
      "type",
      "indexes",
      "listRule",
      "viewRule",
      "createRule",
      "updateRule",
      "deleteRule",
      "fields", // no default fields because the type is unknown
    ],
  },
  {
    name: "base with invalid fields",
    collection: () => {
      const c = newBaseCollection("invalid_name ?!@#$");
      c.indexes = ["create index '' on '' ()"];

      // type specific fields
      c.viewQuery = "invalid"; // should be ignored
      c.authRule = "missing = '123'"; // should be ignored

      return c;
    },
    expectedErrors: ["name", "indexes"],
  },
  {
    name: "view with invalid fields",
    collection: () => {
      const c = newViewCollection("invalid_name ?!@#$");
      c.indexes = ["create index '' on '' ()"];

      // type specific fields
      c.viewQuery = "invalid";
      c.authRule = "missing = '123'"; // should be ignored

      return c;
    },
    expectedErrors: ["indexes", "name", "fields", "viewQuery"],
  },
  {
    name: "auth with invalid fields",
    collection: () => {
      const c = newAuthCollection("invalid_name ?!@#$");
      c.indexes = ["create index '' on '' ()"];

      // type specific fields
      c.viewQuery = "invalid"; // should be ignored
      c.authRule = "missing = '123'";

      return c;
    },
    expectedErrors: ["indexes", "name", "authRule"],
  },

  // type checks
  {
    name: "empty type",
    collection: () => {
      const c = newBaseCollection("test");
      c.type = "";
      return c;
    },
    expectedErrors: ["type"],
  },
  {
    name: "unknown type",
    collection: () => {
      const c = newBaseCollection("test");
      c.type = "unknown";
      return c;
    },
    expectedErrors: ["type"],
  },
  {
    name: "base type",
    collection: () => newBaseCollection("test"),
    expectedErrors: [],
  },
  {
    name: "view type",
    collection: () => {
      const c = newViewCollection("test");
      c.viewQuery = "select 1 as id";
      return c;
    },
    expectedErrors: [],
  },
  {
    name: "auth type",
    collection: () => newAuthCollection("test"),
    expectedErrors: [],
  },
  {
    name: "changing type",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "users");
      c.type = "base"; // core.CollectionTypeBase
      return c;
    },
    expectedErrors: ["type"],
  },

  // system checks
  {
    name: "change from system to regular",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "_superusers"); // core.CollectionNameSuperusers
      c.system = false;
      return c;
    },
    expectedErrors: ["system"],
  },
  {
    name: "change from regular to system",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "demo1");
      c.system = true;
      return c;
    },
    expectedErrors: ["system"],
  },
  {
    name: "create system",
    collection: () => {
      const c = newBaseCollection("new_system");
      c.system = true;
      return c;
    },
    expectedErrors: [],
  },

  // id checks
  {
    name: "empty id",
    collection: () => {
      const c = newBaseCollection("test");
      c.id = "";
      return c;
    },
    expectedErrors: ["id"],
  },
  {
    name: "invalid id",
    collection: () => {
      const c = newBaseCollection("test");
      c.id = "!invalid";
      return c;
    },
    expectedErrors: ["id"],
  },
  {
    name: "existing id",
    collection: () => {
      const c = newBaseCollection("test");
      c.id = "_pb_users_auth_";
      return c;
    },
    expectedErrors: ["id"],
  },
  {
    name: "changing id",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "demo3");
      c.id = "anything";
      return c;
    },
    expectedErrors: ["id"],
  },
  {
    name: "valid id",
    collection: () => {
      const c = newBaseCollection("test");
      c.id = "anything";
      return c;
    },
    expectedErrors: [],
  },

  // name checks
  {
    name: "empty name",
    collection: () => {
      const c = newBaseCollection("");
      c.id = "test";
      return c;
    },
    expectedErrors: ["name"],
  },
  {
    name: "invalid name",
    collection: () => newBaseCollection("!invalid"),
    expectedErrors: ["name"],
  },
  {
    name: "name with _via_",
    collection: () => newBaseCollection("a_via_b"),
    expectedErrors: ["name"],
  },
  {
    name: "create with existing collection name",
    collection: () => newBaseCollection("demo1"),
    expectedErrors: ["name"],
  },
  {
    name: "create with existing internal table name",
    collection: () => newBaseCollection("_collections"),
    expectedErrors: ["name"],
  },
  {
    name: "update with existing collection name",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "users");
      c.name = "demo1";
      return c;
    },
    expectedErrors: ["name"],
  },
  {
    name: "update with existing internal table name",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "users");
      c.name = "_collections";
      return c;
    },
    expectedErrors: ["name"],
  },
  {
    name: "system collection name change",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "_superusers"); // core.CollectionNameSuperusers
      c.name = "superusers_new";
      return c;
    },
    expectedErrors: ["name"],
  },
  {
    name: "create with valid name",
    collection: () => newBaseCollection("new_col"),
    expectedErrors: [],
  },
  {
    name: "update with valid name",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "demo1");
      c.name = "demo1_new";
      return c;
    },
    expectedErrors: [],
  },

  // rule checks
  {
    name: "invalid base rules",
    collection: () => {
      const c = newBaseCollection("new");
      c.listRule = "!invalid";
      c.viewRule = "missing = 123";
      c.createRule = "id = 123 && missing = 456";
      c.updateRule = "@request.body.missing:changed = false";
      c.deleteRule = "(id=123";
      return c;
    },
    expectedErrors: ["listRule", "viewRule", "createRule", "updateRule", "deleteRule"],
  },
  {
    name: "valid base rules",
    collection: () => {
      const c = newBaseCollection("new");
      c.fields.add(new TextField({ name: "f1" })); // dummy field to ensure that new fields can be referenced
      c.listRule = "";
      c.viewRule = "f1 = 123";
      c.createRule = "id = 123 && f1 = 456";
      c.updateRule = "(id = 123 && @request.body.f1:changed = false)";
      c.deleteRule = "f1 = 123";
      return c;
    },
    expectedErrors: [],
  },
  {
    name: "view with non-nil create/update/delete rules",
    collection: () => {
      const c = newViewCollection("new");
      c.viewQuery = "select 1 as id, 'text' as f1";
      c.listRule = "id = 123";
      c.viewRule = "f1 = 456";
      c.createRule = "";
      c.updateRule = "";
      c.deleteRule = "";
      return c;
    },
    expectedErrors: ["createRule", "updateRule", "deleteRule"],
  },
  {
    name: "view with nil create/update/delete rules",
    collection: () => {
      const c = newViewCollection("new");
      c.viewQuery = "select 1 as id, 'text' as f1";
      c.listRule = "id = 1";
      c.viewRule = "f1 = 456";
      return c;
    },
    expectedErrors: [],
  },
  {
    name: "changing api rules",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "users");
      c.fields.add(new TextField({ name: "f1" })); // dummy field to ensure that new fields can be referenced
      c.listRule = "id = 1";
      c.viewRule = "f1 = 456";
      c.createRule = "id = 123 && f1 = 456";
      c.updateRule = "(id = 123)";
      c.deleteRule = "f1 = 123";
      return c;
    },
    expectedErrors: [],
  },
  {
    name: "changing system collection api rules",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "_superusers"); // core.CollectionNameSuperusers
      c.listRule = "1 = 1";
      c.viewRule = "1 = 1";
      c.createRule = "1 = 1";
      c.updateRule = "1 = 1";
      c.deleteRule = "1 = 1";
      c.manageRule = "1 = 1";
      c.authRule = "1 = 1";
      return c;
    },
    expectedErrors: [
      "listRule",
      "viewRule",
      "createRule",
      "updateRule",
      "deleteRule",
      "manageRule",
      "authRule",
    ],
  },

  // indexes checks
  {
    name: "invalid index expression",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "demo1");
      c.indexes = [
        "create index invalid",
        "create index idx_test_demo2 on anything (text)", // the name of table shouldn't matter
      ];
      return c;
    },
    expectedErrors: ["indexes"],
  },
  {
    name: "index name used in other table",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "demo1");
      c.indexes = [
        "create index `idx_test_demo1` on demo1 (id)",
        "create index `__pb_USERS_auth__username_idx` on anything (text)", // should be case-insensitive
      ];
      return c;
    },
    expectedErrors: ["indexes"],
  },
  {
    name: "duplicated index names",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "demo1");
      c.indexes = [
        "create index idx_test_demo1 on demo1 (id)",
        "create index idx_test_demo1 on anything (text)",
      ];
      return c;
    },
    expectedErrors: ["indexes"],
  },
  {
    name: "duplicated index definitions",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "demo1");
      c.indexes = [
        "create index idx_test_demo1 on demo1 (id)",
        "create index idx_test_demo2 on demo1 (id)",
      ];
      return c;
    },
    expectedErrors: ["indexes"],
  },
  {
    name: "try to add index to a view collection",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "view1");
      c.indexes = ["create index idx_test_view1 on view1 (id)"];
      return c;
    },
    expectedErrors: ["indexes"],
  },
  {
    name: "replace old with new indexes",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "demo1");
      c.indexes = [
        "create index idx_test_demo1 on demo1 (id)",
        "create index idx_test_demo2 on anything (text)", // the name of table shouldn't matter
      ];
      return c;
    },
    expectedErrors: [],
  },
  {
    name: "old + new indexes",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "demo1");
      c.indexes = [
        "CREATE INDEX `_wsmn24bux7wo113_created_idx` ON `demo1` (`created`)",
        "create index idx_test_demo1 on anything (id)",
      ];
      return c;
    },
    expectedErrors: [],
  },
  {
    name: "index for missing field",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "demo1");
      c.indexes = [
        "create index idx_test_demo1 on anything (missing)", // still valid because it is checked on db persist
      ];
      return c;
    },
    expectedErrors: [],
  },
  {
    name: "auth collection with missing required unique indexes",
    collection: () => {
      const c = newAuthCollection("new_auth");
      c.indexes = [];
      return c;
    },
    expectedErrors: ["indexes", "passwordAuth"],
  },
  {
    name: "auth collection with non-unique required indexes",
    collection: () => {
      const c = newAuthCollection("new_auth");
      c.indexes = [
        "create index test_idx1 on new_auth (tokenKey)",
        "create index test_idx2 on new_auth (email)",
      ];
      return c;
    },
    expectedErrors: ["indexes", "passwordAuth"],
  },
  {
    name: "auth collection with unique required indexes",
    collection: () => {
      const c = newAuthCollection("new_auth");
      c.indexes = [
        "create unique index test_idx1 on new_auth (tokenKey)",
        "create unique index test_idx2 on new_auth (email)",
      ];
      return c;
    },
    expectedErrors: [],
  },
  {
    name: "removing index on system field",
    collection: (app) => {
      let demo2 = findCollectionByNameOrId(app, "demo2");

      // mark the title field as system
      demo2.fields.getByName("title")!.setSystem(true);
      saveCollection(app, demo2);

      // refresh
      demo2 = findCollectionByNameOrId(app, "demo2");

      demo2.removeIndex("idx_unique_demo2_title");

      return demo2;
    },
    expectedErrors: ["indexes"],
  },
  {
    name: "changing partial constraint of existing index on system field",
    collection: (app) => {
      let demo2 = findCollectionByNameOrId(app, "demo2");

      // mark the title field as system
      demo2.fields.getByName("title")!.setSystem(true);
      saveCollection(app, demo2);

      // refresh
      demo2 = findCollectionByNameOrId(app, "demo2");

      // replace the index with a partial one
      demo2.removeIndex("idx_unique_demo2_title");
      demo2.addIndex("idx_new_demo2_title", true, "title", "1 = 1");

      return demo2;
    },
    expectedErrors: [],
  },
  {
    name: "changing column sort and collate of existing index on system field",
    collection: (app) => {
      let demo2 = findCollectionByNameOrId(app, "demo2");

      // mark the title field as system
      demo2.fields.getByName("title")!.setSystem(true);
      saveCollection(app, demo2);

      // refresh
      demo2 = findCollectionByNameOrId(app, "demo2");

      // replace the index with a new one for the same column but with collate and sort
      demo2.removeIndex("idx_unique_demo2_title");
      demo2.addIndex("idx_new_demo2_title", true, "title COLLATE test ASC", "");

      return demo2;
    },
    expectedErrors: [],
  },
  {
    name: "adding new column to index on system field",
    collection: (app) => {
      let demo2 = findCollectionByNameOrId(app, "demo2");

      // mark the title field as system
      demo2.fields.getByName("title")!.setSystem(true);
      saveCollection(app, demo2);

      // refresh
      demo2 = findCollectionByNameOrId(app, "demo2");

      // replace the index with a non-unique one
      demo2.removeIndex("idx_unique_demo2_title");
      demo2.addIndex("idx_new_title", false, "title, id", "");

      return demo2;
    },
    expectedErrors: ["indexes"],
  },
  {
    name: "changing index type on system field",
    collection: (app) => {
      let demo2 = findCollectionByNameOrId(app, "demo2");

      // mark the title field as system
      demo2.fields.getByName("title")!.setSystem(true);
      saveCollection(app, demo2);

      // refresh
      demo2 = findCollectionByNameOrId(app, "demo2");

      // replace the index with a non-unique one (partial constraints are ignored)
      demo2.removeIndex("idx_unique_demo2_title");
      demo2.addIndex("idx_new_title", false, "title", "1=1");

      return demo2;
    },
    expectedErrors: ["indexes"],
  },
  {
    name: "changing index on non-system field",
    collection: (app) => {
      const demo2 = findCollectionByNameOrId(app, "demo2");

      // replace the index with a partial one
      demo2.removeIndex("idx_demo2_active");
      demo2.addIndex("idx_demo2_active", true, "active", "1 = 1");

      return demo2;
    },
    expectedErrors: [],
  },

  // fields list checks
  {
    name: "empty fields",
    collection: () => {
      const c = newBaseCollection("new_auth");
      c.fields = new FieldsList(); // the minimum fields should auto added
      return c;
    },
    expectedErrors: ["fields"],
  },
  {
    name: "no id primay key field",
    collection: () => {
      const c = newBaseCollection("new_auth");
      c.fields = newFieldsList(new TextField({ name: "id" }));
      return c;
    },
    expectedErrors: ["fields"],
  },
  {
    name: "with id primay key field",
    collection: () => {
      const c = newBaseCollection("new_auth");
      c.fields = newFieldsList(
        new TextField({ name: "id", primaryKey: true, required: true, pattern: "\\w+" }),
      );
      return c;
    },
    expectedErrors: [],
  },
  {
    name: "duplicated field names",
    collection: () => {
      const c = newBaseCollection("new_auth");
      c.fields = newFieldsList(
        new TextField({ name: "id", primaryKey: true, required: true, pattern: "\\w+" }),
        new TextField({ id: "f1", name: "Test" }), // case-insensitive
        new BoolField({ id: "f2", name: "test" }),
      );
      return c;
    },
    expectedErrors: ["fields"],
  },
  {
    name: "changing field type",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "demo1");
      const f = c.fields.getByName("text")!;
      c.fields.add(new BoolField({ id: f.getId(), name: f.getName() }));
      return c;
    },
    expectedErrors: ["fields"],
  },
  {
    name: "renaming system field",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "_authOrigins"); // core.CollectionNameAuthOrigins
      const f = c.fields.getByName("fingerprint")!;
      f.setName("fingerprint_new");
      return c;
    },
    expectedErrors: ["fields"],
  },
  {
    name: "deleting system field",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "_authOrigins"); // core.CollectionNameAuthOrigins
      c.fields.removeByName("fingerprint");
      return c;
    },
    expectedErrors: ["fields"],
  },
  {
    name: "invalid field setting",
    collection: () => {
      const c = newBaseCollection("test_new");
      c.fields.add(new TextField({ name: "f1", min: -10 }));
      return c;
    },
    expectedErrors: ["fields"],
  },
  {
    name: "valid field setting",
    collection: () => {
      const c = newBaseCollection("test_new");
      c.fields.add(new TextField({ name: "f1", min: 10 }));
      return c;
    },
    expectedErrors: [],
  },
  {
    name: "fields view changes should be ignored",
    collection: (app) => {
      const c = findCollectionByNameOrId(app, "view1");
      c.fields = new FieldsList();
      return c;
    },
    expectedErrors: [],
  },
  {
    name: "with reserved auth only field name (passwordConfirm)",
    collection: () => {
      const c = newAuthCollection("new_auth");
      c.fields.add(new TextField({ name: "passwordConfirm" }));
      return c;
    },
    expectedErrors: ["fields"],
  },
  {
    name: "with reserved auth only field name (oldPassword)",
    collection: () => {
      const c = newAuthCollection("new_auth");
      c.fields.add(new TextField({ name: "oldPassword" }));
      return c;
    },
    expectedErrors: ["fields"],
  },
  {
    name: "with invalid password auth field options (1)",
    collection: () => {
      const c = newAuthCollection("new_auth");
      c.fields.add(
        new TextField({ name: "password", system: true, hidden: true }), // should be PasswordField
      );
      return c;
    },
    expectedErrors: ["fields"],
  },
  {
    name: "with valid password auth field options (2)",
    collection: () => {
      const c = newAuthCollection("new_auth");
      c.fields.add(new PasswordField({ name: "password", system: true, hidden: true }));
      return c;
    },
    expectedErrors: [],
  },
  {
    name: "with invalid tokenKey auth field options (1)",
    collection: () => {
      const c = newAuthCollection("new_auth");
      c.fields.add(
        new TextField({ name: "tokenKey", system: true }), // should be also hidden
      );
      return c;
    },
    expectedErrors: ["fields"],
  },
  {
    name: "with valid tokenKey auth field options (2)",
    collection: () => {
      const c = newAuthCollection("new_auth");
      c.fields.add(new TextField({ name: "tokenKey", system: true, hidden: true }));
      return c;
    },
    expectedErrors: [],
  },
  {
    name: "with invalid email auth field options (1)",
    collection: () => {
      const c = newAuthCollection("new_auth");
      c.fields.add(
        new TextField({ name: "email", system: true }), // should be EmailField
      );
      return c;
    },
    expectedErrors: ["fields"],
  },
  {
    name: "with valid email auth field options (2)",
    collection: () => {
      const c = newAuthCollection("new_auth");
      c.fields.add(new EmailField({ name: "email", system: true }));
      return c;
    },
    expectedErrors: [],
  },
  {
    name: "with invalid verified auth field options (1)",
    collection: () => {
      const c = newAuthCollection("new_auth");
      c.fields.add(
        new TextField({ name: "verified", system: true }), // should be BoolField
      );
      return c;
    },
    expectedErrors: ["fields"],
  },
  {
    name: "with valid verified auth field options (2)",
    collection: () => {
      const c = newAuthCollection("new_auth");
      c.fields.add(new BoolField({ name: "verified", system: true }));
      return c;
    },
    expectedErrors: [],
  },
];

describe("TestCollectionValidate", () => {
  for (const s of scenarios) {
    caseTest(s.name, s.pending, () => {
      const app = openTestApp();
      try {
        const collection = s.collection(app);

        const result = validateCollection(app, collection);

        expectValidationErrors(result, s.expectedErrors);
      } finally {
        app.cleanup();
      }
    });
  }
});
