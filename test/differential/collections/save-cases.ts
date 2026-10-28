// The collection save, delete and import sequence of the reference test
// (save.test.ts).
//
// The steps run in order on a fresh upstream install (users, _superusers,
// _authOrigins, _externalAuths, _mfas, _otps). Each is one of:
//
//   - create: POST /api/collections with the body;
//   - update: PATCH /api/collections/{target} with the body;
//   - delete: DELETE /api/collections/{target};
//   - import: PUT /api/collections/import with the body;
//   - sql: the statements, run on the database (records inserted by SQL).
//
// `ok` is the expected upstream outcome (2xx or an error); the test checks
// it, so the counts are what upstream did. A body is a function of the
// current state (Ctx), read through upstream's GET before the step runs.

export interface Ctx {
  // the id of a collection (by name)
  id(collection: string): string;
  // the stored fields of a collection, as upstream's GET returns them
  fields(collection: string): Record<string, unknown>[];
  // the collection as upstream's GET returns it
  collection(name: string): Record<string, unknown>;
  // every collection as upstream's GET returns them
  all(): Record<string, unknown>[];
}

export type Step = { name: string; ok: boolean } & (
  | { kind: "create"; body: (ctx: Ctx) => unknown }
  | { kind: "update"; target: string; body: (ctx: Ctx) => unknown }
  | { kind: "delete"; target: string }
  | { kind: "import"; body: (ctx: Ctx) => { collections: unknown[]; deleteMissing: boolean } }
  | { kind: "sql"; sql: string[] }
);

// the stored fields with fn applied to the named one (keeping its id)
function withField(
  ctx: Ctx,
  collection: string,
  field: string,
  fn: (f: Record<string, unknown>) => void,
): Record<string, unknown>[] {
  const fields = ctx.fields(collection);
  const f = fields.find((x) => x.name === field);
  if (f === undefined) {
    throw new Error(`no field ${collection}.${field}`);
  }
  fn(f);
  return fields;
}

// every collection that is not a system one, as upstream's GET returns it
function userCollections(ctx: Ctx, except: string[] = []): Record<string, unknown>[] {
  return ctx.all().filter((c) => c.system !== true && !except.includes(c.name as string));
}

