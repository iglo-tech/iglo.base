# Rules and filters

API rules and the `filter` query parameter share one language. It is the most subtle part of PocketBase and the part where a small difference silently leaks or hides data. It is ported, not redesigned.

## Upstream sources

| Upstream | Lines (non-test) | Becomes |
|---|---|---|
| `ganigeorgiev.com/fexpr` v0.7.0 (tokenizer and parser, BSD-3-Clause; moved from `github.com/ganigeorgiev/fexpr`, archived 2026-10-26, with no code change) | small | `src/search/fexpr/` with its license notice |
| `tools/search` (`filter.go`, `sort.go`, `provider.go`, `identifier_macros.go`, `token_functions.go`, `multi_match_subquery.go`, `simple_field_resolver.go`) | about 1,700 | `src/search/` |
| `core/record_field_resolver*.go` | about 1,500 | `src/resolver/` |
| `tools/search/*_test.go`, `core/record_field_resolver_test.go` | about 3,000 | ported table tests |

## Language

- **Operators:** `=`, `!=`, `>`, `>=`, `<`, `<=`, `~` (contains, `LIKE` with `%` wrapping unless given), `!~`, and the "any of" forms `?=`, `?!=`, `?>`, `?>=`, `?<`, `?<=`, `?~`, `?!~`. Grouping with `( )`, `&&`, `||`, and `//` comments.
- **Operands:** field paths (`author.name`, back-relations `comments_via_post.message`), `@request.*`, `@collection.<name>.<field>` (with `:alias`), string, number, `true`, `false`, `null`, date macros, functions.
- **`@request.*`:** `auth.*` (the authenticated record, including `collectionName` and `collectionId`), `body.*`, `query.*`, `headers.*` (lowercased, `-` → `_`), `method`, `context` (`default`, `expand`, `realtime`, `protectedFile`, `batch`, `oauth2`, `otp`, `password`).
- **Modifiers:** `:isset` (on static `@request.*` values: query, headers, body), `:changed` (on `@request.body.<field>` of a collection field), `:length` and `:each` (on multi-value fields, and on the body values of the collection's multi-value fields), `:lower` (on fields and `@request.*` values). `@request.context` and `@request.method` take no modifiers: the resolver's allowed-field patterns end at those names, so a rule such as `@request.method:isset = true` fails with `failed to resolve field`. An unknown modifier is an error; on a collection field, `:isset` and `:changed` are ignored, and so are `:each` and `:length` on field types without multiple values (text, number, bool, …; select, relation and file support them at any maxSelect). A missing `@request.*` value (and an unknown field of `@request.auth`, or a missing relation reached through it) resolves to `NULL`, not an error.
- **Macros:** `@now`, `@second`, `@minute`, `@hour`, `@weekday`, `@day`, `@month`, `@year`, `@yesterday`, `@tomorrow`, `@todayStart`, `@todayEnd`, `@monthStart`, `@monthEnd`, `@yearStart`, `@yearEnd`, all in UTC, read from the injected clock when the filter is built (upstream reads `time.Now()` at each macro).
- **Functions:** `geoDistance(lonA, latA, lonB, latB)` (Haversine in kilometers, with the arccosine clamped to [-1, 1] as in v0.40.3), `strftime(format, time-value, modifiers...)`.
- **Rule values:** `null` (superusers only: list and view answer 403 "Only superusers can perform this action." to others), `""` (everyone), or an expression. A failed rule on list returns an empty list, on view/update/delete returns 404, on create returns 400, as upstream. A rule is checked when the collection is saved by building it with an empty request info (`validation_invalid_rule`, "Invalid rule. Raw error: …").

## Semantics that must match exactly

These are the places a naive port goes wrong. Each one gets dedicated differential tests.

1. **Multi-value matching.** For a path that goes through a multi-value relation or field, a `@collection.*` join, a multiple back-relation or a single back-relation without a single-column unique index, `=` means "every item matches" (with a `NOT EXISTS` subquery), while `?=` means "at least one item matches". Upstream builds these with `multi_match_subquery.go`; the generated SQL shape is ported, including how `NULL` and empty arrays behave.
2. **`null` and empty values.** Upstream treats `NULL` and `""` as equal in `=`/`!=` through "null fallback" rules (`filter.go`, `resolveEqualExpr`): it emits `IS`/`IS NOT` and, depending on each side, either a direct comparison, an `… IS NOT NULL` pair or a `COALESCE` fallback. The exact choice matters for both results and index use, so the decision table is ported, not re-derived.
3. **Type coercion.** Numbers compare numerically; text with a number literal follows SQLite's affinity rules on `NUMERIC` and `TEXT` columns. Dates are compared as strings in the stored layout, so macros render in that layout.
4. **`~` escaping.** If a user value has no unescaped `%`, its `\`, `%` and `_` are escaped and it is wrapped in `%…%`; if it has one, it is used as a `LIKE` pattern as given. Both sides use `ESCAPE '\'`. Field-to-field `~` wraps with `'%' || x || '%'`.
5. **`@request.body` with multipart.** Values are normalized to their field types before rule evaluation (`"true"` → `true`, numbers, arrays for multi-value fields), and `+`/`-` modifiers are applied first.
6. **Joins and deduplication.** Relations and back-relations become `LEFT JOIN`s with aliases; the list query selects `DISTINCT` record rows. `@collection.*` joins are independent per alias. In a client filter without hidden fields allowed (a guest's or a user's), each joined collection's list rule applies: a `null` list rule is an error ("… fields can be accessed only when allowHiddenFields is enabled or by superusers"), a non-empty one is added for the join alias as `id='' || (rule)`.
7. **Hidden fields.** A hidden field (`password` and `tokenKey` are hidden) can be filtered only when the resolver allows hidden fields: a superuser's client filter, every rule (rules are built with hidden fields allowed), `FindRecordsByFilter` and the rule check. Otherwise it fails with "non-filterable field". In a client filter without hidden fields allowed, `email` of an auth collection matches only records with `emailVisibility` on, the requester's own record included; `@request.auth.email` is always the auth record's email.
8. **Expression limits.** Max filter length 3,500 characters, 200 filter expressions, 8 sort expressions, and the error messages when exceeded.
9. **Parameters.** User values are always bound parameters (`{:t…}` placeholders with random names upstream), never interpolated.
10. **Sort.** `@random`, `@rowid`, relation paths in sort, and the implicit tie-breaker.

## Query building

Upstream builds SQL with `pocketbase/dbx` (MIT). iglo.base ports the small subset of the builder it uses (select, joins, `WHERE` expressions, `IN`, `EXISTS`, ordering, limits, named parameters) in `src/db/dbx/`, one file per dbx file. The goal is the same SQL text, which makes differential debugging easy: for a given filter and collection schema, iglo.base can print its SQL (with `--dev`, as upstream) and the two can be compared directly.

## Testing

- **Ported unit tables:** upstream's resolver and filter tests compare generated SQL strings. They are ported first and must pass before any records endpoint is wired.
- **Differential fuzzing:** a generator produces random filters over a fixture schema (operators, any-of forms, nested relations, back-relations, `@request.*` with random auth, macros with a fixed clock). Each filter runs against upstream and iglo.base; the record ID sets must be equal. Failures are minimized and added to the fixed suite.
- **Rules matrix:** for each fixture collection, guest, regular user, other user and superuser call list, view, create, update and delete; status codes and visible records must match upstream.
