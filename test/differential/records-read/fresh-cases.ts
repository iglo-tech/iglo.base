// Records list and view on a fresh install: the collections and records
// of the resolver reference test (test/differential/resolver/schema.ts)
// plus one `notes_<shape>` collection per rule shape, with the same
// records in each (records-read.test.ts).

import { rid } from "@test/differential/resolver/schema";
import type { ReadCase } from "@test/differential/records-read/fixture-cases";

export type FreshIdentity = "guest" | "alice" | "bob" | "carol" | "superuser";

export interface RuleShape {
  shape: string;
  rule: string | null;
  // query parameters and headers every request of the shape sends
  query?: string;
  headers?: Record<string, string>;
}

// list and view rule of each notes_<shape> collection
export const ruleShapes: RuleShape[] = [
  { shape: "null", rule: null },
  { shape: "empty", rule: "" },
  { shape: "auth", rule: `@request.auth.id != ""` },
  { shape: "auth_field", rule: `@request.auth.role = "admin" || @request.auth.name = "Bob"` },
  { shape: "relation", rule: "owner = @request.auth.id" },
  { shape: "relation_field", rule: `post.author = @request.auth.id || owner.role = "editor"` },
  { shape: "back_relation", rule: "post.comments_via_post.author ?= @request.auth.id" },
  {
    shape: "collection",
    rule: `@collection.profiles.owner ?= @request.auth.id && @collection.profiles.nickname ?= "ally"`,
  },
  { shape: "query", rule: `@request.query.key = "k1"`, query: "key=k1" },
  { shape: "headers", rule: `@request.headers.x_key = "h1"`, headers: { "X-Key": "h1" } },
];

// the notes of every notes_<shape> collection
export const notes = [
  { id: rid("nt1"), title: "first", owner: rid("alice"), post: rid("p1"), secret: "s1" },
  { id: rid("nt2"), title: "<p>second <b>note</b></p>", owner: rid("bob"), post: rid("p2") },
  { id: rid("nt3"), title: "third", owner: rid("alice"), post: rid("p4") },
  { id: rid("nt4"), title: "fourth", post: rid("p3") },
];

export function notesCollection(
  shape: RuleShape,
  ids: (name: string) => string,
): { [key: string]: unknown } {
  return {
    name: `notes_${shape.shape}`,
    type: "base",
    listRule: shape.rule,
    viewRule: shape.rule,
    fields: [
      { name: "title", type: "text" },
      { name: "owner", type: "relation", collectionId: ids("members"), maxSelect: 1 },
      { name: "post", type: "relation", collectionId: ids("posts"), maxSelect: 1 },
      { name: "secret", type: "text", hidden: true },
      { name: "created", type: "autodate", onCreate: true },
    ],
  };
}

const e = encodeURIComponent;

// the requests of the rules matrix, each sent as every FreshIdentity
export function ruleCases(): ReadCase[] {
  const cases: ReadCase[] = [];
  for (const s of ruleShapes) {
    const q = s.query ? `&${s.query}` : "";
    const base = `/api/collections/notes_${s.shape}/records`;
    cases.push(
      { name: `${s.shape}: list`, url: `${base}?sort=id${q}`, headers: s.headers },
      { name: `${s.shape}: view own`, url: `${base}/${rid("nt1")}?x=1${q}`, headers: s.headers },
      { name: `${s.shape}: view other`, url: `${base}/${rid("nt2")}?x=1${q}`, headers: s.headers },
      {
        name: `${s.shape}: list with expand`,
        url: `${base}?sort=id&expand=owner,post.author${q}`,
        headers: s.headers,
      },
    );
    if (s.query !== undefined || s.headers !== undefined) {
      cases.push(
        { name: `${s.shape}: view own without the request value`, url: `${base}/${rid("nt1")}` },
        { name: `${s.shape}: list without the request value`, url: `${base}?sort=id` },
      );
    }
  }
  return cases;
}

// expand, fields, hidden fields and emailVisibility on the fresh data,
// each sent as every FreshIdentity
export const freshCases: ReadCase[] = [
  {
    name: "members (manageRule, emailVisibility)",
    url: "/api/collections/members/records?sort=id",
  },
  {
    name: "member view (manageRule)",
    url: `/api/collections/members/records/${rid("bob")}`,
  },
  { name: "teams hidden field", url: "/api/collections/teams/records?sort=id" },
  {
    name: "teams filter by a hidden field",
    url: `/api/collections/teams/records?filter=${e("secretNote='s1'")}`,
  },
  {
    name: "posts expand chain",
    url: "/api/collections/posts/records?sort=id&expand=author.team.leader,tags.parent.parent,editors",
  },
  {
    name: "posts expand back-relations",
    url: "/api/collections/posts/records?sort=id&expand=comments_via_post.author,comments_via_refs",
  },
  {
    name: "member expand unique back-relation",
    url: `/api/collections/members/records/${rid("alice")}?expand=profiles_via_owner,posts_via_author.tags`,
  },
  {
    name: "members friends past the depth limit",
    url: "/api/collections/members/records?sort=id&expand=friends.friends.friends.friends.friends.friends.friends",
  },
  {
    name: "expand into a superusers-only rule",
    url: "/api/collections/posts/records?sort=id&expand=author,tags&perPage=2",
  },
  {
    name: "posts fields with expand",
    url: `/api/collections/posts/records?sort=id&expand=author,tags&fields=${e("id,title,expand.author.name,expand.author.email,expand.tags.name")}`,
  },
  {
    name: "posts fields excerpt",
    url: `/api/collections/posts/records?sort=id&fields=${e("id,body:excerpt(12,true),title:excerpt(3)")}`,
  },
  {
    name: "members fields json and geo",
    url: `/api/collections/members/records?sort=id&fields=${e("id,meta,loc,skills,bio:excerpt(5)")}`,
  },
  { name: "post_stats view collection", url: "/api/collections/post_stats/records?sort=id" },
  {
    name: "post_stats view record with expand",
    url: `/api/collections/post_stats/records/${rid("p1")}?expand=author,tags`,
  },
  {
    name: "private_notes (superusers-only list rule)",
    url: "/api/collections/private_notes/records",
  },
  { name: "tags list rule", url: "/api/collections/tags/records?sort=id&expand=parent" },
  {
    name: "comments filter and skipTotal",
    url: `/api/collections/comments/records?skipTotal=true&sort=-likes&filter=${e("likes>0")}`,
  },
];
