# S.5 TypeScript migrations and declared renames

Written by the chief of staff on 2026-11-13. The spec is GitHub issue [#80](https://github.com/iglo-tech/iglo.base/issues/80) (`gh issue view 80`). Decision D40 ("Migrations change data, not structure", the apply order, "Not an extension surface") and `docs/design/14-schema.md`, both on `develop`, are binding. Where the issue and D40 differ, D40 wins. For example, renames are step 2, after the JavaScript migrations; TypeScript migrations are step 5, after widen; `up` is synchronous. **Base branch: `develop`.** S.3 (the apply, with empty steps 2 and 5 waiting for this task) and S.4 (generated types) are merged there.

## Scope

- **Migration files.** They live in `migrations/` next to the schema file, or in the directory `--schemaMigrationsDir` names, on `serve --schema`, `schema plan` and `schema types --schema`.
  - **Names:** `<sortable date or number>_<name>.ts`, run in name order. A name that doesn't fit is refused with a clear error.
  - **Contents:** a default export `satisfies Migration`, with `Migration` coming from the generated types file. Extend S.4's generator to emit it, with record helpers typed per collection.
  - **Loading:** Bun imports the file. A compile or import error fails the apply with the file name.
- **Renames.**
  - **Declaring them:** `renames: { <collection>: { <old>: <new> } }` and `renameCollections: { <old>: <new> }` in a migration file. Read the declarations from every pending file before step 2, and run them in step 2 as real renames through the collection save path, so values, ids and files stay.
  - **Clearing old references:** clear stored rules and indexes that name a renamed or removed field, or a renamed collection (`@collection.<old name>`), exactly as D40 step 2 says. The file's rules and indexes are set again in step 6.
  - **Plan output:** `schema plan` shows each rename and lists the settings rate-limit rules a collection rename changes.
  - **Data-loss guard:** a field or collection the file drops is not data loss when it is the old name of a declared rename. Without the declaration, S.3's guard still applies.
  - **Refusals:** refuse with a clear error a rename whose old name doesn't exist, whose new name already exists or isn't in the file, or that collides with another rename.
  - **Already-applied files:** their renames are not run again.
- **`up(tx)` in step 5.**
  - **Synchronous:** an `up` that returns a thenable fails the apply.
  - **Helpers:** `records(collection, { filter, sort })` as an iterator, `findFirst`, `findById`, `create`, `update`, `delete` and `sql`, all on the apply transaction.
  - **Saving:** saves go through the records API's field validation. The check over the whole data set waits for step 8, so several passes can fill a newly required field.
  - **Not available:** no file uploads, and no network (mail, S3, OAuth2). Make that a type error where possible and a runtime error otherwise.
- **Recording runs:** each applied file is recorded in `_migrations` as `@schema/<file name>`, in the same transaction. A file runs once. `migrate history-sync` never deletes `@schema/` rows and treats every other row as upstream does.
- **Upstream check (D40):** on the PocketBase v0.41.0 binary, confirm that it starts, serves and runs its own `migrate` commands with `@schema/` rows in `_migrations` whose files it doesn't have. Put this in a differential test. Record the result in D40 with a dated line; if it fails, stop and report to the lead before going further.
- **Ordering:** JavaScript migrations in `pb_migrations` (D23) still run in step 1, before everything else.

## Tests

All tests run through the CLI and the API on `mktemp -d` data:
- **Renames:**
  - a field rename keeps the values;
  - a collection rename keeps records, ids, files and relations pointing to it, and the rules naming it are reset from the file;
  - a rename and a narrow in the same apply;
  - each refused rename.
- **Required field:** a migration fills a new required field across two passes, and step 8 passes.
- **Failures and runs:**
  - a migration that throws, and an async `up`, each roll back the whole startup (`pb_data` unchanged apart from the backup);
  - a file runs once across restarts;
  - `schema plan` with a pending migration changes nothing.
- **Types:** `tsc` catches a type error in a migration (wrong field name, wrong value type) against the generated types.
- **History sync:** `migrate history-sync` keeps the `@schema/` rows.
- **Upstream:** PocketBase v0.41.0 opens the data afterwards (differential test).

## Docs

- `docs/schema.md`: a "Migrations" section, with recipes for adding a required field and for renaming a field and a collection.
- `docs/design/14-schema.md`: the design.
- `docs/design/01-scope.md`: mark the items as built.
- `docs/operations.md`: `--schemaMigrationsDir`.

## Verification

- Run `bun run check`, then `bun run test:reference`, one after the other, in the foreground. Never detach a check with `&`.
- Database-layer change: put before/after startup numbers in `docs/perf/S.5-migrations.md`. Cover no pending migration, and one migration updating 10,000 records.
- The worker rules in `docs/design/12-work-plan.md` and the worker instructions in `docs/chief-of-staff.md` apply.
- Open a PR titled "S.5: TypeScript migrations and declared renames" against `develop`, with "Part of #80" in the body. Do not merge.
