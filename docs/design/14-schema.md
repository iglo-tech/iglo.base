# Schema as code

Decision record: [D40](10-decisions.md#d40-schema-as-code). The user guide is [schema.md](../schema.md). Issue [#77](https://github.com/iglo-tech/iglo.base/issues/77) is the spec of the file format; this document is the design of the code. Built in S.2 (`schema pull`), S.3 (the apply, `schema plan` and `serve --schema`, [below](#the-apply-s3)) and S.4 (`schema types`, [below](#types-s4)); later tasks extend this document.

## Layout

| Module | Role |
|---|---|
| `src/schema/types.ts` | The in-memory description: `SchemaDescription`, its collections and fields, and the extras |
| `src/schema/json-tree.ts` | A JSON parser that keeps the order of object members and their duplicates, and reports syntax errors with line and column |
| `src/schema/defaults.ts` | The defaults the file is measured against: the five system collections (from `migrations/baseline.ts`), the factory defaults of every other collection, and the factory defaults of each field type |
| `src/schema/implied.ts` | The indexes upstream adds to an auth collection itself (`tokenKey`, `email`), which the description leaves out |
| `src/schema/describe.ts` | Collections as the API returns them (`marshalJSON`) → the description |
| `src/schema/write.ts` | The description → the file text; the extras of an existing file |
| `src/schema/read.ts` | The file text → the complete description, or a list of errors with their JSON paths |
| `src/schema/diff.ts` | The changes between two descriptions (collections, fields, rules, options, indexes); pure, no database |
| `src/schema/apply.ts` | The apply and `plan`: the checks before the transaction, the steps of the transaction in order, the view rebuild, the record check call |
| `src/schema/apply-json.ts` | The description → the JSON that the collections API takes (fields, rules and options, the collection object) |
| `src/schema/check.ts` | The counts of the data-loss guard (rows, non-empty values) and the record check over the records of a collection |
| `src/schema/typegen.ts` | The types of the collections from the API's collection JSON: the record, response, create and update types, the `Collections` enum and `TypedPocketBase` (S.4) |
| `src/schema/report.ts` | The report of an apply or a plan: the changes, the migrations, the lost data and the problems, and its text |
| `src/schema/backup.ts` | The pre-schema backup: its name, the call to upstream's backup code, the disk-space message and the retention of three |
| `src/schema/json-schema.ts`, `schema/iglo.schema.json` | The JSON Schema, embedded in the executable with `import` |
| `src/schema/url.ts` | The `$schema` URL of a release |
| `src/cli/schema.ts` | `schema pull`, `schema plan` and `schema json-schema`; `pull` and `plan` refuse a data directory without a database, and send the app's logs to stderr |
| `src/cli/serve.ts` | The flags `--schema` and `--allow-data-loss`; the file is read at every start, and the apply runs before the server starts, also on the restart after a restore |

`describe` and `write` take no database. `read` takes no database either: the apply (S.3) checks the description against the database and runs the collection model's validation there. `schema pull` reads the database only through `findAllCollections`.

## The description

`SchemaDescription` is complete. The reader fills every option a file leaves out with its default, adds the system collections it does not list, and sorts the collections by name. The writer leaves out what equals its default. So the description of a file and the file the writer writes from that description are the same description (checked in `test/schema/write.test.ts`).

The description uses the file's names, not the API's: `rules` nested, `query` for a view's query, and `collection` (the target's name) for a relation. Option names are otherwise the dashboard's, so a field's options are its API JSON minus `id`, `name`, `type` and `system`.

Descriptions and `tsType` are extras: they are not in the database, so the writer gets them from an existing file (`extractExtras`) and never from the database.

## Defaults

A collection's default is its name and type's default:

- the five system collections (`_superusers`, `_externalAuths`, `_mfas`, `_otps`, `_authOrigins`) are the ones a fresh install creates (`defaultCollections` in `migrations/baseline.ts`);
- any other collection, `users` included, is the factory default of its type (`newBaseCollection`, `newAuthCollection`, `newViewCollection`).

