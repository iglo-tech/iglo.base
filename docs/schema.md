# Schema as code

Your collections can live in a file in your repository, next to your code. The file lists every collection and field. You can read it in a pull request, review it like any other change, and give it to an editor or an agent that checks it against a JSON Schema.

This guide covers the file, `schema pull`, which writes the file from a database, and applying the file: `serve --schema` at startup and `schema plan`, which shows what an apply would do. Later versions of this guide add the TypeScript types, migrations and the server modes.

## The file

The file is `iglo.schema.json`. Its first line points at the JSON Schema of the release, so editors that understand JSON Schema check and complete it as you type:

```json
{
  "$schema": "https://github.com/iglo-tech/iglo.base/releases/download/v1.0.0/iglo.schema.json",
  "collections": {
    "posts": {
      "type": "base",
      "description": "Blog posts",
      "rules": {
        "list": "",
        "view": "",
        "create": "@request.auth.id != ''",
        "update": "@request.auth.id = author"
      },
      "indexes": [
        "CREATE UNIQUE INDEX `idx_posts_slug` ON `posts` (`slug`)"
      ],
      "fields": {
        "title": {
          "type": "text",
          "required": true,
          "max": 120
        },
        "slug": {
          "type": "text",
          "required": true,
          "pattern": "^[a-z0-9-]+$"
        },
        "body": {
          "type": "editor"
        },
        "author": {
          "type": "relation",
          "collection": "users",
          "maxSelect": 1,
          "cascadeDelete": false
        },
        "tags": {
          "type": "json",
          "tsType": "string[]"
        }
      }
    }
  }
}
```

The file has two top-level keys:

- `$schema`: the JSON Schema of the release. Your editor reads it; iglo.base does not need it.
- `collections`: every collection, keyed by its name.

### Collections

Each collection is keyed by its name and has a `type`: `base`, `auth` or `view`.

- `rules`: the API rules, `list`, `view`, `create`, `update` and `delete`. An auth collection also has `auth` and `manage`. `null` means only superusers, and `""` means everyone.
- `indexes`: the SQL `CREATE INDEX` statements of the collection.
- `fields`: the fields, keyed by name. A view has no `fields`, because its fields come from its `query`.
- `query`: the SELECT statement of a view.
- `description`: a text for your editors and for the generated types. It is not stored in the database.
- `system`: written only for a system collection that is not one of the five built in (`_superusers`, `_externalAuths`, `_mfas`, `_otps`, `_authOrigins`). Those five are system by name.
- `users` is an auth collection like any other. Its rules, fields and options are written in full, so a file that has a `users` block says what it means, whatever the collection is called.
- The options of an auth collection, under the same names the dashboard uses: `passwordAuth`, `oauth2`, `authAlert`, `mfa`, `otp`, `authToken`, `passwordResetToken`, `emailChangeToken`, `verificationToken`, `fileToken`, `verificationTemplate`, `resetPasswordTemplate` and `confirmEmailChangeTemplate`.

### Fields

Each field is keyed by its name, and its order in the file is its order in the API and the dashboard. Keep it: a field's position is part of the schema.

- `type`: one of `text`, `editor`, `number`, `bool`, `email`, `url`, `date`, `autodate`, `select`, `json`, `geoPoint`, `relation`, `file` or `password`.
- The other options are the ones the dashboard has, under the same names: `required`, `max`, `values`, `maxSelect` and so on. Your editor lists the options of each type.
- A `relation` names its target collection by name, in `collection`, not by id.
- `description` is for your editors and generated types.
- `tsType` is on `json` fields only: the TypeScript type of the value, such as `"string[]"`.

### What the file leaves out

The file only lists what you chose. Anything equal to its default is left out, and the reader puts the default back:

