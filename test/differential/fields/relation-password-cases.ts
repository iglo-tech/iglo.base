// The relation and password settings and record values the reference
// test submits to upstream (test/differential/fields/relation-password.test.ts).
// Values are JSON texts, sent as they are in the request body. In relation
// settings, "$T" stands for the id of the "targets" collection, "$V" for
// the "targets_view" view and "$U" for the "users" auth collection.

import type { FieldDef, ValueCase } from "@test/differential/fields/cases";

// the "targets" records the relation values point at
export const targetIds = ["aaaaaaaaaaaaaa1", "aaaaaaaaaaaaaa2", "aaaaaaaaaaaaaa3"] as const;

// a "users" record id
export const userId = "uuuuuuuuuuuuuu1";

// Settings upstream accepts: one collection per entry, one field each.
export const validSettings: FieldDef[] = [
  { name: "r", type: "relation", collectionId: "$T" },
  {
    name: "r",
    type: "relation",
    collectionId: "$T",
    maxSelect: 1,
    required: true,
    cascadeDelete: true,
  },
  { name: "r", type: "relation", collectionId: "$T", minSelect: 2, maxSelect: 5 },
  {
    name: "r",
    type: "relation",
    collectionId: "$T",
    maxSelect: 2,
    presentable: true,
    hidden: true,
    help: "<b>rel</b> & help",
  },
  { name: "r", type: "relation", collectionId: "$U", maxSelect: 999 },
  { name: "r", type: "relation", collectionId: "$T", minSelect: 0, maxSelect: 0 },
  { name: "p", type: "password" },
  { name: "p", type: "password", min: 1, max: 71 },
  { name: "p", type: "password", min: 8, pattern: "^[a-z0-9]+$", cost: 4 },
  { name: "p", type: "password", required: true, hidden: true, cost: 31, presentable: true },
  { name: "p", type: "password", max: 5, help: "x" },
];

// Settings upstream rejects: one collection each.
export const invalidSettings: FieldDef[] = [
  { name: "r", type: "relation" },
  { name: "r", type: "relation", collectionId: "targets" }, // a name, not the id
  { name: "r", type: "relation", collectionId: "missing0000000" },
  { name: "r", type: "relation", collectionId: "$V" }, // base -> view
  { name: "r", type: "relation", collectionId: "$T", minSelect: -1 },
  { name: "r", type: "relation", collectionId: "$T", minSelect: 1 },
  { name: "r", type: "relation", collectionId: "$T", minSelect: 3, maxSelect: 2 },
  { name: "r", type: "relation", collectionId: "$T", maxSelect: -1 },
  { name: "r", type: "relation", collectionId: "", minSelect: -2, maxSelect: -3 },
  { name: "p", type: "password", min: -1 },
  { name: "p", type: "password", min: 72 },
  { name: "p", type: "password", min: 5, max: 3 },
  { name: "p", type: "password", max: 72 },
  { name: "p", type: "password", cost: 3 },
  { name: "p", type: "password", cost: 32 },
  { name: "p", type: "password", pattern: "(invalid" },
  { name: "p", type: "password", min: 10, max: 5, cost: 99, pattern: "[" },
];

export interface ValueCollection {
  name: string;
  fields: FieldDef[];
}

// The collections records are created in. Only the rel_req and pw_req
// collections hold a required field.
export const valueCollections: ValueCollection[] = [
  {
    name: "rel_a",
    fields: [
      { name: "single", type: "relation", collectionId: "$T" },
      { name: "multi", type: "relation", collectionId: "$T", maxSelect: 3 },
      { name: "minmax", type: "relation", collectionId: "$T", minSelect: 2, maxSelect: 3 },
      { name: "users", type: "relation", collectionId: "$U", maxSelect: 2 },
    ],
  },
  {
    name: "rel_req",
    fields: [{ name: "r", type: "relation", collectionId: "$T", required: true }],
  },
  {
    name: "pw_a",
    fields: [
      { name: "p", type: "password" },
      { name: "pr", type: "password", min: 3, max: 10, pattern: String.raw`^[a-z]+\d*$`, cost: 4 },
      { name: "pc", type: "password", cost: 5 },
    ],
  },
  {
    name: "pw_req",
    fields: [{ name: "p", type: "password", required: true, min: 2, cost: 4 }],
  },
];

const q = (s: string): string => JSON.stringify(s);

function cases(collection: string, key: string, values: string[]): ValueCase[] {
  return values.map((v) => [collection, key, v]);
}

const [t1, t2, t3] = targetIds;

