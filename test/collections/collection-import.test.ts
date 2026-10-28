// Upstream: core/collection_import_test.go
//
// Nothing is left out. Each scenario runs on its own copy of the vendored
// fixture (openTestApp, as tests.NewTestApp). The import data is the Go
// map values as they are marshaled, so Go's nil is null.

import { describe, expect, test } from "bun:test";

import { Collection } from "@/collections/collection-model";
import { collectionQuery, findCollectionByNameOrId } from "@/collections/collection-query";
import {
  importCollections,
  importCollectionsByMarshaledJSON,
} from "@/collections/collection-import";
import { HashExp } from "@/db/dbx/expression";

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

// the collections of the fixture, split by the system flag (upstream's
// regularCollections / systemCollections)
function countCollections(app: TestCollectionsApp): { regular: number; system: number } {
  const regular = collectionQuery(app)
    .andWhere(new HashExp({ system: false }))
    .all<Collection>(() => new Collection());
  const system = collectionQuery(app)
    .andWhere(new HashExp({ system: true }))
    .all<Collection>(() => new Collection());

  return { regular: regular.length, system: system.length };
}

describe("TestImportCollections", () => {
  const counts = (() => {
    const app = openTestApp();
    try {
      return countCollections(app);
    } finally {
      app.cleanup();
    }
  })();

  const totalRegularCollections = counts.regular;
  const totalSystemCollections = counts.system;
  const totalCollections = totalRegularCollections + totalSystemCollections;

  const scenarios: {
    name: string;
    data: Record<string, unknown>[];
    deleteMissing: boolean;
    expectError: boolean;
    expectCollectionsCount: number;
    afterTestFunc?: (app: TestCollectionsApp) => void;
  }[] = [
    {
      name: "empty collections",
      data: [],
      deleteMissing: false,
      expectError: true,
      expectCollectionsCount: totalCollections,
    },
    {
      name: "minimal collection import (with missing system fields)",
      data: [
        { name: "import_test1", type: "auth" },
        {
          name: "import_test2",
          fields: [{ name: "test", type: "text" }],
        },
      ],
      deleteMissing: false,
      expectError: false,
      expectCollectionsCount: totalCollections + 2,
    },
    {
      name: "minimal collection import (trigger collection model validations)",
      data: [
        { name: "" },
        {
          name: "import_test2",
          fields: [{ name: "test", type: "text" }],
        },
      ],
      deleteMissing: false,
      expectError: true,
      expectCollectionsCount: totalCollections,
    },
    {
      name: "minimal collection import (trigger field settings validation)",
      data: [{ name: "import_test", fields: [{ name: "test", type: "text", min: -1 }] }],
      deleteMissing: false,
      expectError: true,
      expectCollectionsCount: totalCollections,
    },
    {
      name: "new + update + delete (system collections delete should be ignored)",
      data: [
        {
          id: "wsmn24bux7wo113",
          name: "demo",
          fields: [
            {
              id: "_2hlxbmp",
              name: "title",
              type: "text",
              system: false,
              required: true,
              min: 3,
              max: null,
              pattern: "",
            },
          ],
          indexes: [],
        },
        {
          name: "import1",
          fields: [
            {
              name: "active",
              type: "bool",
            },
          ],
        },
      ],
      deleteMissing: true,
      expectError: false,
      expectCollectionsCount: totalSystemCollections + 2,
    },
    {
      name: "test with deleteMissing: false",
      data: [
        {
          // id: "wsmn24bux7wo113", // test update with only name as identifier
          name: "demo1",
          fields: [
            {
              id: "_2hlxbmp",
              name: "title",
              type: "text",
              system: false,
              required: true,
              min: 3,
              max: null,
              pattern: "",
            },
            {
              id: "_2hlxbmp",
              name: "field_with_duplicate_id",
              type: "text",
              system: false,
              required: true,
              unique: false,
              min: 4,
              max: null,
              pattern: "",
            },
            {
              id: "abcd_import",
              name: "new_field",
              type: "text",
            },
          ],
        },
        {
          name: "new_import",
          fields: [
            {
              id: "abcd_import",
              name: "active",
              type: "bool",
            },
          ],
        },
      ],
      deleteMissing: false,
      expectError: false,
      expectCollectionsCount: totalCollections + 1,
      afterTestFunc: (app) => {
        const expectedCollectionFields: Record<string, number> = {
          _authOrigins: 6,
          nologin: 10,
          demo1: 19,
          demo2: 5,
          demo3: 5,
          demo4: 16,
          demo5: 9,
          new_import: 2,
        };
        for (const [name, expectedCount] of Object.entries(expectedCollectionFields)) {
          const collection = findCollectionByNameOrId(app, name);

          expect({ name, fields: collection.fields.length }).toEqual({
            name,
            fields: expectedCount,
          });
        }
      },
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const app = openTestApp();

      try {
        const err = errorOf(() => importCollections(app, s.data, s.deleteMissing));

        const hasErr = err !== null;
        if (hasErr !== s.expectError) {
          throw new Error(
            `Expected hasErr to be ${s.expectError}, got ${hasErr} (${err?.message ?? "nil"})`,
          );
        }

        // check collections count
        const collections = collectionQuery(app).all<Collection>(() => new Collection());
        expect(collections).toHaveLength(s.expectCollectionsCount);

        s.afterTestFunc?.(app);
      } finally {
        app.cleanup();
      }
    });
  }
});