`users` is not special. The same block means the same schema under any name, so a `users` block that leaves out an option gets the factory default, as an `accounts` block would. A fresh install's `users` has its own rules, avatar limit and autodate options, and `schema pull` writes them.

A field's default is the collection default's field of the same name and type, or the factory default of its type.

A collection with the system flag that is not one of the five system collections (a database can hold one; the upstream test data does) is written with `system: true`, so the flag round-trips. Otherwise `system` is not in the file.

The writer omits a collection that is a system collection and equals its default, and omits every option, rule, index and field equal to its default. The reader restores them. The comparison is on the whole description, so a default is never a special case in the code.

## Implied indexes

Upstream adds two indexes to every auth collection when it saves the collection (`initTokenKeyField` and `initEmailField` in `core/collection_model.go`): a unique index on `tokenKey`, and a unique index on `email` where `email != ''`. Unless a single-column unique index on that column exists, the check is by column, not by name. Their names are `idx_<field>_<collection id>`, and databases from older versions name them after the id in other ways (`_<id>_tokenKey_idx`, `__pb_users_auth__email_idx`). So a name would put an id in the file.

`src/schema/implied.ts` decides which index is implied. It is a unique index on the one column `tokenKey` (with no WHERE clause) or `email` (with `WHERE email != ''`, quotes and spaces ignored), on the collection's table, with no `COLLATE` and no sort order, under any name. The writer leaves an implied index out, and the description holds none. The reader does not add them back: it cannot name them without the collection id. The apply (S.3) restores a missing one through the collection save, as upstream does, and keeps an existing one under its name. Any other index on these columns, such as a `COLLATE NOCASE` email index (which makes login case-insensitive), is explicit and stays in the file as stored. A non-partial unique index on `email` stays in the file too: upstream would not add its own, but a fresh database built from the file would get the partial one.

Other indexes are explicit and written as they are. An index created by an old upstream migration with the id in its name (`_<id>_username_idx`, `_<id>_created_idx`) is one of them, so a database from an old version writes that id in the name. Decided by the lead on 2026-11-12: such an index is an ordinary explicit index, written with the name it has. A name is not a reference to the collection, and the apply (S.3) compares indexes by their definition, not by name, so nothing is renamed.

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

Names that are array indexes (`"0"`, `"12"`, `"2026"`, up to `"4294967294"`) are refused in both directions: JavaScript objects, and JSON objects read as them, put these keys first, so the file could not keep the field order. Other digit names (`"01"`, `"007"`, `"4294967295"`) keep their order and are accepted.

## Standard output and the data directory

`schema pull` writes the file to standard output, so nothing else goes there. While it runs, the app's logs, the dev-mode SQL statements (`--dev`) and the console output of JavaScript migration files go to standard error. `schema json-schema` does the same for migration output, because it is also data on standard output.

`schema pull` opens an existing database only. Bootstrap would create a missing data directory and database, so the command checks first and refuses a `--dir` without a database, with a message that names the path.

## Integers

A JSON number is read as a double. The reader accepts an integer option only when it is a safe integer, and refuses others with "must be a whole number". The writer writes the stored numbers as JSON.

## The JSON Schema

`schema/iglo.schema.json` is the file's JSON Schema (draft 2020-12). It is written by hand, from upstream's `core/field_*.go` and `core/collection_model*.go`, with a description for every property. It has one definition per field type, so each option is checked against its type, and `additionalProperties: false` everywhere, so an unknown option is an error. Tests validate every pulled file against it with ajv (a dev dependency), and the executable prints it with `schema json-schema`. The release workflow publishes it next to the archives and lists it in `SHA256SUMS`.

## The apply (S.3)

