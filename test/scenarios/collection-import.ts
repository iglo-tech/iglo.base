// Upstream: apis/collection_import_test.go (TestCollectionsImport)
//
// The tokens are upstream's fixture tokens (test data, expiring in 2050).
// Not ported (only tests an upstream hook, the tx body write check scenarios):
//   - TestCollectionsImport: OnCollectionsImportRequest tx body write check
// "non-validator failure" makes the import fail with an OnCollectionCreate
// hook error upstream; here the failure is a db error instead (a plain
// table named like the first imported collection, so its CREATE TABLE
// fails), and the expected `custom_error` text is that error's.

import {
  collectionsCount,
  createPlainTable,
  tableIndexesAre,
} from "@test/scenarios/collection-checks";
import { checks } from "@test/scenarios/record-checks";
import { superuserToken, usersToken } from "@test/scenarios/record-crud";
import type { Suite } from "@test/scenarios/scenario";

// the fixture's collections
const totalCollections = 16;

export const collectionsImport: Suite = {
  file: "apis/collection_import_test.go",
  func: "TestCollectionsImport",
  scenarios: [
    {
      name: "unauthorized",
      method: "PUT",
      url: "/api/collections/import",
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method: "PUT",
      url: "/api/collections/import",
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser + empty collections",
      method: "PUT",
      url: "/api/collections/import",
      body: `{"collections":[]}`,
      headers: { Authorization: superuserToken },
      after: collectionsCount(totalCollections),
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"collections":{"code":"validation_required"`],
    },
    {
      name: "authorized as superuser + collections validator failure",
      method: "PUT",
      url: "/api/collections/import",
      body: `{
				"collections":[
					{"name": "import1"},
					{
						"name": "import2",
						"fields": [
							{
							  "id": "koih1lqx",
							  "name": "expand",
							  "type": "text"
							}
						]
					}
				]
			}`,
      headers: { Authorization: superuserToken },
      after: collectionsCount(totalCollections),
      expectedStatus: 400,
      expectedContent: [
        `"data":{`,
        `"collections":{"code":"validation_collections_import_failure"`,
        `import2`,
        `fields`,
      ],
      notExpectedContent: [`Raw error:`],
    },
    {
      name: "authorized as superuser + non-validator failure",
      method: "PUT",
      url: "/api/collections/import",
      body: `{
				"collections":[
					{
						"name": "import1",
						"fields": [
							{
							  "id": "koih1lqx",
							  "name": "test",
							  "type": "text"
							}
						]
					},
					{
						"name": "import2",
						"fields": [
							{
							  "id": "koih1lqx",
							  "name": "test",
							  "type": "text"
							}
						],
						"indexes": [
							"create index idx_test on import2 (test)"
						]
					}
				]
			}`,
      headers: { Authorization: superuserToken },
      // the OnCollectionCreate hook error is a db error here: a plain
      // table named like the first imported collection
      prepare: createPlainTable("import1"),
      after: collectionsCount(totalCollections),
      expectedStatus: 400,
      expectedContent: [
        `"data":{`,
        `"collections":{"code":"validation_collections_import_failure"`,
        `Raw error:`,
        `table`,
        `already exists`,
      ],
    },
    {
      name: "authorized as superuser + successful collections create",
      method: "PUT",
      url: "/api/collections/import",
      body: `{
				"collections":[
					{
						"name": "import1",
						"fields": [
							{
							  "id": "koih1lqx",
							  "name": "test",
							  "type": "text"
							}
						]
					},
					{
						"name": "import2",
						"fields": [
							{
							  "id": "koih1lqx",
							  "name": "test",
							  "type": "text"
							}
						],
						"indexes": [
							"create index idx_test on import2 (test)"
						]
					},
					{
						"name": "auth_without_fields",
						"type": "auth"
					}
				]
			}`,
      headers: { Authorization: superuserToken },
      after: checks(collectionsCount(totalCollections + 3), tableIndexesAre("import2", "idx_test")),
      expectedStatus: 204,
    },
    {
      name: "authorized as superuser + create/update/delete",
      method: "PUT",
      url: "/api/collections/import",
      body: `{
				"deleteMissing": true,
				"collections":[
					{"name": "test123"},
					{
						"id":"wsmn24bux7wo113",
						"name":"demo1",
						"fields":[
							{
								"id":"_2hlxbmp",
								"name":"title",
								"type":"text",
								"required":true
							}
						],
						"indexes": []
					}
				]
			}`,
      headers: { Authorization: superuserToken },
      after: collectionsCount((systemCollections) => systemCollections + 2),
      expectedStatus: 204,
    },
  ],
};