describe("TestImportCollectionsByMarshaledJSON", () => {
  const counts = (() => {
    const app = openTestApp();
    try {
      return countCollections(app);
    } finally {
      app.cleanup();
    }
  })();

  const totalRegularCollections = counts.regular;
  const totalSystemCollections = counts.system;
  const totalCollections = totalRegularCollections + totalSystemCollections;

  const scenarios: {
    name: string;
    data: string;
    deleteMissing: boolean;
    expectError: boolean;
    expectCollectionsCount: number;
    afterTestFunc?: (app: TestCollectionsApp) => void;
  }[] = [
    {
      name: "invalid json array",
      data: `{"test":123}`,
      deleteMissing: false,
      expectError: true,
      expectCollectionsCount: totalCollections,
    },
    {
      name: "new + update + delete (system collections delete should be ignored)",
      data: `[
				{
					"id":   "wsmn24bux7wo113",
					"name": "demo",
					"fields": [
						{
							"id":       "_2hlxbmp",
							"name":     "title",
							"type":     "text",
							"system":   false,
							"required": true,
							"min":      3,
							"max":      null,
							"pattern":  ""
						}
					],
					"indexes": []
				},
				{
					"name": "import1",
					"fields": [
						{
							"name": "active",
							"type": "bool"
						}
					]
				}
			]`,
      deleteMissing: true,
      expectError: false,
      expectCollectionsCount: totalSystemCollections + 2,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const app = openTestApp();

      try {
        const err = errorOf(() => importCollectionsByMarshaledJSON(app, s.data, s.deleteMissing));

        const hasErr = err !== null;
        if (hasErr !== s.expectError) {
          throw new Error(
            `Expected hasErr to be ${s.expectError}, got ${hasErr} (${err?.message ?? "nil"})`,
          );
        }

        // check collections count
        const collections = collectionQuery(app).all<Collection>(() => new Collection());
        expect(collections).toHaveLength(s.expectCollectionsCount);

        s.afterTestFunc?.(app);
      } finally {
        app.cleanup();
      }
    });
  }
});

describe("TestImportCollectionsUpdateRules", () => {
  const scenarios: {
    name: string;
    data: Record<string, unknown>;
    deleteMissing: boolean;
  }[] = [
    {
      name: "extend existing by name (without deleteMissing)",
      data: {
        name: "clients",
        authToken: { duration: 100 },
        fields: [{ name: "test", type: "text" }],
      },
      deleteMissing: false,
    },
    {
      name: "extend existing by id (without deleteMissing)",
      data: {
        id: "v851q4r790rhknl",
        authToken: { duration: 100 },
        fields: [{ name: "test", type: "text" }],
      },
      deleteMissing: false,
    },
    {
      name: "extend with delete missing",
      data: {
        id: "v851q4r790rhknl",
        authToken: { duration: 100 },
        fields: [{ name: "test", type: "text" }],
        passwordAuth: { identityFields: ["email"] },
        indexes: [
          // min required system fields indexes
          "CREATE UNIQUE INDEX `_v851q4r790rhknl_email_idx` ON `clients` (email) WHERE email != ''",
          "CREATE UNIQUE INDEX `_v851q4r790rhknl_tokenKey_idx` ON `clients` (tokenKey)",
        ],
      },
      deleteMissing: true,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const app = openTestApp();

      try {
        const beforeCollection = findCollectionByNameOrId(app, "clients");

        importCollections(app, [s.data], s.deleteMissing);

        const afterCollection = findCollectionByNameOrId(app, "clients");

        expect(Number(afterCollection.authToken.duration)).toBe(100);
        expect(afterCollection.authToken.secret).toBe(beforeCollection.authToken.secret);
        expect(afterCollection.name).toBe(beforeCollection.name);
        expect(afterCollection.id).toBe(beforeCollection.id);

        if (!s.deleteMissing) {
          const totalExpectedFields = beforeCollection.fields.length + 1;
          expect(afterCollection.fields.length).toBe(totalExpectedFields);

          expect(afterCollection.fields.getByName("test")).not.toBeNull();

          // ensure that the old fields still exist
          for (const name of beforeCollection.fields.fieldNames()) {
            expect(afterCollection.fields.getByName(name)).not.toBeNull();
          }
        } else {
          let totalExpectedFields = 1;
          for (const f of beforeCollection.fields) {
            if (f.getSystem()) {
              totalExpectedFields++;
            }
          }

          expect(afterCollection.fields.length).toBe(totalExpectedFields);

          expect(afterCollection.fields.getByName("test")).not.toBeNull();

          // ensure that the old system fields still exist
          for (const f of beforeCollection.fields) {
            if (f.getSystem()) {
              expect(afterCollection.fields.getByName(f.getName())).not.toBeNull();
            }
          }
        }
      } finally {
        app.cleanup();
      }
    });
  }
});

describe("TestImportCollectionsCreateRules", () => {
  test("a created auth collection gets its system fields, indexes and token duration", () => {
    const app = openTestApp();

    try {
      importCollections(
        app,
        [
          {
            name: "new_test",
            type: "auth",
            authToken: { duration: 123 },
            fields: [{ name: "test", type: "text" }],
          },
        ],
        false,
      );

      const collection = findCollectionByNameOrId(app, "new_test");

      const rawStr = collection.marshalJSON();

      const expectedParts = [
        `"name":"new_test"`,
        `"fields":[`,
        `"name":"id"`,
        `"name":"email"`,
        `"name":"tokenKey"`,
        `"name":"password"`,
        `"name":"test"`,
        `"indexes":[`,
        `CREATE UNIQUE INDEX`,
        `"duration":123`,
      ];

      for (const part of expectedParts) {
        expect({ part, found: rawStr.includes(part) }).toEqual({ part, found: true });
      }
    } finally {
      app.cleanup();
    }
  });
});
