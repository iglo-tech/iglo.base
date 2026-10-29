// Upstream: apis/collection_test.go (TestCollectionsList, TestCollectionView, TestCollectionDelete,
// TestCollectionCreate, TestCollectionUpdate, TestCollectionScaffolds, TestCollectionTruncate,
// TestCollectionOAuth2Providers, TestCollectionTestView)
//
// The tokens are upstream's fixture tokens (test data, expiring in 2050).
// Not ported (only tests an upstream hook, the tx body write check scenarios):
//   - TestCollectionsList: OnCollectionsListRequest tx body write check
//   - TestCollectionView: OnCollectionViewRequest tx body write check
//   - TestCollectionDelete: OnCollectionDeleteRequest tx body write check
//   - TestCollectionCreate: OnCollectionCreateRequest tx body write check
//   - TestCollectionUpdate: OnCollectionUpdateRequest tx body write check

import {
  addDemo1Index,
  collectionFilesDeleted,
  oauth2ProvidersAre,
  tableExists,
  tableIndexesAre,
} from "@test/scenarios/collection-checks";
import { superuserToken, usersToken } from "@test/scenarios/record-crud";
import type { Suite } from "@test/scenarios/scenario";

export const collectionsList: Suite = {
  file: "apis/collection_test.go",
  func: "TestCollectionsList",
  scenarios: [
    {
      name: "unauthorized",
      method: "GET",
      url: "/api/collections",
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method: "GET",
      url: "/api/collections",
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser",
      method: "GET",
      url: "/api/collections",
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalItems":16`,
        `"items":[{`,
        `"name":"_superusers"`,
        `"name":"_authOrigins"`,
        `"name":"_externalAuths"`,
        `"name":"_mfas"`,
        `"name":"_otps"`,
        `"name":"users"`,
        `"name":"nologin"`,
        `"name":"clients"`,
        `"name":"demo1"`,
        `"name":"demo2"`,
        `"name":"demo3"`,
        `"name":"demo4"`,
        `"name":"demo5"`,
        `"name":"numeric_id_view"`,
        `"name":"view1"`,
        `"name":"view2"`,
        `"type":"auth"`,
        `"type":"base"`,
        `"type":"view"`,
      ],
    },
    {
      name: "authorized as superuser + paging and sorting",
      method: "GET",
      url: "/api/collections?page=2&perPage=2&sort=-created",
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [
        `"page":2`,
        `"perPage":2`,
        `"totalItems":16`,
        `"items":[{`,
        `"name":"_mfas"`,
      ],
    },
    {
      name: "authorized as superuser + invalid filter",
      method: "GET",
      url: "/api/collections?filter=invalidfield~'demo2'",
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser + valid filter",
      method: "GET",
      url: "/api/collections?filter=name~'demo'",
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalItems":5`,
        `"items":[{`,
        `"name":"demo1"`,
        `"name":"demo2"`,
        `"name":"demo3"`,
        `"name":"demo4"`,
        `"name":"demo5"`,
      ],
    },
  ],
};

export const collectionView: Suite = {
  file: "apis/collection_test.go",
  func: "TestCollectionView",
  scenarios: [
    {
      name: "unauthorized",
      method: "GET",
      url: "/api/collections/demo1",
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method: "GET",
      url: "/api/collections/demo1",
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser + nonexisting collection identifier",
      method: "GET",
      url: "/api/collections/missing",
      headers: { Authorization: superuserToken },
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser + using the collection name",
      method: "GET",
      url: "/api/collections/demo1",
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [`"id":"wsmn24bux7wo113"`, `"name":"demo1"`],
    },
    {
      name: "authorized as superuser + using the collection id",
      method: "GET",
      url: "/api/collections/wsmn24bux7wo113",
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [`"id":"wsmn24bux7wo113"`, `"name":"demo1"`],
    },
  ],
};

