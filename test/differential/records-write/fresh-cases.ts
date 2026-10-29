// Records create, update and delete on a fresh install
// (records-write.test.ts): the collections, the records the builder
// creates before both servers start, and the write cases sent to both.
//
// Identities: guest, alice (members, role admin: the members manage rule),
// bob (members, role editor), dave (members, role member) and a superuser.

import { rid } from "@test/differential/resolver/schema";
import type { WriteCase } from "@test/differential/records-write/write-case";

export type FreshIdentity = "guest" | "alice" | "bob" | "dave" | "superuser";

export const freshPassword = "1234567890";

export const members = {
  alice: { id: rid("alice"), email: "alice@example.com", role: "admin" },
  bob: { id: rid("bob"), email: "bob@example.com", role: "editor" },
  dave: { id: rid("dave"), email: "dave@example.com", role: "member" },
  erin: { id: rid("erin"), email: "erin@example.com", role: "member" },
} as const;

export type Ids = (collection: string) => string;

// the rule of create, update and delete of each w_<shape> collection
export const ruleShapes: { shape: string; rule: string | null }[] = [
  { shape: "null", rule: null },
  { shape: "empty", rule: "" },
  { shape: "auth", rule: `@request.auth.id != ""` },
  { shape: "authfield", rule: `@request.auth.role = "admin"` },
  { shape: "relation", rule: "owner = @request.auth.id" },
  { shape: "isset", rule: "@request.body.title:isset = true" },
  { shape: "changed", rule: "@request.body.title:changed = false" },
  { shape: "length", rule: "@request.body.tags:length > 1" },
  { shape: "each", rule: `@request.body.tags:each != "c"` },
  { shape: "value", rule: "@request.body.count > 5 && @request.body.owner = @request.auth.id" },
  {
    shape: "collection",
    rule: `@collection.profiles.owner ?= @request.auth.id && @collection.profiles.nickname ?= "ally"`,
  },
  { shape: "bodyrel", rule: `@request.body.owner.role = "admin"` },
];

