// The Collections API differential cases (api.test.ts): sessions of
// requests sent to upstream and iglo.base in the same order, each server on
// its own copy of upstream's fixture. A session's requests change the
// collections for the ones after them, as a dashboard session would.

import { setRateLimits } from "@test/scenarios/prepare";

export type Identity = "guest" | "users" | "superuser";

export interface ApiCase {
  name: string;
  as: Identity;
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  url: string;
  body?: string;
  headers?: Record<string, string>;
}

export interface Session {
  name: string;
  cases: ApiCase[];
  // whether pb_data written by iglo.base is read back by upstream after
  // the session (the cross-server round trip)
  roundTrip?: boolean;
  // changes the fixture copy before the servers start on it
  prepare?: (dataDir: string) => void;
}

const su = (
  name: string,
  method: ApiCase["method"],
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
): ApiCase => ({
  name,
  as: "superuser",
  method,
  url,
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  headers,
});

const get = (name: string, url: string): ApiCase => su(name, "GET", url);

const listAll = get("list all collections", "/api/collections?perPage=500");

// every collections endpoint, for the access checks
const endpoints: [ApiCase["method"], string, string][] = [
  ["GET", "/api/collections", ""],
  ["POST", "/api/collections", `{"name":"access_test","type":"base"}`],
  ["GET", "/api/collections/demo1", ""],
  ["PATCH", "/api/collections/demo1", `{"listRule":""}`],
  ["DELETE", "/api/collections/demo2", ""],
  ["DELETE", "/api/collections/demo1/truncate", ""],
  ["PUT", "/api/collections/import", `{"collections":[{"name":"access_test"}]}`],
  ["GET", "/api/collections/meta/scaffolds", ""],
  ["GET", "/api/collections/meta/oauth2-providers", ""],
  ["POST", "/api/collections/meta/dry-run-view", `{"query":"select 1 as id"}`],
];