The apply writes the description into the database, in one write transaction, and `schema plan` runs the same transaction and rolls it back. `serve --schema` runs the apply before the server starts, at every start. The user's steps are in [schema.md](../schema.md#applying-the-file-at-startup).

### Order

The steps are the ones in the header comment of `src/schema/apply.ts`, which D40 sets. Before the transaction, read only: the changes are computed. When nothing changes and no JavaScript migration is pending, the apply stops (no backup, no record check). Otherwise the apply runs its whole transaction once more as `schema plan` does, and rolls it back: the dry run. A dry run that fails prints its report and stops the start, with no backup, so a restart loop makes none (D40, amended 2026-11-13). A passing dry run is followed by the pre-schema backup; a failed backup stops the apply. Then, in one transaction:

1. the pending JavaScript migrations (D23), with `up`, as serve ran them before. They also ran in the dry run, whose database changes (both `data.db` and `auxiliary.db`) are rolled back, so the dry run leaves no trace of them in the databases. Their effects outside the databases (files written with `$os`, outbound calls) are not rolled back and happen twice (see `docs/schema.md`, steps 3 and 5). The transaction opens `auxiliary.db` first and `data.db` inside it, the nesting `up` uses. A migration's stored-file deletes run after a commit: a record's files after the whole apply commits, a collection's when `data.db` commits; neither runs when a plan or a failed apply rolls back;
2. renames (S.5; none yet);
3. the changes again, now that the migrations ran: a collection type change is a problem; the data-loss guard; the SQL views that the changes affect are dropped (their `_collections` rows and ids stay), and so are the SQL views of the removed view collections, before any column or view changes (SQLite checks every view on an `ALTER`);
4. widen: each new collection in one save with all its fields, as the dashboard saves a new collection (so its table gets its columns at once). A collection whose relation targets are new waits until they exist. When the relations form a cycle, one collection goes first without its relation fields, and the new plain fields of the existing collections are added;
5. widen: the new relation fields of the existing collections, and the relation fields that a cycle deferred, once every target exists;
5a. TypeScript migrations (S.5; none yet);
6. narrow: the new and changed collections in full (fields, indexes, rules, options); then the removed views; then the removed collections, each after the collections that relate to it (the save refuses a referenced collection; a cycle of relations is cut first, by a save of one collection without its relation fields into the set);
7. the views of the affected view collections are saved again, each after the views its query reads;
8. the record check, for the fields the apply added or changed;
9. commit, or roll back so that the database is unchanged.

A problem found in step 3 or step 8 stops the transaction (`StopApply`); the problems are in the report. A failed save (`SaveFailed`) becomes a problem that names its collection. After the transaction ends, whether it committed, rolled back or was a plan, the in-memory collection cache is reloaded. After the dry run the settings are reloaded too: a migration that edits `app.settings()` changed the live object, and the dry run rolled back only the stored row, so the real run starts from the stored settings.

### Modules

