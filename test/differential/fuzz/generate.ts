// The seeded case generator. A case is a function of (seed, case number) and
// the fixture's model. Each random choice is made here; printing and sending
// are elsewhere. Forms come from upstream's tools/search/filter.go,
// identifier_macros.go, token_functions.go, sort.go, provider.go and
// core/record_field_resolver*.go; fexpr v0.7.0 gives the grammar.

import type { FilterNode } from "@test/differential/fuzz/filter-ast";
import { printFilter } from "@test/differential/fuzz/filter-ast";
import type { CollectionModel, FieldModel, Model } from "@test/differential/fuzz/model";
import { Rng } from "@test/differential/fuzz/rng";

export const whoKinds = ["guest", "users", "clients", "nologin", "superuser"] as const;
export type Who = (typeof whoKinds)[number];

export interface FuzzCase {
  seed: number;
  n: number;
  collection: string;
  who: Who;
  filter: FilterNode | null;
  sort: string[] | null;
  // sort text that is not made of terms (invalid and over-limit forms)
  rawSort: string | null;
  params: { [name: string]: string };
  headers: { [name: string]: string };
  // the case reads the servers' clocks: a difference is retried once before
  // it counts
  timeDependent: boolean;
  invalid: boolean;
  // forms used, for the coverage report
  tags: Set<string>;
}

const collectionWeights: [string, number][] = [
  ["fuzz_items", 26],
  ["fuzz_tags", 6],
  ["demo1", 18],
  ["demo4", 14],
  ["demo5", 8],
  ["users", 8],
  ["demo2", 5],
  ["demo3", 5],
  ["view1", 5],
  ["nologin", 5],
  ["clients", 4],
  ["view2", 3],
  ["numeric_id_view", 2],
  ["_superusers", 2],
  ["_authOrigins", 2],
  ["_externalAuths", 1],
];

const whoWeights: [Who, number][] = [
  ["superuser", 45],
  ["guest", 20],
  ["users", 15],
  ["clients", 10],
  ["nologin", 10],
];

const signs = ["=", "!=", ">", ">=", "<", "<=", "~", "!~"];
const anySigns = ["?=", "?!=", "?>", "?>=", "?<", "?<=", "?~", "?!~"];

const dates = [
  "2022-10-01 12:00:00.000Z",
  "2022-10-01",
  "2022-10-01 12:00:00",
  "2022-01-01 00:00:00.000Z",
  "2000-01-01",
  "2099-12-31 23:59:59.999Z",
  "2022",
  "not a date",
];

const words = [
  "test",
  "TEST",
  "Test1",
  "lorem",
  "ipsum",
  "example",
  "optionA",
  "optionB",
  "b",
  "a",
  "users",
  "clients",
  "x",
  "zażółć",
  "日本語",
  "🙂",
  "0",
  "1",
  "true",
  "false",
  "null",
  "1.5",
  "123456",
  "456",
  "-1",
  " ",
  " test",
  "test ",
  "@request.auth.id",
  "@collection.demo2.id",
  "@REQUEST.x",
];

const escapes = [
  `it's`,
  `say "hi"`,
  `back\\slash`,
  `tr\\`,
  `line\nbreak`,
  `tab\there`,
  `\\%`,
  `\\_`,
  `%`,
  `%%`,
  `_`,
  `__`,
  `t%`,
  `%t`,
  `t_st`,
  `te%t`,
  `test_`,
  `%test%`,
  `\\%test`,
  `50%`,
  `a_b`,
  `{:x}`,
  `' OR 1=1 --`,
  `"; DROP TABLE demo1; --`,
];

const numbers = [
  "0",
  "1",
  "2",
  "3",
  "-1",
  "1.5",
  "-0.5",
  "0.1",
  "456",
  "123456",
  "1000000",
  "0.0",
  "007",
  "9007199254740993",
  "12345678901234567890",
  "0.000001",
];

const safeMacros = [
  "@now",
  "@yesterday",
  "@tomorrow",
  "@todayStart",
  "@todayEnd",
  "@monthStart",
  "@monthEnd",
  "@yearStart",
  "@yearEnd",
];
const partMacros = ["@hour", "@weekday", "@day", "@month", "@year"];

