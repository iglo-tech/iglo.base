# Schema as code

Your collections can live in a file in your repository, next to your code. The file lists every collection and field. You can read it in a pull request, review it like any other change, and give it to an editor or an agent that checks it against a JSON Schema.

This guide covers the file and `schema pull`, which writes the file from a database. Later versions of this guide add applying the file, the TypeScript types, migrations and the server modes.

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
- **Implied indexes.** An auth collection always has a unique index on `tokenKey` and one on `email`, and upstream adds them itself. The file leaves them out, whatever their names are. Only the index upstream writes counts: one with a `COLLATE` or a sort order, such as a case-insensitive email index, is kept.
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
