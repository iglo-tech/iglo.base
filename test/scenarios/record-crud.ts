// Upstream: apis/record_crud_test.go (TestRecordCrudList, TestRecordCrudView)
//
// The tokens are upstream's fixture tokens (test/fixtures/pocketbase,
// expiring in 2050): test data, not credentials. BeforeTestFunc steps that
// change a collection or the settings become `prepare` steps on the
// fixture copy (test/scenarios/prepare.ts). The two "tx body write check"
// scenarios only test an upstream hook and are not ported.

import { queryEscape } from "@/server/request";

import { setRateLimits, updateCollection } from "@test/scenarios/prepare";
import type { Suite } from "@test/scenarios/scenario";

// users, test@example.com
export const usersToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.ZT3F0Z3iM-xbGgSG3LEKiEzHrPHr8t8IuHLZGGNuxLo";

// clients, test@example.com
export const clientsToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6ImdrMzkwcWVnczR5NDd3biIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoidjg1MXE0cjc5MHJoa25sIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.0ONnm_BsvPRZyDNT31GN1CKUB6uQRxvVvQ-Wc9AZfG0";

// nologin, test@example.com
export const nologinToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6ImRjNDlrNmpnZWpuNDBoMyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoia3B2NzA5c2sybHFicWs4IiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.fdUPFLDx5b6RM_XFqnqsyiyNieyKA2HIIkRmUh9kIoY";

// superusers, test@example.com
export const superuserToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoicGJjXzMxNDI2MzU4MjMiLCJleHAiOjI1MjQ2MDQ0NjEsInJlZnJlc2hhYmxlIjp0cnVlfQ.UXgO3j-0BumcugrFjbd7j0M4MQvbrLggLlcu_YNGjoY";

