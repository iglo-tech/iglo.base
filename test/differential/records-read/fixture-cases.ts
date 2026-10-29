// Records list and view requests on upstream's fixture
// (test/fixtures/pocketbase), each sent to upstream v0.41.0 and iglo.base
// as a guest, a regular user and a superuser (records-read.test.ts).
//
// The URLs are sent as written (percent-encoded where Go's server would
// otherwise reject them).

export type Identity = "guest" | "users" | "clients" | "nologin" | "superuser";

export interface ReadCase {
  name: string;
  url: string;
  // the identities the request is sent as (all when not set)
  as?: Identity[];
  headers?: Record<string, string>;
}

const e = encodeURIComponent;

export const fixtureCases: ReadCase[] = [
  // collection lookup and the rule checks
  { name: "unknown collection list", url: "/api/collections/missing/records" },
  { name: "unknown collection view", url: "/api/collections/missing/records/abc" },
  { name: "null list rule", url: "/api/collections/demo1/records" },
  { name: "null view rule", url: "/api/collections/demo1/records/al1h9ijdeojtsjy" },
  { name: "missing record", url: "/api/collections/demo2/records/missing" },
  { name: "public list", url: "/api/collections/demo2/records" },
  { name: "public list by id", url: "/api/collections/sz5l5z67tg7gku0/records?sort=-title" },
  { name: "public view", url: "/api/collections/demo2/records/llvuca81nly1qls" },
  { name: "rule list (demo3)", url: "/api/collections/demo3/records" },
  { name: "rule view (demo3)", url: "/api/collections/demo3/records/1tmknxy2868d869" },
  { name: "auth collection list (users)", url: "/api/collections/users/records" },
  { name: "auth collection view (users)", url: "/api/collections/users/records/oap640cot4yru2s" },
  { name: "manageRule list (nologin)", url: "/api/collections/nologin/records?sort=email" },
  { name: "manageRule view (nologin)", url: "/api/collections/nologin/records/phhq3wr65cap535" },
  { name: "superusers list", url: "/api/collections/_superusers/records" },
  { name: "view collection list (view1)", url: "/api/collections/view1/records" },
  { name: "view collection view (view1)", url: "/api/collections/view1/records/84nmscqy84lsi1t" },
  { name: "view collection list (view2)", url: "/api/collections/view2/records?sort=-id" },
  { name: "numeric id view list", url: "/api/collections/numeric_id_view/records?sort=-id" },
  { name: "numeric id view record", url: "/api/collections/numeric_id_view/records/2" },
  { name: "demo4 list", url: "/api/collections/demo4/records" },
  { name: "demo5 list", url: "/api/collections/demo5/records" },

  // page, perPage, skipTotal
  { name: "skipTotal", url: "/api/collections/demo2/records?skipTotal=1", as: ["guest"] },
  { name: "skipTotal=false", url: "/api/collections/demo2/records?skipTotal=false", as: ["guest"] },
  { name: "skipTotal invalid", url: "/api/collections/demo2/records?skipTotal=abc", as: ["guest"] },
  {
    name: "perPage=1 page=2",
    url: "/api/collections/demo2/records?perPage=1&page=2",
    as: ["guest"],
  },
  { name: "perPage=0", url: "/api/collections/demo2/records?perPage=0", as: ["guest"] },
  { name: "perPage=-5", url: "/api/collections/demo2/records?perPage=-5", as: ["guest"] },
  { name: "perPage=5000", url: "/api/collections/demo2/records?perPage=5000", as: ["guest"] },
  { name: "perPage invalid", url: "/api/collections/demo2/records?perPage=x", as: ["guest"] },
  { name: "page=0", url: "/api/collections/demo2/records?page=0", as: ["guest"] },
  { name: "page past the end", url: "/api/collections/demo2/records?page=9", as: ["guest"] },
  {
    name: "page out of int64 range",
    url: "/api/collections/demo2/records?page=99999999999999999999",
    as: ["guest"],
  },
  {
    name: "huge page",
    url: "/api/collections/demo2/records?page=9223372036854775807&perPage=1000",
    as: ["guest"],
  },

  // filter and sort
  { name: "filter", url: `/api/collections/demo2/records?filter=${e("title~'test'")}` },
  { name: "filter syntax error", url: `/api/collections/demo2/records?filter=${e("title='")}` },
  { name: "filter unknown field", url: `/api/collections/demo2/records?filter=${e("nope=1")}` },
  { name: "sort unknown field", url: "/api/collections/demo2/records?sort=nope" },
  {
    name: "sort @random",
    url: `/api/collections/demo2/records?sort=@random&filter=${e("id='0yxhwia2amd8gec'")}`,
  },
  { name: "sort @rowid", url: "/api/collections/demo2/records?sort=-@rowid" },
  {
    name: "filter @request (guest)",
    url: `/api/collections/demo2/records?filter=${e("@request.auth.id=''")}`,
  },
  {
    name: "filter @collection",
    url: `/api/collections/demo2/records?filter=${e("@collection.demo1.text!=''")}`,
  },
  {
    name: "filter by email",
    url: `/api/collections/users/records?filter=${e("email~'test'")}`,
  },
  {
    name: "filter too long",
    url: `/api/collections/demo2/records?filter=${e("title='" + "a".repeat(3600) + "'")}`,
    as: ["guest"],
  },
  {
    name: "too many sort fields",
    url: "/api/collections/demo2/records?sort=a,b,c,d,e,f,g,h,i",
    as: ["superuser"],
  },
  { name: "invalid query escape", url: "/api/collections/demo2/records?filter=%zz", as: ["guest"] },

  // expand
  {
    name: "expand relations",
    url: "/api/collections/demo1/records?expand=rel_one,rel_many.rel,missing&sort=created",
    as: ["superuser"],
  },
  {
    name: "expand one record",
    url: "/api/collections/demo1/records/al1h9ijdeojtsjy?expand=rel_one,rel_many.rel",
    as: ["superuser"],
  },
  {
    name: "expand back-relation",
    url: "/api/collections/demo3/records?expand=demo4_via_rel_one_cascade,demo4_via_rel_many_no_cascade_required",
  },
  {
    name: "expand old back-relation syntax",
    url: "/api/collections/demo3/records?expand=demo4(rel_one_cascade)",
    as: ["clients", "superuser"],
  },
  {
    name: "expand nested back-relation",
    url: "/api/collections/demo3/records/lcl9d87w22ml6jy?expand=demo4_via_rel_many_no_cascade_required.self_rel_many.rel_many_no_cascade_required.demo4_via_rel_many_no_cascade_required",
  },
  {
    name: "expand self relations past the depth limit",
    url: "/api/collections/demo4/records?expand=self_rel_many.self_rel_many.self_rel_many.self_rel_many.self_rel_many.self_rel_many.self_rel_many.self_rel_many",
  },
  {
    name: "expand normalizations",
    url: `/api/collections/demo4/records?expand=${e(" self_rel_one ,self_rel_many.,,.self_rel_many.self_rel_one")}`,
  },
  {
    name: "expand of a superusers-only collection",
    url: "/api/collections/demo4/records?expand=rel_one_no_cascade,rel_many_no_cascade",
  },
  {
    name: "expand unknown and non-relation fields",
    url: "/api/collections/demo4/records?expand=title,missing,missing_via_rel,demo3_via_missing",
  },
  {
    name: "expand auth relation (email visibility)",
    url: "/api/collections/demo1/records?expand=rel_one&sort=created",
    as: ["users", "superuser"],
  },

  // fields
  {
    name: "fields",
    url: "/api/collections/demo1/records?fields=id,text,bool",
    as: ["superuser"],
  },
  {
    name: "fields with nested expand paths",
    url: "/api/collections/demo1/records?expand=rel_one,rel_many.rel&fields=id,expand.rel_one.email,expand.rel_many.expand.rel.title",
    as: ["superuser"],
  },
  {
    name: "fields wildcard with nested exception",
    url: "/api/collections/demo1/records?expand=rel_many&fields=*,expand.rel_many.id",
    as: ["superuser"],
  },
  {
    name: "fields expand wildcard",
    url: "/api/collections/demo1/records/al1h9ijdeojtsjy?expand=rel_one&fields=id,expand.*",
    as: ["superuser"],
  },
  {
    name: "fields on a single record",
    url: "/api/collections/demo2/records/0yxhwia2amd8gec?fields=title,missing",
  },
  {
    name: "fields excerpt",
    url: `/api/collections/demo1/records?fields=${e("id,text:excerpt(4,true),json")}`,
    as: ["superuser"],
  },
  {
    name: "fields excerpt of every field",
    url: `/api/collections/demo1/records?fields=${e("*:excerpt(3)")}`,
    as: ["superuser"],
  },
  {
    name: "fields excerpt with the largest int64 limit",
    url: `/api/collections/demo2/records/0yxhwia2amd8gec?fields=${e("title:excerpt(9223372036854775807)")}`,
    as: ["guest"],
  },
  {
    name: "fields excerpt with the int64 limit minus one",
    url: `/api/collections/demo2/records?sort=id&fields=${e("title:excerpt(9223372036854775806)")}`,
    as: ["guest"],
  },
  {
    name: "fields excerpt with the int64 limit minus two",
    url: `/api/collections/demo2/records?sort=id&fields=${e("title:excerpt(9223372036854775805)")}`,
    as: ["guest"],
  },
  {
    name: "fields excerpt without arguments",
    url: `/api/collections/demo2/records?fields=${e("title:excerpt")}`,
    as: ["guest"],
  },
  {
    name: "fields unknown modifier",
    url: `/api/collections/demo2/records?fields=${e("title:nope(1)")}`,
    as: ["guest"],
  },
  {
    name: "fields on an error response",
    url: "/api/collections/demo1/records?fields=status",
    as: ["guest"],
  },
  {
    name: "fields of json values",
    url: "/api/collections/demo5/records?fields=id,total,select_one",
    as: ["superuser"],
  },
];
