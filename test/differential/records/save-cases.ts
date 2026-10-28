// The collections and the record steps of the record save and delete
// reference test (save.test.ts).
//
// Record ids are explicit (15 characters of [a-z0-9]) where later steps
// refer to them; a few creates leave the id to the server, and the test
// aliases those ids. "$main" is the id of the superuser the fresh install
// created (the same on both copies).

// a collection created through POST /api/collections (and then PATCHed with
// `patch`, for fields that refer to the collection itself)
export interface CollectionCase {
  body: { [key: string]: unknown };
  patch?: { [key: string]: unknown };
}

const autodates = [
  { name: "created", type: "autodate", onCreate: true, onUpdate: false },
  { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
];

export const ids = {
  people: "peoplecoll00001",
  tags: "tagscoll0000001",
  items: "itemscoll000001",
  parents: "parentscoll0001",
  children: "childrencoll001",
  grandchildren: "grandchildcoll1",
  notes: "notescoll000001",
  links: "linkscoll000001",
  nodes: "nodescoll000001",
  peopleView: "peopleviewcoll1",
};

export const collections: CollectionCase[] = [
  {
    body: {
      id: ids.people,
      name: "people",
      type: "auth",
      fields: [
        { name: "name", type: "text", max: 50 },
        { name: "age", type: "number", onlyInt: true },
        ...autodates,
      ],
    },
  },
  {
    body: {
      id: ids.tags,
      name: "tags",
      type: "base",
      fields: [{ name: "name", type: "text", required: true }, ...autodates],
      indexes: ["CREATE UNIQUE INDEX `idx_tags_name` ON `tags` (`name`)"],
    },
  },
  {
    body: {
      id: ids.items,
      name: "items",
      type: "base",
      fields: [
        { name: "title", type: "text", required: true, min: 3, max: 50 },
        { name: "body", type: "editor" },
        { name: "qty", type: "number", min: 0, max: 1000 },
        { name: "amount", type: "number" },
        { name: "flag", type: "bool" },
        { name: "contact", type: "email" },
        { name: "site", type: "url" },
        { name: "due", type: "date" },
        { name: "kind", type: "select", values: ["a", "b", "c"], maxSelect: 1 },
        { name: "kinds", type: "select", values: ["a", "b", "c", "d"], maxSelect: 3 },
        { name: "meta", type: "json" },
        { name: "spot", type: "geoPoint" },
        { name: "doc", type: "file", maxSelect: 1 },
        { name: "docs", type: "file", maxSelect: 5 },
        { name: "secret", type: "password", hidden: true },
        {
          name: "owner",
          type: "relation",
          collectionId: ids.people,
          maxSelect: 1,
          cascadeDelete: false,
        },
        { name: "tags", type: "relation", collectionId: ids.tags, maxSelect: 5 },
        ...autodates,
      ],
    },
  },
  {
    body: {
      id: ids.parents,
      name: "parents",
      type: "base",
      fields: [{ name: "name", type: "text" }, ...autodates],
    },
  },
  {
    body: {
      id: ids.children,
      name: "children",
      type: "base",
      fields: [
        { name: "name", type: "text" },
        {
          name: "parent",
          type: "relation",
          collectionId: ids.parents,
          maxSelect: 1,
          required: true,
          cascadeDelete: true,
        },
        ...autodates,
      ],
    },
  },
  {
    body: {
      id: ids.grandchildren,
      name: "grandchildren",
      type: "base",
      fields: [
        { name: "name", type: "text" },
        {
          name: "child",
          type: "relation",
          collectionId: ids.children,
          maxSelect: 1,
          required: true,
          cascadeDelete: false,
        },
        ...autodates,
      ],
    },
  },
  {
    body: {
      id: ids.notes,
      name: "notes",
      type: "base",
      fields: [
        { name: "name", type: "text" },
        {
          name: "parents",
          type: "relation",
          collectionId: ids.parents,
          maxSelect: 5,
          cascadeDelete: false,
        },
        ...autodates,
      ],
    },
  },
  {
    body: {
      id: ids.links,
      name: "links",
      type: "base",
      fields: [
        { name: "name", type: "text" },
        {
          name: "parents",
          type: "relation",
          collectionId: ids.parents,
          maxSelect: 5,
          cascadeDelete: true,
        },
        ...autodates,
      ],
    },
  },
  {
    body: {
      id: ids.nodes,
      name: "nodes",
      type: "base",
      fields: [{ name: "name", type: "text" }, ...autodates],
    },
    patch: {
      fields: [
        { name: "name", type: "text" },
        {
          name: "next",
          type: "relation",
          collectionId: ids.nodes,
          maxSelect: 1,
          cascadeDelete: true,
        },
        {
          name: "peers",
          type: "relation",
          collectionId: ids.nodes,
          maxSelect: 10,
          cascadeDelete: false,
        },
        ...autodates,
      ],
    },
  },
  {
    body: {
      id: ids.peopleView,
      name: "people_view",
      type: "view",
      viewQuery: "SELECT id, name FROM people",
    },
  },
];

// the tables whose rows are compared after every step
export const tables = [
  "people",
  "users",
  "tags",
  "items",
  "parents",
  "children",
  "grandchildren",
  "notes",
  "links",
  "nodes",
  "_superusers",
  "_externalAuths",
  "_mfas",
  "_otps",
  "_authOrigins",
];

// the columns compared as new/same/changed instead of by value
export const volatileColumns = ["created", "updated", "tokenKey", "password", "secret"];

export type Step =
  | { kind: "create"; collection: string; body: { [key: string]: unknown } }
  | { kind: "update"; collection: string; id: string; body: { [key: string]: unknown } }
  | { kind: "delete"; collection: string; id: string }
  | { kind: "truncate"; collection: string };

const pw = { password: "1234567890", passwordConfirm: "1234567890" };

const p1 = "pp0000000000001";
const p2 = "pp0000000000002";
const u1 = "us0000000000001";
const t1 = "tg0000000000001";
const t2 = "tg0000000000002";
const i1 = "it0000000000001";
const i2 = "it0000000000002";
const pa = (n: number): string => `pa000000000000${n}`;
const ch = (n: number): string => `ch000000000000${n}`;
const gc = (n: number): string => `gc000000000000${n}`;
const nd = (n: number): string => `nd000000000000${n}`;
const refs = (record: string) => ({ collectionRef: ids.people, recordRef: record });

const create = (collection: string, body: { [key: string]: unknown }): Step => ({
  kind: "create",
  collection,
  body,
});
const update = (collection: string, id: string, body: { [key: string]: unknown }): Step => ({
  kind: "update",
  collection,
  id,
  body,
});
const del = (collection: string, id: string): Step => ({ kind: "delete", collection, id });
const truncate = (collection: string): Step => ({ kind: "truncate", collection });

export const steps: Step[] = [
  // auth records
  create("people", { id: p1, email: "p1@example.com", ...pw, name: "Ann", age: 30 }),
  create("people", {
    id: p2,
    email: "p2@example.com",
    ...pw,
    name: "Bob",
    emailVisibility: true,
    verified: true,
  }),
  create("people", { email: "p3@example.com", ...pw, name: "Cy" }),
  create("people", { email: "bad", password: "short", passwordConfirm: "short", age: 1.5 }),
  create("people", { id: "pp0000000000004", email: "p1@example.com", ...pw }),
  create("users", { id: u1, email: "u1@example.com", ...pw, name: "User" }),
  create("people", { id: u1, email: "u1@example.com", ...pw }),
  create("_superusers", { id: p1, email: "dup@example.com", ...pw }),
  create("people", { id: "!bad", email: "p5@example.com", ...pw }),
  update("people", p1, { name: "Ann B" }),
  update("people", p1, { password: "0987654321", passwordConfirm: "0987654321" }),
  update("people", p1, { email: "p1b@example.com" }),
  update("people", p1, {
    tokenKey: "customtokenkey0123456789abcdefghij",
    ...pw,
  }),
  update("people", p2, { email: "p2b@example.com", tokenKey: "anothertokenkey0123456789abcdefgh" }),
  update("people", p2, { name: "x".repeat(51) }),
  update("people", p2, { email: "p1b@example.com" }),

  // the auth refs
  create("_externalAuths", { ...refs(p1), provider: "github", providerId: "gh1" }),
  create("_externalAuths", { ...refs(p1), provider: "nope", providerId: "gh2" }),
  create("_externalAuths", { ...refs("pp0000000000009"), provider: "github", providerId: "x" }),
  create("_externalAuths", {
    collectionRef: ids.tags,
    recordRef: p1,
    provider: "github",
    providerId: "x",
  }),
  create("_mfas", { ...refs(p1), method: "password" }),
  create("_otps", { ...refs(p1), password: "123456", sentTo: "p1@example.com" }),
  create("_authOrigins", { ...refs(p1), fingerprint: "fp1" }),
  create("_externalAuths", { ...refs(p2), provider: "google", providerId: "g2" }),
  create("_mfas", { ...refs(p2), method: "otp" }),
  create("_otps", { ...refs(p2), password: "654321", sentTo: "p2@example.com" }),
  create("_authOrigins", { ...refs(p2), fingerprint: "fp2" }),
  update("people", p1, { verified: true }),
  update("people", p1, { password: "1122334455", passwordConfirm: "1122334455" }),
  update("people", p2, { tokenKey: "thirdtokenkey0123456789abcdefghijkl" }),
  update("people", p2, { verified: false }),
  update("people", p2, { verified: true }),
  del("people", p2),

  // tags and items: every field type, modifiers, numbers and validation
  create("tags", { id: t1, name: "red" }),
  create("tags", { id: t2, name: "blue" }),
  create("tags", { name: "red" }),
  create("tags", {}),
  create("items", {
    id: i1,
    title: "First",
    body: "<p>hi</p>",
    qty: 5,
    amount: 1.5,
    flag: true,
    contact: "a@example.com",
    site: "https://example.com/a?b=c",
    due: "2024-01-02 03:04:05.678Z",
    kind: "a",
    kinds: ["a", "b"],
    meta: { b: 1, a: [1, 2, { z: null }], c: "ü" },
    spot: { lon: 1.5, lat: -2.25 },
    secret: "supersecret1",
    owner: p1,
    tags: [t1, t2],
  }),
  create("items", { id: i2, title: "Second", amount: 12345678901234567 }),
  create("items", { title: "Third", amount: 1e21, meta: "text", spot: { lon: 0, lat: 90 } }),
  create("items", {
    title: "ab",
    qty: 2000,
    contact: "nope",
    site: "nope",
    due: "nope",
    kind: "z",
    kinds: ["a", "b", "c", "d"],
    owner: "pp0000000000009",
    tags: [t1, "tg0000000000009"],
    spot: { lon: 200, lat: 0 },
  }),
  create("items", { qty: -1 }),
  update("items", i1, { "kinds+": "c", "tags-": t1, "qty+": 10, "amount-": 0.5 }),
  update("items", i1, { meta: null, flag: false, due: "", amount: 0 }),
  update("items", i1, { meta: [1, "two", true], spot: { lon: 0, lat: 0 }, kind: "" }),
  update("items", i2, { owner: p1, tags: [t2], "+tags": t1, secret: "another1" }),
  update("items", i2, { amount: 9007199254740992, qty: 1000 }),
  create("items", { id: t1, title: "Same id as a tag" }),
  update("items", t1, { title: "" }),
  update("items", "it0000000000009", { title: "Missing" }),
  del("items", "it0000000000009"),
  del("tags", t1),
  del("people", p1),

  // relation chains
  create("parents", { id: pa(1), name: "P1" }),
  create("parents", { id: pa(2), name: "P2" }),
  create("parents", { id: pa(3), name: "P3" }),
  create("children", { id: ch(1), name: "C1", parent: pa(1) }),
  create("children", { id: ch(2), name: "C2", parent: pa(1) }),
  create("children", { id: ch(3), name: "C3", parent: pa(2) }),
  create("children", { name: "C?" }),
  create("children", { name: "C?", parent: "pa0000000000009" }),
  create("grandchildren", { id: gc(1), name: "G1", child: ch(3) }),
  create("notes", { id: "nt0000000000001", name: "N1", parents: [pa(1), pa(2)] }),
  create("notes", { id: "nt0000000000002", name: "N2", parents: [pa(1)] }),
  create("links", { id: "lk0000000000001", name: "L1", parents: [pa(1)] }),
  create("links", { id: "lk0000000000002", name: "L2", parents: [pa(1), pa(3)] }),
  del("parents", pa(2)),
  del("grandchildren", gc(1)),
  del("parents", pa(2)),
  del("parents", pa(1)),
  del("parents", pa(1)),

  // self relations
  create("nodes", { id: nd(1), name: "N1" }),
  create("nodes", { id: nd(2), name: "N2", next: nd(1) }),
  create("nodes", { id: nd(3), name: "N3", next: nd(2) }),
  create("nodes", { id: nd(4), name: "N4", peers: [nd(1), nd(2), nd(3)] }),
  create("nodes", { id: nd(5), name: "N5" }),
  update("nodes", nd(5), { next: nd(5), peers: [nd(5), nd(4)] }),
  del("nodes", nd(1)),
  del("nodes", nd(5)),

  // superusers
  create("_superusers", { email: "__pbinstaller@example.com", ...pw }),
  create("_superusers", {
    id: "su0000000000002",
    email: "su2@example.com",
    ...pw,
    verified: false,
  }),
  update("_superusers", "su0000000000002", { verified: false }),
  update("_superusers", "su0000000000002", { password: "short", passwordConfirm: "short" }),
  del("_superusers", "su0000000000002"),
  del("_superusers", "$main"),

  // truncate
  truncate("tags"),
  create("parents", { id: pa(4), name: "P4" }),
  create("children", { id: ch(4), name: "C4", parent: pa(4) }),
  create("grandchildren", { id: gc(2), name: "G2", child: ch(4) }),
  truncate("children"),
  truncate("parents"),
  truncate("grandchildren"),
  truncate("parents"),
  truncate("people_view"),

  // records that stay for the final GET comparison
  create("tags", { id: "tg0000000000003", name: "green" }),
  create("tags", { name: "yellow" }),
  create("items", {
    id: "it0000000000005",
    title: "Fifth",
    kinds: ["d", "a"],
    tags: ["tg0000000000003"],
    meta: { nested: { list: [1.25, "x", false] } },
    due: "2030-12-31 23:59:59.999Z",
  }),
  update("items", i1, { tags: ["tg0000000000003"], "kinds-": ["a"], title: "First again" }),
  create("parents", { id: pa(5), name: "P5" }),
  create("children", { id: ch(5), name: "C5", parent: pa(5) }),
  create("notes", { id: "nt0000000000003", name: "N3", parents: [pa(5)] }),
];