export const collectionDelete: Suite = {
  file: "apis/collection_test.go",
  func: "TestCollectionDelete",
  scenarios: [
    {
      name: "unauthorized",
      method: "DELETE",
      url: "/api/collections/demo1",
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method: "DELETE",
      url: "/api/collections/demo1",
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser + nonexisting collection identifier",
      method: "DELETE",
      url: "/api/collections/missing",
      headers: { Authorization: superuserToken },
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser + using the collection name",
      method: "DELETE",
      url: "/api/collections/demo5",
      headers: { Authorization: superuserToken },
      delayMs: 100,
      after: collectionFilesDeleted("9n89pl5vkct6330"),
      expectedStatus: 204,
    },
    {
      name: "authorized as superuser + using the collection id",
      method: "DELETE",
      url: "/api/collections/9n89pl5vkct6330",
      headers: { Authorization: superuserToken },
      delayMs: 100,
      after: collectionFilesDeleted("9n89pl5vkct6330"),
      expectedStatus: 204,
    },
    {
      name: "authorized as superuser + trying to delete a system collection",
      method: "DELETE",
      url: "/api/collections/_mfas",
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser + trying to delete a referenced collection",
      method: "DELETE",
      url: "/api/collections/demo2",
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser + deleting a view",
      method: "DELETE",
      url: "/api/collections/view2",
      headers: { Authorization: superuserToken },
      expectedStatus: 204,
    },
  ],
};