const strftimeFormats = [
  "%Y-%m-%d",
  "%Y",
  "%m",
  "%d",
  "%H:%M",
  "%H:%M:%S",
  "%j",
  "%J",
  "%s",
  "%w",
  "%f",
  "%%",
  "%Y-%m-%d %H:%M:%f",
  "",
];
// for strftime of the current time: a format that shows less than a day can
// change between the macro's value and the query's run, inside one server
const strftimeNowFormats = ["%Y-%m-%d", "%Y", "%m", "%d", "%j", "%w", "%%", ""];
const strftimeModifiers = [
  "start of month",
  "start of year",
  "start of day",
  "+1 day",
  "-1 month",
  "+1 year",
  "weekday 0",
  "unixepoch",
  "utc",
  "auto",
  "subsec",
  "bad modifier",
];

const wrongOps = ["==", "===", "<>", "=!", "?", "??=", "!", "=~", "&", "|", "&&&", "|||", "=>"];

interface Ctx {
  r: Rng;
  model: Model;
  c: CollectionModel;
  who: Who;
  tags: Set<string>;
  timeDependent: boolean;
  params: { [name: string]: string };
  headers: { [name: string]: string };
  // @collection joins with an alias are shared by the conditions that name it
  aliases: string[];
}

function quote(r: Rng, text: string): string {
  const q = r.chance(0.7) ? `"` : `'`;
  return q + text.replaceAll(q, `\\${q}`) + q;
}

interface Path {
  text: string;
  leaf: FieldModel | null;
}

function fieldsOf(ctx: Ctx, c: CollectionModel): FieldModel[] {
  const visible = c.fields.filter((f) => !f.hidden);
  return ctx.r.chance(0.02) || visible.length === 0 ? c.fields : visible;
}

function jsonTail(r: Rng, name: string): string {
  if (name === "point") {
    return r.pick(["lat", "lon", "lat", "lon", "missing"]);
  }
  return r.pick([
    "0",
    "1",
    "2",
    "9",
    "10",
    "a",
    "b",
    "c",
    "a.b",
    "a.b.0",
    "a.0",
    "a.b.c",
    "0.a",
    "3.a",
    "0.0",
    "missing",
    "x.y",
    "a_b",
    "A",
  ]);
}

function modifierFor(ctx: Ctx, f: FieldModel): string {
  const r = ctx.r;
  const multiValuer = f.type === "relation" || f.type === "select" || f.type === "file";
  if (multiValuer && r.chance(0.3)) {
    const modifier = r.pick([":length", ":each"]);
    ctx.tags.add(`modifier${modifier}`);
    return modifier;
  }
  if (r.chance(0.12)) {
    const modifier = r.weighted([
      [":lower", 7],
      [":isset", 1],
      [":changed", 1],
      [":each", 1],
      [":length", 1],
    ] as const);
    ctx.tags.add(`modifier${modifier}`);
    return modifier;
  }
  return "";
}

// a field path from collection c
function genPath(ctx: Ctx, c: CollectionModel, depth: number): Path {
  const r = ctx.r;
  if (depth > 0 && c.backRelations.length > 0 && r.chance(0.18)) {
    const back = r.pick(c.backRelations);
    const source = ctx.model.collections.get(back.collection) as CollectionModel;
    const rest = genPath(ctx, source, depth - 1);
    ctx.tags.add("back-relation");
    return { ...rest, text: `${back.collection}_via_${back.field}.${rest.text}` };
  }
  const f = r.pick(fieldsOf(ctx, c));
  if (f.hidden) {
    ctx.tags.add("hidden-field");
  }
  if (f.type === "relation" && f.target !== undefined && depth > 0 && r.chance(0.6)) {
    const target = ctx.model.collections.get(f.target) as CollectionModel;
    const rest = genPath(ctx, target, depth - 1);
    ctx.tags.add(f.multiple ? "relation-multiple" : "relation-single");
    return { ...rest, text: `${f.name}.${rest.text}` };
  }
  if ((f.type === "json" || f.type === "geoPoint") && r.chance(0.7)) {
    ctx.tags.add(f.type === "json" ? "json-path" : "geopoint-path");
    return { text: `${f.name}.${jsonTail(r, f.name)}`, leaf: null };
  }
  const modifier = modifierFor(ctx, f);
  return { text: f.name + modifier, leaf: modifier === ":length" ? null : f };
}