export const recordCrudList: Suite = {
  file: "apis/record_crud_test.go",
  func: "TestRecordCrudList",
  scenarios: [
    {
      name: "missing collection",
      method: "GET",
      url: "/api/collections/missing/records",
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "unauthenticated trying to access nil rule collection (aka. need superuser auth)",
      method: "GET",
      url: "/api/collections/demo1/records",
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authenticated record trying to access nil rule collection (aka. need superuser auth)",
      method: "GET",
      url: "/api/collections/demo1/records",
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "public collection but with superuser only filter param (aka. @collection, @request, etc.)",
      method: "GET",
      url: "/api/collections/demo2/records?filter=%40collection.demo2.title='test1'",
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "public collection but with superuser only sort param (aka. @collection, @request, etc.)",
      method: "GET",
      url: "/api/collections/demo2/records?sort=@request.auth.title",
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "public collection but with ENCODED superuser only filter/sort (aka. @collection)",
      method: "GET",
      url: "/api/collections/demo2/records?filter=%40collection.demo2.title%3D%27test1%27",
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "public collection",
      method: "GET",
      url: "/api/collections/demo2/records",
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalPages":1`,
        `"totalItems":3`,
        `"items":[{`,
        `"id":"0yxhwia2amd8gec"`,
        `"id":"achvryl401bhse3"`,
        `"id":"llvuca81nly1qls"`,
      ],
    },
    {
      name: "public collection (using the collection id)",
      method: "GET",
      url: "/api/collections/sz5l5z67tg7gku0/records",
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalPages":1`,
        `"totalItems":3`,
        `"items":[{`,
        `"id":"0yxhwia2amd8gec"`,
        `"id":"achvryl401bhse3"`,
        `"id":"llvuca81nly1qls"`,
      ],
    },
    {
      name: "authorized as superuser trying to access nil rule collection (aka. need superuser auth)",
      method: "GET",
      url: "/api/collections/demo1/records",
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalPages":1`,
        `"totalItems":3`,
        `"items":[{`,
        `"id":"al1h9ijdeojtsjy"`,
        `"id":"84nmscqy84lsi1t"`,
        `"id":"imy661ixudk5izi"`,
      ],
    },
    {
      name: "valid query params",
      method: "GET",
      url: "/api/collections/demo1/records?filter=text~'test'&sort=-bool",
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalItems":2`,
        `"items":[{`,
        `"id":"al1h9ijdeojtsjy"`,
        `"id":"84nmscqy84lsi1t"`,
      ],
    },
    {
      name: "invalid filter",
      method: "GET",
      url: "/api/collections/demo1/records?filter=invalid~'test'",
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "expand relations",
      method: "GET",
      url: "/api/collections/demo1/records?expand=rel_one,rel_many.rel,missing&perPage=2&sort=created",
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":2`,
        `"totalPages":2`,
        `"totalItems":3`,
        `"items":[{`,
        `"collectionName":"demo1"`,
        `"id":"84nmscqy84lsi1t"`,
        `"id":"al1h9ijdeojtsjy"`,
        `"expand":{`,
        `"rel_one":""`,
        `"rel_one":{"`,
        `"rel_many":[{`,
        `"rel":{`,
        `"rel":""`,
        `"json":[1,2,3]`,
        `"select_many":["optionB","optionC"]`,
        `"select_many":["optionB"]`,
        // subrel items
        `"id":"0yxhwia2amd8gec"`,
        `"id":"llvuca81nly1qls"`,
        // email visibility should be ignored for superusers even in expanded rels
        `"email":"test@example.com"`,
        `"email":"test2@example.com"`,
        `"email":"test3@example.com"`,
      ],
    },
    {
      name: "authenticated record model that DOESN'T match the collection list rule",
      method: "GET",
      url: "/api/collections/demo3/records",
      headers: { Authorization: usersToken },
      expectedStatus: 200,
      expectedContent: [`"page":1`, `"perPage":30`, `"totalItems":0`, `"items":[]`],
    },
    {
      name: "authenticated record that matches the collection list rule",
      method: "GET",
      url: "/api/collections/demo3/records",
      headers: { Authorization: clientsToken },
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalPages":1`,
        `"totalItems":4`,
        `"items":[{`,
        `"id":"1tmknxy2868d869"`,
        `"id":"lcl9d87w22ml6jy"`,
        `"id":"7nwo8tuiatetxdm"`,
        `"id":"mk5fmymtx4wsprk"`,
      ],
    },
    {
      name: "authenticated regular record that matches the collection list rule with hidden field",
      method: "GET",
      url: "/api/collections/demo3/records",
      headers: { Authorization: clientsToken },
      prepare: ({ dataDir }) =>
        updateCollection(dataDir, "demo3", (col) => {
          // mock hidden field
          col.fields.getByName("title")?.setHidden(true);

          col.listRule = "title ~ 'test'";
        }),
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalPages":1`,
        `"totalItems":4`,
        `"items":[{`,
        `"id":"1tmknxy2868d869"`,
        `"id":"lcl9d87w22ml6jy"`,
        `"id":"7nwo8tuiatetxdm"`,
        `"id":"mk5fmymtx4wsprk"`,
      ],
    },
    {
      name: "authenticated regular record filtering with a hidden field",
      method: "GET",
      url: "/api/collections/demo3/records?filter=title~'test'",
      headers: { Authorization: clientsToken },
      prepare: ({ dataDir }) =>
        updateCollection(dataDir, "demo3", (col) => {
          // mock hidden field
          col.fields.getByName("title")?.setHidden(true);
        }),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "superuser filtering with a hidden field",
      method: "GET",
      url: "/api/collections/demo3/records?filter=title~'test'",
      headers: { Authorization: superuserToken },
      prepare: ({ dataDir }) =>
        updateCollection(dataDir, "demo3", (col) => {
          // mock hidden field
          col.fields.getByName("title")?.setHidden(true);
        }),
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalPages":1`,
        `"totalItems":4`,
        `"items":[{`,
        `"id":"1tmknxy2868d869"`,
        `"id":"lcl9d87w22ml6jy"`,
        `"id":"7nwo8tuiatetxdm"`,
        `"id":"mk5fmymtx4wsprk"`,
      ],
    },
    {
      name: ":rule modifer",
      method: "GET",
      url: "/api/collections/demo5/records",
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalPages":1`,
        `"totalItems":1`,
        `"items":[{`,
        `"id":"qjeql998mtp1azp"`,
      ],
    },
    {
      name: "multi-match - at least one of (guest - non-satisfied relation filter API rule)",
      method: "GET",
      url:
        "/api/collections/demo4/records?filter=" +
        queryEscape("rel_many_no_cascade_required.files:length?=2"),
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalPages":0`,
        `"totalItems":0`,
        `"items":[]`,
      ],
    },
    {
      name: "multi-match - at least one of (clients)",
      method: "GET",
      url:
        "/api/collections/demo4/records?filter=" +
        queryEscape("rel_many_no_cascade_required.files:length?=2"),
      headers: { Authorization: clientsToken },
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalPages":1`,
        `"totalItems":1`,
        `"items":[{`,
        `"id":"qzaqccwrmva4o1n"`,
      ],
    },
    {
      name: "multi-match - all (clients)",
      method: "GET",
      url:
        "/api/collections/demo4/records?filter=" +
        queryEscape("rel_many_no_cascade_required.files:length=2"),
      headers: { Authorization: clientsToken },
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalPages":0`,
        `"totalItems":0`,
        `"items":[]`,
      ],
    },
    // "OnRecordsListRequest tx body write check" is not ported: it binds an
    // OnRecordsListRequest hook that wraps the handler in a transaction and
    // fails it (iglo.base has no hooks, and the upstream binary none either).
    {
      name: "check email visibility as guest",
      method: "GET",
      url: "/api/collections/nologin/records",
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalPages":1`,
        `"totalItems":3`,
        `"items":[{`,
        `"id":"phhq3wr65cap535"`,
        `"id":"dc49k6jgejn40h3"`,
        `"id":"oos036e9xvqeexy"`,
        `"email":"test2@example.com"`,
        `"emailVisibility":true`,
        `"emailVisibility":false`,
      ],
      notExpectedContent: [
        `"tokenKey"`,
        `"password"`,
        `"email":"test@example.com"`,
        `"email":"test3@example.com"`,
      ],
    },
    {
      name: "check email visibility as any authenticated record",
      method: "GET",
      url: "/api/collections/nologin/records",
      headers: { Authorization: clientsToken },
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalPages":1`,
        `"totalItems":3`,
        `"items":[{`,
        `"id":"phhq3wr65cap535"`,
        `"id":"dc49k6jgejn40h3"`,
        `"id":"oos036e9xvqeexy"`,
        `"email":"test2@example.com"`,
        `"emailVisibility":true`,
        `"emailVisibility":false`,
      ],
      notExpectedContent: [
        `"tokenKey":"`,
        `"password":""`,
        `"email":"test@example.com"`,
        `"email":"test3@example.com"`,
      ],
    },
    {
      name: "check email visibility as manage auth record",
      method: "GET",
      url: "/api/collections/nologin/records",
      headers: { Authorization: usersToken },
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalPages":1`,
        `"totalItems":3`,
        `"items":[{`,
        `"id":"phhq3wr65cap535"`,
        `"id":"dc49k6jgejn40h3"`,
        `"id":"oos036e9xvqeexy"`,
        `"email":"test@example.com"`,
        `"email":"test2@example.com"`,
        `"email":"test3@example.com"`,
        `"emailVisibility":true`,
        `"emailVisibility":false`,
      ],
      notExpectedContent: [`"tokenKey"`, `"password"`],
    },
    {
      name: "check email visibility as superuser",
      method: "GET",
      url: "/api/collections/nologin/records",
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalPages":1`,
        `"totalItems":3`,
        `"items":[{`,
        `"id":"phhq3wr65cap535"`,
        `"id":"dc49k6jgejn40h3"`,
        `"id":"oos036e9xvqeexy"`,
        `"email":"test@example.com"`,
        `"email":"test2@example.com"`,
        `"email":"test3@example.com"`,
        `"emailVisibility":true`,
        `"emailVisibility":false`,
      ],
      notExpectedContent: [`"tokenKey"`, `"password"`],
    },
    {
      name: "check self email visibility resolver",
      method: "GET",
      url: "/api/collections/nologin/records",
      headers: { Authorization: nologinToken },
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalPages":1`,
        `"totalItems":3`,
        `"items":[{`,
        `"id":"phhq3wr65cap535"`,
        `"id":"dc49k6jgejn40h3"`,
        `"id":"oos036e9xvqeexy"`,
        `"email":"test2@example.com"`,
        `"email":"test@example.com"`,
        `"emailVisibility":true`,
        `"emailVisibility":false`,
      ],
      notExpectedContent: [`"tokenKey"`, `"password"`, `"email":"test3@example.com"`],
    },
    {
      name: "public view records",
      method: "GET",
      url: "/api/collections/view2/records?filter=state=false",
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalPages":1`,
        `"totalItems":2`,
        `"items":[{`,
        `"id":"al1h9ijdeojtsjy"`,
        `"id":"imy661ixudk5izi"`,
      ],
      notExpectedContent: [`"created"`, `"updated"`],
    },
    {
      name: "guest that doesn't match the view collection list rule",
      method: "GET",
      url: "/api/collections/view1/records",
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalPages":0`,
        `"totalItems":0`,
        `"items":[]`,
      ],
    },
    {
      name: "authenticated record that matches the view collection list rule",
      method: "GET",
      url: "/api/collections/view1/records",
      headers: { Authorization: usersToken },
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalPages":1`,
        `"totalItems":1`,
        `"items":[{`,
        `"id":"84nmscqy84lsi1t"`,
        `"bool":true`,
      ],
    },
    {
      name: "view collection with numeric ids",
      method: "GET",
      url: "/api/collections/numeric_id_view/records",
      expectedStatus: 200,
      expectedContent: [
        `"page":1`,
        `"perPage":30`,
        `"totalPages":1`,
        `"totalItems":2`,
        `"items":[{`,
        `"id":"1"`,
        `"id":"2"`,
      ],
    },
    {
      name: "RateLimit rule - view2:list",
      method: "GET",
      url: "/api/collections/view2/records",
      prepare: ({ dataDir }) =>
        setRateLimits(dataDir, [
          { maxRequests: 100, label: "abc" },
          { maxRequests: 100, label: "*:list" },
          { maxRequests: 0, label: "view2:list" },
        ]),
      expectedStatus: 429,
      expectedContent: [`"data":{}`],
    },
    {
      name: "RateLimit rule - *:list",
      method: "GET",
      url: "/api/collections/view2/records",
      prepare: ({ dataDir }) =>
        setRateLimits(dataDir, [
          { maxRequests: 100, label: "abc" },
          { maxRequests: 0, label: "*:list" },
        ]),
      expectedStatus: 429,
      expectedContent: [`"data":{}`],
    },
  ],
};

