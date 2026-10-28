// The collection validation cases of the reference test (validate.test.ts).
//
// setupCollections are created first, through upstream's POST
// /api/collections, on a fresh install (users, _superusers, _authOrigins,
// _externalAuths, _mfas, _otps). Then each case is sent, in order, as
// POST /api/collections (no target) or PATCH /api/collections/{target}.
// `valid` is the expected upstream outcome (200 or a 400 with validation
// errors); the test checks it, so the case counts are what upstream did.
// Valid cases change the state the later cases see, as they do upstream.
//
// A body is a function of the current state (Ctx): collection ids and the
// stored fields, read through upstream's GET before the case runs.

export interface Ctx {
  // the id of a collection (by name)
  id(collection: string): string;
  // the stored fields of a collection, as upstream's GET returns them
  fields(collection: string): Record<string, unknown>[];
  // one stored field (by name)
  field(collection: string, field: string): Record<string, unknown>;
}

export interface Pending {
  task: string;
  reason: string;
}

export interface ValidateCase {
  name: string;
  // PATCH /api/collections/{target}; POST /api/collections when unset
  target?: string;
  body: (ctx: Ctx) => unknown;
  valid: boolean;
  pending?: Pending;
}

export const pendingRule: Pending = {
  task: "M2.2",
  reason: "rule check needs the record field resolver",
};

export const setupCollections: ((ctx: Ctx) => unknown)[] = [
  (ctx) => ({
    name: "posts",
    type: "base",
    listRule: "",
    fields: [
      { name: "title", type: "text", required: true },
      { name: "slug", type: "text" },
      { name: "owner", type: "relation", collectionId: ctx.id("users"), maxSelect: 1 },
      { name: "body", type: "editor" },
    ],
    indexes: [
      "CREATE UNIQUE INDEX `idx_posts_slug` ON `posts` (`slug`)",
      "CREATE INDEX `idx_posts_title` ON `posts` (`title`)",
    ],
  }),
  () => ({
    name: "members",
    type: "auth",
    fields: [
      { name: "username", type: "text" },
      { name: "nick", type: "text" },
    ],
    indexes: ["CREATE UNIQUE INDEX `idx_members_username` ON `members` (`username`)"],
  }),
  () => ({
    name: "locked",
    type: "base",
    system: true,
    listRule: "",
    viewRule: null,
    fields: [
      { name: "code", type: "text", system: true },
      { name: "note", type: "text" },
    ],
    indexes: [
      "CREATE UNIQUE INDEX `idx_locked_code` ON `locked` (`code`)",
      "CREATE INDEX `idx_locked_note` ON `locked` (`note`)",
    ],
  }),
  () => ({
    name: "posts_view",
    type: "view",
    viewQuery: "select id, title from posts",
  }),
];

const longName = (n: number): string => "c" + "x".repeat(n - 1);

const tokenSecret = "s".repeat(40);

// every OAuth2 provider name upstream registers (tools/auth/*.go)
const providerNames = [
  "apple",
  "bitbucket",
  "box",
  "discord",
  "facebook",
  "gitea",
  "gitee",
  "github",
  "gitlab",
  "google",
  "instagram2",
  "kakao",
  "lark",
  "linear",
  "livechat",
  "mailcow",
  "microsoft",
  "monday",
  "notion",
  "oidc",
  "oidc2",
  "oidc3",
  "patreon",
  "planningcenter",
  "spotify",
  "strava",
  "trakt",
  "twitch",
  "twitter",
  "vk",
  "wakatime",
  "yandex",
];

const provider = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  clientId: "client-" + name,
  clientSecret: "secret-" + name,
  ...extra,
});