Each part of the apply is in one module, listed in the [layout](#layout) table. `diff.ts` computes what changes and knows nothing of the database. `apply.ts` owns the order. `apply-json.ts` builds the JSON that the save takes. `check.ts` reads the data. `report.ts` holds the result and its text, which is the output of `schema plan` and the message of a failed `serve`.

### Decisions in the code

- **Fields are matched by name and type.** A field with the same name and type keeps its stored id. A field with the same name and another type is a replacement: it is removed and added again in the narrow step (step 6), so the widen step adds only the fields that are new. The old values go, so the guard counts them.
- **Indexes are compared by their definition.** `indexKey` takes the uniqueness, the columns with their collation and sort order, and the WHERE clause; names, quoting and spacing do not count. A desired index whose definition is stored already keeps the stored statement, and its name. The implied indexes of an auth collection (see above) are not compared at all: a listed one is the stored one, kept once under its name (no "index added", no duplicate on save), and a missing one is restored by the save as upstream does. Only explicit indexes appear in the plan's index changes, on either side.
- **Ids are kept.** A collection is updated from its stored model, so its id stays. A field keeps the id it has when its type is unchanged. A relation names its target's id, which the apply looks up when it builds the JSON, so the target must exist first: a new collection is created after the collections it relates to, and only a cycle leaves one relation field to step 5. The upstream validator refuses a relation to a collection that is not saved yet, so the order is forced by the save, not by a choice of the apply. The one-save creation keeps the table's SQL the same as the dashboard's (a column added later gets another quoting and position).
- **Views are rebuilt when they are affected.** A view is dropped and created again when it is itself changed, or when its query names a collection that changes (added, changed or removed) or a view that is rebuilt. A name in a query is taken as a read, whether or not the view really reads it (a name in a string or a comment counts too). So the set can be larger than needed, and the extra views are created again as well. Views are created in an order where each comes after the views its query reads.
- **Saves go through `saveCollection`, with the API's JSON.** `apply-json.ts` builds the JSON that the collections API takes, and the apply `unmarshalJSON`s it onto the stored model, as the API does. The file has no token secrets and no OAuth2 providers, so the stored ones stay. The result is the dashboard's, because the same save runs.
- **The data-loss count.** For a removed or replaced field, the count is its non-empty values, where empty is the value the API gives an unset field of that type (`check.ts`, `emptyValueCondition`): NULL and `''` for text-like fields; `0` for a number and for a bool; `[]` for a multi-value select, file or relation; NULL, `''`, `null` or `[]` for json; and `{"lon":0,"lat":0}` for a geoPoint (`json_extract` on both coordinates). For a removed collection, it is its rows. A select, file or relation that becomes single-valued counts the rows that hold more than one value: the table sync keeps one of them, so the others are deleted. Any other lowered `maxSelect` (to two or more) deletes nothing, so the record check reports the rows that hold more ("Select no more than 2"), and the apply stops even with `--allow-data-loss`. Removed views are not counted: they hold no data. Without `--allow-data-loss` each count is a problem, and the apply stops. The report shows the counts, with `(allowed by --allow-data-loss)` when the flag is set.
- **The record check.** After the saves and the view rebuild, `check.ts` runs the field validators that the records API runs on save (`validateValue`, with the record save's app) over every record of each changed collection, for the fields that were added, changed or replaced. New collections are not checked: they have no records. Records are read in batches of 500 by id. Each failure is counted per field and per message, with up to five example ids. A required failure reads "required, N records empty" with the next step to add a migration or make the field optional. Unique indexes are not checked in advance: SQLite refuses the index when the save creates it, and `saveProblem` turns that refusal into a problem with the next step to make the values distinct.
- **Added indexes show their table's rows.** For an added index, the report gives the row count of its table, so the plan shows how many records the index is built over.

### Backups

`backup.ts` names the backup `pre-schema-<UTC time>.zip` from the app's clock. The time is the ISO time without its separators, with milliseconds: `pre-schema-20261113T172429.123Z.zip`, which still sorts by time. If a backup of that name already exists (two applies within one millisecond), the time moves on by a millisecond until the name is free, so a backup is never replaced. The backup calls upstream's backup code (`createBackup`), the same code as the dashboard's backups, with the configured storage. It is made after the dry run passes and before the transaction, and it stays when the apply fails. Retention runs after every apply that made a backup, successful or failed: the three newest `pre-schema-*` names are kept, and the rest are deleted, so at most three exist once the apply returns. A dry run that fails makes no backup at all. The retention is on the prefix only, so `cronMaxKeep` (the automatic backups, prefix `@auto_pb_backup_`) never sees these backups. A disk-space failure gets its own message: the size of the data directory (the bytes a backup copies) and the free space. The size is a walk, so it runs only on the failure path.

### Left out, and why

- **Renames of collections and fields (S.5).** A rename needs a declaration that keeps the data, which is a TypeScript migration file. Without one, a rename shows as a removal and an addition, and the data-loss guard refuses it.
- **TypeScript migrations (S.5).** Step 5a is empty until then. The JavaScript migrations of step 1 are the only data migrations in this version.
- **Modes and the development watcher (S.6).** `--mode` and the watcher that applies a file change on a running server are not in this version. `serve --schema` applies at start only.
- **A plan on a copy.** D40 allows a copy, and the copy would avoid the write lock. This version plans on the live database, in the transaction it rolls back. The lock is documented in [schema.md](../schema.md#schema-plan).

## Types (S.4)

`schema types` (`src/cli/schema.ts`, `runTypes`) generates the types with `src/schema/typegen.ts`, which has no database access: `generateTypes(collections, schema?)` takes the collections as the API returns them (`marshalJSON`, so a view has its resolved fields) and, optionally, the file the types come from.

- **Source of the types.** Without `--schema`, the collections are the database's. With `--schema`, `planSchema` runs the apply in its rolled-back transaction, and its `inspect` hook (`ApplyOptions.inspect`) reads the collections there, after the last step. The report goes to standard error, and a file that would not apply writes nothing. No backup is made. The descriptions and `tsType` are not in the database, so they come from the parsed file in every case where it is given.
- **Output.** Sorted by collection name; fields keep the API's order; a header names the command. The layout is oxfmt's (`.oxfmtrc.json`), so the output is a fixed point of the formatter. A line that fits stays on one line; a union that is too long breaks with a leading `|` on each member; an array of a union breaks inside its parentheses, and so does a nested array in a union (the modifiers). A select value is a string literal as oxfmt quotes it: double quotes, or single quotes when the value has more double quotes than single ones. A declaration head that is too long breaks the way oxfmt breaks it: a response's `Expand` parameter on its own line, and an object alias after its `=`. A json field's `tsType` is verbatim, behind `// oxfmt-ignore`, because the generator cannot lay out arbitrary TypeScript. The tests run `oxfmt --check` on the output with long names (up to upstream's 255 characters), long and quoted values, and long types, with a control that a misformatted file fails.
- **Names.** A collection's type name is its words in Pascal case, split on `_` (`my_posts` is `MyPosts`). A name that starts with an underscore keeps it: a system collection (`_superusers`) is `_Superusers`, so no user collection, such as one named `superusers`, can take its name; a name that starts with a digit gets a leading underscore too. Two names with one type name are an error that names both, not a silent suffix: a suffix would change a type name without the user knowing. Field names that are not identifiers are quoted. Upstream reserves `collectionId`, `collectionName` and `expand`, so a response cannot repeat them.
- **Field types.** Upstream's field types (`core/field_*.go`). Decisions: a single select that is not required includes `""`, because the API returns the empty value for an unset select, so a type without it would be wrong for the stored record; a json field that is not required includes `null`, because upstream stores no value and the API returns null, so `tsType` (or `unknown`) alone would be wrong for the stored record too. The modifiers of a select, relation and file take the field's values or ids, and a file's removal takes names. A file's input follows upstream's `FileField.setValue` (`core/field_file.go`): a create takes a file, or for a multi-file field an array of them; an update also takes a name (a string keeps the file) and clears with `""`, or with `null` for a field that is not required. A request never sets an autodate field, and an auth collection's `tokenKey` is the server's. A hidden field is left out of the response, and the response a superuser gets carries it (upstream shows hidden fields to superusers only, `apis/record_crud.go`); the types describe the other clients' view, which the spec asks for.
- **Auth create.** `password` and `passwordConfirm` are required on create, as upstream's `RecordUpsert` requires them for a new record (`forms/record_upsert.go`); the update takes them optionally, with `oldPassword` when the password changes.
- **Hidden fields in Create and Update (backlog).** Create and Update include the hidden fields, and only a superuser can write them. Upstream silently drops a hidden field from another client's create and update (`apis/record_crud.go`), so for those clients the request types are looser than the API. The types do not produce wrong data, and this is documented in [schema.md](../schema.md#types) rather than changed.
- **Modifiers left out.** Upstream's text fields also accept `field:autogenerate`. It is not one of the three modifiers the issue lists, so the types leave it out.
- **Views.** Views get the same types. The API refuses writes to a view, so their create and update types are not used.
- **TypedPocketBase.** `TypedPocketBase<C = PocketBase> = Omit<C, "collection"> & { collection(...) overloads }`. The type argument is the client class: `TypedPocketBase<BrowserClient>` keeps `handOff`, `renew` and `dispose`, and `TypedPocketBase<ServerClient>` keeps `serverNow`, `readableCookie` and `init`. A cast to the plain `TypedPocketBase` would drop those methods, since it is `Omit<PocketBase, ...>`. The SDK does not change in this task. The official `pocketbase` package has a class of its own, which the typed client cannot be cast to; the generated record types work with its generic `collection<M>()`, which the test checks.
- **Package name.** The generated file imports from `@iglo.tech/iglo.base`, the published name of the SDK (`sdkPackage` in `typegen.ts`). The fixture apps of the tests resolve that name to `sdk/src` with tsconfig `paths` on the package and its `ssr` and `ssr/browser` subpaths, so they type-check against the sources, and the CLI test asserts the import line.
- **Testing.** `test/cli/schema-types.test.ts` runs the command: the output is deterministic, `--check` passes on a fresh file and fails on a changed schema, `--schema` leaves `pb_data` byte for byte the same, a name clash and a file that would not apply are errors, a user collection named `superusers` gets its own types, and the output is oxfmt's format, for a fixture and for long names, values and types. `test/schema/types-sdk.test.ts` type-checks a fixture app with `tsc` (the plain, server and browser clients with their class as the type argument, the official package, and `@ts-expect-error` lines for the wrong names, values, fields, file inputs and a missing password confirmation), then runs a script against a server that a start with `--schema` serves, and checks each response's keys and JavaScript types, including a json field that reads null when it is unset. The official package is a test-only devDependency, pinned to the version the SDK is a copy of (0.28.1).

## Migrations (S.5)

The TypeScript migrations and the declared renames (`src/schema/migration-files.ts`, `migration-tx.ts`, `renames.ts`, and the steps 2 and 5a of `apply.ts`). The user's steps are in [schema.md](../schema.md#migrations).

- **Loading.** `loadSchemaMigrationsFor` reads the directory's `.ts` files in name order. A name must fit `<digits>_<name>.ts`; a file that Bun cannot import, an export that is not an object, or a key other than `up`, `renames` and `renameCollections` (a typo would otherwise do nothing) is refused with the file's name. A named directory that does not exist is an error; the default `migrations/` that is missing means no migrations. The files load before the database opens, so a start with a file that does not load changes nothing.
- **Pending.** A file is pending while `@schema/<file name>` is not in `_migrations`. Only pending files contribute renames, so a run that has happened is never run again, and the dry run and the apply see the same set.
- **Step 2, renames.** Runs only when a pending file declares a rename. First, every stored rule of the non-view, non-system collections is set to null (superuser-only), and every index except the implied auth ones (`tokenKey`, `email`, `isImpliedIndex`) is dropped (`clearStoredReferences`). A stored reference can name a renamed name in a form the apply would have to list one by one (a relation path, a back relation `x_via_y`, an alias `@collection.c:alias.f`, an expression or a partial index), and the save of any collection validates its rules and indexes; clearing them all removes the need to find those forms. Step 6 sets them from the file again, and step 3 sees them as changes, so the plan lists them. Then the pending files run in name order (`renameFile`). Each file is checked by `fileProblems` against the database as the earlier files left it: the old name exists and can be renamed, the new one is free in the database, and two renames of one file do not give one name or rename a name the same file creates (a chain inside one file is refused; a chain across files works). A refused file stops the apply before its renames run. Each file's renames are then one save per collection it touches, through `saveCollection`: the table and its columns are renamed by the table sync (ids are kept), and the rate-limit rules are relabelled by the save. When every file has run, `appliedProblems` checks by id that each rename ends in a name the file has (an intermediate name of a chain is not in the file). A rename ran, so step 3 and step 7 create every view again: a view's rules are not in its query, and no rule of a view is cleared here. Views are not saved in step 2; the steps 3 and 7 drop and create them. The step is `applyRenames` in `apply.ts`.
- **Step 3, the guard.** The changes are computed after the renames, so a renamed field or collection is not a removal. The guard, the data-loss counts and the report do not need a rename case.
- **Step 4, widen, and the required fields.** A new field, and a new collection's field, is added as optional (`plainFieldJSON`), whatever the file says. Step 6 sets the file's `required`. This is what lets a migration save a record that does not yet have the new value: a save validates the record it saves, against the stored field. The record check (step 8) still reads every record for the fields that are added or changed, so a record that stays empty stops the apply.
- **Step 5a, the migrations.** Each pending file's `up(tx)` runs in name order, on the apply transaction's App (`newMigrationHelpers`). The helpers save through `saveRecordSync`, the synchronous save with validation that the API's create and update use (record-save.ts), so there is one validation path. `up` must return nothing: a thenable fails the apply, with its file name, and so does a throw. The row is written in the same transaction. The helpers refuse a `Blob` value (a file upload) and have no mail, S3 or OAuth2 helper; a raw `fetch` is not stopped, and the design relies on the author not to make one.
- **Helper rows.** `rowOf` returns a record as a superuser's API read does: every field unhidden and the email visible (`unhide` and `ignoreEmailVisibility`, as upstream's `autoResolveRecordsFlags` does for a superuser). The password and the token key are never in a row, as upstream never returns them. The apply is the superuser of the database, so no visibility rule applies to a helper.
- **Types.** `generateTypes` emits `MigrationRecords` (each collection's `<Base>Record`, the stored record with the hidden fields), `MigrationCreates`, `MigrationUpdates`, `MigrationQuery`, `MigrationTx` and `Migration`. The old names of a rename are not in the generated schema, so `Migration` types `renames` and `renameCollections` loosely (`Record<string, Record<string, string>>` and `Record<string, string>`); the apply's checks are the authority, and their messages name the file. A helper call with a wrong collection, field or value type is a type error. The method signatures break the way oxfmt breaks them, so `schema types --check` agrees with the formatter.
- **History.** `removeMissingAppliedMigrations` (`migrate history-sync`) keeps the `@schema/` rows: its delete excludes the prefix. Upstream's binary, which has no such rows, is checked in `test/differential/schema/migrations.test.ts`: PocketBase v0.41.0 starts on the data, runs `migrate up` with the rows present, serves the stored records, and sees the renamed field.
- **Decisions made in this task, for review.** (1) Names are `<digits>_<name>.ts` with lowercase names, so a file that does not fit stops the start. (2) A file's keys (a field's collection, and a collection) are the names before that file's own renames; a collection renamed in the same file keeps its old name in the file's `renames`. Files run in name order, each against the names the earlier ones left, so a chain across files is a chain of declarations, and a chain inside one file is refused. (3) `findById` and `findFirst` return `null`, not an error, for no match. (4) A new required field is added optional and made required by the narrow step: the alternative, a required field during the migrations, would make every save of an unrelated field fail until the value is set. (5) With a rename, step 2 clears every rule and index (see above) and the plan lists them as changes that the file sets again; this is the cost of not finding each reference. Measured on 10,000 records (`docs/perf/S.5-migrations.md`): a start that renames a field costs about 0.2 s more than a start with nothing pending.

## Not in this document yet

- The server modes (S.6).
- Settings in the file (possible later, without secrets).