export const recordCrudView: Suite = {
  file: "apis/record_crud_test.go",
  func: "TestRecordCrudView",
  scenarios: [
    {
      name: "missing collection",
      method: "GET",
      url: "/api/collections/missing/records/0yxhwia2amd8gec",
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "missing record",
      method: "GET",
      url: "/api/collections/demo2/records/missing",
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "unauthenticated trying to access nil rule collection (aka. need superuser auth)",
      method: "GET",
      url: "/api/collections/demo1/records/imy661ixudk5izi",
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authenticated record trying to access nil rule collection (aka. need superuser auth)",
      method: "GET",
      url: "/api/collections/demo1/records/imy661ixudk5izi",
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authenticated record that doesn't match the collection view rule",
      method: "GET",
      url: "/api/collections/users/records/bgs820n361vj1qd",
      headers: { Authorization: usersToken },
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "public collection view",
      method: "GET",
      url: "/api/collections/demo2/records/0yxhwia2amd8gec",
      expectedStatus: 200,
      expectedContent: [`"id":"0yxhwia2amd8gec"`, `"collectionName":"demo2"`],
    },
    {
      name: "public collection view (using the collection id)",
      method: "GET",
      url: "/api/collections/sz5l5z67tg7gku0/records/0yxhwia2amd8gec",
      expectedStatus: 200,
      expectedContent: [`"id":"0yxhwia2amd8gec"`, `"collectionName":"demo2"`],
    },
    {
      name: "authorized as superuser trying to access nil rule collection view (aka. need superuser auth)",
      method: "GET",
      url: "/api/collections/demo1/records/imy661ixudk5izi",
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [`"id":"imy661ixudk5izi"`, `"collectionName":"demo1"`],
    },
    {
      name: "authenticated record that does match the collection view rule",
      method: "GET",
      url: "/api/collections/users/records/4q1xlclmfloku33",
      headers: { Authorization: usersToken },
      expectedStatus: 200,
      expectedContent: [
        `"id":"4q1xlclmfloku33"`,
        `"collectionName":"users"`,
        // owners can always view their email
        `"emailVisibility":false`,
        `"email":"test@example.com"`,
      ],
    },
    {
      name: "expand relations",
      method: "GET",
      url: "/api/collections/demo1/records/al1h9ijdeojtsjy?expand=rel_one,rel_many.rel,missing&perPage=2&sort=created",
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [
        `"id":"al1h9ijdeojtsjy"`,
        `"collectionName":"demo1"`,
        `"rel_many":[{`,
        `"rel_one":{`,
        `"collectionName":"users"`,
        `"id":"bgs820n361vj1qd"`,
        `"expand":{"rel":{`,
        `"id":"0yxhwia2amd8gec"`,
        `"collectionName":"demo2"`,
      ],
    },
    // "OnRecordViewRequest tx body write check" is not ported: it binds an
    // OnRecordViewRequest hook that wraps the handler in a transaction and
    // fails it (iglo.base has no hooks, and the upstream binary none either).
    {
      name: "check email visibility as guest",
      method: "GET",
      url: "/api/collections/nologin/records/oos036e9xvqeexy",
      expectedStatus: 200,
      expectedContent: [`"id":"oos036e9xvqeexy"`, `"emailVisibility":false`, `"verified":true`],
      notExpectedContent: [`"tokenKey"`, `"password"`, `"email":"test3@example.com"`],
    },
    {
      name: "check email visibility as any authenticated record",
      method: "GET",
      url: "/api/collections/nologin/records/oos036e9xvqeexy",
      headers: { Authorization: clientsToken },
      expectedStatus: 200,
      expectedContent: [`"id":"oos036e9xvqeexy"`, `"emailVisibility":false`, `"verified":true`],
      notExpectedContent: [`"tokenKey"`, `"password"`, `"email":"test3@example.com"`],
    },
    {
      name: "check email visibility as manage auth record",
      method: "GET",
      url: "/api/collections/nologin/records/oos036e9xvqeexy",
      headers: { Authorization: usersToken },
      expectedStatus: 200,
      expectedContent: [
        `"id":"oos036e9xvqeexy"`,
        `"emailVisibility":false`,
        `"email":"test3@example.com"`,
        `"verified":true`,
      ],
    },
    {
      name: "check email visibility as superuser",
      method: "GET",
      url: "/api/collections/nologin/records/oos036e9xvqeexy",
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [
        `"id":"oos036e9xvqeexy"`,
        `"emailVisibility":false`,
        `"email":"test3@example.com"`,
        `"verified":true`,
      ],
      notExpectedContent: [`"tokenKey"`, `"password"`],
    },
    {
      name: "check self email visibility resolver",
      method: "GET",
      url: "/api/collections/nologin/records/dc49k6jgejn40h3",
      headers: { Authorization: nologinToken },
      expectedStatus: 200,
      expectedContent: [
        `"id":"dc49k6jgejn40h3"`,
        `"email":"test@example.com"`,
        `"emailVisibility":false`,
        `"verified":false`,
      ],
      notExpectedContent: [`"tokenKey"`, `"password"`],
    },
    {
      name: "public view record",
      method: "GET",
      url: "/api/collections/view2/records/84nmscqy84lsi1t",
      expectedStatus: 200,
      expectedContent: [
        `"id":"84nmscqy84lsi1t"`,
        `"state":true`,
        `"file_many":["`,
        `"rel_many":["`,
      ],
      notExpectedContent: [`"created"`, `"updated"`],
    },
    {
      name: "guest that doesn't match the view collection view rule",
      method: "GET",
      url: "/api/collections/view1/records/84nmscqy84lsi1t",
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authenticated record that matches the view collection view rule",
      method: "GET",
      url: "/api/collections/view1/records/84nmscqy84lsi1t",
      headers: { Authorization: usersToken },
      expectedStatus: 200,
      expectedContent: [`"id":"84nmscqy84lsi1t"`, `"bool":true`, `"text":"`],
    },
    {
      name: "view record with numeric id",
      method: "GET",
      url: "/api/collections/numeric_id_view/records/1",
      expectedStatus: 200,
      expectedContent: [`"id":"1"`],
    },
    {
      name: "RateLimit rule - numeric_id_view:view",
      method: "GET",
      url: "/api/collections/numeric_id_view/records/1",
      prepare: ({ dataDir }) =>
        setRateLimits(dataDir, [
          { maxRequests: 100, label: "abc" },
          { maxRequests: 100, label: "*:view" },
          { maxRequests: 0, label: "numeric_id_view:view" },
        ]),
      expectedStatus: 429,
      expectedContent: [`"data":{}`],
    },
    {
      name: "RateLimit rule - *:view",
      method: "GET",
      url: "/api/collections/numeric_id_view/records/1",
      prepare: ({ dataDir }) =>
        setRateLimits(dataDir, [
          { maxRequests: 100, label: "abc" },
          { maxRequests: 0, label: "*:view" },
        ]),
      expectedStatus: 429,
      expectedContent: [`"data":{}`],
    },
  ],
};