- **Ids.** Collections and fields are matched by name, so the file has no ids. One exception: an index that an old upstream migration named with the collection id (such as `_<id>_username_idx`) is written with that name, as it is stored. A name is not a reference, and the apply compares indexes by their definition, not by name.
- **System fields.** `id` is in every collection, and the auth collections also have `password`, `tokenKey`, `email`, `emailVisibility` and `verified`. They are implied. They are written only if you change them.
- **System collections.** `_superusers`, `_externalAuths`, `_mfas`, `_otps` and `_authOrigins` are left out unless you change them.
- **Implied indexes.** An auth collection always has a unique index on `tokenKey` and one on `email`, and upstream adds them itself. The file leaves them out, whatever their names are. A listed one is compared by its definition, under the name it has, so it is not a new index. Only the index upstream writes counts: one with a `COLLATE` or a sort order, such as a case-insensitive email index, is kept.
- **Timestamps.** A collection's own creation and update times are not written. A field named `created` or `updated` is an ordinary autodate field, as in the dashboard, so it is written.

The file never holds:

- **Token secrets.** The `secret` in `authToken` and the other token options is not written, and the file with one is refused.
- **Secret values of OAuth2 providers.** A provider's `clientSecret` is an environment reference, `{"env": "NAME"}`, never the value. See [OAuth2 providers](#oauth2-providers). A plain secret is refused.
- **Settings.** SMTP, S3, backups, and the other settings stay in the database for now.
- **Records and migrations.** The file describes the schema. Records are not in it.

The reasons are the same: the file goes into git, and a secret in git is a leak.

## `schema pull`

`schema pull` reads the collections of the database and writes the file:

```sh
./iglo-base schema pull --out iglo.schema.json
```

Without `--out` it writes the file to the terminal:

```sh
./iglo-base schema pull > iglo.schema.json
```

It reads the database in `--dir` (the default is `pb_data` next to the executable), like the other commands. It does not change the database. If `--dir` has no database, the pull stops with an error and creates nothing.

The standard output of `schema pull` is the file and nothing else. The log lines, and the SQL statements that `--dev` prints, go to the standard error.

Some rules make the diffs small:

- Collections are sorted by name.
- Fields keep their stored order.
- Keys of an object are written in a fixed order, and the file ends with a newline.
- Options that equal their default are left out.
- Running `schema pull` twice on an unchanged database gives the same file, byte for byte.

When `--out` names a file that already exists, `schema pull` keeps its `description` and `tsType` values, because the database does not hold them. If that file is not JSON, the pull stops and leaves the file as it is. Fix the file or remove it, then run the pull again.

A name that is a whole number such as `"2026"` or `"0"` is refused, because JSON objects put such names first and do not keep the order of the fields. Other digit names, such as `"007"`, are fine. Rename the collection or field if you need the whole number.

`schema json-schema` prints the JSON Schema that the executable has built in. Use it to set up an editor without a network connection:

```sh
./iglo-base schema json-schema > iglo-schema-format.json
```

## Applying the file at startup

`serve --schema` applies the file before the server starts:

```sh
./iglo-base serve --dir ./pb_data --schema iglo.schema.json
```

It does this at every start, not only the first one. The file is read at each start, so a change to it takes effect at the next start. A restart after a restore from the dashboard applies the file too, so restored data gets the file's schema. Without `--schema`, the server works as before.

An apply does these things, in this order:

