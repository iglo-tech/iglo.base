// POST /api/batch on the batch data set (schema.ts), in this order on one
// pair of servers (batch.test.ts). Ids of records the cases read back are
// fixed, so the read-backs need no pairing.

import { clientsToken, superuserToken, usersToken } from "@test/scenarios/record-crud";
import { multipart } from "@test/scenarios/multipart";

export interface BatchItem {
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface BatchCase {
  name: string;
  // the request's Authorization
  token?: string;
  headers?: Record<string, string>;
  // the items, a raw JSON body or a multipart body
  items?: BatchItem[];
  raw?: string;
  multipart?: ReturnType<typeof multipart>;
  // the query of the batch URL
  query?: string;
  // `batch` settings for this case only
  settings?: Record<string, unknown>;
  // the collections read back from both servers after the case
  reads?: string[];
}

const records = (collection: string, rest = ""): string =>
  `/api/collections/${collection}/records${rest}`;

const create = (collection: string, body: unknown, query = ""): BatchItem => ({
  method: "POST",
  url: records(collection, query),
  body,
});
const update = (collection: string, id: string, body: unknown, query = ""): BatchItem => ({
  method: "PATCH",
  url: records(collection, `/${id}${query}`),
  body,
});
const upsert = (collection: string, body: unknown, query = ""): BatchItem => ({
  method: "PUT",
  url: records(collection, query),
  body,
});
const remove = (collection: string, id: string): BatchItem => ({
  method: "DELETE",
  url: records(collection, `/${id}`),
});

const id = (name: string): string => name.padEnd(15, "0");

const authFields = "?fields=id,email,emailVisibility,verified,secret,name";

export const batchCases: BatchCase[] = [
  // each action
  {
    name: "create",
    items: [create("b_parents", { id: id("p1"), title: "p1" })],
    reads: ["b_parents"],
  },
  {
    name: "update",
    items: [update("b_parents", id("p1"), { title: "p1 updated" })],
    reads: ["b_parents"],
  },
  {
    name: "upsert as create",
    items: [upsert("b_parents", { id: id("p2"), title: "p2" })],
    reads: ["b_parents"],
  },
  {
    name: "upsert as create without an id",
    items: [upsert("b_parents", { title: "p no id" })],
  },
  {
    name: "upsert as update",
    items: [upsert("b_parents", { id: id("p2"), title: "p2 upserted" })],
    reads: ["b_parents"],
  },
  {
    name: "upsert of a numeric id",
    items: [upsert("b_parents", { id: 12345, title: "numeric" })],
  },
  {
    name: "upsert of a missing collection",
    items: [upsert("b_missing", { id: id("x"), title: "x" })],
  },
  {
    name: "upsert create then upsert update of the same id",
    items: [
      upsert("b_parents", { id: id("p3"), title: "p3" }),
      upsert("b_parents", { id: id("p3"), title: "p3 again" }),
    ],
    reads: ["b_parents"],
  },
  {
    name: "delete",
    items: [remove("b_parents", id("p3"))],
    reads: ["b_parents"],
  },
  {
    name: "delete a missing record",
    items: [remove("b_parents", id("missing"))],
  },

  // a later item reads what an earlier one wrote
  {
    name: "relation to a record of an earlier item",
    items: [
      create("b_parents", { id: id("p4"), title: "p4" }),
      create("b_children", { id: id("c4"), title: "c4", parent: id("p4") }, "?expand=parent"),
    ],
    reads: ["b_parents", "b_children"],
  },
  {
    name: "rule that reads a record of an earlier item",
    items: [
      create("b_parents", { id: id("p5"), title: "allowed" }),
      create("b_refrule", { id: id("r5"), title: "allowed" }),
    ],
    reads: ["b_refrule"],
  },
  {
    name: "rule that fails without the earlier item",
    items: [
      create("b_refrule", { id: id("r6"), title: "not there yet" }),
      create("b_parents", { id: id("p6"), title: "not there yet" }),
    ],
    reads: ["b_parents", "b_refrule"],
  },
  {
    name: "unique index against an earlier item",
    items: [
      create("b_parents", { id: id("p7"), title: "same" }),
      create("b_parents", { id: id("p8"), title: "same" }),
    ],
    reads: ["b_parents"],
  },
  {
    name: "update then expand of the updated relation",
    items: [
      update("b_parents", id("p4"), { title: "p4 renamed" }),
      update("b_children", id("c4"), { title: "c4 renamed" }, "?expand=parent"),
    ],
  },
  {
    name: "delete then a relation to the deleted record",
    items: [
      create("b_parents", { id: id("p9"), title: "p9" }),
      remove("b_parents", id("p9")),
      create("b_children", { id: id("c9"), title: "c9", parent: id("p9") }),
    ],
    reads: ["b_parents", "b_children"],
  },

  // `?expand=` and `?fields=`
  {
    name: "expand and fields in item urls",
    items: [
      update(
        "b_children",
        id("c4"),
        { title: "c4 fields" },
        "?expand=parent&fields=id,expand.parent.title",
      ),
      update("b_parents", id("p4"), { title: "p4 excerpt" }, "?fields=title:excerpt(3,true)"),
    ],
  },
  {
    name: "fields on the batch url",
    query: "?fields=status",
    items: [update("b_parents", id("p4"), { title: "p4 outer" })],
  },
  {
    name: "a query value next to the same body key",
    items: [update("b_parents", id("p4"), { title: "from body" }, "?title=5")],
  },
  {
    name: "a query value of a field not in the body",
    items: [update("b_parents", id("p4"), {}, "?title=from_query")],
    reads: ["b_parents"],
  },
  {
    name: "an invalid item query",
    items: [update("b_parents", id("p4"), { title: "x" }, "?a=%zz")],
  },
  {
    name: "an invalid item path escape",
    items: [{ method: "PATCH", url: records("b_parents", "/%zz"), body: {} }],
  },

  // headers, auth and context in rules
  {
    name: "per-item headers visible to rules",
    items: [
      {
        ...create("b_rules", { id: id("h1"), title: "h1" }),
        headers: { "X-Tenant": "acme" },
      },
    ],
    reads: ["b_rules"],
  },
  {
    name: "rule failure without the item header",
    items: [create("b_rules", { id: id("h2"), title: "h2" })],
    reads: ["b_rules"],
  },
  {
    name: "a non-Latin-1 item header value",
    items: [
      {
        ...create("b_rules", { id: id("h3"), title: "h3" }),
        headers: { "X-Tenant": "acme", "X-Name": "żółć" },
      },
    ],
  },
  {
    name: "the base request headers reach the rules",
    headers: { "X-Tenant": "acme" },
    items: [
      update("b_rules", id("h1"), { title: "h1 updated" }),
      { ...update("b_rules", id("h1"), { title: "h1 ignored" }), headers: { "X-Tenant": "other" } },
    ],
    reads: ["b_rules"],
  },
  {
    name: "the item Authorization is ignored",
    token: usersToken,
    items: [
      {
        ...create("b_auth_only", { id: id("a1"), title: "a1" }),
        headers: { Authorization: "invalid" },
      },
    ],
    reads: ["b_auth_only"],
  },
  {
    name: "a guest item with an item Authorization",
    items: [
      {
        ...create("b_auth_only", { id: id("a2"), title: "a2" }),
        headers: { Authorization: usersToken },
      },
    ],
    reads: ["b_auth_only"],
  },
  {
    name: "context in rules",
    items: [
      {
        ...update("b_rules", id("h1"), { title: "h1 context" }),
        headers: { "x-tenant": "acme" },
      },
      remove("b_rules", id("h1")),
    ],
    reads: ["b_rules"],
  },
  {
    name: "the method a rule sees on an upsert",
    items: [
      upsert("b_method", { id: id("m1"), title: "created" }),
      upsert("b_method", { id: id("m1"), title: "updated" }),
    ],
    reads: ["b_method"],
  },

  // failures: the index and the body shape
  {
    name: "failure on the first item",
    items: [
      create("b_parents", { title: "" }),
      create("b_parents", { id: id("f1"), title: "f1" }),
      create("b_parents", { id: id("f2"), title: "f2" }),
    ],
    reads: ["b_parents"],
  },
  {
    name: "failure on a middle item",
    items: [
      create("b_parents", { id: id("f1"), title: "f1" }),
      create("b_parents", { title: "" }),
      create("b_parents", { id: id("f2"), title: "f2" }),
    ],
    reads: ["b_parents"],
  },
  {
    name: "failure on the last item",
    items: [
      create("b_parents", { id: id("f1"), title: "f1" }),
      create("b_parents", { id: id("f2"), title: "f2" }),
      create("b_parents", { title: "" }),
    ],
    reads: ["b_parents"],
  },
  {
    name: "unknown action on the first item",
    items: [{ method: "GET", url: "/api/health" }, create("b_parents", { title: "u" })],
  },
  {
    name: "unknown action on a later item",
    items: [
      create("b_parents", { id: id("u1"), title: "u1" }),
      { method: "GET", url: "/api/health" },
    ],
    reads: ["b_parents"],
  },
  {
    name: "unknown action after an update and a delete",
    items: [
      update("b_parents", id("p4"), { title: "p4 u" }),
      { method: "POST", url: "/api/collections/b_parents/records/x" },
    ],
  },
  {
    name: "a 403 and a 404 inside the error body",
    items: [create("b_superuser_only", { title: "x" })],
  },
  {
    name: "a view collection item",
    items: [create("b_view", { title: "x" })],
  },

  // limits and shapes
  {
    name: "too many items",
    settings: { maxRequests: 2 },
    items: Array.from({ length: 3 }, () => create("b_parents", { title: "x" })),
  },
  {
    name: "disabled batch",
    settings: { enabled: false },
    items: [create("b_parents", { title: "x" })],
  },
  {
    name: "maxBodySize over the limit",
    settings: { maxBodySize: 10 },
    items: [create("b_parents", { title: "x" })],
  },
  {
    name: "maxBodySize of a chunk of the body",
    settings: { maxBodySize: 200 },
    items: Array.from({ length: 5 }, (_, i) => create("b_parents", { title: `long title ${i}` })),
  },
  { name: "an empty request", raw: "" },
  { name: "an empty object", raw: "{}" },
  { name: "no items", raw: `{"requests":[]}` },
  { name: "null requests", raw: `{"requests":null}` },
  { name: "a malformed body", raw: `{"requests":` },
  {
    name: "a string body in an item",
    raw: `{"requests":[{"method":"POST","url":"/x","body":"x"}]}`,
  },
  {
    name: "a number header in an item",
    raw: `{"requests":[{"method":"POST","url":"/x","headers":{"a":1}}]}`,
  },
  {
    name: "a lowercase method",
    raw: `{"requests":[{"method":"post","url":"/api/collections/b_parents/records"}]}`,
  },
  {
    name: "an item body of null",
    raw: `{"requests":[{"method":"PATCH","url":"/api/collections/b_parents/records/${id("p4")}","body":null}]}`,
  },
  {
    name: "case-insensitive names",
    raw: `{"Requests":[{"METHOD":"PATCH","Url":"/api/collections/b_parents/records/${id("p4")}","Body":{"title":"ci"}}]}`,
  },

  {
    name: "a null item",
    raw: `{"requests":[null]}`,
  },

  // files
  {
    name: "files under requests.N.field and requests[N].field",
    token: superuserToken,
    multipart: multipart(
      {
        "@jsonPayload": JSON.stringify({
          requests: [
            create("b_files", { id: id("d1"), title: "d1" }),
            create("b_files", { id: id("d2"), title: "d2" }),
          ],
        }),
      },
      "requests.0.doc",
      "requests[1].files",
      "requests[1].files",
    ),
    reads: ["b_files"],
  },
  {
    name: "file append, prepend and delete modifiers",
    multipart: multipart(
      {
        "@jsonPayload": JSON.stringify({
          requests: [
            update("b_files", id("d2"), { title: "appended" }),
            update("b_files", id("d2"), { title: "prepended" }),
          ],
        }),
      },
      "requests.0.files+",
      "requests[1].+files",
    ),
    reads: ["b_files"],
  },
  {
    name: "a file key that replaces the same body key",
    multipart: multipart(
      {
        "@jsonPayload": JSON.stringify({
          requests: [update("b_files", id("d1"), { doc: "ignored.txt" })],
        }),
      },
      "requests.0.doc",
    ),
    reads: ["b_files"],
  },
  {
    name: "a file for an unknown field and an item that does not exist",
    multipart: multipart(
      {
        "@jsonPayload": JSON.stringify({
          requests: [update("b_files", id("d1"), { title: "d1 x" })],
        }),
      },
      "requests.0.unknown",
      "requests.5.doc",
    ),
    reads: ["b_files"],
  },
  {
    name: "a failed batch keeps its uploads out of storage",
    multipart: multipart(
      {
        "@jsonPayload": JSON.stringify({
          requests: [
            create("b_files", { id: id("d3"), title: "d3" }),
            create("b_files", { id: id("d4"), title: "" }),
          ],
        }),
      },
      "requests.0.doc",
      "requests.1.doc",
    ),
    reads: ["b_files"],
  },
  {
    name: "a multipart batch without a payload",
    multipart: multipart({ title: "x" }),
  },

  // auth collection items
  {
    name: "auth create as a guest: hidden field and email visibility",
    items: [
      create(
        "b_auth",
        {
          id: id("u1"),
          email: "u1@example.com",
          password: "1234567890",
          passwordConfirm: "1234567890",
          secret: "dropped",
          name: "u1",
        },
        authFields,
      ),
      create(
        "b_auth",
        {
          id: id("u2"),
          email: "u2@example.com",
          emailVisibility: true,
          password: "1234567890",
          passwordConfirm: "1234567890",
          name: "u2",
        },
        authFields,
      ),
    ],
  },
  {
    name: "auth create as a superuser with hidden fields",
    token: superuserToken,
    items: [
      create(
        "b_auth",
        {
          id: id("u3"),
          email: "u3@example.com",
          password: "1234567890",
          passwordConfirm: "1234567890",
          secret: "kept",
          verified: true,
        },
        authFields,
      ),
    ],
  },
  {
    name: "auth password mismatch",
    items: [
      create("b_auth", {
        email: "u4@example.com",
        password: "1234567890",
        passwordConfirm: "0987654321",
      }),
    ],
  },
  {
    name: "auth guest cannot set verified",
    items: [
      create(
        "b_auth",
        {
          email: "u5@example.com",
          password: "1234567890",
          passwordConfirm: "1234567890",
          verified: true,
        },
        authFields,
      ),
    ],
  },
  {
    name: "auth password change by a superuser, then sign in",
    token: superuserToken,
    items: [
      update(
        "b_auth",
        id("u1"),
        { password: "abcdefghij", passwordConfirm: "abcdefghij" },
        authFields,
      ),
    ],
  },

  // cascade delete
  {
    name: "cascade delete inside a batch",
    token: clientsToken,
    items: [
      create("b_parents", { id: id("k1"), title: "k1" }),
      create("b_children", { id: id("k2"), title: "k2", parent: id("k1") }),
      create("b_children", { id: id("k3"), title: "k3", parent: id("k1") }),
      remove("b_parents", id("k1")),
    ],
    reads: ["b_parents", "b_children"],
  },
  {
    name: "a required relation stops the delete",
    items: [
      create("b_parents", { id: id("k4"), title: "k4" }),
      create("b_required", { id: id("k5"), title: "k5", parent: id("k4") }),
      remove("b_parents", id("k4")),
    ],
    reads: ["b_parents", "b_required"],
  },

  // stored JSON and numbers
  {
    name: "json values and large integers in item bodies",
    raw: `{"requests":[
      {"method":"POST","url":"/api/collections/b_json/records","body":{"id":"${id("j1")}",
        "j":{"z":1,"10":2,"2":3,"a":[1.50,1e3,"x",null,{"b":12345678901234567890,"a":0.1}]},
        "n":9007199254740993}},
      {"method":"POST","url":"/api/collections/b_json/records","body":{"id":"${id("j2")}",
        "j":"{\\"text\\":12345678901234567890}","n":1.5e300}},
      {"method":"POST","url":"/api/collections/b_json/records","body":{"id":"${id("j3")}",
        "j":12345678901234567890,"n":-0.0}},
      {"method":"PATCH","url":"/api/collections/b_json/records/${id("j1")}","body":{"n+":1}}
    ]}`,
    reads: ["b_json"],
  },
  {
    name: "json values in a multipart payload",
    multipart: multipart({
      "@jsonPayload": `{"requests":[{"method":"POST","url":"/api/collections/b_json/records","body":{"id":"${id("j4")}","j":{"é":"ż","big":123456789012345678901234567890,"nested":{"b":[],"a":{}}},"n":0.1}}]}`,
    }),
    reads: ["b_json"],
  },
];