// the stored fields of a collection with one field changed
const withField = (
  ctx: Ctx,
  collection: string,
  field: string,
  change: (f: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown>[] =>
  ctx.fields(collection).map((f) => (f.name === field ? change({ ...f }) : f));

const withoutField = (ctx: Ctx, collection: string, field: string): Record<string, unknown>[] =>
  ctx.fields(collection).filter((f) => f.name !== field);

export const validateCases: ValidateCase[] = [
  // -----------------------------------------------------------------
  // id
  //
  // An update that changes the id cannot reach the validator through the
  // API: upstream's settings hook on OnCollectionUpdate looks the new id up
  // in the collections cache first and answers 404. The unit table
  // (test/collections/collection-validate.test.ts, "changing id") covers it.
  {
    name: "create: empty id is regenerated",
    body: () => ({ id: "", name: "c_id_empty" }),
    valid: true,
  },
  {
    name: "create: invalid id",
    body: () => ({ id: "!invalid", name: "c_id_invalid" }),
    valid: false,
  },
  {
    name: "create: id with a space",
    body: () => ({ id: "a b", name: "c_id_space" }),
    valid: false,
  },
  {
    name: "create: id longer than 100",
    body: () => ({ id: "i".repeat(101), name: "c_id_long" }),
    valid: false,
  },
  {
    name: "create: id of 100 characters",
    body: () => ({ id: "i".repeat(100), name: "c_id_100" }),
    valid: true,
  },
  {
    name: "create: existing id",
    body: (ctx) => ({ id: ctx.id("users"), name: "c_id_existing" }),
    valid: false,
  },
  {
    name: "create: non-ASCII id",
    body: () => ({ id: "zażółć", name: "c_id_unicode" }),
    valid: false,
  },
  {
    name: "update: the same id",
    target: "posts",
    body: (ctx) => ({ id: ctx.id("posts") }),
    valid: true,
  },
  {
    name: "create: the autogenerated id of an existing type+name checksum gets a number",
    body: () => ({ name: "c_id_empty_2" }),
    valid: true,
  },

  // -----------------------------------------------------------------
  // name
  { name: "create: empty name", body: () => ({ name: "" }), valid: false },
  { name: "create: no body members", body: () => ({}), valid: false },
  { name: "create: invalid name", body: () => ({ name: "!invalid" }), valid: false },
  { name: "create: name with a space", body: () => ({ name: "a b" }), valid: false },
  { name: "create: non-ASCII name", body: () => ({ name: "zażółć" }), valid: false },
  { name: "create: name with _via_", body: () => ({ name: "a_via_b" }), valid: false },
  { name: "create: name with _VIA_", body: () => ({ name: "a_VIA_b" }), valid: false },
  {
    name: "create: name with _vİa_ (Go lowers U+0130 to i)",
    body: () => ({ name: "a_vİa_b" }),
    valid: false,
  },
  { name: "create: name longer than 255", body: () => ({ name: longName(256) }), valid: false },
  { name: "create: name of 255 characters", body: () => ({ name: longName(255) }), valid: true },
  { name: "create: existing collection name", body: () => ({ name: "users" }), valid: false },
  {
    name: "create: existing collection name in another case",
    body: () => ({ name: "USERS" }),
    valid: false,
  },
  {
    name: "create: existing view name",
    body: () => ({ name: "posts_view" }),
    valid: false,
  },
  {
    name: "create: existing internal table name",
    body: () => ({ name: "_collections" }),
    valid: false,
  },
  { name: "create: _params table name", body: () => ({ name: "_params" }), valid: false },
  {
    name: "create: _migrations table name in another case",
    body: () => ({ name: "_MIGRATIONS" }),
    valid: false,
  },
  {
    name: "create: name matching an existing collection id",
    body: (ctx) => ({ name: ctx.id("posts") }),
    valid: false,
  },
  { name: "create: valid name", body: () => ({ name: "c_valid_name" }), valid: true },
  {
    name: "update: name of another collection",
    target: "posts",
    body: () => ({ name: "members" }),
    valid: false,
  },
  {
    name: "update: internal table name",
    target: "posts",
    body: () => ({ name: "_params" }),
    valid: false,
  },
  {
    name: "update: system collection name change",
    target: "_superusers",
    body: () => ({ name: "admins" }),
    valid: false,
  },
  {
    name: "update: system collection (created as system) name change",
    target: "locked",
    body: () => ({ name: "locked_new" }),
    valid: false,
  },
  {
    name: "update: invalid name",
    target: "posts",
    body: () => ({ name: "a-b" }),
    valid: false,
  },
  { name: "update: same name", target: "posts", body: () => ({ name: "posts" }), valid: true },

  // -----------------------------------------------------------------
  // type
  { name: "create: unknown type", body: () => ({ name: "c_type", type: "unknown" }), valid: false },
  { name: "create: uppercase type", body: () => ({ name: "c_type2", type: "BASE" }), valid: false },
  { name: "update: base to auth", target: "posts", body: () => ({ type: "auth" }), valid: false },
  { name: "update: auth to base", target: "members", body: () => ({ type: "base" }), valid: false },
  {
    name: "update: view to base",
    target: "posts_view",
    body: () => ({ type: "base" }),
    valid: false,
  },
  { name: "update: empty type", target: "posts", body: () => ({ type: "" }), valid: true },

  // -----------------------------------------------------------------
  // system flag
  {
    name: "update: regular to system",
    target: "posts",
    body: () => ({ system: true }),
    valid: false,
  },
  {
    name: "update: system to regular",
    target: "_superusers",
    body: () => ({ system: false }),
    valid: false,
  },
  {
    name: "update: created system to regular",
    target: "locked",
    body: () => ({ system: false }),
    valid: false,
  },
  {
    name: "create: system collection",
    body: () => ({ name: "c_system", system: true }),
    valid: true,
  },

  // -----------------------------------------------------------------
  // rules
  {
    name: "create: invalid list rule syntax",
    body: () => ({ name: "c_rule1", listRule: "(id=1" }),
    valid: false,
    pending: pendingRule,
  },
  {
    name: "create: rule with a missing field",
    body: () => ({ name: "c_rule2", viewRule: "missing = 1" }),
    valid: false,
    pending: pendingRule,
  },
  {
    name: "create: all base rules invalid",
    body: () => ({
      name: "c_rule3",
      listRule: "!invalid",
      viewRule: "missing = 123",
      createRule: "id = 123 && missing = 456",
      updateRule: "@request.body.missing:changed = false",
      deleteRule: "(id=123",
    }),
    valid: false,
    pending: pendingRule,
  },
  {
    name: "create: valid rules",
    body: () => ({
      name: "c_rule4",
      fields: [{ name: "f1", type: "text" }],
      listRule: "",
      viewRule: "f1 = 123",
      createRule: "id = 123 && f1 = 456",
      updateRule: "(id = 123 && @request.body.f1:changed = false)",
      deleteRule: "f1 = 123",
    }),
    valid: true,
  },
  {
    name: "update: view create/update/delete rules not null",
    target: "posts_view",
    body: () => ({ createRule: "", updateRule: "", deleteRule: "id != ''" }),
    valid: false,
  },
  {
    name: "update: view create rule not null with a valid list rule",
    target: "posts_view",
    body: () => ({ listRule: "id != ''", createRule: "" }),
    valid: false,
  },
  {
    name: "update: system collection list rule change",
    target: "_superusers",
    body: () => ({ listRule: "id != ''" }),
    valid: false,
  },
  {
    name: "update: system collection rules all changed",
    target: "_superusers",
    body: () => ({
      listRule: "1 = 1",
      viewRule: "1 = 1",
      createRule: "1 = 1",
      updateRule: "1 = 1",
      deleteRule: "1 = 1",
      manageRule: "1 = 1",
      authRule: "1 = 1",
    }),
    valid: false,
  },
  {
    name: "update: created system collection list rule to null",
    target: "locked",
    body: () => ({ listRule: null }),
    valid: false,
  },
  {
    name: "update: created system collection same rules",
    target: "locked",
    body: () => ({ listRule: "", viewRule: null }),
    valid: true,
  },
  {
    name: "update: system auth rule change",
    target: "_superusers",
    body: () => ({ authRule: null }),
    valid: false,
  },
  {
    name: "update: system manage rule empty",
    target: "_superusers",
    body: () => ({ manageRule: "" }),
    valid: false,
  },
  {
    name: "update: system MFA rule change",
    target: "_superusers",
    body: () => ({ mfa: { enabled: true, rule: "id != ''" }, otp: { enabled: true } }),
    valid: false,
  },
  {
    name: "update: regular collection rules",
    target: "posts",
    body: () => ({ listRule: "title != ''", viewRule: null, createRule: "" }),
    valid: true,
  },

  // -----------------------------------------------------------------
  // fields
  {
    name: "create: duplicated field names (case insensitive)",
    body: () => ({
      name: "c_fields1",
      fields: [
        { name: "Title", type: "text" },
        { name: "title", type: "bool" },
      ],
    }),
    valid: false,
  },
  {
    name: "create: duplicated field ids are merged by NewFieldsList",
    body: () => ({
      name: "c_fields2",
      fields: [
        { id: "f1", name: "a", type: "text" },
        { id: "f1", name: "b", type: "text" },
      ],
    }),
    valid: true,
  },
  {
    name: "create: field named id of another type",
    body: () => ({ name: "c_fields3", fields: [{ name: "id", type: "bool" }] }),
    valid: false,
  },
  {
    name: "create: id field without primaryKey is fixed",
    body: () => ({
      name: "c_fields4",
      fields: [{ name: "id", type: "text", primaryKey: false, min: 3, max: 20 }],
    }),
    valid: true,
  },
  {
    name: "create: invalid field name",
    body: () => ({ name: "c_fields5", fields: [{ name: "a b", type: "text" }] }),
    valid: false,
  },
  {
    name: "create: field name with _via_",
    body: () => ({ name: "c_fields6", fields: [{ name: "a_via_b", type: "text" }] }),
    valid: false,
  },
  {
    name: "create: field named null",
    body: () => ({ name: "c_fields7", fields: [{ name: "null", type: "text" }] }),
    valid: false,
  },
  {
    name: "create: field named expand",
    body: () => ({ name: "c_fields8", fields: [{ name: "expand", type: "json" }] }),
    valid: false,
  },
  {
    name: "create: text min below zero",
    body: () => ({ name: "c_fields9", fields: [{ name: "f1", type: "text", min: -10 }] }),
    valid: false,
  },
  {
    name: "create: text max below min and an invalid pattern",
    body: () => ({
      name: "c_fields10",
      fields: [
        { name: "f1", type: "text", min: 10, max: 5 },
        { name: "f2", type: "text", pattern: "(" },
      ],
    }),
    valid: false,
  },
  {
    name: "create: relation to a missing collection",
    body: () => ({
      name: "c_fields11",
      fields: [{ name: "rel", type: "relation", collectionId: "missing" }],
    }),
    valid: false,
  },
  {
    name: "create: relation to a view collection",
    body: (ctx) => ({
      name: "c_fields12",
      fields: [{ name: "rel", type: "relation", collectionId: ctx.id("posts_view") }],
    }),
    valid: false,
  },
  {
    name: "create: relation with minSelect above maxSelect",
    body: (ctx) => ({
      name: "c_fields13",
      fields: [
        {
          name: "rel",
          type: "relation",
          collectionId: ctx.id("posts"),
          minSelect: 3,
          maxSelect: 2,
        },
      ],
    }),
    valid: false,
  },
  {
    name: "create: select without values, number min above max",
    body: () => ({
      name: "c_fields14",
      fields: [
        { name: "s", type: "select", values: [] },
        { name: "n", type: "number", min: 10, max: 1 },
      ],
    }),
    valid: false,
  },
  {
    name: "create: every field kind with valid settings",
    body: (ctx) => ({
      name: "c_fields15",
      fields: [
        { name: "t", type: "text", min: 1, max: 10, pattern: "^\\w+$" },
        { name: "n", type: "number", min: 0, max: 10, onlyInt: true },
        { name: "b", type: "bool" },
        { name: "e", type: "email", onlyDomains: ["example.com"] },
        { name: "u", type: "url" },
        { name: "d", type: "date" },
        { name: "s", type: "select", values: ["a", "b"], maxSelect: 2 },
        { name: "j", type: "json" },
        { name: "f", type: "file", maxSelect: 2, maxSize: 1000 },
        { name: "r", type: "relation", collectionId: ctx.id("posts"), maxSelect: 1 },
        { name: "p", type: "password", min: 8 },
        { name: "ed", type: "editor" },
        { name: "g", type: "geoPoint" },
        { name: "ad", type: "autodate", onCreate: true },
      ],
    }),
    valid: true,
  },
  {
    name: "create: auth field named passwordConfirm",
    body: () => ({
      name: "c_auth_reserved1",
      type: "auth",
      fields: [{ name: "passwordConfirm", type: "text" }],
    }),
    valid: false,
  },
  {
    name: "create: auth fields named oldPassword and passwordConfirm",
    body: () => ({
      name: "c_auth_reserved2",
      type: "auth",
      fields: [
        { name: "oldPassword", type: "text" },
        { name: "passwordConfirm", type: "bool" },
      ],
    }),
    valid: false,
  },
  {
    name: "create: base field named passwordConfirm",
    body: () => ({ name: "c_fields16", fields: [{ name: "passwordConfirm", type: "text" }] }),
    valid: true,
  },
  {
    name: "create: auth password field of another type",
    body: () => ({
      name: "c_auth_pass",
      type: "auth",
      fields: [{ name: "password", type: "text" }],
    }),
    valid: true,
  },
  {
    name: "create: auth email field of another type",
    body: () => ({ name: "c_auth_email", type: "auth", fields: [{ name: "email", type: "text" }] }),
    valid: true,
  },
  {
    name: "create: auth system field flags are enforced",
    body: () => ({
      name: "c_auth_flags",
      type: "auth",
      fields: [
        { name: "email", type: "email", hidden: true, system: false },
        { name: "tokenKey", type: "text", hidden: false, system: false },
        { name: "verified", type: "bool", system: false },
      ],
    }),
    valid: true,
  },
  {
    name: "update: changing a field type",
    target: "posts",
    body: (ctx) => ({ fields: withField(ctx, "posts", "slug", (f) => ({ ...f, type: "bool" })) }),
    valid: false,
  },
  {
    name: "update: changing two field types",
    target: "posts",
    body: (ctx) => ({
      fields: ctx
        .fields("posts")
        .map((f) =>
          f.name === "slug" || f.name === "body" ? { id: f.id, name: f.name, type: "number" } : f,
        ),
    }),
    valid: false,
  },
  {
    name: "update: renaming a system field",
    target: "_authOrigins",
    body: (ctx) => ({
      fields: withField(ctx, "_authOrigins", "fingerprint", (f) => ({ ...f, name: "fp" })),
    }),
    valid: false,
  },
  {
    name: "update: deleting a system field",
    target: "_authOrigins",
    body: (ctx) => ({ fields: withoutField(ctx, "_authOrigins", "fingerprint") }),
    valid: false,
  },
  {
    name: "update: deleting a created system field",
    target: "locked",
    body: (ctx) => ({ fields: withoutField(ctx, "locked", "code") }),
    valid: false,
  },
  {
    name: "update: fields without the id field",
    target: "posts",
    body: (ctx) => ({ fields: withoutField(ctx, "posts", "id") }),
    valid: true,
  },
  {
    name: "update: renaming a field to a duplicate",
    target: "posts",
    body: (ctx) => ({ fields: withField(ctx, "posts", "slug", (f) => ({ ...f, name: "TITLE" })) }),
    valid: false,
  },
  {
    name: "update: invalid settings of a stored field",
    target: "posts",
    body: (ctx) => ({ fields: withField(ctx, "posts", "slug", (f) => ({ ...f, max: -1 })) }),
    valid: false,
  },
  {
    name: "update: auth email field renamed",
    target: "members",
    body: (ctx) => ({
      fields: withField(ctx, "members", "email", (f) => ({ ...f, name: "mail" })),
    }),
    valid: false,
  },
  {
    name: "update: auth field renamed to oldPassword",
    target: "members",
    body: (ctx) => ({
      fields: withField(ctx, "members", "nick", (f) => ({ ...f, name: "oldPassword" })),
    }),
    valid: false,
  },
  {
    name: "update: adding a field",
    target: "posts",
    body: (ctx) => ({ fields: [...ctx.fields("posts"), { name: "extra", type: "number" }] }),
    valid: true,
  },
  {
    name: "update: view fields are generated from the query",
    target: "posts_view",
    body: () => ({ fields: [] }),
    valid: true,
  },

  // -----------------------------------------------------------------
  // indexes
  {
    name: "create: invalid index expression",
    body: () => ({
      name: "c_idx1",
      indexes: ["create index invalid", "create index idx_c_idx1 on anything (id)"],
    }),
    valid: false,
  },
  {
    name: "create: empty index expression",
    body: () => ({ name: "c_idx2", indexes: [""] }),
    valid: false,
  },
  {
    name: "create: duplicated index names (case insensitive)",
    body: () => ({
      name: "c_idx3",
      fields: [{ name: "a", type: "text" }],
      indexes: ["create index idx_dup on c_idx3 (id)", "create index IDX_DUP on c_idx3 (a)"],
    }),
    valid: false,
  },
  {
    name: "create: duplicated index definitions",
    body: () => ({
      name: "c_idx4",
      indexes: ["create index idx_a1 on c_idx4 (id)", "create index idx_a2 on other (id)"],
    }),
    valid: false,
  },
  {
    name: "create: index name used in another collection",
    body: () => ({
      name: "c_idx5",
      fields: [{ name: "slug", type: "text" }],
      indexes: ["create index `IDX_POSTS_SLUG` on c_idx5 (slug)"],
    }),
    valid: false,
  },
  {
    name: "create: index name of a system collection",
    body: (ctx) => ({
      name: "c_idx6",
      indexes: ["create index `idx_tokenKey_" + ctx.id("_superusers") + "` on c_idx6 (id)"],
    }),
    valid: false,
  },
  {
    name: "create: valid indexes, the table name is normalized",
    body: () => ({
      name: "c_idx7",
      fields: [
        { name: "a", type: "text" },
        { name: "b", type: "number" },
      ],
      indexes: [
        "create unique index idx_c7_a on anything (a)",
        "create index idx_c7_ab on c_idx7 (a, b DESC) where b > 0",
      ],
    }),
    valid: true,
  },
  {
    name: "update: index on a view",
    target: "posts_view",
    body: () => ({ indexes: ["create index idx_view on posts_view (id)"] }),
    valid: false,
  },
  {
    name: "update: removing the unique index of a system field",
    target: "locked",
    body: () => ({ indexes: ["CREATE INDEX `idx_locked_note` ON `locked` (`note`)"] }),
    valid: false,
  },
  {
    name: "update: unique index of a system field made non-unique",
    target: "locked",
    body: () => ({ indexes: ["CREATE INDEX `idx_locked_code` ON `locked` (`code`)"] }),
    valid: false,
  },
  {
    name: "update: unique index of a system field with another column",
    target: "locked",
    body: () => ({
      indexes: ["CREATE UNIQUE INDEX `idx_locked_code` ON `locked` (`code`, `note`)"],
    }),
    valid: false,
  },
  {
    name: "update: renamed unique index of a system field with collate, sort and a condition",
    target: "locked",
    body: () => ({
      indexes: [
        "CREATE UNIQUE INDEX `idx_locked_code2` ON `locked` (`code` COLLATE NOCASE DESC) WHERE `code` != ''",
        "CREATE INDEX `idx_locked_note` ON `locked` (`note`)",
      ],
    }),
    valid: true,
  },
  {
    name: "update: removing an index of a regular field",
    target: "posts",
    body: () => ({ indexes: ["CREATE UNIQUE INDEX `idx_posts_slug` ON `posts` (`slug`)"] }),
    valid: true,
  },
  {
    name: "create: auth without indexes gets the required ones",
    body: () => ({ name: "c_auth_idx", type: "auth", indexes: [] }),
    valid: true,
  },

  // -----------------------------------------------------------------
  // auth options
  {
    name: "create: auth manage rule empty",
    body: () => ({ name: "c_auth1", type: "auth", manageRule: "" }),
    valid: false,
  },
  {
    name: "create: auth invalid auth rule",
    body: () => ({ name: "c_auth2", type: "auth", authRule: "missing > 1" }),
    valid: false,
    pending: pendingRule,
  },
  {
    name: "update: password auth without identity fields",
    target: "members",
    body: () => ({ passwordAuth: { enabled: true, identityFields: [] } }),
    valid: false,
  },
  {
    name: "update: identity field without a unique index",
    target: "members",
    body: () => ({ passwordAuth: { enabled: true, identityFields: ["email", "nick"] } }),
    valid: false,
  },
  {
    name: "update: missing identity field",
    target: "members",
    body: () => ({ passwordAuth: { enabled: true, identityFields: ["missing"] } }),
    valid: false,
  },
  {
    name: "update: disabled password auth without identity fields",
    target: "members",
    body: () => ({ passwordAuth: { enabled: false, identityFields: [] } }),
    valid: true,
  },
  {
    name: "update: unique identity fields with duplicates",
    target: "members",
    body: () => ({
      passwordAuth: { enabled: true, identityFields: ["username", "email", "username"] },
    }),
    valid: true,
  },
  {
    name: "update: unknown OAuth2 provider",
    target: "members",
    body: () => ({ oauth2: { enabled: true, providers: [provider("missing")] } }),
    valid: false,
  },
  {
    name: "update: OAuth2 provider names are case sensitive",
    target: "members",
    body: () => ({ oauth2: { enabled: true, providers: [provider("Google")] } }),
    valid: false,
  },
  {
    name: "update: old instagram and oidc4 provider names",
    target: "members",
    body: () => ({
      oauth2: { enabled: true, providers: [provider("instagram"), provider("oidc4")] },
    }),
    valid: false,
  },
  {
    name: "update: OAuth2 provider without client id and secret",
    target: "members",
    body: () => ({ oauth2: { enabled: true, providers: [{ name: "gitlab" }] } }),
    valid: false,
  },
  {
    name: "update: OAuth2 provider with invalid URLs",
    target: "members",
    body: () => ({
      oauth2: {
        enabled: true,
        providers: [
          provider("gitlab", {
            authURL: "!invalid!",
            tokenURL: "ftp:/x",
            userInfoURL: "https://example.com/me",
          }),
        ],
      },
    }),
    valid: false,
  },
  {
    name: "update: duplicated OAuth2 providers",
    target: "members",
    body: () => ({
      oauth2: {
        enabled: true,
        providers: [provider("gitlab"), provider("google"), provider("gitlab")],
      },
    }),
    valid: false,
  },
  {
    name: "update: OAuth2 provider without a name",
    target: "members",
    body: () => ({ oauth2: { enabled: true, providers: [{ clientId: "a", clientSecret: "b" }] } }),
    valid: false,
  },
  {
    name: "update: invalid OAuth2 providers while disabled",
    target: "members",
    body: () => ({ oauth2: { enabled: false, providers: [provider("missing"), { name: "" }] } }),
    valid: true,
  },
  {
    name: "update: every registered OAuth2 provider",
    target: "members",
    body: () => ({ oauth2: { enabled: true, providers: providerNames.map((n) => provider(n)) } }),
    valid: true,
  },
  {
    name: "update: OTP duration and length too small",
    target: "members",
    body: () => ({ otp: { enabled: true, duration: 5, length: 3 } }),
    valid: false,
  },
  {
    name: "update: OTP duration too large",
    target: "members",
    body: () => ({ otp: { enabled: true, duration: 86401, length: 4 } }),
    valid: false,
  },
  {
    name: "update: OTP zero duration and length",
    target: "members",
    body: () => ({ otp: { enabled: true, duration: 0, length: 0 } }),
    valid: false,
  },
  {
    name: "update: disabled OTP with an empty email template",
    target: "members",
    body: () => ({ otp: { enabled: false, emailTemplate: { subject: "", body: "" } } }),
    valid: false,
  },
  {
    name: "update: MFA with one auth method",
    target: "members",
    body: () => ({
      mfa: { enabled: true, duration: 100 },
      otp: { enabled: false },
      oauth2: { enabled: false },
      passwordAuth: { enabled: true },
    }),
    valid: false,
  },
  {
    name: "update: MFA with zero duration",
    target: "members",
    body: () => ({ mfa: { enabled: true, duration: 0 } }),
    valid: false,
  },
  {
    name: "update: MFA duration too large",
    target: "members",
    body: () => ({ mfa: { enabled: true, duration: 86401 } }),
    valid: false,
  },
  {
    name: "update: MFA with an invalid rule",
    target: "members",
    body: () => ({
      mfa: { enabled: true, duration: 100, rule: "missing = 1" },
      otp: { enabled: true },
    }),
    valid: false,
    pending: pendingRule,
  },
  {
    name: "update: auth token secret too short",
    target: "members",
    body: () => ({ authToken: { secret: "abc", duration: 100 } }),
    valid: false,
  },
  {
    name: "update: token durations out of range",
    target: "members",
    body: () => ({
      passwordResetToken: { duration: 5 },
      emailChangeToken: { duration: 94670857 },
      verificationToken: { duration: 0 },
      fileToken: { secret: "x".repeat(256) },
    }),
    valid: false,
  },
  {
    name: "update: empty email templates",
    target: "members",
    body: () => ({
      verificationTemplate: { subject: "", body: "" },
      resetPasswordTemplate: { subject: "x", body: "" },
      confirmEmailChangeTemplate: { subject: "", body: "x" },
      authAlert: { enabled: false, emailTemplate: { subject: "", body: "" } },
    }),
    valid: false,
  },
  {
    name: "update: base options errors and auth options errors together",
    target: "members",
    body: () => ({
      name: "a b",
      indexes: ["invalid"],
      authToken: { secret: "abc" },
      otp: { enabled: true, duration: 1 },
    }),
    valid: false,
  },
  {
    name: "update: MFA with an MFA error and a password auth error",
    target: "members",
    body: () => ({
      mfa: { enabled: true, duration: 100 },
      otp: { enabled: false },
      oauth2: { enabled: false },
      passwordAuth: { enabled: true, identityFields: ["nick"] },
    }),
    valid: false,
  },
  {
    name: "update: valid auth options",
    target: "members",
    body: () => ({
      authRule: "verified = true",
      manageRule: null,
      passwordAuth: { enabled: true, identityFields: ["email", "username"] },
      mfa: { enabled: true, duration: 600, rule: "" },
      otp: { enabled: true, duration: 300, length: 6 },
      authToken: { secret: tokenSecret, duration: 3600 },
      oauth2: {
        enabled: true,
        mappedFields: { name: "nick", avatarURL: "missing" },
        providers: [provider("google"), provider("github", { pkce: false })],
      },
    }),
    valid: true,
  },
  {
    name: "create: auth with an invalid provider and template",
    body: () => ({
      name: "c_auth3",
      type: "auth",
      oauth2: { enabled: true, providers: [provider("nope")] },
      verificationTemplate: { subject: "", body: "x" },
    }),
    valid: false,
  },

  // -----------------------------------------------------------------
  // view options
  {
    name: "create: view without a query",
    body: () => ({ name: "c_view1", type: "view" }),
    valid: false,
  },
  {
    name: "create: view with an invalid query",
    body: () => ({ name: "c_view2", type: "view", viewQuery: "invalid" }),
    valid: false,
  },
  {
    name: "create: view with a valid query",
    body: () => ({ name: "c_view3", type: "view", viewQuery: "select id, title from posts" }),
    valid: true,
  },
  {
    name: "update: view with an invalid query",
    target: "posts_view",
    body: () => ({ viewQuery: "select missing from posts" }),
    valid: false,
  },
  {
    name: "update: view with an empty query",
    target: "posts_view",
    body: () => ({ viewQuery: "" }),
    valid: false,
  },
];