1. It reads the file and checks it. A file that is not valid stops the start.
2. It compares the file with the database. If nothing would change, and no JavaScript migration in `pb_migrations` is waiting to run, it stops here. It makes no backup and checks no records.
3. It makes a dry run: the whole apply runs in one transaction that is rolled back, as `schema plan` runs it. If the dry run finds a problem, the start stops and prints the report. It makes no backup, so a server that fails on every start makes none either. The data-loss guard (see [The data-loss guard](#the-data-loss-guard)) is part of the dry run. The dry run holds the write locks of both `data.db` and `auxiliary.db` while it runs, as `schema plan` does.
4. It makes a backup (see [Backups before an apply](#backups-before-an-apply)). A backup that fails refuses the start, and the schema is not applied.
5. It opens one transaction on `auxiliary.db`, and inside it one on `data.db`, so a rollback undoes the writes to both. The JavaScript migrations in `pb_migrations` that have not run yet run first. A migration may create a collection that the file also lists; the apply then matches the file to what the migration created.
6. Then the changes. New collections are created, each with its fields, after the collections they relate to; new fields are added to the existing ones. A relation to a collection that does not exist yet is refused by the save, so when two new collections relate to each other, one of the relation fields is added after both exist. New and changed collections are saved in full: their fields in the file's order, their indexes, rules and options. A field that the file no longer lists is dropped by the save of its collection. Views that the change affects, and the views the file removes, are dropped first. Then the removed views go, and the removed collections go after the collections that relate to them.
7. Then every record of each collection whose fields were added or changed is checked against the rules the API applies when a record is saved.
8. If every step works, the transaction is committed and the server starts. If any step fails, the transaction is rolled back and the database is unchanged. The backup from step 4 stays, and the retention keeps the three newest pre-schema backups.

A pending migration runs twice on the start that applies it: once in the dry run of step 3, which rolls back its changes to `data.db` and `auxiliary.db`, and then for real in this step. A migration's deletes of records and collections remove their stored files only after the transaction commits, so a rolled back dry run or plan leaves the files in place. Effects that a migration makes itself outside the databases are not rolled back: a file it writes (for example with `$os.writeFile`) and an outbound call happen twice. `schema plan` runs the pending migrations too, so a plan has the same effects outside the databases. Keep `up` free of such effects, or make them safe to repeat. Settings that a migration changes through `app.settings()` are read again from the database after the dry run, so the real run starts from the stored settings and the change is made once.

A few rules apply to the changes:

- The apply does not read token secrets from the file, and the token secrets stay as the database has them. OAuth2 providers are set from the file only when the file lists them (see [OAuth2 providers](#oauth2-providers)); a file that leaves them out keeps the stored ones.
- Indexes are compared by their definition, not by name. An index with the same definition under another name keeps the name it has. The implied index of an auth collection (the unique index on `tokenKey` and the one on `email`) is compared the same way: if the file lists it, the file's copy is the stored index, under its stored name. It is not an added index, and the file does not need to list it.
- A field whose type changes (same name, another type) is removed and added again. Its old values are lost, so the data-loss guard applies to it.
- A collection's type cannot change. An apply that changes it stops.
- While `--schema` is set, `--automigrate` is off, so the dashboard does not write migration files.
- Renames of collections and fields are declared in TypeScript migrations (see [Migrations](#migrations)). The modes, `--mode dev|prod`, are described in [Development and production](#development-and-production).

## `schema plan`

`schema plan` shows what applying the file would do, and changes nothing:

```sh
./iglo-base schema plan --schema iglo.schema.json
```

It runs the apply's transaction and rolls it back. It prints:

- the changes, collection by collection. With a rename, a rule or option that the file sets to its stored value is not listed, and an index that the file keeps is listed as `index rebuilt`: the apply drops it and creates it again, and the row count is the size of the table it is built on;
- the JavaScript migrations that would run;
- the data that would be lost;
- every problem, with up to five example record ids and the next step.

It makes no backup. Its exit code is `0` when the file would apply, also when nothing would change, and `1` when it would not. Pass `--allow-data-loss` to see the plan with the deletion allowed.

Like `schema pull`, it needs a database in `--dir` and creates none.

Plan runs on the live database. It holds the write locks of `data.db` and `auxiliary.db` from its first write until it rolls back, so run it when a short pause in writes is acceptable: the server's writes to `auxiliary.db`, the request logs among them, wait for it. A start with `--schema` holds the locks for its dry run in the same way.

Example output, for a file that makes a field required while some of its records are empty:

```text
collections:
  ~ posts (base)
      ~ author: required
problems:
  posts.author: required, 312 records empty. Add a migration that fills it, or make the field optional.
    examples: 7y2kq9mz4rt1ab5, c3n8w0xv6pl2de9, 9hd3ta0ls7ve2mq
the schema would not apply: 1 problem
```

## Backups before an apply

When an apply has something to change and its dry run passes, it backs up the data directory before the transaction. The backup is named `pre-schema-<UTC time>.zip`, with milliseconds, for example `pre-schema-20261112T101500.123Z.zip`. It goes to the backup storage that the dashboard uses, local or S3, and it is made with the same code as the dashboard's backups.

- Two backups never share a name. If a backup of the same name already exists (two applies within one millisecond), the time moves on by a millisecond, so the older backup stays.
- The backup stays when the apply fails after it.
- If the backup fails, the start is refused and the schema is not applied.
- A disk-space failure says how much room the backup needs (the size of the data directory) and how much is free. Free that space, or set a backup storage with room, and start again.
- A start whose dry run fails makes no backup at all. The report says why; fix the file or the data first.
- After every apply that made a backup, successful or failed, the three newest `pre-schema-*` backups are kept, and older ones are deleted. So at most three exist once the apply returns, even when the server fails on every start. If a deletion fails, the error is logged; the apply's own result stands.
- The automatic backup setting `cronMaxKeep` does not touch pre-schema backups.

## The data-loss guard

An apply that would delete data stops before it changes anything, unless you pass `--allow-data-loss`:

```sh
./iglo-base serve --schema iglo.schema.json --allow-data-loss
```

Without `--schema`, the flag has no effect.

A field holds data when one of its rows has a value that is not empty. Empty is the value the API shows for a field that is not set: NULL and the empty text for text-like fields, `0` for a number or a bool, an empty list for a multi-value select, file or relation (for a json field, also `null`), and the point `{"lon":0,"lat":0}` for a geoPoint. The guard counts:

- the values of a field that the file removes;
- the values of a field whose type changes, since it is removed and added again;
- the records of a collection that the file removes;
- for a select, file or relation that the file makes single-valued, the rows that hold more than one value: the extra values go.

Views hold no data, so removing a view is not counted. Without `--allow-data-loss`, each count is a problem in the report, and the apply stops.

Lowering a `maxSelect` to two or more deletes no values. The rows that hold more than the new maximum then fail the record check, with a problem such as `posts.tags: Select no more than 2, 1 records fail the check`. `--allow-data-loss` does not change that: the apply stops until those records are fixed (a migration can do it) or the field keeps its maximum.

## When an apply fails

If an apply fails, the server does not start. The start exits with status `1` and prints the reason on standard error. The database is unchanged. A failed dry run makes no backup. A failure after the backup (in the transaction) keeps that backup until the retention removes it. Each later start fails the same way until the file or the migration is fixed. This is by design: the server stays down rather than run against a schema that does not match the data.

The report lists what the apply would change and every problem. For example:

```text
collections:
  ~ posts (base)
      ~ author: required
problems:
  posts.author: required, 312 records empty. Add a migration that fills it, or make the field optional.
    examples: 7y2kq9mz4rt1ab5, c3n8w0xv6pl2de9, 9hd3ta0ls7ve2mq
the schema is not applied: 1 problem
```

Each problem names the field or collection, the number of records or values, and the next step. Examples:

- Records that break a new rule, such as an empty required value: add a migration that fills the value, or make the field optional.
- A unique index that two records break: the problem names the collection and the column (SQLite does not report the values). Make those values distinct, or change the index so that it is not unique. To find the duplicates, query the column, for example `SELECT title, COUNT(*) FROM posts GROUP BY title HAVING COUNT(*) > 1`.
- Data that would be deleted: pass `--allow-data-loss` if the deletion is intended, or keep the field or collection in the file.
- A select, file or relation that is made single-valued and holds more values in some rows: the extra values are counted as data that would be deleted.
- A collection type change: keep the type in the file, or remove the collection and add one under another name.

To see the report before you deploy, run `schema plan` with the same file.

## Migrations

The file says what the schema is. A migration changes the data, and only the data, as a TypeScript file that the apply runs once, at the start, inside its transaction. Renames of fields and collections are declared in a migration, so the values stay.

### Where they live

Migration files are in `migrations/`, next to the schema file, or in the directory that `--schemaMigrationsDir` names (for `serve --schema`, `schema plan` and `schema types --schema`). A relative path is taken from the directory you run the command in.

A file is named `<digits>_<name>.ts`, for example `20261113120000_rename_writer.ts`. The name is digits, an underscore, then lowercase letters, digits, `_` or `-`. Use a timestamp (`YYYYMMDDHHMMSS`), so the files run in the order they were written: the migrations run in file name order, and mixed widths of number do not sort. A file whose name does not fit, or that does not load, stops the start with the file's name. A migration is loaded from a bundle of its own text and the files it imports, so an edit is what runs, and a value import from the types file (`Collections`, for example) resolves. The `import.meta` location values (`import.meta.dir`, `dirname`, `path`, `filename`, `file` and `url`) are the migration file's own, so a file next to it is read with `join(import.meta.dir, "seed.csv")`. A module the migration imports sees the same values, so keep the reads in the migration file. A file that does not load stops the start with its position: the file, line, column and the reason.

Each file default-exports an object that `satisfies Migration`. `Migration` comes from the types file that `schema types` writes, so the record helpers are typed:

```ts
import type { Migration } from "../src/iglo.types";

export default {
  renames: { posts: { writer: "author" } },
  up(tx) {
    for (const post of tx.records("posts", { filter: "slug = ''" })) {
      tx.update("posts", post.id, { slug: post.id });
    }
  },
} satisfies Migration;
```

The object has three keys and no others: `renames`, `renameCollections` and `up`.

### `up(tx)`

- `up` runs in the apply transaction, after the fields and collections are added and before the file's changes narrow them (constraints, rules, indexes and removals). It is synchronous: an `up` that returns a promise, or that throws, fails the apply, and the transaction rolls back, so the database is as it was. The error names the file.
- `tx` has these helpers. They read and write the records through the same validation the API applies to the record being saved.
  - Records come back as a superuser's API read returns them: every field, the hidden ones and the email included. A password and a token key are never in them.
  - `records(collection, { filter, sort, params })`: an iterator over the matching records, read before the first one is returned.
  - `findFirst(collection, query)` and `findById(collection, id)`: the record, or `null`.
  - `create(collection, data)`, `update(collection, id, data)` and `delete(collection, id)`.
  - `sql(query, params)`: a raw query on `data.db`, for what the helpers do not cover.
- The record check (the last step of the apply, which checks every record against the final schema) runs after `up`, not during it. A migration can therefore fill a new required field in several passes: the field is optional while the migrations run, and the check finds any record that is still empty.
- Not available: file uploads (the helpers refuse a `File` or `Blob` value) and network access (mail, S3, OAuth2). Nothing in the helpers reaches the network, but a `fetch` call inside `up` is not stopped, and it would hold the write transaction for as long as it takes. Do not make one.
- Forward only: there is no `down`. The pre-schema backup is the way back.

### Running once

Each file that runs is recorded in `_migrations` as `@schema/<file name>`, in the same transaction as its changes, so a file runs once across restarts. A failed run records nothing. Do not rename a file that has run: the new name runs again. `migrate history-sync` keeps these rows.

### Renames

`renames` and `renameCollections` declare renames:

```ts
export default {
  renames: { posts: { writer: "author" } },
  renameCollections: { authors: "writers" },
} satisfies Migration;
```

- A field is keyed by its collection's name as it is before this file's own renames. A collection that this file renames is keyed by its old name in `renames` too, so `renames: { authors: { name: "fullname" } }` works next to `renameCollections: { authors: "writers" }`. A renamed collection is named by its new name in `renameCollections`.
- A rename runs as a real rename: the field keeps its id and the column keeps its values; the collection keeps its id, its table, its records and their files, and the relations that point to it. Rate-limit rules that start with the old collection name are relabelled, as the dashboard does.
- Pending files run in name order, each against the names the earlier files left, so a second file can rename what the first one renamed: `renames: { posts: { author: "byline" } }` in a later file works after `renames: { posts: { writer: "author" } }` in an earlier one. A file that has run is not read again. Within one file, a name cannot be renamed again: put the second rename in a file of its own.
- When a file renames something, the apply first drops the SQL views. It then clears the rules of every collection that is not a system collection (a system rule cannot change), the identity fields and the MFA rule of an auth collection (`email` and empty), and the indexes: every index of a collection that is not a system collection, and of a system collection the indexes that name a renamed field (upstream requires the others). The implied indexes of an auth collection are kept. The file's values are set again, and the views are created again. So a rule, option or index that names an old name, in any form (a relation path, a back relation, an alias, an expression), is not an error. Write the file's rules and indexes with the new names.
- A rename is refused, with the reason, and the apply does not start, when: the old name does not exist; the new name already exists, or the file does not have it at the end of the pending renames; two renames of one file give one name, or a file renames a name it creates. A view and a system collection or field cannot be renamed. Remove the view and add one under the new name.
- A field or collection that the file drops is not data loss when it is the old name of a rename; without the rename, the data-loss guard still stops the apply.

`schema plan` lists each rename, and the rate-limit rules a collection rename relabels, before the changes and the migrations.

### Recipes

**Add a required field that existing records fill.** Add the field to the file as required, and add a migration that fills it:

```json
"slug": { "type": "text", "required": true }
```

```ts
// migrations/20261113170000_slug.ts
import type { Migration } from "../src/iglo.types";

export default {
  up(tx) {
    for (const post of tx.records("posts")) {
      tx.update("posts", post.id, { slug: String(post.title).toLowerCase().replace(/\W+/g, "-") });
    }
  },
} satisfies Migration;
```

If a record stays empty, the record check stops the apply and names the field. The file is applied only when every record has the value.

**Rename a field.** Change the name in the file, and declare the rename in a new migration:

```ts
// migrations/20261113180000_writer_is_author.ts
import type { Migration } from "../src/iglo.types";

export default {
  renames: { posts: { writer: "author" } },
} satisfies Migration;
```

**Rename a collection.** Change the name in the file, including the relations and rules that name it, and declare the rename:

```ts
// migrations/20261113190000_writers.ts
import type { Migration } from "../src/iglo.types";

export default {
  renameCollections: { authors: "writers" },
} satisfies Migration;
```

## Types

`schema types` writes the TypeScript types of the collections, so that app code and the database cannot drift apart without the compiler saying so:

```sh
./iglo-base schema types --schema iglo.schema.json --out src/iglo.types.ts
```

- `--schema <file>` applies the file first, in a transaction that is rolled back: the same plan as `schema plan`, with its write lock and its notes, and no backup. The types are those of the applied schema, and no server is needed. Without it, the types come from the database as it is, so the database must already have the schema (a start with `--schema` applies it).
- `--out <file>` writes the file. Without it, the types go to standard output.
- `--check` compares `--out` with what the command would write, exits nonzero and names the file when they differ, and writes nothing. Run it with the same `--schema` in CI or a pre-commit hook.
- `--dir` chooses the data directory, as for the other commands. The command reads an existing database and creates none.

The same schema gives the same file, byte for byte. The file also has the `Migration` type and the helper types of a migration (`MigrationTx`), which come from the applied schema, so a migration that names a missing field or gives a value of the wrong type is a compile error (see [Migrations](#migrations)). The file's header names the command, and it is laid out the way oxfmt lays out TypeScript, so a formatter run on it changes nothing. A test checks that with long names, long values and quoted values. The one exception is a json field's `tsType`: it is written as the schema file has it, behind an `// oxfmt-ignore` comment, so a formatter leaves its line alone.

### What is generated

For each collection, `Posts` below is its name in Pascal case (`my_posts` becomes `MyPosts`). A system collection keeps its underscore, so `_otps` becomes `_Otps` and `_superusers` becomes `_Superusers`, and a user collection named `superusers` is `Superusers`, which does not clash with it:

- `PostsRecord`: every stored field, the hidden ones too (an auth collection's password, for example).
- `PostsResponse<Expand = {}>`: what the API returns to a client that is not a superuser: `id`, `collectionId`, `collectionName`, the fields that are not hidden, and `expand`. The `Expand` argument types the expanded relations, for example `PostsResponse<{ author: AuthorsResponse }>`. A superuser's responses also carry the hidden fields; the types leave them out.
- `PostsCreate` and `PostsUpdate`: the inputs. A field that is not required is optional, and so is a field the server fills in (the id, a text field with an autogenerate pattern). `PostsUpdate` also takes the modifiers `field+`, `+field` and `field-` where the API takes them: `field+` and `field-` on a number, and all three on a select, relation or file field. Autodate fields are not set by a request, and neither is an auth collection's `tokenKey`. Hidden fields (an auth collection's password, for example) are in `Create` and `Update`, and only a superuser can write them: the API drops them from another client's request.
- `Collections`: an enum of the collection names, `Collections.Posts` is `"posts"`.
- `TypedPocketBase`: the client, with its `collection` method typed for each collection name. A name the schema does not have is a type error.

A view collection gets the same types, from its resolved fields. The API is read-only for views, so their `Create` and `Update` types are not used.

| Field type | Stored value (`Record`, `Response`) | Input (`Create`, `Update`) |
| --- | --- | --- |
| text, editor, email, url, date, password | `string` | `string` |
| autodate | `string` | not set by a request |
| number | `number` | `number`; `field+` and `field-` add and subtract |
| bool | `boolean` | `boolean` |
| select | the union of its values. A single select that is not required also includes `""`, which the API returns when it is not set. A multi-select is an array of the union | the same; `+field`, `field+` and `field-` |
| relation | the id, or an array of ids | the same; `+field`, `field+` and `field-` |
| file | the file name, or an array | `File \| Blob`, or an array for a multi-file field. `Update` also takes a name (a string keeps the file), and `""` or `null` (for a field that is not required) clears it; `+field` and `field+` take uploads or names, `field-` removes names |
| json | the field's `tsType` (verbatim) or `unknown`, and `\| null` when the field is not required, since it reads null when unset | the same |
| geoPoint | `{ lon: number; lat: number }` | the same |

An auth collection's `email` is optional in a response, since the API returns it only when `emailVisibility` allows it. Its create requires `password` and `passwordConfirm`, as the API does for every new record, and its update takes `passwordConfirm` and `oldPassword` optionally.

A collection's and a field's `description` becomes JSDoc, and a json field's `tsType` is its type. Neither is in the database, so they come from the file: keep `--schema` in the command that generates the types.

Two collections whose names give the same type name, such as `my_posts` and `myPosts` (both `MyPosts`), are an error that names both. Rename one of them.

### Using the types

```ts
import PocketBase from "@iglo.tech/iglo.base";
import type { PostsResponse, TypedPocketBase } from "./iglo.types";

const pb = new PocketBase("https://example.com") as TypedPocketBase;
const post: PostsResponse = await pb.collection("posts").getOne("RECORD_ID");
```

`TypedPocketBase` takes the client class as its type argument, `TypedPocketBase<C = PocketBase>`, so a server or browser client keeps its own methods. Cast to the class you use:

```ts
import { createBrowserClient, type BrowserClient } from "@iglo.tech/iglo.base/ssr/browser";
import { createServerClient, type ServerClient } from "@iglo.tech/iglo.base/ssr";
import type { PostsResponse, TypedPocketBase } from "./iglo.types";

const browser = createBrowserClient({ url }) as TypedPocketBase<BrowserClient>;
browser.handOff(); // the browser client's own method
const server = (await createServerClient({ url, cookies })) as TypedPocketBase<ServerClient>;
const posts = await server.collection("posts").getFullList<PostsResponse>();
```

With the official `pocketbase` package, which keeps the same API, pass the record type to its generic instead: `pb.collection<PostsResponse>("posts")`.

## Development and production

`serve` has two modes for a schema file. Without `--schema` neither changes anything.

```sh
./iglo-base serve --dir ./pb_data --schema iglo.schema.json --types src/iglo.types.ts        # development (the default)
./iglo-base serve --dir ./pb_data --mode prod --schema iglo.schema.json                      # production
```

### Development

`--mode dev` is the default with `--schema`. The file and the database follow each other while the server runs:

- **From the dashboard or the API to the file.** A collection that you create, change, delete or import in the dashboard, or through the collections API, is written back to `iglo.schema.json` within a second, and to the `--types` file when you give one. The server does not apply its own write. Your comments are not in the file (JSON has none); the file keeps its `description` and `tsType` keys.
- **From the file to the database.** When you save the file, or add or change a migration file in `migrations/` next to it (the directory may be made after the start), the server applies the change at once, with the steps of the start (see [Applying the file at startup](#applying-the-file-at-startup)) but without a backup, since you are developing on your own data. Saves that arrive in a burst are applied once, after a short pause. Only a change of content counts: a touched file, or another file in those directories (an editor's swap file, a log), changes nothing, unless the last apply failed. After a failure, a save or a touch of the file applies it again, so a fix made in the data (a duplicate deleted through the API, for example) takes effect at once, without an edit of the text. A file that does not apply changes nothing else: the report is printed in the terminal once for that content and modification time, and the server keeps the old schema. A fix of a migration in place applies at once, without a restart.
- **Edits that are not applied.** The file is the source of truth. If the file has an edit that the server has not applied yet (for example, a file that does not parse), a change made in the dashboard or through the API is not written to the file, and the terminal says that the dashboard change to the collection *will be replaced by the pending file edit*. When the edit applies, the file replaces the dashboard change, so make the change in the file, or revert the edit first.

### Production

`--mode prod` applies the file at each start, as before, and then **locks** the schema and the settings:

- collection create, update, delete and import, and `PATCH /api/settings`, answer `403` with the message "The schema and settings are managed by the schema file". The message says where each change is made: the collections in the file, the settings in a migration. Superusers get the `403` too;
- records, users, files, backups (a restore too, which restarts the server and applies the file again), logs and everything else work as usual;
- the dashboard's collection and settings screens are read-only and say why.

Change the schema in the repository, and restart the server: the start applies it. Nothing watches the file in production.

The settings (SMTP, S3, backups, rate limits and the rest) are locked as well, and the file does not hold them. They change through a JavaScript migration and a restart, as described in [Changing the settings](#changing-the-settings).

#### Invalidating the tokens

"Invalidate all previously issued tokens" in the dashboard is a collection update, so in production it is a JavaScript migration in `pb_migrations`, which runs once at the next start. It gives the collection a new token secret, and the tokens issued before it stop working. Name the file with a timestamp and a name, for example `pb_migrations/1700000000_invalidate_user_tokens.js`:

```js
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  users.authToken.secret = $security.randomString(50);
  app.save(users);
}, (app) => {});
```

For another auth collection, change the collection name. Applied migrations are recorded, so the file runs once.

#### Changing the settings

The settings are not in the schema file, so in production a settings change is a JavaScript migration in `pb_migrations` and a restart. The migration edits the settings and saves them. It runs once, at the next start, before the server answers requests:

```js
migrate((app) => {
  const settings = app.settings();
  settings.meta.appName = "My app";
  app.save(settings);
}, (app) => {});
```

Name the file with a timestamp, as for the tokens. The TypeScript migrations in `migrations/` cannot change the settings: their helpers reach records and collections only.

## OAuth2 providers

An auth collection's OAuth2 providers can be in the file, so its whole sign-in setup lives in the repository. The secret of each provider is read from an environment variable when the server starts or `schema plan` runs:

```json
{
  "collections": {
    "users": {
      "type": "auth",
      "oauth2": {
        "enabled": true,
        "providers": [
          {
            "name": "github",
            "clientId": "Iv1.0123456789abcdef",
            "clientSecret": { "env": "USERS_GITHUB_CLIENT_SECRET" }
          }
        ]
      }
    }
  }
}
```

- **The secret is a reference.** `clientSecret` must be `{"env": "NAME"}`. A plain string is refused, with a message that says why. The other keys (`clientId`, `authURL`, `tokenURL`, `userInfoURL`, `displayName`, `pkce`, `extra`) may be plain values or references too: a reference to `pkce` holds `true` or `false`, and one to `extra` holds a JSON object.
- **The variables.** Set `USERS_GITHUB_CLIENT_SECRET` in the environment of the server (for example in its systemd unit, or with `docker run -e`). A variable that is not set, or is empty, fails `schema plan` and the start, and the message names it. The value is never printed, never written to the file, and never in a report or a log.
- **Listing the providers.** A file that lists `providers` sets them at every apply, from the file and the environment. A file that leaves `providers` out keeps the providers the database has, as before.
- **Changes.** `schema plan` names what changes without showing a value: `provider github: clientSecret changed` means the variable holds another secret than the server has.
- **The dashboard and the file.** In development a provider you add in the dashboard is written to the file with a generated reference, such as `USERS_GOOGLE_CLIENT_SECRET`, and the terminal lists the variables to set; the references the file already has are kept. A file that does not list `providers` for the collection gets none from the dashboard: the database keeps its providers, and the start does not need their variables. `schema pull` follows the same rules, and a new file gets the generated references.

## Limitations

- **A rule that names a view field that the same apply changes.** The rules are set in step 6 and the views are created again in step 7, so the rule is checked against the view the database still holds, and it fails with `unknown field`. The workaround is to keep the view's column name with an alias in its query.
- **Unique indexes are absent while the migrations run, when a rename is pending.** The renames drop the indexes first (see [Renames](#renames)), so a migration that relies on a unique index to reject a duplicate succeeds. The apply then fails at step 6 with `Failed to create index`, and the rollback leaves the database as it was; only the message is less clear.
