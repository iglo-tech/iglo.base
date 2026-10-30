// The fixed suite: requests that `bun run test:reference` sends to both
// servers on every run. Each real difference the fuzzer finds and that is
// fixed gets its minimized case here, under "fixed"; "boundaries" holds the
// limits and the forms the generator hits only rarely.

import type { FuzzCase, Who } from "@test/differential/fuzz/generate";

export interface FixedCase {
  name: string;
  collection: string;
  who: Who;
  filter?: string;
  sort?: string;
  params?: { [name: string]: string };
}

const cond = `id != "x"`;

export const fixed: FixedCase[] = [];

export const boundaries: FixedCase[] = [
  {
    name: "200 expressions",
    collection: "demo2",
    who: "guest",
    filter: Array.from({ length: 200 }, () => cond).join("&&"),
  },
  {
    name: "201 expressions",
    collection: "demo2",
    who: "guest",
    filter: Array.from({ length: 201 }, () => cond).join("&&"),
  },
  {
    name: "3,500 characters",
    collection: "demo4",
    who: "guest",
    filter: `id != "${"x".repeat(3492)}"`,
  },
  {
    name: "3,501 characters",
    collection: "demo4",
    who: "guest",
    filter: `id != "${"x".repeat(3493)}"`,
  },
  {
    name: "8 sort expressions",
    collection: "demo4",
    who: "guest",
    sort: "id,id,id,id,id,id,id,id",
  },
  {
    name: "9 sort expressions",
    collection: "demo4",
    who: "guest",
    sort: "id,id,id,id,id,id,id,id,id",
  },
  {
    name: "a stored % against an unescaped and an escaped value",
    collection: "fuzz_items",
    who: "guest",
    filter: `text ~ "50%" || text ~ "\\%"`,
    sort: "id",
  },
  {
    name: "a stored _ is not a wildcard without %",
    collection: "fuzz_items",
    who: "guest",
    filter: `text ~ "a_b"`,
    sort: "id",
  },
  {
    name: ":lower keeps non-ASCII letters",
    collection: "fuzz_items",
    who: "guest",
    filter: `text:lower = "zażółć"`,
    sort: "id",
  },
  {
    name: "a large number against a number field",
    collection: "fuzz_items",
    who: "guest",
    filter: `number = 9007199254740993`,
    sort: "id",
  },
  {
    name: "JSON scalars and numeric keys",
    collection: "fuzz_items",
    who: "guest",
    filter: `json = "str" || json = 1.5 || json.1 = "x" || json.10 = "y" || json.a.b.0 = 1`,
    sort: "id",
  },
  {
    name: "a single back-relation with data",
    collection: "fuzz_tags",
    who: "guest",
    filter: `fuzz_items_via_tag.text != ""`,
    sort: "id",
  },
  {
    name: "a relation target that no longer exists",
    collection: "fuzz_items",
    who: "guest",
    filter: `tags.name != "x"`,
    sort: "id",
  },
  {
    name: "a joined collection with a rule hides its records",
    collection: "fuzz_items",
    who: "guest",
    filter: `tag.name ?= "hidden" || tags.name ?= "hidden"`,
    sort: "id",
  },
  {
    name: "a joined collection with a null rule",
    collection: "demo1",
    who: "guest",
    filter: `rel_many.name != ""`,
  },
  {
    name: "a literal that names @request is refused",
    collection: "demo4",
    who: "users",
    filter: `title = "@request.auth.id"`,
  },
  {
    name: "two aliases of one collection",
    collection: "demo2",
    who: "superuser",
    filter: `@collection.demo3:a.title ?= "test1" && @collection.demo3:b.title ?= "test2"`,
    sort: "id",
  },
];

export function toCase(c: FixedCase): FuzzCase {
  return {
    seed: 0,
    n: 0,
    collection: c.collection,
    who: c.who,
    filter: c.filter === undefined ? null : { k: "raw", text: c.filter },
    sort: null,
    rawSort: c.sort ?? null,
    params: c.params ?? {},
    headers: {},
    timeDependent: false,
    invalid: false,
    tags: new Set(),
  };
}
