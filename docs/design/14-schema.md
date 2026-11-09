# Schema as code

Decision record: [D40](10-decisions.md#d40-schema-as-code). The user guide is [schema.md](../schema.md). Issue [#77](https://github.com/iglo-tech/iglo.base/issues/77) is the spec of the file format; this document is the design of the code. Built in S.2 (`schema pull`); S.3 adds the apply on the reader, S.4 the types, and later tasks extend this document.

## Layout

| Module | Role |
|---|---|
| `src/schema/types.ts` | The in-memory description: `SchemaDescription`, its collections and fields, and the extras |
| `src/schema/json-tree.ts` | A JSON parser that keeps the order of object members and their duplicates, and reports syntax errors with line and column |
| `src/schema/defaults.ts` | The defaults the file is measured against: the five system collections and `users` (from `migrations/baseline.ts`), and the factory defaults of each collection and field type |
| `src/schema/describe.ts` | Collections as the API returns them (`marshalJSON`) → the description |
| `src/schema/write.ts` | The description → the file text; the extras of an existing file |
| `src/schema/read.ts` | The file text → the complete description, or a list of errors with their JSON paths |
| `src/schema/json-schema.ts`, `schema/iglo.schema.json` | The JSON Schema, embedded in the executable with `import` |
| `src/schema/url.ts` | The `$schema` URL of a release |
| `src/cli/schema.ts` | `schema pull` and `schema json-schema` |

`describe` and `write` take no database. `read` takes no database either: the apply (S.3) checks the description against the database and runs the collection model's validation there. `schema pull` reads the database only through `findAllCollections`.

## The description

`SchemaDescription` is complete. The reader fills every option a file leaves out with its default, adds the system collections it does not list, and sorts the collections by name. The writer leaves out what equals its default. So the description of a file and the file the writer writes from that description are the same description (checked in `test/schema/write.test.ts`).

The description uses the file's names, not the API's: `rules` nested, `query` for a view's query, and `collection` (the target's name) for a relation. Option names are otherwise the dashboard's, so a field's options are its API JSON minus `id`, `name`, `type` and `system`.

Descriptions and `tsType` are extras: they are not in the database, so the writer gets them from an existing file (`extractExtras`) and never from the database.

## Defaults

A collection's default is its name and type's default:

- the five system collections (`_superusers`, `_externalAuths`, `_mfas`, `_otps`, `_authOrigins`) and `users` are the ones a fresh install creates (`defaultCollections` in `migrations/baseline.ts`);
- any other collection is the factory default of its type (`newBaseCollection`, `newAuthCollection`, `newViewCollection`).

A field's default is the collection default's field of the same name and type, or the factory default of its type.

A collection with the system flag that is not one of the five system collections (a database can hold one; the upstream test data does) is written with `system: true`, so the flag round-trips. Otherwise `system` is not in the file.

The writer omits a collection that is a system collection and equals its default, and omits every option, rule, index and field equal to its default. The reader restores them. The comparison is on the whole description, so a default is never a special case in the code.

## Field order and implied system fields

The fields of a collection keep their stored order: that order is the API's and the dashboard's, and the file keeps it.

System fields are implied. A collection's *leading run of system fields in its default* (`id` for a base collection; `id`, `password`, `tokenKey`, `email`, `emailVisibility`, `verified` for an auth collection; all of a system collection's fields) is written only when it differs from the default. The writer's rule:

1. Compare the stored fields with the default fields, in order, while both are the leading run's fields and equal in name, type, system flag and options. Call the number of equal fields `p`.
2. Write the stored fields after the first `p`. A field with an extra key (a description or tsType) in the leading run makes `p` zero, so that the file lists every field and keeps the order.

The reader's rule: the leading run's fields that the file leaves out are placed first, in their default order, and the listed fields follow in the file's order. The writer's `p` and the reader's omitted fields agree, so the order round-trips. A hand-written file that omits a system field is read the same way: the omitted field comes first.

Upstream's `created` and `updated` are not system fields. They are ordinary autodate fields on every collection, so the file lists them (the issue's list of implied fields names them; the API does not mark them system, so the file does not either).

## Relations and references

A relation's `collection` is the target's name. The reader checks that the name is a collection of the file or a system collection (which the reader always has, by default). It does not check the target's type; the apply does, against the database.

The writer maps a relation's `collectionId` to a name with the collections of the database. A relation to a missing collection stops the pull with that message.

## Secrets and providers

The file never holds a token's `secret` or the OAuth2 `providers` list. The reader refuses them with a message that says why, and the describer drops `providers` (the collection JSON has it as an empty list or with the secrets; the writer never sees it). Settings are out of the file for now (D40).

## Errors

The reader collects every error it can find, and each has the JSON path of its place (`$.collections.posts.fields.title.maxSelect`). Syntax errors give the line and column. Names are checked here (word characters, not only digits, at most 100 characters for fields, not reserved); the rest of the collection model's validation runs in the apply.

Integer-like names (`"2026"`) are refused in both directions: a JSON object keeps the order of such keys differently, so the file could not keep the field order.

## Integers

A JSON number is read as a double. The reader accepts an integer option only when it is a safe integer, and refuses others with "must be a whole number". The writer writes the stored numbers as JSON.

## The JSON Schema

`schema/iglo.schema.json` is the file's JSON Schema (draft 2020-12). It is written by hand, from upstream's `core/field_*.go` and `core/collection_model*.go`, with a description for every property. It has one definition per field type, so each option is checked against its type, and `additionalProperties: false` everywhere, so an unknown option is an error. Tests validate every pulled file against it with ajv (a dev dependency), and the executable prints it with `schema json-schema`. The release workflow publishes it next to the archives and lists it in `SHA256SUMS`.

## Not in this document yet

- `schema plan` and the apply (S.3): applying the description to the database, with renames and the data-loss check.
- `schema types` (S.4), migrations (S.5) and the server modes (S.6).
- Settings in the file (possible later, without secrets).