function genCollectionField(ctx: Ctx): Path {
  const r = ctx.r;
  const c = ctx.model.collections.get(r.pick(ctx.model.names)) as CollectionModel;
  let alias = "";
  if (r.chance(0.6)) {
    const name = r.pick(["a", "b", "c"]);
    alias = `:${name}`;
    ctx.aliases.push(name);
    ctx.tags.add("collection-alias");
  }
  ctx.tags.add("@collection");
  const rest = genPath(ctx, c, r.int(3));
  return { ...rest, text: `@collection.${c.name}${alias}.${rest.text}` };
}

function genRequestField(ctx: Ctx): Path {
  const r = ctx.r;
  const kind = r.weighted([
    ["auth", 8],
    ["query", 4],
    ["headers", 3],
    ["body", 4],
    ["method", 1],
    ["context", 1],
  ] as const);
  ctx.tags.add(`@request.${kind}`);
  if (kind === "method" || kind === "context") {
    return { text: `@request.${kind}`, leaf: null };
  }
  if (kind === "auth") {
    const name = r.pick([
      "id",
      "id",
      "email",
      "verified",
      "emailVisibility",
      "collectionName",
      "collectionId",
      "name",
      "username",
      "created",
      "rel.title",
      "rel.active",
      "rel.missing",
      "file:length",
      "file:each",
      "name:lower",
      "email:lower",
      "username:lower",
      "missing",
      "password",
      "tokenKey",
    ]);
    return { text: `@request.auth.${name}`, leaf: null };
  }
  if (kind === "query") {
    ctx.params.q = r.pick(["test", "1", "", "true", "TeSt", "%", ...words.slice(0, 4)]);
    const name = r.pick(["q", "q", "q:isset", "q:lower", "missing", "missing:isset", "perPage"]);
    return { text: `@request.query.${name}`, leaf: null };
  }
  if (kind === "headers") {
    ctx.headers["x-token"] = r.pick(["test", "1", "TeSt", "a b"]);
    const name = r.pick([
      "x_token",
      "x_token",
      "x_token:isset",
      "x_token:lower",
      "x_missing",
      "x_missing:isset",
      "accept",
    ]);
    return { text: `@request.headers.${name}`, leaf: null };
  }
  const f = r.pick(ctx.c.fields);
  const tail = r.pick([
    f.name,
    "missing",
    "missing:isset",
    `${f.name}:isset`,
    `${f.name}:changed`,
    `${f.name}:lower`,
    `${f.name}:length`,
    `${f.name}:each`,
    `${f.name}.title`,
  ]);
  return { text: `@request.body.${tail}`, leaf: null };
}

function genMacro(ctx: Ctx): string {
  ctx.tags.add("macro");
  ctx.timeDependent = true;
  return ctx.r.pick(safeMacros);
}

// a number or date comparison for the macros that change every second or
// minute: true or false at any instant
function genClockSafeCond(ctx: Ctx): FilterNode {
  const r = ctx.r;
  ctx.tags.add("macro-second-minute");
  const macro = r.pick(["@second", "@minute"]);
  const [op, value] = r.pick([
    [">=", "0"],
    ["<", "60"],
    ["<=", "59"],
    ["!=", "99"],
    ["=", "-1"],
    [">", "60"],
    ["?>=", "0"],
    ["?!=", "99"],
  ] as const);
  return { k: "cond", left: macro, op, right: value, gap: " " };
}

function genFunction(ctx: Ctx): string {
  const r = ctx.r;
  if (r.chance(0.5)) {
    ctx.tags.add("geoDistance");
    const pointOf = (axis: string): string => {
      const c = ctx.c.fields.some((f) => f.type === "geoPoint");
      return r.weighted([
        [c ? `point.${axis}` : `missing.${axis}`, 5],
        [String(r.pick([0, 1, 23.333157, 42.654318, -74.006015, 40.712728, 180, -90])), 5],
        ["rel_one.point.lat", 1],
        ["rel_many.point.lon", 1],
        ["@request.query.q", 1],
        ["text", 1],
        ["null", 1],
      ] as const);
    };
    return `geoDistance(${pointOf("lon")}, ${pointOf("lat")}, ${pointOf("lon")}, ${pointOf("lat")})`;
  }
  ctx.tags.add("strftime");
  const args: string[] = [];
  const value = r.weighted([
    ["field", 6],
    ["date", 3],
    ["number", 1],
    ["now", 1],
    ["none", 1],
  ] as const);
  args.push(
    quote(r, r.pick(value === "now" || value === "none" ? strftimeNowFormats : strftimeFormats)),
  );
  if (value === "field") {
    const dateFields = ctx.c.fields.filter((f) => f.type === "date" || f.type === "autodate");
    const relations = ctx.c.fields.filter((f) => f.target !== undefined);
    if (relations.length > 0 && r.chance(0.3)) {
      args.push(`${r.pick(relations).name}.created`);
    } else {
      args.push(dateFields.length > 0 ? r.pick(dateFields).name : "created");
    }
  } else if (value === "date") {
    args.push(quote(r, r.pick(dates)));
  } else if (value === "number") {
    args.push(r.pick(["0", "2459580", "1664625600"]));
  } else if (value === "now") {
    ctx.timeDependent = true;
    args.push(quote(r, "now"));
  } else {
    ctx.timeDependent = true;
  }
  if (args.length > 1) {
    while (r.chance(0.3)) {
      args.push(quote(r, r.pick(strftimeModifiers)));
    }
  }
  return `strftime(${args.join(r.pick([", ", ","]))})`;
}

function plainValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function genLiteral(ctx: Ctx): string {
  const r = ctx.r;
  return r.weighted<() => string>([
    [() => `""`, 3],
    [() => `''`, 1],
    [() => r.pick(["null", "null", "NULL", "Null"]), 4],
    [() => r.pick(["true", "false", "TRUE", "False"]), 3],
    [() => r.pick(numbers), 4],
    [() => quote(r, r.pick(numbers)), 3],
    [() => quote(r, r.pick(["true", "false"])), 1],
    [() => quote(r, r.pick(words)), 4],
    [() => quote(r, r.pick(dates)), 3],
    [
      () => {
        ctx.tags.add("escapes");
        return quote(r, r.pick(escapes));
      },
      3,
    ],
  ])();
}

function genSample(ctx: Ctx, leaf: FieldModel): string {
  const r = ctx.r;
  const sample = r.pick(leaf.samples);
  if (sample === null) {
    return "null";
  }
  if (typeof sample === "number" || typeof sample === "boolean") {
    return r.chance(0.8) ? String(sample) : quote(r, String(sample));
  }
  if (typeof sample === "object" && (sample as { lon?: number }).lon !== undefined) {
    return quote(r, plainValue(sample));
  }
  // a stored array or object: its text, or one of its values
  if (typeof sample === "object" && r.chance(0.6)) {
    const [value] = Object.values(sample as object) as unknown[];
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (typeof value === "string") {
      return quote(r, value);
    }
  }
  return quote(r, plainValue(sample));
}

// a value for the ~ operators: part of a stored value, wildcards, escapes
function genLikeValue(ctx: Ctx, leaf: FieldModel | null): string {
  const r = ctx.r;
  ctx.tags.add("like");
  const sample = leaf !== null && leaf.samples.length > 0 ? plainValue(r.pick(leaf.samples)) : "";
  const text = sample ?? "";
  const start = r.int(text.length + 1);
  const part = text.slice(start, start + 1 + r.int(6)).toWellFormed();
  return quote(
    r,
    r.weighted([
      [part, 5],
      [`%${part}`, 2],
      [`${part}%`, 2],
      [`%${part}%`, 1],
      [part.replaceAll(/[a-z]/g, "_"), 1],
      [r.pick(escapes), 3],
      [part.toUpperCase(), 1],
    ] as const),
  );
}

// the right side for a left side that ended in `leaf`
function genRight(ctx: Ctx, leaf: FieldModel | null, op: string): string {
  const r = ctx.r;
  if (op.endsWith("~") && r.chance(0.7)) {
    return genLikeValue(ctx, leaf);
  }
  if (leaf !== null && leaf.samples.length > 0 && r.chance(0.45)) {
    return genSample(ctx, leaf);
  }
  if (leaf !== null && (leaf.type === "date" || leaf.type === "autodate") && r.chance(0.4)) {
    return r.chance(0.5) ? genMacro(ctx) : quote(r, r.pick(dates));
  }
  return r.weighted<() => string>([
    [() => genLiteral(ctx), 8],
    [() => genPath(ctx, ctx.c, r.int(3)).text, 3],
    [() => genOperand(ctx).text, 2],
  ])();
}

