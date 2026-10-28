// The collections and records of the resolver reference test
// (resolver.test.ts), created through upstream's API on a fresh install.
//
// Base, auth and view collections with every field type, single and
// multiple relations (also circular and to itself), back-relations with
// and without a unique index, hidden fields, a collection with a non-empty
// list rule (tags) and one with a superusers-only list rule
// (private_notes), and auth records with and without emailVisibility.

// a 15 character record id from a short name
export function rid(name: string): string {
  return (name + "000000000000000").slice(0, 15);
}

export const password = "1234567890";

// the auth records the rules matrix signs in as
export const authUsers = {
  alice: { collection: "members", id: rid("alice"), email: "alice@example.com" },
  bob: { collection: "members", id: rid("bob"), email: "bob@example.com" },
  carol: { collection: "users", id: rid("carol"), email: "carol@example.com" },
} as const;

export type Ids = (collection: string) => string;

export interface CollectionStep {
  // POST /api/collections, or a PATCH that adds fields (addFields)
  create?: (ids: Ids) => object;
  addFields?: { collection: string; fields: (ids: Ids) => object[] };
}

export const collectionSteps: CollectionStep[] = [
  {
    create: () => ({
      name: "teams",
      type: "base",
      listRule: "",
      viewRule: "",
      fields: [
        { name: "name", type: "text" },
        { name: "code", type: "number" },
        { name: "active", type: "bool" },
        { name: "labels", type: "json" },
        { name: "secretNote", type: "text", hidden: true },
      ],
    }),
  },
  {
    create: (ids) => ({
      name: "members",
      type: "auth",
      listRule: "",
      viewRule: "",
      fields: [
        { name: "name", type: "text" },
        { name: "age", type: "number" },
        { name: "role", type: "select", values: ["admin", "editor", "viewer"], maxSelect: 1 },
        { name: "skills", type: "select", values: ["go", "js", "sql", "rust"], maxSelect: 4 },
        { name: "team", type: "relation", collectionId: ids("teams"), maxSelect: 1 },
        { name: "secret", type: "text", hidden: true },
        { name: "meta", type: "json" },
        { name: "bio", type: "editor" },
        { name: "website", type: "url" },
        { name: "contact", type: "email" },
        { name: "birthday", type: "date" },
        { name: "loc", type: "geoPoint" },
      ],
    }),
  },
  {
    addFields: {
      collection: "members",
      fields: (ids) => [
        { name: "friends", type: "relation", collectionId: ids("members"), maxSelect: 10 },
      ],
    },
  },
  {
    addFields: {
      collection: "teams",
      fields: (ids) => [
        { name: "leader", type: "relation", collectionId: ids("members"), maxSelect: 1 },
        { name: "crew", type: "relation", collectionId: ids("members"), maxSelect: 10 },
      ],
    },
  },
  {
    create: () => ({
      name: "tags",
      type: "base",
      listRule: "weight > 0",
      viewRule: "weight > 0",
      fields: [
        { name: "name", type: "text" },
        { name: "weight", type: "number" },
      ],
    }),
  },
  {
    addFields: {
      collection: "tags",
      fields: (ids) => [
        { name: "parent", type: "relation", collectionId: ids("tags"), maxSelect: 1 },
      ],
    },
  },
  {
    create: () => ({
      name: "private_notes",
      type: "base",
      listRule: null,
      viewRule: null,
      fields: [{ name: "text", type: "text" }],
    }),
  },
  {
    create: (ids) => ({
      name: "posts",
      type: "base",
      listRule: "",
      viewRule: "",
      fields: [
        { name: "title", type: "text" },
        { name: "body", type: "editor" },
        { name: "views", type: "number" },
        { name: "published", type: "bool" },
        { name: "status", type: "select", values: ["draft", "review", "live"], maxSelect: 1 },
        {
          name: "categories",
          type: "select",
          values: ["news", "tech", "life", "misc"],
          maxSelect: 4,
        },
        { name: "author", type: "relation", collectionId: ids("members"), maxSelect: 1 },
        { name: "editors", type: "relation", collectionId: ids("members"), maxSelect: 5 },
        { name: "team", type: "relation", collectionId: ids("teams"), maxSelect: 1 },
        { name: "tags", type: "relation", collectionId: ids("tags"), maxSelect: 5 },
        { name: "note", type: "relation", collectionId: ids("private_notes"), maxSelect: 1 },
        { name: "data", type: "json" },
        { name: "location", type: "geoPoint" },
        { name: "publishedAt", type: "date" },
        { name: "website", type: "url" },
        { name: "contactEmail", type: "email" },
        { name: "attachments", type: "file", maxSelect: 3, maxSize: 1000000 },
        { name: "hiddenScore", type: "number", hidden: true },
        { name: "slug", type: "text" },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE UNIQUE INDEX `idx_posts_slug` ON `posts` (`slug`) WHERE `slug` != ''"],
    }),
  },
  {
    create: (ids) => ({
      name: "comments",
      type: "base",
      listRule: "",
      viewRule: "",
      fields: [
        { name: "post", type: "relation", collectionId: ids("posts"), maxSelect: 1 },
        { name: "author", type: "relation", collectionId: ids("members"), maxSelect: 1 },
        { name: "message", type: "text" },
        { name: "likes", type: "number" },
        { name: "refs", type: "relation", collectionId: ids("posts"), maxSelect: 5 },
        { name: "flagged", type: "bool" },
      ],
    }),
  },
  {
    create: (ids) => ({
      name: "profiles",
      type: "base",
      listRule: "",
      viewRule: "",
      fields: [
        { name: "owner", type: "relation", collectionId: ids("members"), maxSelect: 1 },
        { name: "nickname", type: "text" },
      ],
      indexes: ["CREATE UNIQUE INDEX `idx_profiles_owner` ON `profiles` (`owner`)"],
    }),
  },
  {
    create: () => ({
      name: "post_stats",
      type: "view",
      listRule: "",
      viewRule: "",
      viewQuery:
        "SELECT p.id, p.title, p.views, p.author, p.published, p.tags, (SELECT COUNT(*) FROM comments c WHERE c.post = p.id) AS comments_count FROM posts p",
    }),
  },
];

export interface RecordStep {
  collection: string;
  // POST (create) or PATCH (update) of the record with this id
  update?: boolean;
  body: object;
}

const m = (name: string): string => rid(name);

export const recordSteps: RecordStep[] = [
  // teams (leaders and crews are set once the members exist)
  {
    collection: "teams",
    body: {
      id: rid("talpha"),
      name: "Alpha",
      code: 1,
      active: true,
      labels: { tier: "gold", n: [1, 2] },
      secretNote: "s1",
    },
  },
  {
    collection: "teams",
    body: { id: rid("tbeta"), name: "Beta", code: 2, active: false, labels: ["x", "y"] },
  },
  { collection: "teams", body: { id: rid("tgamma"), name: "Gamma", code: 0 } },

  // members
  {
    collection: "members",
    body: {
      id: m("alice"),
      email: authUsers.alice.email,
      emailVisibility: true,
      verified: true,
      password,
      passwordConfirm: password,
      name: "Alice",
      age: 30,
      role: "admin",
      skills: ["go", "sql"],
      team: rid("talpha"),
      secret: "a-secret",
      meta: { lang: "en", score: 5 },
      bio: "<p>Hi</p>",
      website: "https://alice.example.com",
      contact: "alice.contact@example.com",
      birthday: "1990-01-02 00:00:00.000Z",
      loc: { lon: 10, lat: 20 },
    },
  },
  {
    collection: "members",
    body: {
      id: m("bob"),
      email: authUsers.bob.email,
      emailVisibility: false,
      verified: false,
      password,
      passwordConfirm: password,
      name: "Bob",
      age: 25,
      role: "editor",
      skills: ["js"],
      team: rid("tbeta"),
      meta: { lang: "pl" },
    },
  },
  {
    collection: "members",
    body: {
      id: m("dave"),
      email: "dave@example.org",
      emailVisibility: true,
      verified: false,
      password,
      passwordConfirm: password,
      name: "Dave",
      role: "viewer",
    },
  },
  {
    collection: "members",
    body: {
      id: m("eve"),
      email: "eve@example.org",
      emailVisibility: false,
      verified: true,
      password,
      passwordConfirm: password,
      age: 41,
      skills: ["rust", "go", "js"],
      team: rid("talpha"),
      secret: "e",
      meta: [1, 2],
    },
  },
  {
    collection: "members",
    update: true,
    body: { id: m("alice"), friends: [m("bob"), m("dave")] },
  },
  { collection: "members", update: true, body: { id: m("bob"), friends: [m("alice")] } },
  {
    collection: "members",
    update: true,
    body: { id: m("eve"), friends: [m("alice"), m("bob"), m("dave")] },
  },
  {
    collection: "users",
    body: {
      id: rid("carol"),
      email: authUsers.carol.email,
      emailVisibility: true,
      verified: true,
      password,
      passwordConfirm: password,
      name: "Carol",
    },
  },
  {
    collection: "teams",
    update: true,
    body: { id: rid("talpha"), leader: m("alice"), crew: [m("alice"), m("bob")] },
  },
  {
    collection: "teams",
    update: true,
    body: { id: rid("tbeta"), leader: m("bob"), crew: [m("bob"), m("dave")] },
  },

  // tags
  { collection: "tags", body: { id: rid("tggo"), name: "go", weight: 5 } },
  { collection: "tags", body: { id: rid("tgweb"), name: "web", weight: 0, parent: rid("tggo") } },
  { collection: "tags", body: { id: rid("tgdb"), name: "db", weight: 3, parent: rid("tggo") } },
  {
    collection: "tags",
    body: { id: rid("tgmisc"), name: "misc", weight: -1, parent: rid("tgweb") },
  },

  // private notes
  { collection: "private_notes", body: { id: rid("n1"), text: "top secret" } },
  { collection: "private_notes", body: { id: rid("n2"), text: "" } },

  // posts
  {
    collection: "posts",
    body: {
      id: rid("p1"),
      title: "Hello World",
      body: "<p>hi</p>",
      views: 100,
      published: true,
      status: "live",
      categories: ["news", "tech"],
      author: m("alice"),
      editors: [m("bob"), m("dave")],
      team: rid("talpha"),
      tags: [rid("tggo"), rid("tgdb")],
      note: rid("n1"),
      data: { a: { b: "test" }, list: [1, 2, 3] },
      location: { lon: 21, lat: 52.2 },
      publishedAt: "2024-01-15 10:00:00.000Z",
      website: "https://a.example.com",
      contactEmail: "a@example.com",
      hiddenScore: 7,
      slug: "hello-world",
    },
  },
  {
    collection: "posts",
    body: {
      id: rid("p2"),
      title: "Second post",
      views: 5,
      published: false,
      status: "draft",
      categories: ["life"],
      author: m("bob"),
      editors: [m("alice")],
      team: rid("tbeta"),
      tags: [rid("tgweb")],
      note: rid("n2"),
      data: [1, "two", null],
      location: { lon: -0.12, lat: 51.5 },
      hiddenScore: 0,
      slug: "second",
    },
  },
  { collection: "posts", body: { id: rid("p3") } },
  {
    collection: "posts",
    body: {
      id: rid("p4"),
      title: "hello again",
      views: 50,
      published: true,
      status: "review",
      categories: ["tech", "misc", "news"],
      author: m("alice"),
      editors: [m("alice"), m("bob"), m("eve")],
      team: rid("talpha"),
      tags: [rid("tggo"), rid("tgweb"), rid("tgdb"), rid("tgmisc")],
      data: { a: { b: "other" } },
      publishedAt: "2024-03-01 00:00:00.000Z",
      hiddenScore: 3,
      slug: "hello-again",
    },
  },
  {
    collection: "posts",
    body: {
      id: rid("p5"),
      title: "Gamma_ray 100%",
      views: -3,
      published: true,
      status: "live",
      categories: ["misc"],
      author: m("eve"),
      editors: [m("eve")],
      team: rid("tgamma"),
      tags: [rid("tgmisc")],
      data: "plain string",
      publishedAt: "2023-06-30 12:30:00.000Z",
      slug: "gamma",
    },
  },
  {
    collection: "posts",
    body: {
      id: rid("p6"),
      title: "UPPER case",
      views: 1000000,
      published: false,
      status: "review",
      categories: ["news"],
      author: m("dave"),
      editors: [m("dave"), m("alice")],
      team: rid("tbeta"),
      tags: [rid("tgdb")],
      data: 42,
      location: { lon: 0, lat: 0 },
      contactEmail: "upper@example.org",
      slug: "upper",
    },
  },
  {
    collection: "posts",
    body: {
      id: rid("p7"),
      title: "Ünïcode ✓",
      views: 7.5,
      published: true,
      status: "live",
      categories: ["tech", "life"],
      author: m("bob"),
      team: rid("talpha"),
      tags: [rid("tggo")],
      data: true,
      slug: "unicode",
    },
  },
  {
    collection: "posts",
    body: {
      id: rid("p8"),
      title: "with 'quote' \\ back",
      views: 12,
      published: true,
      author: m("alice"),
      editors: [m("bob")],
      data: { list: [] },
      slug: "quote",
    },
  },

  // comments
  {
    collection: "comments",
    body: {
      id: rid("c1"),
      post: rid("p1"),
      author: m("bob"),
      message: "Nice!",
      likes: 3,
      refs: [rid("p2"), rid("p4")],
    },
  },
  {
    collection: "comments",
    body: { id: rid("c2"), post: rid("p1"), author: m("alice"), message: "Thanks", likes: 0 },
  },
  {
    collection: "comments",
    body: {
      id: rid("c3"),
      post: rid("p2"),
      author: m("dave"),
      message: "meh",
      likes: 1,
      refs: [rid("p1")],
    },
  },
  {
    collection: "comments",
    body: {
      id: rid("c4"),
      post: rid("p4"),
      author: m("eve"),
      likes: 10,
      refs: [rid("p1"), rid("p2"), rid("p4")],
      flagged: true,
    },
  },
  {
    collection: "comments",
    body: { id: rid("c5"), author: m("alice"), message: "orphan", likes: 2 },
  },

  // profiles (owner has a unique index)
  { collection: "profiles", body: { id: rid("pr1"), owner: m("alice"), nickname: "ally" } },
  { collection: "profiles", body: { id: rid("pr2"), owner: m("bob"), nickname: "bobby" } },
  { collection: "profiles", body: { id: rid("pr3"), owner: m("eve") } },
];
