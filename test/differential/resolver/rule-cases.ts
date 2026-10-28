// The rules matrix of the resolver reference test (resolver.test.ts).
//
// Each case sets the target collection's listRule and viewRule through
// upstream's PATCH /api/collections/{target}, then lists the target's
// records and views each of them as a guest, as alice and bob (members),
// as carol (users) and as a superuser, with the case's query params,
// headers and optional client-side filter. iglo.base evaluates the same
// rules for a RequestInfo holding the same auth record, query and headers.
//
// "{id:name}" in a rule is replaced with that collection's id.

export interface RuleCase {
  name: string;
  target: string;
  listRule: string | null;
  // the listRule when unset
  viewRule?: string | null;
  query?: { [key: string]: string };
  headers?: { [key: string]: string };
  // a client-side filter of the list request
  filter?: string;
}

function r(
  name: string,
  rule: string | null,
  extra: Omit<Partial<RuleCase>, "name" | "listRule"> = {},
): RuleCase {
  return { name, target: "posts", listRule: rule, ...extra };
}

export const ruleCases: RuleCase[] = [
  // plain rules and @request.auth
  r("public", ""),
  r("superusers only", null),
  r("public list, superusers-only view", "", { viewRule: null }),
  r("signed in", "@request.auth.id != ''"),
  r("guests", "@request.auth.id = ''"),
  r("owner", "author = @request.auth.id"),
  r("owner by id path", "author.id = @request.auth.id"),
  r("any editor", "editors ?= @request.auth.id"),
  r("every editor", "editors = @request.auth.id"),
  r("editor id path", "editors.id ?= @request.auth.id"),
  r(
    "owner or published",
    "@request.auth.id != '' && (published = true || author = @request.auth.id)",
  ),
  r("auth collection name", "@request.auth.collectionName = 'members'"),
  r("auth collection name users", "@request.auth.collectionName = 'users' && published = true"),
  r("auth collection id", "@request.auth.collectionId = '{id:members}'"),
  r("auth verified", "@request.auth.verified = true"),
  r("auth email visibility", "@request.auth.emailVisibility = false"),
  r("auth email", "@request.auth.email ~ 'alice'"),
  r("auth select", "@request.auth.role = 'admin' || status = 'draft'"),
  r("auth relation", "@request.auth.team = team"),
  r("auth relation field", "@request.auth.team.name = team.name"),
  r("auth relation number", "@request.auth.team.code > 1"),
  r("auth multi relation", "@request.auth.friends ?= author"),
  r("auth multi relation field", "@request.auth.friends.name ?= author.name"),
  r("auth multi relation all", "@request.auth.friends.name = author.name"),
  r("auth multi select", "@request.auth.skills ?= 'go'"),
  r("auth multi select length", "@request.auth.skills:length > 1"),
  r("auth multi select each", "@request.auth.skills:each ?= 'js'"),
  r("auth number", "@request.auth.age >= 30 && published = true"),
  r("auth number vs field", "views > @request.auth.age"),
  r("auth hidden field", "@request.auth.secret != ''"),
  r("auth json path", "@request.auth.meta.lang = 'en'"),
  r("auth back relation", "@request.auth.members_via_friends.name ?= 'Eve'"),
  r("auth unique back relation", "@request.auth.profiles_via_owner.nickname = 'bobby'"),
  r("auth missing field", "@request.auth.missing = null"),
  r("auth lower", "@request.auth.name:lower = 'alice'"),
  r("auth id lower", "@request.auth.id:lower = author"),

  // @request.query, @request.headers, @request.method, @request.context
  r("query match", "@request.query.tag = 'go' && tags.name ?= 'go'", { query: { tag: "go" } }),
  r("query mismatch", "@request.query.tag = 'go'", { query: { tag: "web" } }),
  r("query number", "@request.query.level > 10", { query: { level: "20" } }),
  r("query vs field", "@request.query.status = status", { query: { status: "live" } }),
  r("query missing", "@request.query.missing = null"),
  r("query empty", "@request.query.empty = ''", { query: { empty: "" } }),
  r("query lower", "@request.query.q:lower = title:lower", { query: { q: "HELLO WORLD" } }),
  r("query isset", "@request.query.flag:isset = true", { query: { flag: "" } }),
  r("query not isset", "@request.query.flag:isset = true"),
  r("header match", "@request.headers.x_tenant = 'alpha' && team.name:lower = 'alpha'", {
    headers: { "X-Tenant": "alpha" },
  }),
  r("header vs relation", "@request.headers.x_tenant = team.name", {
    headers: { "x-tenant": "Beta" },
  }),
  r("header missing", "@request.headers.x_missing = null"),
  r("method get", "@request.method = 'GET'"),
  r("method post", "@request.method = 'POST'"),
  r("context default", "@request.context = 'default'"),
  r("context expand", "@request.context = 'expand'"),

  // @collection
  r(
    "collection leader",
    "@collection.teams.leader ?= @request.auth.id && @collection.teams.id ?= team",
  ),
  r(
    "collection alias",
    "@collection.teams:t.leader = @request.auth.id && @collection.teams:t.id = team",
  ),
  r(
    "collection comments",
    "@collection.comments.post ?= id && @collection.comments.author ?= @request.auth.id",
  ),
  r(
    "collection two aliases",
    "@collection.comments:a.post ?= id && @collection.comments:b.likes ?> 5",
  ),
  r("collection superusers-only", "@collection.private_notes.text ?= 'top secret'"),

  // back-relations, relations, modifiers
  r("back rel author", "comments_via_post.author ?= @request.auth.id"),
  r("back rel all", "comments_via_post.likes > 0"),
  r("back rel any", "comments_via_post.likes ?> 2"),
  r("back rel multiple", "comments_via_refs.author ?= @request.auth.id"),
  r("editors length", "editors:length > 1"),
  r("categories each", "categories:each = 'news'"),
  r("categories each any", "categories:each ?= 'tech'"),
  r("tags all", "tags.weight > 0"),
  r("tags parent", "tags.parent.name ?= 'go'"),
  r("three levels", "author.team.leader = @request.auth.id"),
  r("multi nested", "author.friends.team.name ?= 'Alpha'"),
  r("lower", "title:lower ~ 'hello'"),
  r("json", "data.a.b = 'test' || data = 42"),
  r("geo", "geoDistance(location.lon, location.lat, 21, 52) < 100"),
  r("date", "strftime('%Y', publishedAt) = '2024'"),
  r("relation email", "author.email ~ 'example.com'"),
  r("relation to superusers-only", "note.text != ''"),
  r("hidden field", "hiddenScore > 1"),

  // client-side filters (list-rule joins and hidden fields for non-superusers)
  r("filter tags with list rule", "", { filter: "tags.name ?= 'go'" }),
  r("filter tags weight", "", { filter: "tags.weight ?< 1" }),
  r("filter superusers-only relation", "", { filter: "note.text != ''" }),
  r("filter hidden field", "", { filter: "hiddenScore > 1" }),
  r("filter relation email", "", { filter: "author.email ~ 'example'" }),
  r("filter missing relation", "", { filter: "author.name != '' || tags.name != ''" }),
  r("filter back relation", "@request.auth.id != ''", {
    filter: "comments_via_post.message ~ 'n'",
  }),
  r("filter with rule", "published = true", { filter: "views > 10" }),
  r("filter view rule", "author = @request.auth.id", {
    viewRule: "",
    filter: "editors:length > 0",
  }),
  { name: "members public", target: "members", listRule: "" },
  { name: "members self", target: "members", listRule: "id = @request.auth.id" },
  {
    name: "members verified or self",
    target: "members",
    listRule: "verified = true || id = @request.auth.id",
  },
  { name: "members friends", target: "members", listRule: "friends ?= @request.auth.id" },
  { name: "members team leader", target: "members", listRule: "team.leader = @request.auth.id" },
  {
    name: "members email filter",
    target: "members",
    listRule: "",
    filter: "email ~ 'example'",
  },
  {
    name: "members friends email filter",
    target: "members",
    listRule: "emailVisibility = true",
    filter: "friends.email ?~ 'example'",
  },
  {
    name: "members self join with rule",
    target: "members",
    listRule: "verified = true",
    filter: "friends.name ?!= ''",
  },
  { name: "members hidden filter", target: "members", listRule: "", filter: "secret = ''" },
  {
    name: "members same collection",
    target: "members",
    listRule: "@request.auth.collectionName = 'members' && id != @request.auth.id",
  },
  { name: "view owner", target: "post_stats", listRule: "author = @request.auth.id" },
  { name: "view published", target: "post_stats", listRule: "published = true" },
  { name: "view relation", target: "post_stats", listRule: "author.name ~ 'a'" },
  {
    name: "view comments",
    target: "post_stats",
    listRule: "comments_count > 0 || @request.auth.id != ''",
  },
  { name: "tags own rule", target: "tags", listRule: "weight > 0", filter: "parent.name = 'go'" },
  { name: "tags public", target: "tags", listRule: "", filter: "parent.weight >= 0" },
];