function superuserForms(ctx: Ctx): number {
  // @request.* and @collection.* in a filter are refused for everyone else;
  // a few such cases check the refusal
  return ctx.who === "superuser" ? 0.3 : 0.01;
}

function genOperand(ctx: Ctx): Path {
  const r = ctx.r;
  const special = superuserForms(ctx);
  if (r.chance(special)) {
    return r.chance(0.45) ? genCollectionField(ctx) : genRequestField(ctx);
  }
  return r.weighted<() => Path>([
    [
      () =>
        genPath(
          ctx,
          ctx.c,
          r.weighted([
            [0, 4],
            [1, 3],
            [2, 2],
            [3, 1],
          ] as const),
        ),
      86,
    ],
    [() => ({ text: genFunction(ctx), leaf: null }), 7],
    [() => ({ text: genMacro(ctx), leaf: null }), 2],
    [() => ({ text: r.pick(partMacrosWithTag(ctx)), leaf: null }), 1],
    [() => ({ text: genLiteral(ctx), leaf: null }), 4],
  ])();
}

function partMacrosWithTag(ctx: Ctx): string[] {
  ctx.tags.add("macro");
  ctx.timeDependent = true;
  return partMacros;
}

function genCond(ctx: Ctx): FilterNode {
  const r = ctx.r;
  if (r.chance(0.01)) {
    return genClockSafeCond(ctx);
  }
  const left = genOperand(ctx);
  const any = r.chance(0.4);
  if (any) {
    ctx.tags.add("any-of");
  }
  const op = r.pick(any ? anySigns : signs);
  ctx.tags.add(`op ${op}`);
  return {
    k: "cond",
    left: left.text,
    op,
    right: genRight(ctx, left.leaf, op),
    gap: r.pick([" ", " ", " ", "", "\n", "\t", "  "]),
  };
}

function genTree(ctx: Ctx, depth: number): FilterNode {
  const r = ctx.r;
  if (depth === 0 || r.chance(0.35)) {
    return genCond(ctx);
  }
  if (r.chance(0.2)) {
    ctx.tags.add("parens");
    return { k: "paren", inner: genTree(ctx, depth - 1) };
  }
  const size = 2 + r.int(4);
  const items: FilterNode[] = [];
  for (let i = 0; i < size; i++) {
    items.push(genTree(ctx, depth - 1));
  }
  ctx.tags.add("join");
  return {
    k: "join",
    op: r.chance(0.55) ? "&&" : "||",
    items: items.map((item) => (item.k === "join" ? { k: "paren", inner: item } : item)),
    gap: r.pick([" ", " ", "", "\n"]),
  };
}

function genFilter(ctx: Ctx): FilterNode {
  const r = ctx.r;
  const tree = genTree(
    ctx,
    r.weighted([
      [0, 4],
      [1, 3],
      [2, 2],
      [3, 1],
    ] as const),
  );
  if (r.chance(0.02)) {
    ctx.tags.add("comment");
    return { k: "raw", text: `// leading\n${printFilter(tree)} // trailing\n` };
  }
  return tree;
}

function genSortTerm(ctx: Ctx): string {
  const r = ctx.r;
  const prefix = r.pick(["", "", "-", "+"]);
  if (r.chance(0.12)) {
    ctx.tags.add("sort-rowid");
    return `${prefix}@rowid`;
  }
  if (r.chance(0.12)) {
    return `${prefix}id`;
  }
  const path = genPath(
    ctx,
    ctx.c,
    r.weighted([
      [0, 6],
      [1, 3],
      [2, 1],
    ] as const),
  );
  if (path.text.includes(".")) {
    ctx.tags.add("sort-relation");
  }
  return `${prefix}${path.text}`;
}

function genSort(ctx: Ctx): string[] {
  const r = ctx.r;
  const terms: string[] = [];
  const size =
    1 +
    r.weighted([
      [0, 4],
      [1, 4],
      [2, 2],
      [3, 1],
    ] as const);
  for (let i = 0; i < size; i++) {
    terms.push(genSortTerm(ctx));
  }
  if (size > 1) {
    ctx.tags.add("sort-multi");
  }
  // mostly a total order, so that the order of the ids can be compared
  if (r.chance(0.7) && !terms.some((t) => /^[-+]?(id|@rowid)$/.test(t))) {
    terms.push(r.pick(["id", "-id", "@rowid", "-@rowid"]));
  }
  return terms;
}