export const valueCases: ValueCase[] = [
  // relation, single
  ...cases("rel_a", "single", [
    q(""),
    q(t1),
    q("nonexistent0000"),
    q(t1.toUpperCase()),
    `[${q(t1)}]`,
    `[${q(t1)},${q(t2)}]`,
    `[${q(t1)},${q(t1)}]`,
    "123",
    "null",
    "[]",
    "true",
    q(`["${t2}"]`),
    `{"a":1}`,
  ]),
  // relation, multiple
  ...cases("rel_a", "multi", [
    "[]",
    `[${q(t1)}]`,
    `[${q(t1)},${q(t2)},${q(t3)}]`,
    `[${q(t3)},${q(t1)}]`,
    `[${q(t1)},${q(t2)},${q(t3)},"nonexistent0000"]`,
    `[${q(t1)},"nonexistent0000"]`,
    q(t2),
    q(`["${t1}","${t2}"]`),
    `[${q(t1)},"",${q(t1)}]`,
    "[1,2]",
    "null",
    q(""),
  ]),
  // relation, minSelect and maxSelect
  ...cases("rel_a", "minmax", [
    "[]",
    `[${q(t1)}]`,
    `[${q(t1)},${q(t2)}]`,
    `[${q(t1)},${q(t2)},${q(t3)}]`,
    `[${q(t1)},${q(t2)},${q(t3)},"x"]`,
    `[${q(t1)},"nonexistent0000"]`,
    q(t1),
  ]),
  // relation to an auth collection
  ...cases("rel_a", "users", [`[${q(userId)}]`, `["missing"]`, q(userId)]),
  // modifiers on a new record
  ...cases("rel_a", "multi+", [q(t1), `[${q(t1)},${q(t2)}]`]),
  ...cases("rel_a", "+multi", [`[${q(t3)},${q(t2)}]`]),
  ...cases("rel_a", "multi-", [q(t1)]),
  ...cases("rel_a", "single+", [`[${q(t1)},${q(t2)}]`]),
  ...cases("rel_req", "r", [q(""), q(t2), "[]", "null"]),

  // password
  ...cases("pw_a", "p", [
    q(""),
    q("short"),
    q("a".repeat(71)),
    q("a".repeat(72)),
    q("ж".repeat(36)), // 72 bytes
    q("ж".repeat(40)), // 40 runes, 80 bytes
    q("pass word with spaces"),
    q("\u0000nul"),
    "123",
    "1.5",
    "true",
    "null",
    `["a","b"]`,
    `{"x":1}`,
  ]),
  ...cases("pw_a", "pr", [
    q("ab"),
    q("abc"),
    q("abc1"),
    q("abcdefghij"),
    q("abcdefghijk"),
    q("1abc"),
    q("ABC"),
    q("абв"),
    q("abc12345"),
    q(""),
  ]),
  ...cases("pw_a", "pc", [q("secret"), q("ünïcödé")]),
  ...cases("pw_a", "p:hash", [q("$2a$10$XajjQvNhvvRt5GSeFk1xFeyqRrsxkhBkUiQeg0dt.wU1qD4aFDcga")]),
  ...cases("pw_req", "p", [q(""), q("x"), q("xy"), "null"]),
];

// Field JSON texts with Go int settings around 2^53 and the int64 bounds,
// sent as they are (one collection each, "$T" replaced in the text).
// Upstream decodes them into Go int / int64: out of range, fractions and
// exponents fail when the body is read; the other values are compared
// exactly by the settings validators.
export const rawSettings: string[] = [
  // relation minSelect/maxSelect (int)
  `{"name":"r","type":"relation","collectionId":"$T","minSelect":9007199254740993,"maxSelect":9007199254740992}`,
  `{"name":"r","type":"relation","collectionId":"$T","minSelect":9007199254740992,"maxSelect":9007199254740993}`,
  `{"name":"r","type":"relation","collectionId":"$T","minSelect":-9223372036854775808,"maxSelect":9223372036854775807}`,
  `{"name":"r","type":"relation","collectionId":"$T","maxSelect":9223372036854775808}`,
  `{"name":"r","type":"relation","collectionId":"$T","minSelect":-9223372036854775809}`,
  `{"name":"r","type":"relation","collectionId":"$T","maxSelect":2.0}`,
  `{"name":"r","type":"relation","collectionId":"$T","maxSelect":1e3}`,
  // text min/max (int)
  `{"name":"t","type":"text","min":9007199254740991,"max":9007199254740991}`,
  `{"name":"t","type":"text","min":9007199254740993,"max":9223372036854775807}`,
  `{"name":"t","type":"text","min":9007199254740992,"max":9007199254740991}`,
  `{"name":"t","type":"text","min":-9223372036854775808}`,
  `{"name":"t","type":"text","max":-9223372036854775809}`,
  // select maxSelect (int)
  `{"name":"s","type":"select","values":["a","b"],"maxSelect":9007199254740993}`,
  `{"name":"s","type":"select","values":["a","b"],"maxSelect":-9223372036854775808}`,
  `{"name":"s","type":"select","values":["a","b"],"maxSelect":9223372036854775808}`,
  // json and editor maxSize (int64)
  `{"name":"j","type":"json","maxSize":9007199254740991}`,
  `{"name":"j","type":"json","maxSize":9007199254740992}`,
  `{"name":"j","type":"json","maxSize":-9223372036854775808}`,
  `{"name":"e","type":"editor","maxSize":9223372036854775807}`,
  `{"name":"e","type":"editor","maxSize":9223372036854775808}`,
  // password min/max/cost (int)
  `{"name":"p","type":"password","min":9007199254740993,"max":9007199254740992,"cost":-9223372036854775808}`,
  `{"name":"p","type":"password","cost":9223372036854775807}`,
  `{"name":"p","type":"password","cost":1e1}`,
];
