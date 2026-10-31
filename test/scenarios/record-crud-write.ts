// Upstream: apis/record_crud_test.go (TestRecordCrudDelete,
// TestRecordCrudCreate, TestRecordCrudUpdate)
//
// The tokens are upstream's fixture tokens (test data, expiring in 2050).
// BeforeTestFunc steps become `prepare` steps on the fixture copy
// (test/scenarios/prepare.ts, record-prepare.ts); AfterTestFunc checks and
// the stored state every write scenario leaves are `after` checks through
// the records API and the pb_data files (test/scenarios/record-checks.ts).
// The three "OnRecord{Delete,Create,Update}Request tx body write check"
// scenarios only test an upstream hook and are not ported.

import { multipart } from "@test/scenarios/multipart";
import {
  authOriginsCount,
  checks,
  externalAuthsCount,
  filesDeleted,
  passwordIs,
  recordCount,
  recordHas,
  recordMissing,
  responsePasswordIs,
  responseRecordStored,
} from "@test/scenarios/record-checks";
import { setRateLimits, updateCollection } from "@test/scenarios/prepare";
import { addAuthOrigins, smallDemo1BodyLimit } from "@test/scenarios/record-prepare";
import { clientsToken, superuserToken, usersToken } from "@test/scenarios/record-crud";
import type { Suite } from "@test/scenarios/scenario";

// users, test2@example.com
const usersTest2Token =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6Im9hcDY0MGNvdDR5cnUycyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.GfJo6EHIobgas_AXt-M-tj5IoQendPnrkMSe9ExuSEY";

// the multipart form of TestRecordCrudCreate and TestRecordCrudUpdate that is sent with a superuser token
const mpCreate1 = multipart({ title: "title_test" }, "files");
const mpUpdate1 = multipart({ title: "title_test" }, "files");

export const recordCrudDelete: Suite = {
  file: "apis/record_crud_test.go",
  func: "TestRecordCrudDelete",
  scenarios: [
    {
      name: "missing collection",
      method: "DELETE",
      url: "/api/collections/missing/records/0yxhwia2amd8gec",
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "missing record",
      method: "DELETE",
      url: "/api/collections/demo2/records/missing",
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "unauthenticated trying to delete nil rule collection (aka. need superuser auth)",
      method: "DELETE",
      url: "/api/collections/demo1/records/imy661ixudk5izi",
      after: recordHas("demo1", "imy661ixudk5izi"),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authenticated record trying to delete nil rule collection (aka. need superuser auth)",
      method: "DELETE",
      url: "/api/collections/demo1/records/imy661ixudk5izi",
      headers: { Authorization: usersToken },
      after: recordHas("demo1", "imy661ixudk5izi"),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authenticated record that doesn't match the collection delete rule",
      method: "DELETE",
      url: "/api/collections/users/records/bgs820n361vj1qd",
      headers: { Authorization: usersToken },
      after: recordHas("users", "bgs820n361vj1qd"),
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "trying to delete a view collection record",
      method: "DELETE",
      url: "/api/collections/view1/records/imy661ixudk5izi",
      after: recordHas("demo1", "imy661ixudk5izi"),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "public collection record delete",
      method: "DELETE",
      url: "/api/collections/nologin/records/dc49k6jgejn40h3",
      after: recordMissing("nologin", "dc49k6jgejn40h3"),
      expectedStatus: 204,
    },
    {
      name: "public collection record delete (using the collection id as identifier)",
      method: "DELETE",
      url: "/api/collections/kpv709sk2lqbqk8/records/dc49k6jgejn40h3",
      after: recordMissing("nologin", "dc49k6jgejn40h3"),
      expectedStatus: 204,
    },
    {
      name: "authorized as superuser trying to delete nil rule collection view (aka. need superuser auth)",
      method: "DELETE",
      url: "/api/collections/clients/records/o1y0dd0spd786md",
      headers: { Authorization: superuserToken },
      after: recordMissing("clients", "o1y0dd0spd786md"),
      expectedStatus: 204,
    },
    {
      name: "authenticated record that match the collection delete rule",
      method: "DELETE",
      url: "/api/collections/users/records/4q1xlclmfloku33",
      headers: { Authorization: usersToken },
      delayMs: 100,
      after: checks(
        recordMissing("users", "4q1xlclmfloku33"),
        // the linked external auths were deleted
        externalAuthsCount("_pb_users_auth_", "4q1xlclmfloku33", 0),
        filesDeleted("_pb_users_auth_", "4q1xlclmfloku33"),
      ),
      expectedStatus: 204,
    },
    {
      name: "@request :isset (rule failure check)",
      method: "DELETE",
      url: "/api/collections/demo5/records/la4y2w4o98acwuj",
      after: recordHas("demo5", "la4y2w4o98acwuj"),
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "@request :isset (rule pass check)",
      method: "DELETE",
      url: "/api/collections/demo5/records/la4y2w4o98acwuj?test=1",
      after: recordMissing("demo5", "la4y2w4o98acwuj"),
      expectedStatus: 204,
    },

    // cascade delete checks
    // -----------------------------------------------------------
    {
      name: "trying to delete a record while being part of a non-cascade required relation",
      method: "DELETE",
      url: "/api/collections/demo3/records/7nwo8tuiatetxdm",
      headers: { Authorization: superuserToken },
      after: recordHas("demo3", "7nwo8tuiatetxdm"),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "delete a record with non-cascade references",
      method: "DELETE",
      url: "/api/collections/demo3/records/1tmknxy2868d869",
      headers: { Authorization: superuserToken },
      after: checks(
        recordMissing("demo3", "1tmknxy2868d869"),
        recordHas("demo4", "qzaqccwrmva4o1n", {
          rel_many_no_cascade: [],
          rel_many_no_cascade_required: ["lcl9d87w22ml6jy"],
        }),
      ),
      expectedStatus: 204,
    },
    {
      name: "delete a record with cascade references",
      method: "DELETE",
      url: "/api/collections/users/records/oap640cot4yru2s",
      headers: { Authorization: superuserToken },
      delayMs: 100,
      after: checks(
        recordMissing("users", "oap640cot4yru2s"),
        recordMissing("demo1", "84nmscqy84lsi1t"),
        filesDeleted("wsmn24bux7wo113", "84nmscqy84lsi1t"),
        filesDeleted("_pb_users_auth_", "oap640cot4yru2s"),
      ),
      expectedStatus: 204,
    },

    // rate limit checks
    // -----------------------------------------------------------
    {
      name: "RateLimit rule - demo5:delete",
      method: "DELETE",
      url: "/api/collections/demo5/records/la4y2w4o98acwuj?test=1",
      prepare: ({ dataDir }) =>
        setRateLimits(dataDir, [
          { maxRequests: 100, label: "abc" },
          { maxRequests: 100, label: "*:delete" },
          { maxRequests: 0, label: "demo5:delete" },
        ]),
      expectedStatus: 429,
      expectedContent: [`"data":{}`],
    },
    {
      name: "RateLimit rule - *:delete",
      method: "DELETE",
      url: "/api/collections/demo5/records/la4y2w4o98acwuj?test=1",
      prepare: ({ dataDir }) =>
        setRateLimits(dataDir, [
          { maxRequests: 100, label: "abc" },
          { maxRequests: 0, label: "*:delete" },
        ]),
      expectedStatus: 429,
      expectedContent: [`"data":{}`],
    },
  ],
};