function genParams(ctx: Ctx): void {
  const r = ctx.r;
  const { params } = ctx;
  const perPage = r.weighted([
    [null, 3],
    ["1", 2],
    ["2", 2],
    ["3", 1],
    ["5", 1],
    ["30", 1],
    ["1000", 1],
  ] as const);
  if (perPage !== null) {
    params.perPage = perPage;
  }
  const page = r.weighted([
    [null, 6],
    ["1", 1],
    ["2", 2],
    ["3", 1],
    ["1000", 0.2],
  ] as const);
  if (page !== null) {
    params.page = page;
  }
  if (r.chance(0.25)) {
    params.skipTotal = r.pick(["1", "true", "0", "false"]);
    ctx.tags.add("skipTotal");
  }
}

function invalidParams(ctx: Ctx): void {
  const r = ctx.r;
  ctx.params[r.pick(["page", "perPage", "skipTotal"])] = r.pick([
    "0",
    "-1",
    "abc",
    "1.5",
    "1e3",
    "1001",
    "99999999999999999999",
    "",
    " 1",
  ]);
}

function mutate(r: Rng, text: string): string {
  let out = text;
  const edits = 1 + r.int(3);
  for (let i = 0; i < edits; i++) {
    const at = r.int(out.length + 1);
    const piece = r.pick([
      ...`()&|=!~?"'@.:<>,`.split(""),
      "&&",
      "||",
      "?=",
      " ",
      "\\",
      "//",
      "1",
      "x",
      "_via_",
      ":each",
      ":lower",
      "@request.",
      "@collection.",
    ]);
    out = r.chance(0.5)
      ? out.slice(0, at) + piece + out.slice(at)
      : out.slice(0, at) + out.slice(at + 1 + r.int(3));
  }
  return out.toWellFormed();
}

const brokenFilters = [
  "collectionId != 1",
  "collectionName != 1",
  "expand != 1",
  "id = 5abc",
  "id = 1.2.3",
  "id = .5",
  "id = 5.",
  "id = -",
  "id = +1",
  "id = 0x10",
  "id = 1e3",
  "id = 1_000",
  "id ~ --1",
  "",
  " ",
  "\n",
  "// only a comment",
  "()",
  "(",
  ")",
  "(())",
  "&&",
  "||",
  "=",
  "id",
  "id =",
  "= id",
  "id = ",
  `id = "`,
  `id = '`,
  `"id`,
  "id = 1 &&",
  "id = 1 ||",
  "&& id = 1",
  "id = 1 id = 2",
  "(id = 1",
  "id = 1)",
  "id = (1)",
  "1",
  "true",
  "null",
  `"text"`,
  "@now",
  "@unknown = 1",
  "@request",
  "@request.",
  "@request.auth",
  "@request.unknown.x = 1",
  "@request.method:isset = true",
  "@request.context:lower = 'default'",
  "@collection = 1",
  "@collection.demo2 = 1",
  "@collection.missing.id = 1",
  "@collection.demo2.missing = 1",
  "@collection.demo2:.title = 1",
  "@collection.demo2:a:b.title = 1",
  "unknown()",
  "geoDistance() > 1",
  "geoDistance(1, 2, 3) > 1",
  "geoDistance(1, 2, 3, 4, 5) > 1",
  `geoDistance("a", 2, 3, 4) > 1`,
  "strftime() = 1",
  "strftime(1) = 1",
  `strftime("%Y", true) = 1`,
  `strftime("%Y", created, 1) = 1`,
  `strftime("%Y", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j") = 1`,
  "id = geoDistance(",
  "id = strftime(",
  "a.b.c.d.e.f.g.h = 1",
];

function overLimit(ctx: Ctx): { filter?: string; sort?: string } {
  const r = ctx.r;
  ctx.tags.add("over-limit");
  const cond = `id != "x"`;
  return r.weighted<() => { filter?: string; sort?: string }>([
    // 200 expressions pass, 201 do not
    [() => ({ filter: Array.from({ length: 200 }, () => cond).join("&&") }), 1],
    [() => ({ filter: Array.from({ length: 201 }, () => cond).join("&&") }), 1],
    // 3,500 characters pass, 3,501 do not
    [() => ({ filter: `id != "${"x".repeat(3500 - 8)}"` }), 1],
    [() => ({ filter: `id != "${"x".repeat(3501 - 8)}"` }), 1],
    // deep nesting, within the length limit
    [() => ({ filter: `${"(".repeat(1000)}id != ""${")".repeat(1000)}` }), 1],
    [() => ({ filter: `${"(".repeat(1740)}id != ""${")".repeat(1740)}` }), 1],
    // sort expressions: 8 pass, 9 do not
    [() => ({ sort: Array.from({ length: 8 }, () => "id").join(",") }), 1],
    [() => ({ sort: Array.from({ length: 9 }, () => "id").join(",") }), 1],
    // the longest sort field
    [() => ({ sort: `${"a".repeat(255)}` }), 1],
    [() => ({ sort: `${"a".repeat(256)}` }), 1],
  ])();
}