export const sessions: Session[] = [
  {
    // registerSettingsHooks (core/settings_model.go): a collection rename
    // relabels the "<name>:" rate limit rules
    name: "rate limit rules follow a rename",
    roundTrip: true,
    prepare: (dataDir) =>
      setRateLimits(dataDir, [
        { label: "demo2:create", maxRequests: 1000 },
        { label: "demo2:list", maxRequests: 1000, audience: "@guest" },
        { label: "demo22:list", maxRequests: 1000 },
        { label: "*:create", maxRequests: 1000 },
        { label: "clients:auth", maxRequests: 1000 },
        { label: "/api/demo2:x", maxRequests: 1000 },
      ]),
    cases: [
      su("rename", "PATCH", "/api/collections/demo2", { name: "demo2_new" }),
      get("relabeled rules", "/api/settings"),
      su("rename back with another change", "PATCH", "/api/collections/demo2_new", {
        name: "demo2",
        listRule: null,
      }),
      su("rename through import", "PUT", "/api/collections/import", {
        collections: [{ id: "v851q4r790rhknl", name: "clients_renamed" }],
      }),
      su("a failed rename", "PATCH", "/api/collections/demo2", { name: "users" }),
      get("rules after the import", "/api/settings"),
    ],
  },
  {
    name: "access",
    cases: [
      ...endpoints.flatMap(([method, url, body]) =>
        (["guest", "users"] as const).map((as) => ({
          name: `${method} ${url} as ${as}`,
          as,
          method,
          url,
          body: body === "" ? undefined : body,
        })),
      ),
      // nothing changed
      listAll,
    ],
  },
  {
    name: "list and view",
    cases: [
      get("filter by type, sort by name desc", "/api/collections?filter=type%3D'auth'&sort=-name"),
      get(
        "filter system, sort by created",
        "/api/collections?filter=system%3Dtrue&sort=created,id",
      ),
      get("filter name like, page 2", "/api/collections?filter=name~'demo'&perPage=2&page=2"),
      get("sort by updated and name, skipTotal", "/api/collections?sort=-updated,name&skipTotal=1"),
      get(
        "filter by id with fields",
        "/api/collections?filter=id%3D'wsmn24bux7wo113'&fields=id,name",
      ),
      get("filter or on name", "/api/collections?filter=(name%3D'demo2'||name%3D'view1')"),
      get("filter by a not allowed field", "/api/collections?filter=listRule%3D''"),
      get("sort by a not allowed field", "/api/collections?sort=fields"),
      get("invalid filter syntax", "/api/collections?filter=name%3D"),
      get("random sort", "/api/collections?sort=@random&filter=name%3D'demo1'"),
      get("view by id", "/api/collections/_pb_users_auth_"),
      get("view by name, case insensitive", "/api/collections/DEMO2"),
      get("view a view collection with fields", "/api/collections/view2?fields=name,fields.name"),
      get("view missing", "/api/collections/missing"),
      get(
        "scaffolds with fields",
        "/api/collections/meta/scaffolds?fields=base.type,view.viewQuery",
      ),
    ],
  },
  {
    name: "create",
    roundTrip: true,
    cases: [
      su("base with fields, rules and indexes", "POST", "/api/collections", {
        id: "articles_id_001",
        name: "articles",
        type: "base",
        listRule: "",
        viewRule: "@request.auth.id != ''",
        createRule: null,
        fields: [
          { name: "title", type: "text", required: true, max: 200 },
          { name: "views", type: "number", onlyInt: true, min: 0 },
          { name: "tags", type: "select", values: ["a", "b", "c"], maxSelect: 2 },
          { name: "cover", type: "file", maxSelect: 1, maxSize: 1000 },
          { name: "author", type: "relation", collectionId: "_pb_users_auth_", maxSelect: 1 },
          { name: "meta", type: "json", maxSize: 100 },
          { name: "created", type: "autodate", onCreate: true },
        ],
        indexes: ["CREATE INDEX idx_articles_title ON articles (title)"],
      }),
      su("base with a duplicated name", "POST", "/api/collections", {
        name: "Articles",
        type: "base",
      }),
      su("base without a name", "POST", "/api/collections", { type: "base" }),
      su("base with an unknown field type", "POST", "/api/collections", {
        name: "invalid_field",
        fields: [{ name: "x", type: "unknown" }],
      }),
      su("base with invalid field settings", "POST", "/api/collections", {
        name: "invalid_field",
        fields: [
          { name: "", type: "text" },
          { name: "num", type: "number", min: 5, max: 1 },
          { name: "num", type: "bool" },
          { name: "rel", type: "relation", collectionId: "missing" },
        ],
      }),
      su("base with an invalid rule", "POST", "/api/collections", {
        name: "invalid_rule",
        listRule: "missing = 1",
        viewRule: "title ~",
      }),
      su("base with an index on a missing column", "POST", "/api/collections", {
        name: "invalid_index",
        indexes: ["CREATE INDEX idx_invalid_index ON invalid_index (missing)", "invalid"],
      }),
      su("unknown type", "POST", "/api/collections", { name: "unknown_type", type: "abc" }),
      su("syntax error", "POST", "/api/collections", `{"name":"broken",`),
      su("auth with options", "POST", "/api/collections", {
        name: "members",
        type: "auth",
        authRule: "verified = true",
        manageRule: null,
        passwordAuth: { enabled: true, identityFields: ["email"] },
        oauth2: {
          enabled: true,
          providers: [{ name: "google", clientId: "test_id", clientSecret: "test_secret" }],
        },
        otp: { enabled: true, duration: 120, length: 6 },
        mfa: { enabled: false, duration: 600 },
        authToken: { duration: 3600 },
        fields: [{ name: "nickname", type: "text" }],
      }),
      su("auth with invalid options", "POST", "/api/collections", {
        name: "members_invalid",
        type: "auth",
        passwordAuth: { enabled: true, identityFields: ["missing"] },
        oauth2: { enabled: true, providers: [{ name: "unknown" }] },
        authToken: { duration: 0 },
      }),
      su("view", "POST", "/api/collections", {
        name: "articles_view",
        type: "view",
        listRule: "",
        viewQuery: "select id, title, views, author from articles",
      }),
      su("view with an invalid query", "POST", "/api/collections", {
        name: "broken_view",
        type: "view",
        viewQuery: "select * from missing_table",
      }),
      su("view without an id column", "POST", "/api/collections", {
        name: "no_id_view",
        type: "view",
        viewQuery: "select title from articles",
      }),
      su("relation to the new collection with cascade", "POST", "/api/collections", {
        name: "comments",
        fields: [
          {
            name: "article",
            type: "relation",
            collectionId: "articles_id_001",
            cascadeDelete: true,
            required: true,
            maxSelect: 1,
          },
          { name: "body", type: "editor" },
        ],
      }),
      su(
        "form-urlencoded",
        "POST",
        "/api/collections",
        "name=form_created&type=base&listRule=&viewRule=id%3D''&indexes=CREATE+INDEX+idx_form+ON+form_created+(id)&system=false",
        { "content-type": "application/x-www-form-urlencoded" },
      ),
      su(
        "multipart with @jsonPayload",
        "POST",
        "/api/collections",
        '--X\r\nContent-Disposition: form-data; name="name"\r\n\r\nmp_created\r\n' +
          '--X\r\nContent-Disposition: form-data; name="@jsonPayload"\r\n\r\n' +
          '{"name":"mp_created","listRule":"","fields":[{"name":"t","type":"text"}]}\r\n--X--\r\n',
        { "content-type": "multipart/form-data; boundary=X" },
      ),
      su(
        "form-urlencoded update",
        "PATCH",
        "/api/collections/form_created",
        "listRule=&createRule=id%3D''&name=form_renamed",
        { "content-type": "application/x-www-form-urlencoded" },
      ),
      get("view the created auth collection", "/api/collections/members"),
      get("list the created collections", "/api/collections?filter=created>'2024-01-01'&sort=name"),
    ],
  },
  {
    name: "update and rename",
    roundTrip: true,
    cases: [
      su("rename a collection", "PATCH", "/api/collections/demo2", { name: "demo2_renamed" }),
      get("records follow the rename", "/api/collections/demo2_renamed/records?sort=id"),
      get("the old name is gone", "/api/collections/demo2"),
      su("rename a field", "PATCH", "/api/collections/demo2_renamed", {
        fields: [
          {
            id: "_pbf_text_id_",
            name: "id",
            type: "text",
            primaryKey: true,
            system: true,
            required: true,
            pattern: "^[a-z0-9]+$",
            min: 15,
            max: 15,
            autogeneratePattern: "[a-z0-9]{15}",
          },
          { id: "mkrguaaf", name: "headline", type: "text" },
          { id: "izkl5z2s", name: "active", type: "bool" },
          {
            id: "_pbf_autodate_created_",
            name: "created",
            type: "autodate",
            onCreate: true,
            system: false,
          },
          {
            id: "_pbf_autodate_updated_",
            name: "updated",
            type: "autodate",
            onCreate: true,
            onUpdate: true,
          },
        ],
        indexes: [
          "CREATE INDEX `idx_demo2_created` ON `demo2_renamed` (`created`)",
          'CREATE UNIQUE INDEX "idx_unique_demo2_title" on "demo2_renamed" ("headline")',
        ],
      }),
      get("records with the renamed field", "/api/collections/demo2_renamed/records?sort=headline"),
      su("drop a field", "PATCH", "/api/collections/demo3", {
        fields: [
          {
            id: "_pbf_text_id_",
            name: "id",
            type: "text",
            primaryKey: true,
            system: true,
            required: true,
            pattern: "^[a-z0-9]+$",
            min: 15,
            max: 15,
            autogeneratePattern: "[a-z0-9]{15}",
          },
          { id: "w5z2x0nq", name: "title", type: "text" },
          { id: "_pbf_autodate_created_", name: "created", type: "autodate", onCreate: true },
          {
            id: "_pbf_autodate_updated_",
            name: "updated",
            type: "autodate",
            onCreate: true,
            onUpdate: true,
          },
        ],
      }),
      su("change rules and auth options", "PATCH", "/api/collections/clients", {
        listRule: "id = @request.auth.id",
        passwordAuth: { identityFields: ["email", "username"] },
        authToken: { duration: 7200 },
      }),
      su("out of range option of a disabled otp", "PATCH", "/api/collections/clients", {
        otp: { duration: -1 },
      }),
      su("invalid auth option update", "PATCH", "/api/collections/clients", {
        otp: { enabled: true, duration: 0, length: 0 },
        passwordAuth: { identityFields: [] },
      }),
      su("rename a system collection", "PATCH", "/api/collections/_superusers", {
        name: "admins",
      }),
      su("change a system collection's rules", "PATCH", "/api/collections/nologin", {
        listRule: "",
      }),
      su("change a view query", "PATCH", "/api/collections/view1", {
        viewQuery: "select id, text, bool from demo1",
      }),
      su("invalid view query", "PATCH", "/api/collections/view1", {
        viewQuery: "delete from demo1",
      }),
      su("change a collection's type", "PATCH", "/api/collections/demo1", { type: "auth" }),
      su("an index name used in another collection", "PATCH", "/api/collections/demo1", {
        indexes: ["CREATE INDEX idx_demo2_created ON demo1 (text)"],
      }),
      su("update missing", "PATCH", "/api/collections/missing", { name: "x" }),
      su("syntax error", "PATCH", "/api/collections/demo1", `{"name":1}`),
      get("view the updated collection", "/api/collections/demo2_renamed"),
    ],
  },
  {
    name: "delete",
    roundTrip: true,
    cases: [
      su("referenced by another collection", "DELETE", "/api/collections/demo2"),
      su("referenced by another collection (demo4 from demo5)", "DELETE", "/api/collections/demo4"),
      su("used by view queries", "DELETE", "/api/collections/demo1"),
      su("a view used by another view", "DELETE", "/api/collections/view1"),
      su("a view", "DELETE", "/api/collections/view2"),
      su("with files", "DELETE", "/api/collections/demo5"),
      su("its former reference", "DELETE", "/api/collections/demo4"),
      su("with files, by id", "DELETE", "/api/collections/wzlqyes4orhoygb"),
      su("a system collection", "DELETE", "/api/collections/_otps"),
      su("missing", "DELETE", "/api/collections/demo5"),
      listAll,
    ],
  },
  {
    name: "truncate",
    roundTrip: true,
    cases: [
      su("with required references", "DELETE", "/api/collections/demo3/truncate"),
      su("with files and a self reference", "DELETE", "/api/collections/demo1/truncate"),
      get("records are gone", "/api/collections/demo1/records"),
      su("with cascade references and files", "DELETE", "/api/collections/users/truncate"),
      get("cascaded records", "/api/collections/demo1/records"),
      su("a view", "DELETE", "/api/collections/view1/truncate"),
      su("missing", "DELETE", "/api/collections/missing/truncate"),
      su("a system collection", "DELETE", "/api/collections/_authOrigins/truncate"),
      get("auth origins", "/api/collections/_authOrigins/records"),
    ],
  },
  {
    name: "import",
    roundTrip: true,
    cases: [
      su("no body", "PUT", "/api/collections/import"),
      su("collections is not an array", "PUT", "/api/collections/import", { collections: "x" }),
      su("collection is not an object", "PUT", "/api/collections/import", { collections: [1] }),
      su("validation errors", "PUT", "/api/collections/import", {
        collections: [{ name: "" }, { name: "import_ok" }, { id: "x", name: "bad name!" }],
      }),
      su("create and update without deleteMissing", "PUT", "/api/collections/import", {
        collections: [
          { name: "imported1", fields: [{ name: "title", type: "text" }] },
          {
            id: "sz5l5z67tg7gku0",
            name: "demo2",
            listRule: "",
            fields: [{ id: "mkrguaaf", name: "title", type: "text", max: 50 }],
          },
          {
            name: "imported_view",
            type: "view",
            viewQuery: "select id, title from imported1",
          },
        ],
      }),
      get("the imported collection", "/api/collections/imported1"),
      get("the updated collection", "/api/collections/demo2"),
      su("with deleteMissing, users without its fields", "PUT", "/api/collections/import", {
        deleteMissing: true,
        collections: [
          { name: "imported2" },
          {
            id: "sz5l5z67tg7gku0",
            name: "demo2",
            fields: [{ id: "mkrguaaf", name: "title", type: "text" }],
          },
          { id: "_pb_users_auth_", name: "users", type: "auth" },
        ],
      }),
      su("with deleteMissing", "PUT", "/api/collections/import", {
        deleteMissing: true,
        collections: [
          { name: "imported2", fields: [{ name: "note", type: "text" }] },
          {
            id: "sz5l5z67tg7gku0",
            name: "demo2",
            fields: [
              { id: "mkrguaaf", name: "title", type: "text" },
              { id: "izkl5z2s", name: "active", type: "bool" },
            ],
            indexes: [],
          },
        ],
      }),
      listAll,
      get("records of the kept collection", "/api/collections/demo2/records?sort=id"),
    ],
  },
  {
    name: "dry-run view",
    cases: [
      su("relations and files", "POST", "/api/collections/meta/dry-run-view", {
        query: "select id, rel_one, file_one, number, json from demo1",
      }),
      su("aggregate with a cast", "POST", "/api/collections/meta/dry-run-view", {
        query:
          "select users.id, count(demo1.id) as total from users left join demo1 on demo1.rel_many like '%' || users.id || '%' group by users.id",
      }),
      su("empty query", "POST", "/api/collections/meta/dry-run-view", { query: "" }),
      su("missing table", "POST", "/api/collections/meta/dry-run-view", {
        query: "select id from missing",
      }),
      su("not a select", "POST", "/api/collections/meta/dry-run-view", {
        query: "update demo1 set text = 'x'",
      }),
      su("form body", "POST", "/api/collections/meta/dry-run-view", "query=select+id+from+demo2", {
        "content-type": "application/x-www-form-urlencoded",
      }),
      get("demo1 is unchanged", "/api/collections/demo1/records?sort=id"),
    ],
  },
  {
    name: "forced _superusers options",
    roundTrip: true,
    cases: [
      su("OTP turns MFA on", "PATCH", "/api/collections/_superusers", {
        otp: { enabled: true },
        mfa: { enabled: false },
      }),
      su("MFA stays on while OTP is on", "PATCH", "/api/collections/_superusers", {
        mfa: { enabled: false },
      }),
      su("MFA can go with OTP", "PATCH", "/api/collections/_superusers", {
        otp: { enabled: false },
        mfa: { enabled: false },
      }),
      su("password auth stays on", "PATCH", "/api/collections/_superusers", {
        passwordAuth: { enabled: false },
      }),
      su("OAuth2 stays off", "PATCH", "/api/collections/_superusers", {
        oauth2: {
          enabled: true,
          providers: [{ name: "google", clientId: "test", clientSecret: "test" }],
        },
      }),
      su("the same through import", "PUT", "/api/collections/import", {
        collections: [{ name: "_superusers", type: "auth", otp: { enabled: true } }],
        deleteMissing: false,
      }),
      get("what was stored", "/api/collections/_superusers"),
    ],
  },
];
