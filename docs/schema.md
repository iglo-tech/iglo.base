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

- **Secrets.** Token secrets (`secret` in `authToken` and the other token options) are not written, and the file with one is refused.
- **OAuth2 providers.** The `providers` list holds client secrets, so it is not written. Set providers in the dashboard. Providers and their secrets are kept out of git on purpose.
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
3. It makes a dry run: the whole apply runs in one transaction that is rolled back, as `schema plan` runs it. If the dry run finds a problem, the start stops and prints the report. It makes no backup, so a server that fails on every start makes none either. The data-loss guard (see [The data-loss guard](#the-data-loss-guard)) is part of the dry run. The dry run holds the database's write lock while it runs, as `schema plan` does.
4. It makes a backup (see [Backups before an apply](#backups-before-an-apply)). A backup that fails refuses the start, and the schema is not applied.
5. It opens one transaction. The JavaScript migrations in `pb_migrations` that have not run yet run first. A migration may create a collection that the file also lists; the apply then matches the file to what the migration created.
6. Then the changes. New collections are created, each with its fields, after the collections they relate to; new fields are added to the existing ones. A relation to a collection that does not exist yet is refused by the save, so when two new collections relate to each other, one of the relation fields is added after both exist. New and changed collections are saved in full: their fields in the file's order, their indexes, rules and options. A field that the file no longer lists is dropped by the save of its collection. Views that the change affects, and the views the file removes, are dropped first. Then the removed views go, and the removed collections go after the collections that relate to them.
7. Then every record of each collection whose fields were added or changed is checked against the rules the API applies when a record is saved.
8. If every step works, the transaction is committed and the server starts. If any step fails, the transaction is rolled back and the database is unchanged. The backup from step 4 stays, and the retention keeps the three newest pre-schema backups.

A few rules apply to the changes:

- The apply does not read secrets from the file. Token secrets and OAuth2 providers stay as the database has them.
- Indexes are compared by their definition, not by name. An index with the same definition under another name keeps the name it has. The implied index of an auth collection (the unique index on `tokenKey` and the one on `email`) is compared the same way: if the file lists it, the file's copy is the stored index, under its stored name. It is not an added index, and the file does not need to list it.
- A field whose type changes (same name, another type) is removed and added again. Its old values are lost, so the data-loss guard applies to it.
- A collection's type cannot change. An apply that changes it stops.
- While `--schema` is set, `--automigrate` is off, so the dashboard does not write migration files.
- Renames of collections and fields, and TypeScript migrations, are not in this version. Modes (`--mode`) and the development file watcher are not in this version either. Each comes in a later version.

## `schema plan`

`schema plan` shows what applying the file would do, and changes nothing:

```sh
./iglo-base schema plan --schema iglo.schema.json
```

It runs the apply's transaction and rolls it back. It prints:

- the changes, collection by collection;
- the JavaScript migrations that would run;
- the data that would be lost;
- every problem, with up to five example record ids and the next step.

It makes no backup. Its exit code is `0` when the file would apply, also when nothing would change, and `1` when it would not. Pass `--allow-data-loss` to see the plan with the deletion allowed.

Like `schema pull`, it needs a database in `--dir` and creates none.

Plan runs on the live database. It holds the database's write lock from its first write until it rolls back, so run it when a short pause in writes is acceptable. A start with `--schema` holds the lock for its dry run in the same way.

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