function genInvalid(ctx: Ctx, base: FilterNode): { filter: FilterNode | null; sort?: string } {
  const r = ctx.r;
  const kind = r.weighted([
    ["unknown-field", 3],
    ["broken", 3],
    ["mutation", 4],
    ["wrong-op", 1],
    ["bad-modifier", 2],
    ["bad-sort", 2],
    ["over-limit", 1],
  ] as const);
  ctx.tags.add(`invalid ${kind}`);
  const text = printFilter(base);
  switch (kind) {
    case "unknown-field": {
      const path = genPath(ctx, ctx.c, r.int(3)).text.replace(/:\w+$/, "");
      const tail = r.pick([
        ".missing",
        "_missing",
        "_via_missing",
        ".id.id",
        ".collectionId",
        ".collectionName",
        ".expand",
        ":each.id",
        ":lower.id",
      ]);
      return { filter: { k: "raw", text: `${path}${tail} ${r.pick(signs)} 1` } };
    }
    case "broken":
      return { filter: { k: "raw", text: r.pick(brokenFilters) } };
    case "mutation":
      return { filter: { k: "raw", text: mutate(r, text) } };
    case "wrong-op":
      return { filter: { k: "raw", text: `id ${r.pick(wrongOps)} 1` } };
    case "bad-modifier": {
      const path = genPath(ctx, ctx.c, r.int(2)).text.replace(/:\w+$/, "");
      const modifier = r.pick([":unknown", ":", ":lower:lower", ":each:length", ":LENGTH"]);
      return { filter: { k: "raw", text: `${path}${modifier} ${r.pick(signs)} 1` } };
    }
    case "bad-sort":
      return {
        filter: base,
        sort: r.pick([
          "missing",
          "rel_one.missing",
          "@request.auth.id",
          "@request.query.q",
          "@collection.demo2.title",
          "@now",
          "null",
          `"text"`,
          "text text",
          "-",
          "+",
          ",",
          " , ",
          "id,",
          ",id",
          "id,,id",
          "--id",
          "-+id",
          "@rowid.x",
          "@ROWID",
          "geoDistance(1,2,3,4)",
        ]),
      };
    case "over-limit": {
      const limit = overLimit(ctx);
      return {
        filter: limit.filter === undefined ? base : { k: "raw", text: limit.filter },
        ...(limit.sort === undefined ? {} : { sort: limit.sort }),
      };
    }
  }
}

export function generateCase(model: Model, seed: number, n: number): FuzzCase {
  const r = new Rng(seed, n);
  const collection = r.weighted(collectionWeights);
  const who = r.weighted(whoWeights);
  const ctx: Ctx = {
    r,
    model,
    c: model.collections.get(collection) as CollectionModel,
    who,
    tags: new Set(),
    timeDependent: false,
    params: {},
    headers: {},
    aliases: [],
  };
  genParams(ctx);
  let filter: FilterNode | null = r.chance(0.93) ? genFilter(ctx) : null;
  let sort: string[] | null = r.chance(0.65) ? genSort(ctx) : null;
  let rawSort: string | null = null;
  const invalid = r.chance(0.1);
  if (invalid) {
    if (r.chance(0.15)) {
      invalidParams(ctx);
    } else {
      const bad = genInvalid(ctx, filter ?? genFilter(ctx));
      filter = bad.filter;
      if (bad.sort !== undefined) {
        sort = null;
        rawSort = bad.sort;
      }
    }
  }
  return {
    seed,
    n,
    collection,
    who,
    filter,
    sort,
    rawSort,
    params: ctx.params,
    headers: ctx.headers,
    timeDependent: ctx.timeDependent,
    invalid,
    tags: ctx.tags,
  };
}
