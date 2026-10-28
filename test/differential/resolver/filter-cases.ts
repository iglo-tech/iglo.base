// The superuser filter cases of the resolver reference test
// (resolver.test.ts): each one is sent as
// GET /api/collections/{collection}/records?filter=…&sort=…&perPage=200
// to upstream and run through iglo.base's Provider with the record field
// resolver and through FindRecordsByFilter.

export interface FilterCase {
  name: string;
  collection: string;
  filter: string;
  // "" for none (the ids are then compared as a set)
  sort: string;
}

function c(name: string, collection: string, filter: string, sort = "id"): FilterCase {
  return { name, collection, filter, sort };
}

export const filterCases: FilterCase[] = [
  // plain fields
  c("text eq", "posts", "title = 'Hello World'"),
  c("text neq", "posts", "title != 'Hello World'"),
  c("text like", "posts", "title ~ 'hello'"),
  c("text not like", "posts", "title !~ 'hello'"),
  c("text like underscore", "posts", "title ~ 'Gamma_'"),
  c("text like percent", "posts", "title ~ '100%'"),
  c("text like quote", "posts", "title ~ \"'quote'\""),
  c("text like backslash", "posts", "title ~ '\\\\'"),
  c("text unicode", "posts", "title = 'Ünïcode ✓'"),
  c("text empty", "posts", "title = ''"),
  c("text null", "posts", "title = null"),
  c("text not empty", "posts", "title != ''"),
  c("number gt", "posts", "views > 10"),
  c("number gte real", "posts", "views >= 7.5"),
  c("number negative", "posts", "views < 0"),
  c("number zero", "posts", "views = 0"),
  c("number vs text", "posts", "views = '100'"),
  c("bool true", "posts", "published = true"),
  c("bool false", "posts", "published = false"),
  c("bool not true", "posts", "published != true"),
  c("select single", "posts", "status = 'live'"),
  c("select single empty", "posts", "status = ''"),
  c("select multi eq", "posts", "categories = 'news'"),
  c("select multi any eq", "posts", "categories ?= 'news'"),
  c("select multi neq", "posts", "categories != 'news'"),
  c("select multi any neq", "posts", "categories ?!= 'news'"),
  c("select multi like", "posts", "categories ~ 'te'"),
  c("select multi each eq", "posts", "categories:each = 'news'"),
  c("select multi each any eq", "posts", "categories:each ?= 'tech'"),
  c("select multi each like", "posts", "categories:each ~ 'e'"),
  c("select multi length", "posts", "categories:length = 2"),
  c("select multi length zero", "posts", "categories:length = 0"),
  c("select multi length gt", "posts", "categories:length > 1"),
  c("date gt", "posts", "publishedAt > '2024-01-01'"),
  c("date empty", "posts", "publishedAt = ''"),
  c("date macro", "posts", "publishedAt < @now && publishedAt != ''"),
  c("date strftime", "posts", "strftime('%Y', publishedAt) = '2024'"),
  c("autodate", "posts", "created <= @now && updated >= created"),
  c("url like", "posts", "website ~ 'example'"),
  c("email field", "posts", "contactEmail ~ '@example.com'"),
  c("editor like", "posts", "body ~ 'hi'"),
  c("file empty", "posts", "attachments:length = 0"),
  c("file length", "posts", "attachments:length > 0"),
  c("file like", "posts", "attachments ~ '.txt'"),
  c("hidden field", "posts", "hiddenScore > 1"),
  c("slug", "posts", "slug = 'gamma' || slug = 'upper'"),
  c("lower modifier", "posts", "title:lower = 'upper case'"),
  c("lower modifier like", "posts", "title:lower ~ 'hello'"),
  c("lower on both sides", "posts", "title:lower = status:lower"),
  c("field vs field", "posts", "title != slug"),
  c("field like field", "posts", "title ~ slug"),

  // json and geoPoint
  c("json path", "posts", "data.a.b = 'test'"),
  c("json path neq", "posts", "data.a.b != 'test'"),
  c("json array index", "posts", "data.1 = 'two'"),
  c("json nested index", "posts", "data.list.2 = 3"),
  c("json top-level number", "posts", "data = 42"),
  c("json top-level string", "posts", "data = 'plain string'"),
  c("json top-level bool", "posts", "data = true"),
  c("json null", "posts", "data = null"),
  c("json not null", "posts", "data != null"),
  c("json like", "posts", "data ~ 'two'"),
  c("json each", "posts", "data:each ?= 1"),
  c("json length", "posts", "data:length = 3"),
  c("geo lon", "posts", "location.lon > 0"),
  c("geo lat", "posts", "location.lat >= 51.5"),
  c("geo distance", "posts", "geoDistance(location.lon, location.lat, 21, 52) < 100"),
  c("geo zero", "posts", "location.lon = 0 && location.lat = 0"),

  // single relations
  c("rel id", "posts", "author = 'alice0000000000'"),
  c("rel id path", "posts", "author.id = 'alice0000000000'"),
  c("rel empty", "posts", "author = ''"),
  c("rel field", "posts", "author.name = 'Alice'"),
  c("rel field neq", "posts", "author.name != 'Alice'"),
  c("rel hidden field", "posts", "author.secret != ''"),
  c("rel email", "posts", "author.email ~ 'example.com'"),
  c("rel two levels", "posts", "author.team.name = 'Alpha'"),
  c("rel three levels", "posts", "author.team.leader.name = 'Alice'"),
  c("rel relation to self", "tags", "parent.name = 'go'"),
  c("rel self two levels", "tags", "parent.parent.name = 'go'"),
  c("rel superusers-only target", "posts", "note.text != ''"),
  c("rel json path", "posts", "author.meta.lang = 'en'"),
  c("rel geo", "posts", "author.loc.lon = 10"),

  // multiple relations
  c("multi rel eq", "posts", "editors = 'bob000000000000'"),
  c("multi rel any eq", "posts", "editors ?= 'bob000000000000'"),
  c("multi rel id any", "posts", "editors.id ?= 'bob000000000000'"),
  c("multi rel field all", "posts", "editors.name = 'Bob'"),
  c("multi rel field any", "posts", "editors.name ?= 'Bob'"),
  c("multi rel field neq", "posts", "editors.name != 'Bob'"),
  c("multi rel field any neq", "posts", "editors.name ?!= 'Bob'"),
  c("multi rel number all", "posts", "tags.weight > 0"),
  c("multi rel number any", "posts", "tags.weight ?> 3"),
  c("multi rel nested", "posts", "editors.team.name ?= 'Beta'"),
  c("multi rel nested all", "posts", "editors.team.name = 'Beta'"),
  c("multi rel self", "members", "friends.name ?= 'Dave'"),
  c("multi rel self all", "members", "friends.name = 'Alice'"),
  c("multi rel length", "posts", "editors:length = 2"),
  c("multi rel each", "posts", "editors:each ?= 'eve000000000000'"),
  c("multi rel each all", "posts", "editors:each = 'alice0000000000'"),
  c("multi rel lower", "posts", "editors.name:lower ?= 'bob'"),
  c("multi vs multi", "posts", "editors.name ?= tags.name"),
  c("multi rel strftime", "posts", "strftime('%Y', editors.birthday) ?= '1990'"),
  c("multi rel null", "posts", "editors.name = null"),
  c("multi rel parent tags", "posts", "tags.parent.name ?= 'go'"),

  // back-relations
  c("back rel any", "posts", "comments_via_post.likes ?> 2"),
  c("back rel all", "posts", "comments_via_post.likes > 0"),
  c("back rel id", "posts", "comments_via_post.id != ''"),
  c("back rel message", "posts", "comments_via_post.message ~ 'n'"),
  c("back rel author", "posts", "comments_via_post.author.name ?= 'Eve'"),
  c("back rel multiple", "posts", "comments_via_refs.likes ?>= 10"),
  c("back rel multiple all", "posts", "comments_via_refs.id != ''"),
  c("back rel unique", "members", "profiles_via_owner.nickname = 'ally'"),
  c("back rel unique empty", "members", "profiles_via_owner.nickname = ''"),
  c("back rel to self", "members", "members_via_friends.name ?= 'Eve'"),
  c("back rel nested", "teams", "members_via_team.posts_via_author.title ?~ 'hello'"),
  c("back rel from rel", "posts", "author.comments_via_author.likes ?> 5"),
  c("back rel wrong collection", "posts", "comments_via_author.id != ''"),
  c("back rel not a relation", "posts", "comments_via_message.id != ''"),
  c("back rel missing collection", "posts", "missing_via_post.id != ''"),
  c("back rel missing field", "posts", "comments_via_missing.id != ''"),

  // @collection
  c("collection join", "posts", "@collection.comments.post ?= id"),
  c("collection join all", "posts", "@collection.comments.post = id"),
  c(
    "collection field",
    "posts",
    "@collection.teams.name ?= 'Gamma' && team = @collection.teams.id",
  ),
  c(
    "collection aliases",
    "posts",
    "@collection.comments:a.post ?= id && @collection.comments:b.likes ?> 5",
  ),
  c(
    "collection same alias",
    "posts",
    "@collection.comments:x.post ?= id && @collection.comments:x.likes ?> 2",
  ),
  c("collection relation", "posts", "@collection.comments.author.name ?= author.name"),
  c("collection by id is an error", "posts", "@collection.unknown.id != ''"),
  c("collection superusers-only", "posts", "@collection.private_notes.text ?= 'top secret'"),
  c(
    "collection view",
    "posts",
    "@collection.post_stats.comments_count ?> 1 && @collection.post_stats.id ?= id",
  ),

  // auth collection fields
  c("auth email", "members", "email ~ 'example.com'"),
  c("auth email visibility", "members", "emailVisibility = true"),
  c("auth verified", "members", "verified = true"),
  c("auth password", "members", "password != ''"),
  c("auth tokenKey", "members", "tokenKey != ''"),
  c("auth select", "members", "role = 'admin' || role = ''"),
  c("auth skills", "members", "skills ?= 'go'"),
  c("auth date", "members", "birthday > '1980-01-01'"),

  // view collection
  c("view field", "post_stats", "views > 10"),
  c("view relation", "post_stats", "author.name = 'Alice'"),
  c("view count", "post_stats", "comments_count > 0"),
  c("view multi relation", "post_stats", "tags.name ?= 'db'"),
  c("view back relation", "post_stats", "comments_via_post.id != ''"),

  // @request as a superuser
  c("request auth id", "posts", "@request.auth.id != ''"),
  c("request auth collection", "posts", "@request.auth.collectionName = '_superusers'"),
  c("request method", "posts", "@request.method = 'GET'"),
  c("request context", "posts", "@request.context = 'default'"),
  c("request query", "posts", "@request.query.perPage = '200'"),
  c("request missing", "posts", "@request.query.missing = null"),

  // sort
  c("sort relation", "posts", "", "author.name,id"),
  c("sort desc relation", "posts", "", "-author.name,id"),
  c("sort multi relation", "posts", "id != ''", "editors.name,id"),
  c("sort json", "posts", "", "data.a.b,id"),
  c("sort back relation", "posts", "", "-comments_via_post.likes,id"),
  c("sort hidden", "posts", "", "-hiddenScore,id"),
  c("sort lower", "posts", "", "title:lower,id"),
  c("sort length", "posts", "", "-categories:length,id"),
  c("sort each", "posts", "", "categories:each,id"),
  c("sort request", "posts", "", "@request.auth.id"),
  c("sort unknown", "posts", "", "missing"),
  c("sort rowid", "posts", "", "-@rowid"),

  // errors
  c("unknown field", "posts", "missing = 1"),
  c("unknown rel field", "posts", "author.missing = 1"),
  c("not a relation", "posts", "title.id = 1"),
  c("unknown modifier", "posts", "title:upper = 'x'"),
  c("isset on a field", "posts", "title:isset = true"),
  c("changed on a field", "posts", "title:changed = true"),
  c("too deep", "posts", "author.team.leader.team.leader.team.leader.name = ''"),
  c("collection path", "posts", "@collection.comments = 1"),
  c("collection unknown alias", "posts", "@collection.comments:.post = id"),
  c("invalid field name", "posts", "title! = 1"),
  c("syntax", "posts", "title = "),
  c("modifier on rel", "posts", "author:length = 1"),
  c("each on single", "posts", "status:each = 'live'"),
];