export const steps: Step[] = [
  // ---------------------------------------------------------------
  // create
  {
    name: "create base collection with every field type and indexes",
    kind: "create",
    ok: true,
    body: () => ({
      name: "posts",
      type: "base",
      listRule: "",
      viewRule: "",
      fields: [
        { name: "title", type: "text", required: true, max: 200 },
        { name: "body", type: "editor", maxSize: 100000 },
        { name: "views", type: "number", onlyInt: true },
        { name: "published", type: "bool" },
        { name: "contact", type: "email" },
        { name: "link", type: "url" },
        { name: "when", type: "date" },
        { name: "tags", type: "select", values: ["a", "b", "c"], maxSelect: 1 },
        { name: "cover", type: "file", maxSelect: 1, maxSize: 1000 },
        { name: "meta", type: "json" },
        { name: "loc", type: "geoPoint" },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX `idx_posts_title` ON `posts` (`title`)",
        "CREATE INDEX `idx_posts_views` ON `posts` (`views`) WHERE `published` = 1",
        "CREATE INDEX `idx_posts_lower` ON `posts` (lower(`title`), `views` DESC)",
      ],
    }),
  },
  {
    name: "create auth collection with an extra field and index",
    kind: "create",
    ok: true,
    body: () => ({
      name: "members",
      type: "auth",
      authRule: "",
      fields: [
        { name: "nickname", type: "text" },
        { name: "avatar", type: "file", maxSelect: 1, mimeTypes: ["image/png"] },
      ],
      indexes: ["CREATE UNIQUE INDEX `idx_members_nickname` ON `members` (`nickname`)"],
    }),
  },
  {
    name: "create base collection with relations",
    kind: "create",
    ok: true,
    body: (ctx) => ({
      name: "comments",
      type: "base",
      fields: [
        { name: "message", type: "text" },
        {
          name: "post",
          type: "relation",
          collectionId: ctx.id("posts"),
          maxSelect: 1,
          cascadeDelete: true,
        },
        { name: "author", type: "relation", collectionId: ctx.id("members"), maxSelect: 1 },
      ],
      indexes: ["CREATE INDEX `idx_comments_post` ON `comments` (`post`)"],
    }),
  },
  {
    name: "insert rows",
    kind: "sql",
    ok: true,
    sql: [
      "INSERT INTO posts (id, title, views, published, tags, cover) VALUES ('p1aaaaaaaaaaaaa', 'First', 1, 1, 'a', 'one.png')",
      "INSERT INTO posts (id, title, views, published, tags, cover) VALUES ('p2aaaaaaaaaaaaa', 'Second', 2, 0, '', '')",
      "INSERT INTO posts (id, title, views, published, tags, cover) VALUES ('p3aaaaaaaaaaaaa', 'Third', 2, 1, '[\"b\"]', 'x.txt')",
      "INSERT INTO comments (id, message, post) VALUES ('c1aaaaaaaaaaaaa', 'hi', 'p1aaaaaaaaaaaaa')",
      "INSERT INTO comments (id, message, post) VALUES ('c2aaaaaaaaaaaaa', 'yo', '')",
    ],
  },
  {
    name: "create view collection",
    kind: "create",
    ok: true,
    body: () => ({
      name: "post_stats",
      type: "view",
      listRule: "",
      viewQuery:
        "select p.id, p.title, p.tags, count(c.id) as total from posts p left join comments c on c.post = p.id group by p.id",
    }),
  },
  {
    name: "create view depending on a view",
    kind: "create",
    ok: true,
    body: () => ({
      name: "post_titles",
      type: "view",
      viewQuery: "select id, title, total from post_stats",
    }),
  },
  {
    name: "create view with a numeric id (wrapped)",
    kind: "create",
    ok: true,
    body: () => ({
      name: "numbers",
      type: "view",
      viewQuery: "select 1 as id, 'x' as label",
    }),
  },

  // ---------------------------------------------------------------
  // single <-> multiple
  {
    name: "select single to multiple",
    kind: "update",
    target: "posts",
    ok: true,
    body: (ctx) => ({ fields: withField(ctx, "posts", "tags", (f) => (f.maxSelect = 3)) }),
  },
  {
    name: "file single to multiple",
    kind: "update",
    target: "posts",
    ok: true,
    body: (ctx) => ({ fields: withField(ctx, "posts", "cover", (f) => (f.maxSelect = 2)) }),
  },
  {
    name: "relation single to multiple",
    kind: "update",
    target: "comments",
    ok: true,
    body: (ctx) => ({ fields: withField(ctx, "comments", "post", (f) => (f.maxSelect = 5)) }),
  },
  {
    name: "insert rows with multiple values",
    kind: "sql",
    ok: true,
    sql: [
      "INSERT INTO posts (id, title, views, published, tags, cover) VALUES ('p4aaaaaaaaaaaaa', 'Fourth', 4, 1, '[\"a\",\"c\"]', '[\"m.png\",\"n.png\"]')",
      "INSERT INTO comments (id, message, post) VALUES ('c3aaaaaaaaaaaaa', 'multi', '[\"p1aaaaaaaaaaaaa\",\"p4aaaaaaaaaaaaa\"]')",
    ],
  },
  {
    name: "select multiple to single",
    kind: "update",
    target: "posts",
    ok: true,
    body: (ctx) => ({ fields: withField(ctx, "posts", "tags", (f) => (f.maxSelect = 1)) }),
  },
  {
    name: "file multiple to single",
    kind: "update",
    target: "posts",
    ok: true,
    body: (ctx) => ({ fields: withField(ctx, "posts", "cover", (f) => (f.maxSelect = 1)) }),
  },
  {
    name: "relation multiple to single",
    kind: "update",
    target: "comments",
    ok: true,
    body: (ctx) => ({ fields: withField(ctx, "comments", "post", (f) => (f.maxSelect = 1)) }),
  },
  {
    name: "new multiple field on a table with rows",
    kind: "update",
    target: "posts",
    ok: true,
    body: (ctx) => ({
      fields: [
        ...ctx.fields("posts"),
        { name: "labels", type: "select", values: ["x", "y"], maxSelect: 2 },
      ],
    }),
  },

  // ---------------------------------------------------------------
  // renames
  {
    name: "rename a field a view of a view uses (fails in SQLite)",
    kind: "update",
    target: "posts",
    ok: false,
    body: (ctx) => ({ fields: withField(ctx, "posts", "title", (f) => (f.name = "headline")) }),
  },
  {
    name: "rename a field",
    kind: "update",
    target: "posts",
    ok: true,
    body: (ctx) => ({ fields: withField(ctx, "posts", "body", (f) => (f.name = "content")) }),
  },
  {
    name: "swap two field names",
    kind: "update",
    target: "posts",
    ok: true,
    body: (ctx) => {
      const fields = ctx.fields("posts");
      for (const f of fields) {
        if (f.name === "contact") {
          f.name = "link";
        } else if (f.name === "link") {
          f.name = "contact";
        }
      }
      return { fields };
    },
  },
  {
    name: "rename a collection used by views",
    kind: "update",
    target: "posts",
    ok: true,
    body: () => ({ name: "articles" }),
  },
  {
    name: "change a view query to the renamed collection",
    kind: "update",
    target: "post_stats",
    ok: true,
    body: () => ({
      viewQuery:
        "select a.id, a.title, a.tags, count(c.id) as total from articles a left join comments c on c.post = a.id group by a.id",
    }),
  },
  {
    name: "change the dependent view query",
    kind: "update",
    target: "post_titles",
    ok: true,
    body: () => ({ viewQuery: "select id, title, tags, total from post_stats" }),
  },
  {
    name: "rename a view collection",
    kind: "update",
    target: "post_titles",
    ok: true,
    body: () => ({ name: "article_titles" }),
  },

  // ---------------------------------------------------------------
  // indexes
  {
    name: "add an index",
    kind: "update",
    target: "articles",
    ok: true,
    body: (ctx) => ({
      indexes: [
        ...(ctx.collection("articles").indexes as string[]),
        "CREATE INDEX `idx_articles_when` ON `articles` (`when`)",
      ],
    }),
  },
  {
    name: "drop the partial index",
    kind: "update",
    target: "articles",
    ok: true,
    body: (ctx) => ({
      indexes: (ctx.collection("articles").indexes as string[]).filter(
        (i) => !i.includes("idx_posts_views"),
      ),
    }),
  },
  {
    name: "duplicate index name (fails)",
    kind: "update",
    target: "articles",
    ok: false,
    body: (ctx) => ({
      indexes: [
        ...(ctx.collection("articles").indexes as string[]),
        "CREATE INDEX `idx_posts_title` ON `articles` (`views`)",
      ],
    }),
  },
  {
    name: "index name used by another collection (fails)",
    kind: "update",
    target: "articles",
    ok: false,
    body: (ctx) => ({
      indexes: [
        ...(ctx.collection("articles").indexes as string[]),
        "CREATE INDEX `idx_comments_post` ON `articles` (`views`)",
      ],
    }),
  },
  {
    name: "unique index over duplicate values (fails in SQLite)",
    kind: "update",
    target: "articles",
    ok: false,
    body: (ctx) => ({
      indexes: [
        ...(ctx.collection("articles").indexes as string[]),
        "CREATE UNIQUE INDEX `idx_articles_views` ON `articles` (`views`)",
      ],
    }),
  },
  {
    name: "index on a missing column (fails in SQLite)",
    kind: "update",
    target: "articles",
    ok: false,
    body: (ctx) => ({
      indexes: [
        ...(ctx.collection("articles").indexes as string[]),
        "CREATE INDEX `idx_articles_missing` ON `articles` (`missing`)",
      ],
    }),
  },

  // ---------------------------------------------------------------
  // failing views
  {
    name: "view on a missing table (fails)",
    kind: "create",
    ok: false,
    body: () => ({ name: "bad_view", type: "view", viewQuery: "select id from missing_table" }),
  },
  {
    name: "view without id (fails)",
    kind: "create",
    ok: false,
    body: () => ({ name: "bad_view", type: "view", viewQuery: "select title from articles" }),
  },
  {
    name: "view with a syntax error (fails)",
    kind: "create",
    ok: false,
    body: () => ({ name: "bad_view", type: "view", viewQuery: "select id, from articles" }),
  },
  {
    name: "view with duplicated ids (fails)",
    kind: "create",
    ok: false,
    body: () => ({
      name: "bad_view",
      type: "view",
      viewQuery: "select 'a' as id union all select 'a' as id",
    }),
  },

  // ---------------------------------------------------------------
  // deletes
  {
    name: "delete a collection with references (fails)",
    kind: "delete",
    target: "members",
    ok: false,
  },
  {
    name: "delete a system collection (fails)",
    kind: "delete",
    target: "_superusers",
    ok: false,
  },
  {
    name: "delete a collection a view depends on (fails)",
    kind: "delete",
    target: "comments",
    ok: false,
  },
  {
    name: "delete a view",
    kind: "delete",
    target: "numbers",
    ok: true,
  },

  // ---------------------------------------------------------------
  // auth collections
  {
    name: "change the auth rule (rotates the token secret)",
    kind: "update",
    target: "members",
    ok: true,
    body: () => ({ authRule: "verified = true" }),
  },
  {
    name: "rename an auth field",
    kind: "update",
    target: "members",
    ok: true,
    body: (ctx) => ({
      fields: withField(ctx, "members", "nickname", (f) => (f.name = "nick")),
      indexes: ["CREATE UNIQUE INDEX `idx_members_nickname` ON `members` (`nick`)"],
    }),
  },
  {
    name: "rename an auth collection",
    kind: "update",
    target: "members",
    ok: true,
    body: () => ({ name: "people" }),
  },
  {
    name: "create and delete a collection",
    kind: "create",
    ok: true,
    body: () => ({ name: "scratch", type: "base", fields: [{ name: "x", type: "text" }] }),
  },
  { name: "delete the created collection", kind: "delete", target: "scratch", ok: true },

  // ---------------------------------------------------------------
  // import
  {
    name: "import without deleteMissing",
    kind: "import",
    ok: true,
    body: (ctx) => ({
      deleteMissing: false,
      collections: [
        {
          name: "imported",
          type: "base",
          fields: [
            { name: "title", type: "text" },
            { name: "ref", type: "relation", collectionId: ctx.id("articles"), maxSelect: 1 },
          ],
          indexes: ["CREATE INDEX `idx_imported_title` ON `imported` (`title`)"],
        },
        {
          id: ctx.id("comments"),
          name: "comments",
          fields: [{ name: "rating", type: "number" }],
        },
        {
          name: "imported_view",
          type: "view",
          viewQuery: "select id, title from imported",
        },
      ],
    }),
  },
  {
    name: "create a collection for the deleteMissing import",
    kind: "create",
    ok: true,
    body: () => ({ name: "doomed", type: "base", fields: [{ name: "y", type: "text" }] }),
  },
  {
    name: "import with deleteMissing",
    kind: "import",
    ok: true,
    body: (ctx) => {
      const collections = userCollections(ctx, ["doomed"]).map((c) => {
        if (c.name !== "articles") {
          return c;
        }
        // drop a field by leaving it out
        return {
          ...c,
          fields: (c.fields as Record<string, unknown>[]).filter((f) => f.name !== "loc"),
        };
      });
      return { deleteMissing: true, collections };
    },
  },
  {
    name: "import with an invalid collection (fails)",
    kind: "import",
    ok: false,
    body: () => ({
      deleteMissing: false,
      collections: [
        { name: "valid_one", type: "base" },
        { name: "invalid one", type: "base", fields: [{ name: "a", type: "text", min: -1 }] },
      ],
    }),
  },
  {
    name: "import with a broken view query (fails)",
    kind: "import",
    ok: false,
    body: () => ({
      deleteMissing: false,
      collections: [{ name: "broken_view", type: "view", viewQuery: "select nope from nowhere" }],
    }),
  },
  {
    name: "import a rename of an existing collection",
    kind: "import",
    ok: true,
    body: (ctx) => ({
      deleteMissing: false,
      collections: [{ id: ctx.id("imported"), name: "imported_renamed" }],
    }),
  },

  // ---------------------------------------------------------------
  // final changes
  {
    name: "rename the collection back",
    kind: "update",
    target: "articles",
    ok: true,
    body: () => ({ name: "posts" }),
  },
  {
    name: "remove fields and indexes",
    kind: "update",
    target: "posts",
    ok: true,
    body: (ctx) => ({
      fields: ctx.fields("posts").filter((f) => f.name !== "meta" && f.name !== "labels"),
      indexes: [],
    }),
  },
  {
    name: "delete a view while the views of the renamed collection are broken (fails)",
    kind: "delete",
    target: "article_titles",
    ok: false,
  },
  {
    name: "repair the view query",
    kind: "update",
    target: "post_stats",
    ok: true,
    body: () => ({
      viewQuery:
        "select p.id, p.title, p.tags, count(c.id) as total from posts p left join comments c on c.post = p.id group by p.id",
    }),
  },
  {
    name: "repair the view of the collection renamed by import",
    kind: "update",
    target: "imported_view",
    ok: true,
    body: () => ({ viewQuery: "select id, title from imported_renamed" }),
  },
  { name: "delete a view of a view", kind: "delete", target: "article_titles", ok: true },
  { name: "delete a view", kind: "delete", target: "post_stats", ok: true },
  { name: "delete a referencing collection", kind: "delete", target: "comments", ok: true },
];