export const recordCrudCreate: Suite = {
  file: "apis/record_crud_test.go",
  func: "TestRecordCrudCreate",
  scenarios: [
    {
      name: "missing collection",
      method: "POST",
      url: "/api/collections/missing/records",
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "guest trying to access nil-rule collection",
      method: "POST",
      url: "/api/collections/demo1/records",
      after: recordCount("demo1", 3),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "auth record trying to access nil-rule collection",
      method: "POST",
      url: "/api/collections/demo1/records",
      headers: { Authorization: usersToken },
      after: recordCount("demo1", 3),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "trying to create a new view collection record",
      method: "POST",
      url: "/api/collections/view1/records",
      body: `{"text":"new"}`,
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "submit invalid body",
      method: "POST",
      url: "/api/collections/demo2/records",
      body: `{"`,
      after: recordCount("demo2", 3),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "submit nil body",
      method: "POST",
      url: "/api/collections/demo2/records",
      after: recordCount("demo2", 3),
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"title":{"code":"validation_required"`],
    },
    {
      name: "submit empty json body",
      method: "POST",
      url: "/api/collections/nologin/records",
      body: `{}`,
      after: recordCount("nologin", 3),
      expectedStatus: 400,
      expectedContent: [
        `"data":{`,
        `"password":{"code":"validation_required"`,
        `"passwordConfirm":{"code":"validation_required"`,
      ],
    },
    {
      name: "guest submit in public collection",
      method: "POST",
      url: "/api/collections/demo2/records",
      body: `{"title":"new"}`,
      after: checks(responseRecordStored("demo2"), recordCount("demo2", 4)),
      expectedStatus: 200,
      expectedContent: [`"id":`, `"title":"new"`, `"active":false`],
    },
    {
      name: "guest trying to submit in restricted collection",
      method: "POST",
      url: "/api/collections/demo3/records",
      body: `{"title":"test123"}`,
      after: recordCount("demo3", 4),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "auth record submit in restricted collection (rule failure check)",
      method: "POST",
      url: "/api/collections/demo3/records",
      body: `{"title":"test123"}`,
      headers: { Authorization: usersToken },
      after: recordCount("demo3", 4),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "auth record submit in restricted collection (rule pass check) + expand relations",
      method: "POST",
      url: "/api/collections/demo4/records?expand=missing,rel_one_no_cascade,rel_many_no_cascade_required",
      body: `{
				"title":"test123",
				"rel_one_no_cascade":"mk5fmymtx4wsprk",
				"rel_one_no_cascade_required":"7nwo8tuiatetxdm",
				"rel_one_cascade":"mk5fmymtx4wsprk",
				"rel_many_no_cascade":"mk5fmymtx4wsprk",
				"rel_many_no_cascade_required":["7nwo8tuiatetxdm","lcl9d87w22ml6jy"],
				"rel_many_cascade":"lcl9d87w22ml6jy"
			}`,
      headers: { Authorization: usersToken },
      after: responseRecordStored("demo4"),
      expectedStatus: 200,
      expectedContent: [
        `"id":`,
        `"title":"test123"`,
        `"expand":{}`, // empty expand even because of the query param
        `"rel_one_no_cascade":"mk5fmymtx4wsprk"`,
        `"rel_one_no_cascade_required":"7nwo8tuiatetxdm"`,
        `"rel_one_cascade":"mk5fmymtx4wsprk"`,
        `"rel_many_no_cascade":["mk5fmymtx4wsprk"]`,
        `"rel_many_no_cascade_required":["7nwo8tuiatetxdm","lcl9d87w22ml6jy"]`,
        `"rel_many_cascade":["lcl9d87w22ml6jy"]`,
      ],
      notExpectedContent: [
        // the users auth records don't have access to view the demo3 expands
        `"missing"`,
        `"id":"mk5fmymtx4wsprk"`,
        `"id":"7nwo8tuiatetxdm"`,
        `"id":"lcl9d87w22ml6jy"`,
      ],
    },
    {
      name: "superuser submit in restricted collection (rule skip check) + expand relations",
      method: "POST",
      url: "/api/collections/demo4/records?expand=missing,rel_one_no_cascade,rel_many_no_cascade_required",
      body: `{
				"title":"test123",
				"rel_one_no_cascade":"mk5fmymtx4wsprk",
				"rel_one_no_cascade_required":"7nwo8tuiatetxdm",
				"rel_one_cascade":"mk5fmymtx4wsprk",
				"rel_many_no_cascade":"mk5fmymtx4wsprk",
				"rel_many_no_cascade_required":["7nwo8tuiatetxdm","lcl9d87w22ml6jy"],
				"rel_many_cascade":"lcl9d87w22ml6jy"
			}`,
      headers: { Authorization: superuserToken },
      after: responseRecordStored("demo4"),
      expectedStatus: 200,
      expectedContent: [
        `"id":`,
        `"title":"test123"`,
        `"rel_one_no_cascade":"mk5fmymtx4wsprk"`,
        `"rel_one_no_cascade_required":"7nwo8tuiatetxdm"`,
        `"rel_one_cascade":"mk5fmymtx4wsprk"`,
        `"rel_many_no_cascade":["mk5fmymtx4wsprk"]`,
        `"rel_many_no_cascade_required":["7nwo8tuiatetxdm","lcl9d87w22ml6jy"]`,
        `"rel_many_cascade":["lcl9d87w22ml6jy"]`,
        `"expand":{`,
        `"id":"mk5fmymtx4wsprk"`,
        `"id":"7nwo8tuiatetxdm"`,
        `"id":"lcl9d87w22ml6jy"`,
      ],
      notExpectedContent: [`"missing"`],
    },
    {
      name: "superuser submit via multipart form data",
      method: "POST",
      url: "/api/collections/demo3/records",
      body: mpCreate1.body,
      headers: { ...mpCreate1.headers, Authorization: superuserToken },
      after: responseRecordStored("demo3"),
      expectedStatus: 200,
      expectedContent: [`"id":"`, `"title":"title_test"`, `"files":["`],
    },
    {
      name: "submit via multipart form data with @jsonPayload key and unsatisfied @request.body rule",
      method: "POST",
      url: "/api/collections/demo3/records",
      ...multipart({ "@jsonPayload": `{"title": "title_test2", "testPayload": 123}` }, "files"),
      prepare: ({ dataDir }) =>
        updateCollection(dataDir, "demo3", (col) => {
          col.createRule = "@request.body.testPayload != 123";
        }),
      after: recordCount("demo3", 4),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "submit via multipart form data with @jsonPayload key and satisfied @request.body rule",
      method: "POST",
      url: "/api/collections/demo3/records",
      ...multipart({ "@jsonPayload": `{"title": "title_test3", "testPayload": 123}` }, "files"),
      prepare: ({ dataDir }) =>
        updateCollection(dataDir, "demo3", (col) => {
          col.createRule = "@request.body.testPayload = 123";
        }),
      after: responseRecordStored("demo3"),
      expectedStatus: 200,
      expectedContent: [`"id":"`, `"title":"title_test3"`, `"files":["`],
    },
    {
      name: "unique field error check",
      method: "POST",
      url: "/api/collections/demo2/records",
      body: `{
				"title":"test2"
			}`,
      after: recordCount("demo2", 3),
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"title":{`, `"code":"validation_not_unique"`],
    },

    // ID checks
    // -----------------------------------------------------------
    {
      name: "invalid custom insertion id (less than 15 chars)",
      method: "POST",
      url: "/api/collections/demo3/records",
      body: `{
				"id": "12345678901234",
				"title": "test"
			}`,
      headers: { Authorization: superuserToken },
      after: recordCount("demo3", 4),
      expectedStatus: 400,
      expectedContent: [`"id":{"code":"validation_min_text_constraint"`],
    },
    {
      name: "invalid custom insertion id (more than 15 chars)",
      method: "POST",
      url: "/api/collections/demo3/records",
      body: `{
				"id": "1234567890123456",
				"title": "test"
			}`,
      headers: { Authorization: superuserToken },
      after: recordCount("demo3", 4),
      expectedStatus: 400,
      expectedContent: [`"id":{"code":"validation_max_text_constraint"`],
    },
    {
      name: "valid custom insertion id (exactly 15 chars)",
      method: "POST",
      url: "/api/collections/demo3/records",
      body: `{
				"id": "123456789012345",
				"title": "test"
			}`,
      headers: { Authorization: superuserToken },
      after: recordHas("demo3", "123456789012345", { title: "test" }),
      expectedStatus: 200,
      expectedContent: [`"id":"123456789012345"`, `"title":"test"`],
    },
    {
      name: "valid custom insertion id existing in another non-auth collection",
      method: "POST",
      url: "/api/collections/demo3/records",
      body: `{
				"id": "0yxhwia2amd8gec",
				"title": "test"
			}`,
      headers: { Authorization: superuserToken },
      after: recordHas("demo3", "0yxhwia2amd8gec", { title: "test" }),
      expectedStatus: 200,
      expectedContent: [`"id":"0yxhwia2amd8gec"`, `"title":"test"`],
    },
    {
      name: "valid custom insertion auth id duplicating in another auth collection",
      method: "POST",
      url: "/api/collections/users/records",
      body: `{
				"id":"o1y0dd0spd786md",
				"title":"test",
				"password":"1234567890",
				"passwordConfirm":"1234567890"
			}`,
      headers: { Authorization: superuserToken },
      after: recordMissing("users", "o1y0dd0spd786md"),
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"id":{"code":"validation_invalid_auth_id"`],
    },

    // check whether if @request.body modifer fields are properly resolved
    // -----------------------------------------------------------
    {
      name: "@request.body.field with compute modifers (rule failure check)",
      method: "POST",
      url: "/api/collections/demo5/records",
      body: `{
				"total+":4,
				"total-":2
			}`,
      after: recordCount("demo5", 2),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "@request.body.field with compute modifers (rule pass check)",
      method: "POST",
      url: "/api/collections/demo5/records",
      body: `{
				"total+":4,
				"total-":1
			}`,
      after: responseRecordStored("demo5", { total: 3 }),
      expectedStatus: 200,
      expectedContent: [`"id":"`, `"collectionName":"demo5"`, `"total":3`],
    },

    // auth records
    // -----------------------------------------------------------
    {
      name: "auth record with invalid form data",
      method: "POST",
      url: "/api/collections/users/records",
      body: `{
				"password":"1234567",
				"passwordConfirm":"1234560",
				"email":"invalid",
				"username":"Users75657"
			}`,
      headers: { Authorization: superuserToken },
      after: recordCount("users", 3),
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"passwordConfirm":{"code":"validation_values_mismatch"`],
      notExpectedContent: [
        // record fields are not checked if the base auth form fields have errors
        `"rel":`,
        `"email":`,
      ],
    },
    {
      name: "auth record with valid form data but invalid record fields",
      method: "POST",
      url: "/api/collections/users/records",
      body: `{
				"password":"1234567",
				"passwordConfirm":"1234567",
				"rel":"invalid"
			}`,
      headers: { Authorization: superuserToken },
      after: recordCount("users", 3),
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"rel":{"code":`, `"password":{"code":`],
    },
    {
      name: "auth record with valid data and explicitly verified state by guest",
      method: "POST",
      url: "/api/collections/users/records",
      body: `{
				"password":"12345678",
				"passwordConfirm":"12345678",
				"verified":true
			}`,
      after: recordCount("users", 3),
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"verified":{"code":`],
    },
    {
      name: "auth record with valid data and explicitly verified state by random user",
      method: "POST",
      url: "/api/collections/users/records",
      headers: { Authorization: usersToken },
      body: `{
				"password":"12345678",
				"passwordConfirm":"12345678",
				"emailVisibility":true,
				"verified":true
			}`,
      after: recordCount("users", 3),
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"verified":{"code":`],
      notExpectedContent: [`"emailVisibility":{"code":`],
    },
    {
      name: "auth record with valid data by superuser",
      method: "POST",
      url: "/api/collections/users/records",
      body: `{
				"id":"o1o1y0pd78686mq",
				"username":"test.valid",
				"email":"new@example.com",
				"password":"12345678",
				"passwordConfirm":"12345678",
				"rel":"achvryl401bhse3",
				"emailVisibility":true,
				"verified":true
			}`,
      headers: { Authorization: superuserToken },
      after: checks(
        recordHas("users", "o1o1y0pd78686mq", {
          username: "test.valid",
          email: "new@example.com",
          rel: "achvryl401bhse3",
          emailVisibility: true,
          verified: true,
        }),
        passwordIs("users", "o1o1y0pd78686mq", "12345678"),
      ),
      expectedStatus: 200,
      expectedContent: [
        `"id":"o1o1y0pd78686mq"`,
        `"username":"test.valid"`,
        `"email":"new@example.com"`,
        `"rel":"achvryl401bhse3"`,
        `"emailVisibility":true`,
        `"verified":true`,
      ],
      notExpectedContent: [`"tokenKey"`, `"password"`, `"passwordConfirm"`],
    },
    {
      name: "auth record with valid data by auth record with manage access",
      method: "POST",
      url: "/api/collections/nologin/records",
      body: `{
				"email":"new@example.com",
				"password":"12345678",
				"passwordConfirm":"12345678",
				"name":"test_name",
				"emailVisibility":true,
				"verified":true
			}`,
      headers: { Authorization: usersToken },
      after: checks(
        responseRecordStored("nologin", { email: "new@example.com", verified: true }),
        responsePasswordIs("nologin", "12345678"),
      ),
      expectedStatus: 200,
      expectedContent: [
        `"id":"`,
        `"username":"`,
        `"email":"new@example.com"`,
        `"name":"test_name"`,
        `"emailVisibility":true`,
        `"verified":true`,
      ],
      notExpectedContent: [`"tokenKey"`, `"password"`, `"passwordConfirm"`],
    },

    // ensure that hidden fields cannot be set by non-superusers
    // -----------------------------------------------------------
    {
      name: "create with hidden field as regular user",
      method: "POST",
      url: "/api/collections/demo3/records",
      body: `{
				"id": "abcde1234567890",
				"title": "test_create"
			}`,
      headers: { Authorization: clientsToken },
      prepare: ({ dataDir }) =>
        updateCollection(dataDir, "demo3", (col) => {
          // mock hidden field
          col.fields.getByName("title")?.setHidden(true);
        }),
      after: recordHas("demo3", "abcde1234567890", { title: "" }),
      expectedStatus: 200,
      expectedContent: [`"id":"abcde1234567890"`],
      notExpectedContent: [`"title"`],
    },
    {
      name: "create with hidden field as superuser",
      method: "POST",
      url: "/api/collections/demo3/records",
      body: `{
				"id": "abcde1234567890",
				"title": "test_create"
			}`,
      headers: { Authorization: superuserToken },
      prepare: ({ dataDir }) =>
        updateCollection(dataDir, "demo3", (col) => {
          // mock hidden field
          col.fields.getByName("title")?.setHidden(true);
        }),
      after: recordHas("demo3", "abcde1234567890", { title: "test_create" }),
      expectedStatus: 200,
      expectedContent: [`"id":"abcde1234567890"`, `"title":"test_create"`],
    },

    // rate limit checks
    // -----------------------------------------------------------
    {
      name: "RateLimit rule - demo2:create",
      method: "POST",
      url: "/api/collections/demo2/records",
      body: `{"title":"new"}`,
      prepare: ({ dataDir }) =>
        setRateLimits(dataDir, [
          { maxRequests: 100, label: "abc" },
          { maxRequests: 100, label: "*:create" },
          { maxRequests: 0, label: "demo2:create" },
        ]),
      expectedStatus: 429,
      expectedContent: [`"data":{}`],
    },
    {
      name: "RateLimit rule - *:create",
      method: "POST",
      url: "/api/collections/demo2/records",
      body: `{"title":"new"}`,
      prepare: ({ dataDir }) =>
        setRateLimits(dataDir, [
          { maxRequests: 100, label: "abc" },
          { maxRequests: 0, label: "*:create" },
        ]),
      expectedStatus: 429,
      expectedContent: [`"data":{}`],
    },

    // dynamic body limit checks
    // -----------------------------------------------------------
    {
      name: "body > collection BodyLimit",
      method: "POST",
      url: "/api/collections/demo1/records",
      // the exact body doesn't matter as long as it returns 413
      body: new Uint8Array((32 << 20) + 5 + 20 + 2 + 1),
      prepare: ({ dataDir }) => smallDemo1BodyLimit(dataDir),
      after: recordCount("demo1", 3),
      expectedStatus: 413,
      expectedContent: [`"data":{}`],
    },
    {
      name: "body <= collection BodyLimit",
      method: "POST",
      url: "/api/collections/demo1/records",
      // the exact body doesn't matter as long as it doesn't return 413
      body: new Uint8Array((32 << 20) + 5 + 20 + 2),
      prepare: ({ dataDir }) => smallDemo1BodyLimit(dataDir),
      after: recordCount("demo1", 3),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
  ],
};

export const recordCrudUpdate: Suite = {
  file: "apis/record_crud_test.go",
  func: "TestRecordCrudUpdate",
  scenarios: [
    {
      name: "missing collection",
      method: "PATCH",
      url: "/api/collections/missing/records/0yxhwia2amd8gec",
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "guest trying to access nil-rule collection record",
      method: "PATCH",
      url: "/api/collections/demo1/records/imy661ixudk5izi",
      after: recordHas("demo1", "imy661ixudk5izi"),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "auth record trying to access nil-rule collection",
      method: "PATCH",
      url: "/api/collections/demo1/records/imy661ixudk5izi",
      headers: { Authorization: usersToken },
      after: recordHas("demo1", "imy661ixudk5izi"),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "trying to update a view collection record",
      method: "PATCH",
      url: "/api/collections/view1/records/imy661ixudk5izi",
      body: `{"text":"new"}`,
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "submit invalid body",
      method: "PATCH",
      url: "/api/collections/demo2/records/0yxhwia2amd8gec",
      body: `{"`,
      after: recordHas("demo2", "0yxhwia2amd8gec", { title: "test3" }),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "submit nil body (aka. no fields change)",
      method: "PATCH",
      url: "/api/collections/demo2/records/0yxhwia2amd8gec",
      after: recordHas("demo2", "0yxhwia2amd8gec", { title: "test3", active: true }),
      expectedStatus: 200,
      expectedContent: [`"collectionName":"demo2"`, `"id":"0yxhwia2amd8gec"`],
    },
    {
      name: "submit empty body (aka. no fields change)",
      method: "PATCH",
      url: "/api/collections/demo2/records/0yxhwia2amd8gec",
      body: `{}`,
      after: recordHas("demo2", "0yxhwia2amd8gec", { title: "test3", active: true }),
      expectedStatus: 200,
      expectedContent: [`"collectionName":"demo2"`, `"id":"0yxhwia2amd8gec"`],
    },
    {
      name: "trigger field validation",
      method: "PATCH",
      url: "/api/collections/demo2/records/0yxhwia2amd8gec",
      body: `{"title":"a"}`,
      after: recordHas("demo2", "0yxhwia2amd8gec", { title: "test3" }),
      expectedStatus: 400,
      expectedContent: [`data":{`, `"title":{"code":"validation_min_text_constraint"`],
    },
    {
      name: "guest submit in public collection",
      method: "PATCH",
      url: "/api/collections/demo2/records/0yxhwia2amd8gec",
      body: `{"title":"new"}`,
      after: recordHas("demo2", "0yxhwia2amd8gec", { title: "new" }),
      expectedStatus: 200,
      expectedContent: [`"id":"0yxhwia2amd8gec"`, `"title":"new"`, `"active":true`],
    },
    {
      name: "guest trying to submit in restricted collection",
      method: "PATCH",
      url: "/api/collections/demo3/records/mk5fmymtx4wsprk",
      body: `{"title":"new"}`,
      after: recordHas("demo3", "mk5fmymtx4wsprk", { title: "test4" }),
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "auth record submit in restricted collection (rule failure check)",
      method: "PATCH",
      url: "/api/collections/demo3/records/mk5fmymtx4wsprk",
      body: `{"title":"new"}`,
      headers: { Authorization: usersToken },
      after: recordHas("demo3", "mk5fmymtx4wsprk", { title: "test4" }),
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "auth record submit in restricted collection (rule pass check) + expand relations",
      method: "PATCH",
      url: "/api/collections/demo4/records/i9naidtvr6qsgb4?expand=missing,rel_one_no_cascade,rel_many_no_cascade_required",
      body: `{
				"title":"test123",
				"rel_one_no_cascade":"mk5fmymtx4wsprk",
				"rel_one_no_cascade_required":"7nwo8tuiatetxdm",
				"rel_one_cascade":"mk5fmymtx4wsprk",
				"rel_many_no_cascade":"mk5fmymtx4wsprk",
				"rel_many_no_cascade_required":["7nwo8tuiatetxdm","lcl9d87w22ml6jy"],
				"rel_many_cascade":"lcl9d87w22ml6jy"
			}`,
      headers: { Authorization: usersToken },
      after: recordHas("demo4", "i9naidtvr6qsgb4", {
        title: "test123",
        rel_one_no_cascade: "mk5fmymtx4wsprk",
        rel_many_no_cascade_required: ["7nwo8tuiatetxdm", "lcl9d87w22ml6jy"],
        rel_many_cascade: ["lcl9d87w22ml6jy"],
      }),
      expectedStatus: 200,
      expectedContent: [
        `"id":"i9naidtvr6qsgb4"`,
        `"title":"test123"`,
        `"expand":{}`, // empty expand even because of the query param
        `"rel_one_no_cascade":"mk5fmymtx4wsprk"`,
        `"rel_one_no_cascade_required":"7nwo8tuiatetxdm"`,
        `"rel_one_cascade":"mk5fmymtx4wsprk"`,
        `"rel_many_no_cascade":["mk5fmymtx4wsprk"]`,
        `"rel_many_no_cascade_required":["7nwo8tuiatetxdm","lcl9d87w22ml6jy"]`,
        `"rel_many_cascade":["lcl9d87w22ml6jy"]`,
      ],
      notExpectedContent: [
        // the users auth records don't have access to view the demo3 expands
        `"missing"`,
        `"id":"mk5fmymtx4wsprk"`,
        `"id":"7nwo8tuiatetxdm"`,
        `"id":"lcl9d87w22ml6jy"`,
      ],
    },
    {
      name: "superuser submit in restricted collection (rule skip check) + expand relations",
      method: "PATCH",
      url: "/api/collections/demo4/records/i9naidtvr6qsgb4?expand=missing,rel_one_no_cascade,rel_many_no_cascade_required",
      body: `{
				"title":"test123",
				"rel_one_no_cascade":"mk5fmymtx4wsprk",
				"rel_one_no_cascade_required":"7nwo8tuiatetxdm",
				"rel_one_cascade":"mk5fmymtx4wsprk",
				"rel_many_no_cascade":"mk5fmymtx4wsprk",
				"rel_many_no_cascade_required":["7nwo8tuiatetxdm","lcl9d87w22ml6jy"],
				"rel_many_cascade":"lcl9d87w22ml6jy"
			}`,
      headers: { Authorization: superuserToken },
      after: recordHas("demo4", "i9naidtvr6qsgb4", {
        title: "test123",
        rel_one_no_cascade: "mk5fmymtx4wsprk",
        rel_many_no_cascade_required: ["7nwo8tuiatetxdm", "lcl9d87w22ml6jy"],
        rel_many_cascade: ["lcl9d87w22ml6jy"],
      }),
      expectedStatus: 200,
      expectedContent: [
        `"id":"i9naidtvr6qsgb4"`,
        `"title":"test123"`,
        `"rel_one_no_cascade":"mk5fmymtx4wsprk"`,
        `"rel_one_no_cascade_required":"7nwo8tuiatetxdm"`,
        `"rel_one_cascade":"mk5fmymtx4wsprk"`,
        `"rel_many_no_cascade":["mk5fmymtx4wsprk"]`,
        `"rel_many_no_cascade_required":["7nwo8tuiatetxdm","lcl9d87w22ml6jy"]`,
        `"rel_many_cascade":["lcl9d87w22ml6jy"]`,
        `"expand":{`,
        `"id":"mk5fmymtx4wsprk"`,
        `"id":"7nwo8tuiatetxdm"`,
        `"id":"lcl9d87w22ml6jy"`,
      ],
      notExpectedContent: [`"missing"`],
    },
    {
      name: "superuser submit via multipart form data",
      method: "PATCH",
      url: "/api/collections/demo3/records/mk5fmymtx4wsprk",
      body: mpUpdate1.body,
      headers: { ...mpUpdate1.headers, Authorization: superuserToken },
      after: recordHas("demo3", "mk5fmymtx4wsprk", { title: "title_test" }),
      expectedStatus: 200,
      expectedContent: [`"id":"mk5fmymtx4wsprk"`, `"title":"title_test"`, `"files":["`],
    },
    {
      name: "submit via multipart form data with @jsonPayload key and unsatisfied @request.body rule",
      method: "PATCH",
      url: "/api/collections/demo3/records/mk5fmymtx4wsprk",
      ...multipart({ "@jsonPayload": `{"title": "title_test2", "testPayload": 123}` }, "files"),
      prepare: ({ dataDir }) =>
        updateCollection(dataDir, "demo3", (col) => {
          col.updateRule = "@request.body.testPayload != 123";
        }),
      after: recordHas("demo3", "mk5fmymtx4wsprk", { title: "test4" }),
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "submit via multipart form data with @jsonPayload key and satisfied @request.body rule",
      method: "PATCH",
      url: "/api/collections/demo3/records/mk5fmymtx4wsprk",
      ...multipart(
        {
          "@jsonPayload": `{"title": "title_test3", "testPayload": 123, "files":"300_JdfBOieXAW.png"}`,
        },
        "files",
      ),
      prepare: ({ dataDir }) =>
        updateCollection(dataDir, "demo3", (col) => {
          col.updateRule = "@request.body.testPayload = 123";
        }),
      after: recordHas("demo3", "mk5fmymtx4wsprk", { title: "title_test3" }),
      expectedStatus: 200,
      expectedContent: [
        `"id":"mk5fmymtx4wsprk"`,
        `"title":"title_test3"`,
        `"files":["`,
        `"300_JdfBOieXAW.png"`,
        `"tmpfile_`,
      ],
    },
    {
      name: "try to change the id of an existing record",
      method: "PATCH",
      url: "/api/collections/demo3/records/mk5fmymtx4wsprk",
      body: `{
				"id": "mk5fmymtx4wspra"
			}`,
      headers: { Authorization: superuserToken },
      after: checks(
        recordHas("demo3", "mk5fmymtx4wsprk"),
        recordMissing("demo3", "mk5fmymtx4wspra"),
      ),
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"id":{"code":"validation_pk_change"`],
    },
    {
      name: "unique field error check",
      method: "PATCH",
      url: "/api/collections/demo2/records/llvuca81nly1qls",
      body: `{
				"title":"test2"
			}`,
      after: recordHas("demo2", "llvuca81nly1qls", { title: "test1" }),
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"title":{`, `"code":"validation_not_unique"`],
    },

    // check whether if @request.body modifer fields are properly resolved
    // -----------------------------------------------------------
    {
      name: "@request.body.field with compute modifers (rule failure check)",
      method: "PATCH",
      url: "/api/collections/demo5/records/la4y2w4o98acwuj",
      body: `{
				"total+":3,
				"total-":1
			}`,
      after: recordHas("demo5", "la4y2w4o98acwuj", { total: 2 }),
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "@request.body.field with compute modifers (rule pass check)",
      method: "PATCH",
      url: "/api/collections/demo5/records/la4y2w4o98acwuj",
      body: `{
				"total+":2,
				"total-":1
			}`,
      after: recordHas("demo5", "la4y2w4o98acwuj", { total: 3 }),
      expectedStatus: 200,
      expectedContent: [`"id":"la4y2w4o98acwuj"`, `"collectionName":"demo5"`, `"total":3`],
    },

    // auth records
    // -----------------------------------------------------------
    {
      name: "auth record with invalid form data",
      method: "PATCH",
      url: "/api/collections/users/records/bgs820n361vj1qd",
      body: `{
				"password":"",
				"passwordConfirm":"1234560",
				"email":"invalid",
				"verified":false
			}`,
      headers: { Authorization: superuserToken },
      after: recordHas("users", "bgs820n361vj1qd", { email: "test3@example.com", verified: true }),
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"passwordConfirm":{`, `"password":{`],
      notExpectedContent: [
        // record fields are not checked if the base auth form fields have errors
        `"email":`,
        "verified", // superusers are allowed to change the verified state
      ],
    },
    {
      name: "auth record with valid form data but invalid record fields",
      method: "PATCH",
      url: "/api/collections/users/records/bgs820n361vj1qd",
      body: `{
				"password":"1234567",
				"passwordConfirm":"1234567",
				"rel":"invalid"
			}`,
      headers: { Authorization: superuserToken },
      after: recordHas("users", "bgs820n361vj1qd", { rel: "0yxhwia2amd8gec" }),
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"rel":{"code":`, `"password":{"code":`],
    },
    {
      name: "try to change account managing fields by guest",
      method: "PATCH",
      url: "/api/collections/nologin/records/phhq3wr65cap535",
      body: `{
				"password":"12345678",
				"passwordConfirm":"12345678",
				"emailVisibility":true,
				"verified":true
			}`,
      after: recordHas("nologin", "phhq3wr65cap535", { verified: false }),
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"verified":{"code":`, `"oldPassword":{"code":`],
      notExpectedContent: [`"emailVisibility":{"code":`],
    },
    {
      name: "try to change account managing fields by auth record (owner)",
      method: "PATCH",
      url: "/api/collections/users/records/4q1xlclmfloku33",
      headers: { Authorization: usersToken },
      body: `{
				"password":"12345678",
				"passwordConfirm":"12345678",
				"emailVisibility":true,
				"verified":true
			}`,
      after: recordHas("users", "4q1xlclmfloku33", { verified: false, emailVisibility: false }),
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"verified":{"code":`, `"oldPassword":{"code":`],
      notExpectedContent: [`"emailVisibility":{"code":`],
    },
    {
      name: "try to unset/downgrade email and verified fields (owner)",
      method: "PATCH",
      url: "/api/collections/users/records/oap640cot4yru2s",
      // users, test2@example.com
      headers: { Authorization: usersTest2Token },
      body: `{
				"email":"",
				"verified":false
			}`,
      after: recordHas("users", "oap640cot4yru2s", { email: "test2@example.com", verified: true }),
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"email":{"code":`, `"verified":{"code":`],
    },
    {
      name: "try to change account managing fields by auth record with managing rights",
      method: "PATCH",
      url: "/api/collections/nologin/records/phhq3wr65cap535",
      body: `{
				"email":"new@example.com",
				"password":"12345678",
				"passwordConfirm":"12345678",
				"name":"test_name",
				"emailVisibility":true,
				"verified":true
			}`,
      headers: { Authorization: usersToken },
      after: checks(
        recordHas("nologin", "phhq3wr65cap535", {
          email: "new@example.com",
          name: "test_name",
          emailVisibility: true,
          verified: true,
        }),
        passwordIs("nologin", "phhq3wr65cap535", "12345678"),
      ),
      expectedStatus: 200,
      expectedContent: [
        `"email":"new@example.com"`,
        `"name":"test_name"`,
        `"emailVisibility":true`,
        `"verified":true`,
      ],
      notExpectedContent: [`"tokenKey"`, `"password"`, `"passwordConfirm"`],
    },
    {
      name: "update auth record with valid data by superuser",
      method: "PATCH",
      url: "/api/collections/users/records/oap640cot4yru2s",
      body: `{
				"username":"test.valid",
				"email":"new@example.com",
				"password":"12345678",
				"passwordConfirm":"12345678",
				"rel":"achvryl401bhse3",
				"emailVisibility":true,
				"verified":false
			}`,
      headers: { Authorization: superuserToken },
      after: checks(
        recordHas("users", "oap640cot4yru2s", {
          username: "test.valid",
          email: "new@example.com",
          rel: "achvryl401bhse3",
          emailVisibility: true,
          verified: false,
        }),
        passwordIs("users", "oap640cot4yru2s", "12345678"),
      ),
      expectedStatus: 200,
      expectedContent: [
        `"username":"test.valid"`,
        `"email":"new@example.com"`,
        `"rel":"achvryl401bhse3"`,
        `"emailVisibility":true`,
        `"verified":false`,
      ],
      notExpectedContent: [`"tokenKey"`, `"password"`],
    },
    {
      name: "update auth record with valid data by guest (empty update filter + auth origins check)",
      method: "PATCH",
      url: "/api/collections/nologin/records/dc49k6jgejn40h3",
      body: `{
				"username":"test_new",
				"emailVisibility":true,
				"name":"test"
			}`,
      prepare: ({ dataDir }) => addAuthOrigins(dataDir, "nologin", "dc49k6jgejn40h3"),
      after: checks(
        recordHas("nologin", "dc49k6jgejn40h3", {
          username: "test_new",
          emailVisibility: true,
          name: "test",
        }),
        // the dummy auth origins should NOT have been removed since we didn't change the password
        authOriginsCount("kpv709sk2lqbqk8", "dc49k6jgejn40h3", 3),
      ),
      expectedStatus: 200,
      expectedContent: [
        `"username":"test_new"`,
        `"email":"test@example.com"`, // the email should be visible since we updated the emailVisibility
        `"emailVisibility":true`,
        `"verified":false`,
        `"name":"test"`,
      ],
      notExpectedContent: [`"tokenKey"`, `"password"`, `"passwordConfirm"`],
    },
    {
      name: "success password change with oldPassword (+authOrigins reset check)",
      method: "PATCH",
      url: "/api/collections/nologin/records/dc49k6jgejn40h3",
      body: `{
				"password":"123456789",
				"passwordConfirm":"123456789",
				"oldPassword":"1234567890"
			}`,
      prepare: ({ dataDir }) => addAuthOrigins(dataDir, "nologin", "dc49k6jgejn40h3"),
      after: checks(
        passwordIs("nologin", "dc49k6jgejn40h3", "123456789"),
        // the dummy auth origins should have been removed
        authOriginsCount("kpv709sk2lqbqk8", "dc49k6jgejn40h3", 0),
      ),
      expectedStatus: 200,
      expectedContent: [`"id":"dc49k6jgejn40h3"`],
      notExpectedContent: [`"tokenKey"`, `"password"`, `"passwordConfirm"`],
    },

    // ensure that hidden fields cannot be set by non-superusers
    // -----------------------------------------------------------
    {
      name: "update with hidden field as regular user",
      method: "PATCH",
      url: "/api/collections/demo3/records/1tmknxy2868d869",
      body: `{
				"title": "test_update"
			}`,
      headers: { Authorization: clientsToken },
      prepare: ({ dataDir }) =>
        updateCollection(dataDir, "demo3", (col) => {
          // mock hidden field
          col.fields.getByName("title")?.setHidden(true);
        }),
      after: recordHas("demo3", "1tmknxy2868d869", { title: "test1" }),
      expectedStatus: 200,
      expectedContent: [`"id":"1tmknxy2868d869"`],
      notExpectedContent: [`"title"`],
    },
    {
      name: "update with hidden field as superuser",
      method: "PATCH",
      url: "/api/collections/demo3/records/1tmknxy2868d869",
      body: `{
				"title": "test_update"
			}`,
      headers: { Authorization: superuserToken },
      prepare: ({ dataDir }) =>
        updateCollection(dataDir, "demo3", (col) => {
          // mock hidden field
          col.fields.getByName("title")?.setHidden(true);
        }),
      after: recordHas("demo3", "1tmknxy2868d869", { title: "test_update" }),
      expectedStatus: 200,
      expectedContent: [`"id":"1tmknxy2868d869"`, `"title":"test_update"`],
    },

    // rate limit checks
    // -----------------------------------------------------------
    {
      name: "RateLimit rule - demo2:update",
      method: "PATCH",
      url: "/api/collections/demo2/records/0yxhwia2amd8gec",
      body: `{"title":"new"}`,
      prepare: ({ dataDir }) =>
        setRateLimits(dataDir, [
          { maxRequests: 100, label: "abc" },
          { maxRequests: 100, label: "*:update" },
          { maxRequests: 0, label: "demo2:update" },
        ]),
      expectedStatus: 429,
      expectedContent: [`"data":{}`],
    },
    {
      name: "RateLimit rule - *:update",
      method: "PATCH",
      url: "/api/collections/demo2/records/0yxhwia2amd8gec",
      body: `{"title":"new"}`,
      prepare: ({ dataDir }) =>
        setRateLimits(dataDir, [
          { maxRequests: 100, label: "abc" },
          { maxRequests: 0, label: "*:update" },
        ]),
      expectedStatus: 429,
      expectedContent: [`"data":{}`],
    },

    // dynamic body limit checks
    // -----------------------------------------------------------
    {
      name: "body > collection BodyLimit",
      method: "PATCH",
      url: "/api/collections/demo1/records/imy661ixudk5izi",
      // the exact body doesn't matter as long as it returns 413
      body: new Uint8Array((32 << 20) + 5 + 20 + 2 + 1),
      prepare: ({ dataDir }) => smallDemo1BodyLimit(dataDir),
      after: recordHas("demo1", "imy661ixudk5izi"),
      expectedStatus: 413,
      expectedContent: [`"data":{}`],
    },
    {
      name: "body <= collection BodyLimit",
      method: "PATCH",
      url: "/api/collections/demo1/records/imy661ixudk5izi",
      // the exact body doesn't matter as long as it doesn't return 413
      body: new Uint8Array((32 << 20) + 5 + 20 + 2),
      prepare: ({ dataDir }) => smallDemo1BodyLimit(dataDir),
      after: recordHas("demo1", "imy661ixudk5izi"),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
  ],
};