// collections in creation order (each may refer to the ones before)
export function freshCollections(ids: Ids): { [key: string]: unknown }[] {
  const shapeCollections = ruleShapes.map((s) => ({
    name: `w_${s.shape}`,
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: s.rule,
    updateRule: s.rule,
    deleteRule: s.rule,
    fields: [
      { name: "title", type: "text" },
      { name: "owner", type: "relation", collectionId: ids("members"), maxSelect: 1 },
      { name: "tags", type: "select", values: ["a", "b", "c"], maxSelect: 3 },
      { name: "count", type: "number" },
      { name: "secret", type: "text", hidden: true },
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  }));

  return [
    {
      name: "profiles",
      type: "base",
      listRule: "",
      viewRule: "",
      fields: [
        { name: "owner", type: "relation", collectionId: ids("members"), maxSelect: 1 },
        { name: "nickname", type: "text" },
      ],
    },
    ...shapeCollections,
    {
      name: "w_types",
      type: "base",
      listRule: "",
      viewRule: "",
      createRule: "",
      updateRule: "",
      deleteRule: "",
      fields: [
        { name: "t", type: "text", min: 3, max: 10, pattern: "^[a-z]+$" },
        { name: "ed", type: "editor", maxSize: 50 },
        { name: "n", type: "number", min: 1, max: 100, onlyInt: true },
        { name: "f", type: "number" },
        { name: "b", type: "bool" },
        { name: "breq", type: "bool", required: true },
        { name: "em", type: "email", exceptDomains: ["bad.com"] },
        { name: "u", type: "url", onlyDomains: ["example.com"] },
        {
          name: "d",
          type: "date",
          min: "2020-01-01 00:00:00.000Z",
          max: "2030-01-01 00:00:00.000Z",
        },
        { name: "s1", type: "select", values: ["x", "y", "z"], maxSelect: 1 },
        { name: "sm", type: "select", values: ["x", "y", "z"], maxSelect: 2 },
        { name: "j", type: "json", maxSize: 100 },
        { name: "g", type: "geoPoint" },
        { name: "r", type: "relation", collectionId: ids("members"), maxSelect: 2 },
        { name: "pw", type: "password", min: 4 },
        { name: "fl", type: "file", maxSelect: 3, maxSize: 1000 },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
    },
    {
      name: "w_unique",
      type: "base",
      listRule: "",
      viewRule: "",
      createRule: "",
      updateRule: "",
      deleteRule: "",
      fields: [{ name: "slug", type: "text" }],
      indexes: ["CREATE UNIQUE INDEX idx_w_unique_slug ON w_unique (slug)"],
    },
    {
      name: "parents",
      type: "base",
      listRule: "",
      viewRule: "",
      createRule: "",
      updateRule: "",
      deleteRule: "",
      fields: [{ name: "name", type: "text" }],
    },
  ];
}

// collections that refer to parents (created after it)
export function freshCollections2(ids: Ids): { [key: string]: unknown }[] {
  return [
    {
      name: "children",
      type: "base",
      listRule: "",
      viewRule: "",
      deleteRule: "",
      fields: [
        {
          name: "parent",
          type: "relation",
          collectionId: ids("parents"),
          maxSelect: 1,
          cascadeDelete: true,
        },
      ],
    },
    {
      name: "pins",
      type: "base",
      listRule: "",
      viewRule: "",
      fields: [
        {
          name: "parent",
          type: "relation",
          collectionId: ids("parents"),
          maxSelect: 1,
          required: true,
        },
      ],
    },
    {
      name: "tags_of",
      type: "base",
      listRule: "",
      viewRule: "",
      fields: [{ name: "parents", type: "relation", collectionId: ids("parents"), maxSelect: 5 }],
    },
    {
      name: "w_view",
      type: "view",
      listRule: "",
      viewRule: "",
      viewQuery: "SELECT id, title FROM w_empty",
    },
  ];
}

// the members collection's rules (members is created first, as an auth
// collection with name and role fields)
export const membersCollection = {
  name: "members",
  type: "auth",
  listRule: `@request.auth.id != ""`,
  viewRule: `@request.auth.id != ""`,
  createRule: "",
  updateRule: `id = @request.auth.id || @request.auth.role = "admin" || @request.auth.role = "editor"`,
  deleteRule: "id = @request.auth.id",
  manageRule: `@request.auth.role = "admin"`,
  fields: [
    { name: "name", type: "text" },
    { name: "role", type: "select", values: ["admin", "editor", "member"], maxSelect: 1 },
  ],
};

// records the builder creates (collection, body)
export function freshRecords(): { collection: string; body: { [key: string]: unknown } }[] {
  const out: { collection: string; body: { [key: string]: unknown } }[] = [];
  for (const [name, m] of Object.entries(members)) {
    out.push({
      collection: "members",
      body: {
        id: m.id,
        email: m.email,
        password: freshPassword,
        passwordConfirm: freshPassword,
        name,
        role: m.role,
      },
    });
  }
  out.push(
    {
      collection: "profiles",
      body: { id: rid("palice"), owner: members.alice.id, nickname: "ally" },
    },
    { collection: "profiles", body: { id: rid("pbob"), owner: members.bob.id, nickname: "bobby" } },
  );
  for (const s of ruleShapes) {
    // the update target, then one delete target per identity
    for (const target of ["u", ...identities.map((who) => `d${who}`)]) {
      out.push({
        collection: `w_${s.shape}`,
        body: {
          id: rid(`${s.shape.slice(0, 6)}${target}`),
          title: "first",
          owner: members.alice.id,
          tags: ["a", "b"],
          count: 7,
          secret: "s",
        },
      });
    }
  }
  out.push(
    {
      collection: "w_types",
      body: {
        id: rid("types1"),
        t: "abc",
        n: 5,
        f: 1.5,
        b: true,
        breq: true,
        sm: ["x", "y"],
        r: [members.alice.id, members.bob.id],
        j: { b: 1, a: [1, 2] },
      },
    },
    { collection: "w_unique", body: { id: rid("uniq1"), slug: "one" } },
    { collection: "w_unique", body: { id: rid("uniq2"), slug: "two" } },
  );
  for (const p of ["p1", "p2", "p3", "p4"]) {
    out.push({ collection: "parents", body: { id: rid(p), name: p } });
  }
  out.push(
    { collection: "children", body: { id: rid("c1"), parent: rid("p1") } },
    { collection: "children", body: { id: rid("c2"), parent: rid("p1") } },
    { collection: "pins", body: { id: rid("pin1"), parent: rid("p2") } },
    { collection: "tags_of", body: { id: rid("to1"), parents: [rid("p3"), rid("p4")] } },
  );
  return out;
}

// the files the builder uploads to w_types/types1 (fl)
export const typesFiles = ["a.txt", "b.txt", "c.txt"];

const identities: FreshIdentity[] = ["guest", "alice", "bob", "superuser"];

const json = (v: unknown) => JSON.stringify(v);

// the rules matrix: create, update and delete on every w_<shape> as each
// identity
function ruleCases(): WriteCase[] {
  const cases: WriteCase[] = [];
  const createBody = (shape: string, who: FreshIdentity) => ({
    id: rid(`${shape.slice(0, 6)}c${who}`),
    title: `t_${who}`,
    owner: who === "bob" ? members.bob.id : members.alice.id,
    tags: who === "bob" ? ["c"] : ["a", "b"],
    count: who === "guest" ? 3 : 7,
    secret: "from " + who,
  });
  const updateBody: { [K in FreshIdentity]?: unknown } = {
    guest: { title: "u_guest", count: 9 },
    alice: { "tags+": "c", "count+": 2 },
    bob: { title: "u_bob", tags: ["a", "b"], owner: members.bob.id },
    superuser: { title: "first", "tags-": "a", secret: "su" },
  };
  for (const s of ruleShapes) {
    const base = `/api/collections/w_${s.shape}/records`;
    for (const who of identities) {
      cases.push({
        name: `${s.shape}: create`,
        as: who,
        method: "POST",
        url: base,
        body: json(createBody(s.shape, who)),
      });
    }
    for (const who of identities) {
      cases.push({
        name: `${s.shape}: update`,
        as: who,
        method: "PATCH",
        url: `${base}/${rid(`${s.shape.slice(0, 6)}u`)}`,
        body: json(updateBody[who]),
      });
    }
    for (const who of identities) {
      cases.push({
        name: `${s.shape}: delete`,
        as: who,
        method: "DELETE",
        url: `${base}/${rid(`${s.shape.slice(0, 6)}d${who}`)}`,
      });
    }
  }
  return cases;
}

const types = "/api/collections/w_types/records";
const typesRecord = `${types}/${rid("types1")}`;

const typesCreate = (name: string, body: { [key: string]: unknown }, id?: string): WriteCase => ({
  name: `types: ${name}`,
  as: "guest",
  method: "POST",
  url: types,
  body: json({ ...(id === undefined ? {} : { id: rid(id) }), ...body }),
});

const typesUpdate = (name: string, body: unknown, query = ""): WriteCase => ({
  name: `types: ${name}`,
  as: "guest",
  method: "PATCH",
  url: typesRecord + query,
  body: typeof body === "string" ? body : json(body),
});

// every simple field type's validation errors and normalization; files
// are the stored names of w_types/types1's fl files
function typeCases(files: string[]): WriteCase[] {
  const valid = {
    t: "abcd",
    ed: "<p>hi</p>",
    n: 10,
    f: -2.25,
    b: false,
    breq: true,
    em: "a@example.com",
    u: "https://example.com/x",
    d: "2022-01-02 03:04:05.678Z",
    s1: "x",
    sm: ["y", "z"],
    j: { z: 1, a: [true, null], n: 1.5e300 },
    g: { lon: 23.5, lat: 42.25 },
    r: [members.bob.id],
    pw: "secret1",
  };
  const invalid = (field: string, value: unknown): WriteCase =>
    typesCreate(`invalid ${field} ${json(value)}`, { ...valid, [field]: value });
  return [
    typesCreate("valid", valid, "typesok"),
    typesCreate("empty body (required bool)", {}),
    typesCreate("required bool false", { ...valid, breq: false }),
    invalid("t", "ab"),
    invalid("t", "abcdefghijkl"),
    invalid("t", "ABC"),
    invalid("ed", "x".repeat(60)),
    invalid("n", 0),
    invalid("n", 101),
    invalid("n", 1.5),
    invalid("n", "abc"),
    invalid("em", "invalid"),
    invalid("em", "a@bad.com"),
    invalid("u", "not a url"),
    invalid("u", "https://other.com"),
    invalid("d", "invalid"),
    invalid("d", "2019-01-01 00:00:00.000Z"),
    invalid("d", "2031-01-01 00:00:00.000Z"),
    invalid("s1", "w"),
    invalid("sm", ["x", "y", "z"]),
    invalid("sm", ["x", "nope"]),
    invalid("j", { long: "x".repeat(120) }),
    invalid("g", { lon: 200, lat: 0 }),
    invalid("g", { lon: 0, lat: -91 }),
    invalid("r", ["missing00000000"]),
    invalid("r", [members.alice.id, members.bob.id, members.dave.id]),
    invalid("pw", "abc"),
    typesCreate("text with spaces (no trimming before the pattern)", { ...valid, t: "  abc  " }),
    typesCreate("normalized values", {
      t: "abcx",
      n: "42",
      f: "1e3",
      b: 1,
      breq: "true",
      d: "2022-01-01",
      s1: ["z"],
      sm: "x",
      j: "12",
      // (a member of the wrong type, e.g. {lon:"1.5",lat:2}, is not used:
      // upstream re-encodes the map with json/v2 in Go's random map order,
      // so which member is decoded before the error varies)
      g: { lat: 2, lon: 1.5 },
      r: members.alice.id,
    }),
    typesCreate("unknown fields ignored", {
      ...valid,
      nope: 1,
      "@collection": "x",
      expand: { r: 1 },
    }),
    typesCreate("json raw text kept", { ...valid, j: { b: 1, a: 2, "10": 3, "1": 4 } }, "typesraw"),
    {
      name: "types: json big numbers and escapes kept as sent",
      as: "guest",
      method: "POST",
      url: types,
      body: `{"id":"${rid("typesbig")}","breq":true,"j":{"n":12345678901234567890,"f":1.50,"e":"\\u00e9\\/"}}`,
    },
    typesCreate("custom id", { ...valid }, "types2"),
    typesCreate("duplicate id", { ...valid }, "types1"),
    typesCreate("id too short", { ...valid, id: "short" }),
    typesCreate("id with a bad pattern", { ...valid, id: "UPPERCASE123456" }),
    typesUpdate("number modifiers", { "n+": 7, "n-": 2 }),
    typesUpdate("number modifier with a string", { "n+": "3" }),
    typesUpdate("select append and prepend", { "+sm": "z", "sm+": "y" }),
    typesUpdate("select remove", { "sm-": ["x"] }),
    typesUpdate("select append over maxSelect", { "sm+": ["z"] }),
    typesUpdate("relation append", { "r+": members.dave.id }),
    typesUpdate("relation prepend and remove", { "+r": members.erin.id, "r-": members.alice.id }),
    typesUpdate("relation remove missing", { "r-": ["nope"] }),
    typesUpdate("file names remove", { "fl-": files[1] }, "?fields=id,fl"),
    typesUpdate("file names reorder and remove", { fl: [files[2], files[0], "nope.txt"] }),
    typesUpdate("file names set to an unknown name", { fl: ["unknown.txt"] }),
    typesUpdate("password set", { pw: "newpass" }, "?fields=id,pw"),
    typesUpdate("modifier on an unknown field", { "nope+": 1 }),
    typesUpdate("both value and modifier", { n: 50, "n+": 5 }),
    typesUpdate("modifier prefix on a number", { "+n": 5 }),
    typesUpdate("urlencoded values", "t=xyz&n=33&b=true&sm=x&sm=y&j=%7B%22k%22%3A1%7D"),
  ];
}

// the same create sent as JSON, urlencoded and multipart (@jsonPayload)
function encodingCases(): WriteCase[] {
  const base = "/api/collections/w_empty/records";
  const boundary = "WriteCaseBoundary0123456789";
  const multipart = (parts: [string, string][]) =>
    parts
      .map(
        ([name, value]) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      )
      .join("") + `--${boundary}--\r\n`;
  const mpHeaders = { "Content-Type": `multipart/form-data; boundary=${boundary}` };
  const urlencoded = { "Content-Type": "application/x-www-form-urlencoded" };
  return [
    {
      name: "encoding: json",
      as: "guest",
      method: "POST",
      url: base,
      body: json({ id: rid("encjson"), title: "j", tags: ["a", "b"], count: 2 }),
    },
    {
      name: "encoding: urlencoded",
      as: "guest",
      method: "POST",
      url: base,
      headers: urlencoded,
      body: `id=${rid("encform")}&title=f&tags=a&tags=b&count=2`,
    },
    {
      name: "encoding: multipart",
      as: "guest",
      method: "POST",
      url: base,
      headers: mpHeaders,
      body: multipart([
        ["id", rid("encmp")],
        ["title", "m"],
        ["tags", "a"],
        ["tags", "b"],
        ["count", "2"],
      ]),
    },
    {
      name: "encoding: multipart with @jsonPayload",
      as: "guest",
      method: "POST",
      url: base,
      headers: mpHeaders,
      body: multipart([
        ["@jsonPayload", json({ id: rid("encjp"), tags: ["a"], count: 3 })],
        ["title", "jp"],
      ]),
    },
    {
      name: "encoding: multipart with two @jsonPayload parts",
      as: "guest",
      method: "POST",
      url: base,
      headers: mpHeaders,
      body: multipart([
        ["@jsonPayload", json({ id: rid("encjp2"), title: "one" })],
        ["@jsonPayload", json({ title: "two", count: 4 })],
      ]),
    },
    {
      name: "encoding: multipart with an invalid @jsonPayload",
      as: "guest",
      method: "POST",
      url: base,
      headers: mpHeaders,
      body: multipart([["@jsonPayload", "{bad"]]),
    },
    {
      name: "encoding: urlencoded modifiers",
      as: "guest",
      method: "PATCH",
      url: `${base}/${rid("encform")}`,
      headers: urlencoded,
      body: "tags-=a&count%2B=5",
    },
    {
      name: "encoding: json null body",
      as: "guest",
      method: "PATCH",
      url: `${base}/${rid("encjson")}`,
      body: "null",
    },
    {
      name: "encoding: json array body",
      as: "guest",
      method: "POST",
      url: base,
      body: "[1,2]",
    },
    {
      name: "encoding: unsupported content type",
      as: "guest",
      method: "POST",
      url: base,
      headers: { "Content-Type": "text/plain" },
      body: "title=x",
    },
  ];
}

function otherCases(): WriteCase[] {
  const membersUrl = "/api/collections/members/records";
  return [
    // unique index
    {
      name: "unique: create duplicate",
      as: "guest",
      method: "POST",
      url: "/api/collections/w_unique/records",
      body: json({ slug: "one" }),
    },
    {
      name: "unique: update to a duplicate",
      as: "guest",
      method: "PATCH",
      url: `/api/collections/w_unique/records/${rid("uniq2")}`,
      body: json({ slug: "one" }),
    },
    // cascade delete and required relations
    {
      name: "cascade: delete a parent with cascading children",
      as: "guest",
      method: "DELETE",
      url: `/api/collections/parents/records/${rid("p1")}`,
      reads: [
        `/api/collections/children/records/${rid("c1")}`,
        `/api/collections/children/records/${rid("c2")}`,
      ],
    },
    {
      name: "cascade: delete a parent of a required relation",
      as: "guest",
      method: "DELETE",
      url: `/api/collections/parents/records/${rid("p2")}`,
      reads: [`/api/collections/pins/records/${rid("pin1")}`],
    },
    {
      name: "cascade: delete a parent of a multiple non-required relation",
      as: "guest",
      method: "DELETE",
      url: `/api/collections/parents/records/${rid("p3")}`,
      reads: [`/api/collections/tags_of/records/${rid("to1")}`],
    },
    {
      name: "cascade: delete a child (no delete rule on pins)",
      as: "guest",
      method: "DELETE",
      url: `/api/collections/pins/records/${rid("pin1")}`,
    },
    // view collections
    {
      name: "view: create",
      as: "superuser",
      method: "POST",
      url: "/api/collections/w_view/records",
      body: json({ title: "x" }),
    },
    {
      name: "view: update",
      as: "superuser",
      method: "PATCH",
      url: `/api/collections/w_view/records/${rid("encjson")}`,
      body: json({ title: "x" }),
    },
    {
      name: "view: delete",
      as: "superuser",
      method: "DELETE",
      url: `/api/collections/w_view/records/${rid("encjson")}`,
    },
    // expand and fields on write responses
    {
      name: "response: create with expand and fields",
      as: "alice",
      method: "POST",
      url: "/api/collections/w_empty/records?expand=owner&fields=id,title,expand.owner.name,expand.owner.email",
      body: json({ id: rid("expand1"), title: "e", owner: members.bob.id }),
    },
    {
      name: "response: update with expand of a missing relation",
      as: "bob",
      method: "PATCH",
      url: `/api/collections/w_empty/records/${rid("expand1")}?expand=owner,missing`,
      body: json({ title: "e2" }),
    },
    {
      name: "response: guest update with expand (members view rule)",
      as: "guest",
      method: "PATCH",
      url: `/api/collections/w_empty/records/${rid("expand1")}?expand=owner`,
      body: json({ title: "e3" }),
    },
    {
      name: "response: create with fields excerpt",
      as: "guest",
      method: "POST",
      url: "/api/collections/w_empty/records?fields=title:excerpt(3,true),count",
      body: json({ id: rid("excerpt1"), title: "abcdefgh", count: 1 }),
    },
    // hidden fields
    {
      name: "hidden: create as a guest",
      as: "guest",
      method: "POST",
      url: "/api/collections/w_empty/records",
      body: json({ id: rid("hidden1"), title: "h", secret: "nope" }),
    },
    {
      name: "hidden: create as a superuser",
      as: "superuser",
      method: "POST",
      url: "/api/collections/w_empty/records",
      body: json({ id: rid("hidden2"), title: "h", secret: "yes" }),
    },
    {
      name: "hidden: update as a guest",
      as: "guest",
      method: "PATCH",
      url: `/api/collections/w_empty/records/${rid("hidden2")}`,
      body: json({ secret: "changed", title: "h2" }),
    },
    {
      name: "hidden: update with a filter on the hidden field (superuser only)",
      as: "superuser",
      method: "PATCH",
      url: `/api/collections/w_empty/records/${rid("hidden2")}?fields=secret`,
      body: json({ secret: "changed2" }),
    },
    // the auth collection manage rule
    {
      name: "manage: guest creates a verified member",
      as: "guest",
      method: "POST",
      url: membersUrl,
      body: json({
        email: "new1@example.com",
        password: freshPassword,
        passwordConfirm: freshPassword,
        verified: true,
      }),
    },
    {
      name: "manage: manager creates a verified member",
      as: "alice",
      method: "POST",
      url: membersUrl,
      body: json({
        id: rid("new2"),
        email: "new2@example.com",
        password: freshPassword,
        passwordConfirm: freshPassword,
        verified: true,
        emailVisibility: false,
      }),
    },
    {
      name: "manage: guest creates a member without passwordConfirm",
      as: "guest",
      method: "POST",
      url: membersUrl,
      body: json({ email: "new3@example.com", password: freshPassword }),
    },
    {
      name: "manage: guest creates a member with a short password",
      as: "guest",
      method: "POST",
      url: membersUrl,
      body: json({ email: "new4@example.com", password: "123", passwordConfirm: "123" }),
    },
    {
      name: "manage: guest creates a member with a taken email",
      as: "guest",
      method: "POST",
      url: membersUrl,
      body: json({
        email: members.bob.email,
        password: freshPassword,
        passwordConfirm: freshPassword,
      }),
    },
    {
      name: "manage: non-manager changes another member's email and verified",
      as: "bob",
      method: "PATCH",
      url: `${membersUrl}/${members.erin.id}`,
      body: json({ email: "erin2@example.com", verified: true }),
    },
    {
      name: "manage: non-manager changes another member's password",
      as: "bob",
      method: "PATCH",
      url: `${membersUrl}/${members.erin.id}`,
      body: json({ password: "newpass123", passwordConfirm: "newpass123" }),
    },
    {
      name: "manage: owner changes the password with a wrong oldPassword",
      as: "dave",
      method: "PATCH",
      url: `${membersUrl}/${members.dave.id}`,
      body: json({ password: "newpass123", passwordConfirm: "newpass123", oldPassword: "nope" }),
    },
    {
      name: "manage: owner sets verified",
      as: "dave",
      method: "PATCH",
      url: `${membersUrl}/${members.dave.id}`,
      body: json({ verified: true, name: "Dave" }),
    },
    {
      name: "manage: owner changes the name and emailVisibility",
      as: "dave",
      method: "PATCH",
      url: `${membersUrl}/${members.dave.id}`,
      body: json({ name: "Dave", emailVisibility: true }),
    },
    {
      name: "manage: owner sets only passwordConfirm",
      as: "dave",
      method: "PATCH",
      url: `${membersUrl}/${members.dave.id}`,
      body: json({ passwordConfirm: "newpass123" }),
    },
    {
      name: "manage: manager changes another member's email, verified and password",
      as: "alice",
      method: "PATCH",
      url: `${membersUrl}/${members.erin.id}`,
      body: json({
        email: "erin3@example.com",
        verified: true,
        password: "erinpass123",
        passwordConfirm: "erinpass123",
      }),
    },
    {
      name: "manage: manager deletes another member (delete rule)",
      as: "alice",
      method: "DELETE",
      url: `${membersUrl}/${members.erin.id}`,
    },
    {
      name: "manage: superuser changes tokenKey and password directly",
      as: "superuser",
      method: "PATCH",
      url: `${membersUrl}/${rid("new2")}`,
      body: json({ tokenKey: "x".repeat(50), password: "pass12345", passwordConfirm: "pass12345" }),
    },
    {
      name: "manage: owner changes the password with the oldPassword",
      as: "dave",
      method: "PATCH",
      url: `${membersUrl}/${members.dave.id}`,
      body: json({
        password: "newpass123",
        passwordConfirm: "newpass123",
        oldPassword: freshPassword,
      }),
    },
    {
      name: "manage: owner deletes self with the old token (token key changed)",
      as: "dave",
      method: "DELETE",
      url: `${membersUrl}/${members.dave.id}`,
    },
  ];
}

export function freshCases(files: string[]): WriteCase[] {
  return [...ruleCases(), ...typeCases(files), ...encodingCases(), ...otherCases()];
}

// passwords set by the cases, checked with auth-with-password on the data
// written by iglo.base, read by upstream
export const changedPasswords: { collection: string; email: string; password: string }[] = [
  { collection: "members", email: "erin3@example.com", password: "erinpass123" },
  { collection: "members", email: "new2@example.com", password: "pass12345" },
  { collection: "members", email: members.dave.email, password: "newpass123" },
];