export const collectionCreate: Suite = {
  file: "apis/collection_test.go",
  func: "TestCollectionCreate",
  scenarios: [
    {
      name: "unauthorized",
      method: "POST",
      url: "/api/collections",
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method: "POST",
      url: "/api/collections",
      body: `{"name":"new","type":"base","fields":[{"type":"text","name":"test"}]}`,
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser + empty data",
      method: "POST",
      url: "/api/collections",
      body: ``,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"name":{"code":"validation_required"`],
      notExpectedContent: [`"fields":{`],
    },
    {
      name: "authorized as superuser + invalid data (eg. existing name)",
      method: "POST",
      url: "/api/collections",
      body: `{"name":"demo1","type":"base","fields":[{"type":"text","name":""}]}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [
        `"data":{`,
        `"fields":{`,
        `"name":{"code":"validation_collection_name_exists"`,
        `"name":{"code":"validation_required"`,
      ],
    },
    {
      name: "authorized as superuser + valid data",
      method: "POST",
      url: "/api/collections",
      body: `{"name":"new","type":"base","fields":[{"type":"text","id":"12345789","name":"test"}]}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [
        `"id":`,
        `"name":"new"`,
        `"type":"base"`,
        `"system":false`,
        `"fields":[{"autogeneratePattern":"[a-z0-9]{15}","help":"","hidden":false,"id":"text3208210256","max":15,"min":15,"name":"id","pattern":"^[a-z0-9]+$","presentable":false,"primaryKey":true,"required":true,"system":true,"type":"text"},{"autogeneratePattern":"","help":"","hidden":false,"id":"12345789","max":0,"min":0,"name":"test","pattern":"","presentable":false,"primaryKey":false,"required":false,"system":false,"type":"text"}]`,
      ],
    },
    {
      name: "creating auth collection (default settings merge test)",
      method: "POST",
      url: "/api/collections",
      body: `{
				"name":"new",
				"type":"auth",
				"emailChangeToken":{"duration":123},
				"fields":[
					{"type":"text","id":"12345789","name":"test"},
					{"type":"text","name":"tokenKey","system":true,"required":false,"min":10}
				]
			}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [
        `"id":`,
        `"name":"new"`,
        `"type":"auth"`,
        `"system":false`,
        `"passwordAuth":{"enabled":true,"identityFields":["email"]}`,
        `"authRule":""`,
        `"manageRule":null`,
        `"name":"test"`,
        `"name":"id"`,
        `"name":"tokenKey"`,
        `"name":"password"`,
        `"name":"email"`,
        `"name":"emailVisibility"`,
        `"name":"verified"`,
        `"duration":123`,
        `{"autogeneratePattern":"","help":"","hidden":true,"id":"text2504183744","max":0,"min":10,"name":"tokenKey","pattern":"","presentable":false,"primaryKey":false,"required":true,"system":true,"type":"text"}`,
      ],
      notExpectedContent: [`"secret":"`],
    },
    {
      name: "creating base collection with reserved auth fields",
      method: "POST",
      url: "/api/collections",
      body: `{
				"name":"new",
				"type":"base",
				"fields":[
					{"type":"text","name":"email"},
					{"type":"text","name":"username"},
					{"type":"text","name":"verified"},
					{"type":"text","name":"emailVisibility"},
					{"type":"text","name":"lastResetSentAt"},
					{"type":"text","name":"lastVerificationSentAt"},
					{"type":"text","name":"tokenKey"},
					{"type":"text","name":"passwordHash"},
					{"type":"text","name":"password"},
					{"type":"text","name":"passwordConfirm"},
					{"type":"text","name":"oldPassword"}
				]
			}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [`"name":"new"`, `"type":"base"`, `"fields":[{`],
    },
    {
      name: "trying to create base collection with reserved system fields",
      method: "POST",
      url: "/api/collections",
      body: `{
				"name":"new",
				"type":"base",
				"fields":[
					{"type":"text","name":"id"},
					{"type":"text","name":"expand"},
					{"type":"text","name":"collectionId"},
					{"type":"text","name":"collectionName"}
				]
			}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [
        `"data":{"fields":{`,
        `"1":{"name":{"code":"validation_not_in_invalid`,
        `"2":{"name":{"code":"validation_not_in_invalid`,
        `"3":{"name":{"code":"validation_not_in_invalid`,
      ],
    },
    {
      name: "trying to create auth collection with reserved auth fields",
      method: "POST",
      url: "/api/collections",
      body: `{
				"name":"new",
				"type":"auth",
				"fields":[
					{"type":"text","name":"oldPassword"},
					{"type":"text","name":"passwordConfirm"}
				]
			}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [
        `"data":{"fields":{`,
        `"1":{"name":{"code":"validation_reserved_field_name`,
        `"2":{"name":{"code":"validation_reserved_field_name`,
      ],
    },
    {
      name: "trying to create view collection with invalid options",
      method: "POST",
      url: "/api/collections",
      body: `{
				"name":"new",
				"type":"view",
				"fields":[{"type":"text","id":"12345789","name":"ignored!@#$"}],
				"viewQuery":"select '123' as abc"
			}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"viewQuery":{"code":"validation_invalid_view_query`],
    },
    {
      name: "creating view collection",
      method: "POST",
      url: "/api/collections",
      body: `{
				"name":"new",
				"type":"view",
				"fields":[{"type":"text","id":"12345789","name":"ignored!@#$"}],
				"viewQuery": "select 1 as id from _superusers limit 1"
			}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [
        `"name":"new"`,
        `"type":"view"`,
        `"fields":[{"autogeneratePattern":"","help":"","hidden":false,"id":"text3208210256","max":0,"min":0,"name":"id","pattern":"^[a-z0-9]+$","presentable":false,"primaryKey":true,"required":true,"system":true,"type":"text"}]`,
      ],
    },
    {
      name: "creating base collection with invalid indexes",
      method: "POST",
      url: "/api/collections",
      body: `{
				"name":"new",
				"type":"base",
				"fields":[
					{"type":"text","name":"test"}
				],
				"indexes": [
					"create index idx_test1 on new (test)",
					"create index idx_test2 on new (missing)"
				]
			}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"indexes":{"1":{"code":"`],
    },
    {
      name: "creating base collection with index name from another collection",
      method: "POST",
      url: "/api/collections",
      body: `{
				"name":"new",
				"type":"base",
				"fields":[
					{"type":"text","name":"test"}
				],
				"indexes": [
					"create index exist_test on new (test)"
				]
			}`,
      headers: { Authorization: superuserToken },
      prepare: addDemo1Index("exist_test"),
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"indexes":{`, `"0":{"code":"validation_existing_index_name"`],
    },
    {
      name: "creating base collection with 2 indexes using the same name",
      method: "POST",
      url: "/api/collections",
      body: `{
				"name":"new",
				"type":"base",
				"indexes": [
					"create index duplicate_idx on new (created)",
					"create index duplicate_idx on new (updated)"
				]
			}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [
        `"data":{`,
        `"indexes":{`,
        `"1":{"code":"validation_duplicated_index_name"`,
      ],
    },
    {
      name: "creating base collection with valid indexes (+ random table name)",
      method: "POST",
      url: "/api/collections",
      body: `{
				"name":"new",
				"type":"base",
				"fields":[
					{"type":"text","name":"test"}
				],
				"indexes": [
					"create index idx_test1 on new (test)",
					"create index idx_test2 on anything (id, test)"
				]
			}`,
      headers: { Authorization: superuserToken },
      after: tableIndexesAre("new", "idx_test1", "idx_test2"),
      expectedStatus: 200,
      expectedContent: [`"name":"new"`, `"type":"base"`, `"indexes":[`, `idx_test1`, `idx_test2`],
    },
  ],
};

export const collectionUpdate: Suite = {
  file: "apis/collection_test.go",
  func: "TestCollectionUpdate",
  scenarios: [
    {
      name: "unauthorized",
      method: "PATCH",
      url: "/api/collections/demo1",
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method: "PATCH",
      url: "/api/collections/demo1",
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser + missing collection",
      method: "PATCH",
      url: "/api/collections/missing",
      body: `{}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser + empty body",
      method: "PATCH",
      url: "/api/collections/demo1",
      body: `{}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [`"id":"wsmn24bux7wo113"`, `"name":"demo1"`],
    },
    {
      name: "authorized as superuser + invalid data (eg. existing name)",
      method: "PATCH",
      url: "/api/collections/demo1",
      body: `{
				"name":"demo2",
				"type":"auth"
			}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [
        `"data":{`,
        `"name":{"code":"validation_collection_name_exists"`,
        `"type":{"code":"validation_collection_type_change"`,
      ],
    },
    {
      name: "authorized as superuser + valid data",
      method: "PATCH",
      url: "/api/collections/demo1",
      body: `{"name":"new"}`,
      headers: { Authorization: superuserToken },
      after: tableExists("new"),
      expectedStatus: 200,
      expectedContent: [`"id":`, `"name":"new"`],
    },
    {
      name: "trying to update collection with reserved fields",
      method: "PATCH",
      url: "/api/collections/demo1",
      body: `{
				"name":"new",
				"fields":[
					{"type":"text","name":"id","id":"_pbf_text_id_"},
					{"type":"text","name":"created"},
					{"type":"text","name":"updated"},
					{"type":"text","name":"expand"},
					{"type":"text","name":"collectionId"},
					{"type":"text","name":"collectionName"}
				]
			}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [
        `"data":{"fields":{`,
        `"3":{"name":{"code":"validation_not_in_invalid`,
        `"4":{"name":{"code":"validation_not_in_invalid`,
        `"5":{"name":{"code":"validation_not_in_invalid`,
      ],
      notExpectedContent: [`"0":`, `"1":`, `"2":`],
    },
    {
      name: "trying to update collection with changed/removed system fields",
      method: "PATCH",
      url: "/api/collections/demo1",
      body: `{
				"name":"new",
				"fields":[
					{"type":"text","name":"created"}
				]
			}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{"fields":{`, `"code":"validation_system_field_change"`],
    },
    {
      name: "trying to update auth collection with invalid options",
      method: "PATCH",
      url: "/api/collections/users",
      body: `{
				"passwordAuth":{"identityFields": ["missing"]}
			}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [
        `"data":{`,
        `"passwordAuth":{"identityFields":{"code":"validation_missing_field"`,
      ],
    },
    {
      name: "add another OAuth2 provider to an auth collection",
      method: "PATCH",
      url: "/api/collections/users",
      body: `{
				"oauth2": {
					"providers": [
						{"name": "apple", "clientId": "a", "clientSecret": "b"},
						{
							"pkce": null,
							"name": "google",
							"authURL": "",
							"displayName": "existing",
							"extra": {}
						}
					]
				}
			}`,
      headers: { Authorization: superuserToken },
      // verify that the collection has google and gitlab as OAuth2 providers
      prepare: oauth2ProvidersAre("users", "gitlab", "google"),
      expectedStatus: 200,
      expectedContent: [
        `"name":"google"`,
        `"name":"apple"`,
        `"displayName":"existing"`,
        `"clientId":"test"`,
        `"clientId":"a"`,
      ],
      notExpectedContent: [`"name":"gitlab"`, `clientSecret`],
    },
    {
      name: "trying to update view collection with invalid options",
      method: "PATCH",
      url: "/api/collections/view1",
      body: `{
				"fields":[{"type":"text","id":"12345789","name":"ignored!@#$"}],
				"viewQuery":"invalid"
			}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"viewQuery":{"code":"validation_invalid_view_query"`],
    },
    {
      name: "updating view collection",
      method: "PATCH",
      url: "/api/collections/view2",
      body: `{
				"name":"view2_update",
				"fields":[{"type":"text","id":"12345789","name":"ignored!@#$"}],
				"viewQuery": "select 2 as id, created, updated, email from _superusers limit 1"
			}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [
        `"name":"view2_update"`,
        `"type":"view"`,
        `"fields":[{`,
        `"name":"email"`,
        `"name":"id"`,
        `"name":"created"`,
        `"name":"updated"`,
      ],
    },
    {
      name: "updating base collection with invalid indexes",
      method: "PATCH",
      url: "/api/collections/demo2",
      body: `{
				"indexes": [
					"create unique idx_test1 on demo1 (text)",
					"create index idx_test2 on demo2 (id, title)"
				]
			}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"indexes":{"0":{"code":"`],
    },
    {
      name: "updating base collection with index name from another collection",
      method: "PATCH",
      url: "/api/collections/demo2",
      body: `{
				"indexes": [
					"create index exist_test on new (test)"
				]
			}`,
      headers: { Authorization: superuserToken },
      prepare: addDemo1Index("exist_test"),
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"indexes":{`, `"0":{"code":"validation_existing_index_name"`],
    },
    {
      name: "updating base collection with 2 indexes using the same name",
      method: "PATCH",
      url: "/api/collections/demo2",
      body: `{
				"indexes": [
					"create index duplicate_idx on new (created)",
					"create index duplicate_idx on new (updated)"
				]
			}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [
        `"data":{`,
        `"indexes":{`,
        `"1":{"code":"validation_duplicated_index_name"`,
      ],
    },
    {
      name: "updating base collection with valid indexes (+ random table name)",
      method: "PATCH",
      url: "/api/collections/demo2",
      body: `{
				"indexes": [
					"create unique index idx_test1 on demo2 (title)",
					"create index idx_test2 on anything (active)"
				]
			}`,
      headers: { Authorization: superuserToken },
      after: tableIndexesAre("demo2", "idx_test1", "idx_test2"),
      expectedStatus: 200,
      expectedContent: [`"name":"demo2"`, `"indexes":[`, `idx_test1`, `idx_test2`],
    },
  ],
};

export const collectionScaffolds: Suite = {
  file: "apis/collection_test.go",
  func: "TestCollectionScaffolds",
  scenarios: [
    {
      name: "unauthorized",
      method: "GET",
      url: "/api/collections/meta/scaffolds",
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method: "GET",
      url: "/api/collections/meta/scaffolds",
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser",
      method: "GET",
      url: "/api/collections/meta/scaffolds",
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [
        `"id":""`,
        `"name":""`,
        `"auth":{`,
        `"base":{`,
        `"view":{`,
        `"type":"auth"`,
        `"type":"base"`,
        `"type":"view"`,
        `"fields":[{`,
        `"fields":[{`,
        `"id":"text3208210256"`,
      ],
    },
  ],
};

export const collectionTruncate: Suite = {
  file: "apis/collection_test.go",
  func: "TestCollectionTruncate",
  scenarios: [
    {
      name: "unauthorized",
      method: "DELETE",
      url: "/api/collections/demo5/truncate",
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method: "DELETE",
      url: "/api/collections/demo5/truncate",
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser",
      method: "DELETE",
      url: "/api/collections/demo5/truncate",
      headers: { Authorization: superuserToken },
      expectedStatus: 204,
    },
    {
      name: "authorized as superuser but collection with required cascade delete references",
      method: "DELETE",
      url: "/api/collections/demo3/truncate",
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser trying to truncate view collection",
      method: "DELETE",
      url: "/api/collections/view2/truncate",
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
  ],
};

export const collectionOAuth2Providers: Suite = {
  file: "apis/collection_test.go",
  func: "TestCollectionOAuth2Providers",
  scenarios: [
    {
      name: "unauthorized",
      method: "GET",
      url: "/api/collections/meta/oauth2-providers",
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method: "GET",
      url: "/api/collections/meta/oauth2-providers",
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser",
      method: "GET",
      url: "/api/collections/meta/oauth2-providers",
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [`{"name":"oidc3","displayName":"OIDC","logo":"<svg`],
      notExpectedContent: [
        `"order":`,
        `"pkce":`,
        `"scopes":`,
        `"authURL":`,
        `"tokenURL":`,
        `"userInfoURL":`,
      ],
    },
  ],
};

export const collectionTestView: Suite = {
  file: "apis/collection_test.go",
  func: "TestCollectionTestView",
  scenarios: [
    {
      name: "unauthorized",
      method: "POST",
      url: "/api/collections/meta/dry-run-view",
      body: `{"query":"select 1 as id"}`,
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method: "POST",
      url: "/api/collections/meta/dry-run-view",
      body: `{"query":"select 1 as id"}`,
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser",
      method: "POST",
      url: "/api/collections/meta/dry-run-view",
      body: `{"query":"select 1 as id"}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [`"fields":[{`, `"name":"id"`, `"type":"text"`, `"sample":[{`, `"id":"1"`],
    },
    {
      name: "empty query",
      method: "POST",
      url: "/api/collections/meta/dry-run-view",
      body: `{"query":""}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{"query":`],
    },
    {
      name: "query length beyond validator limit",
      method: "POST",
      url: "/api/collections/meta/dry-run-view",
      body: `{"query":"${"a".repeat(5001)}"}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{"query":`],
    },
    {
      name: "query with length equal to the validator limit",
      method: "POST",
      url: "/api/collections/meta/dry-run-view",
      body: `{"query":"select 1 as id${" ".repeat(4986)}"}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [`"fields":[{`, `"name":"id"`, `"type":"text"`, `"sample":[`, `"id":"1"`],
    },
    {
      name: "missing ids sample",
      method: "POST",
      url: "/api/collections/meta/dry-run-view",
      body: `{"query":"(select 1 as id union select '' as id)"}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{}`, `Raw error:`],
    },
    {
      name: "duplicated ids sample",
      method: "POST",
      url: "/api/collections/meta/dry-run-view",
      body: `{"query":"(select 1 as id union all select 1 as id)"}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{}`, `Raw error:`],
    },
    {
      name: "write query",
      method: "POST",
      url: "/api/collections/meta/dry-run-view",
      body: `{"query":"CREATE TABLE t1(x INT)"}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{}`, `Raw error:`],
    },
  ],
};
