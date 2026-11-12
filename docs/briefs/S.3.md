# S.3 `schema plan` and applying the schema at startup

Written by the chief of staff on 2026-11-12. The spec is GitHub issue [#78](https://github.com/iglo-tech/iglo.base/issues/78) (`gh issue view 78`). Decision D40 ("Apply order" and the rules around it) and `docs/design/14-schema.md`, both on `develop`, are binding. Where the issue and D40 differ, D40 wins. **Base branch: `develop`.**

## Scope

- **Commands and flags:**
  - `serve --schema <file>` and `schema plan --schema <file>`, both with `--allow-data-loss`;
  - `--mode` and the development file watcher are S.6, and declared renames and TypeScript migrations are S.5. Build the apply so S.5 and S.6 plug in: steps 2 (renames) and 5 (TypeScript migrations) exist as steps that do nothing yet, and the apply is one function that takes the file text and options.
- **Apply order, exactly as D40 lists it:**
  - **Before the transaction:** read the file (S.2's reader) and compute the plan. If nothing would change and no migration is pending, stop: no backup and no record check.
  - **Backup:** made with the existing backups code to the configured backup storage as `pre-schema-<UTC time>.zip`. Refuse to start if it fails.
    - **Retention:** keep the 3 newest `pre-schema-*` backups and delete older ones after a successful apply. Write it down in the docs.
    - **Disk space:** a disk-space failure says how much space the backup needs.
  - **In one write transaction:** pending D23 JavaScript migrations, renames (none yet), dropping the affected SQL views (their `_collections` rows and ids stay), widen, TypeScript migrations (none yet), narrow (every collection except views), recreating the views and re-saving view collections with the file's query, rules and options, checking every record, then commit or roll back.
  - **Existing serve path:** with `--schema`, the JavaScript migrations that `serve` runs today are part of this transaction instead of their own run. Without `--schema`, `serve` is unchanged.
- **Saving.** Every collection change goes through the collection save path that the dashboard and the collections API use (validation, table sync, view handling, generated ids for new collections and fields). Never hand-written SQL on `_collections`. The stored result of an apply must equal what the dashboard produces for the same change.
  - **Indexes** are compared by definition, not by name (D40, `14-schema.md`). An existing index with the same definition keeps its name.
  - **Implied auth indexes** are restored by the save when missing, and kept under their names when present.
- **The record check** (step 8) uses the same field validation that the records API runs on save: required, select values, lengths and ranges, patterns, relation targets that exist, and the rest. Unique indexes are enforced by SQLite when created; a failure there is reported the same way. Only collections or fields the plan changed need checking, but every record of those. Say in the PR if you check more.
- **Data-loss guard.** Dropping a field or collection that holds data is refused without `--allow-data-loss`. The renames that will also allow it come in S.5. Count the rows that would be lost and show them in the plan.
- **Failure.** Roll back, print a report (the plan's format) to stderr, and exit nonzero. The database is left exactly as it was.
- **Restart loop.** The apply runs on every bootstrap in `runServeCommand`'s loop, so a restart after a restore re-applies the file (D40).
- **`schema plan` output:**
  - collections and fields added, changed and removed, rules, and indexes (with the row count of each new index's table);
  - the migrations that would run;
  - every problem the check finds, with counts, up to 5 example record ids, and the next step to take (see the issue's example).
  
  It runs the transaction and rolls back, and makes no backup. Its help text and the docs say that on a live database it holds the write lock while it runs.
- **Rules from D40 to keep in mind:** no network call inside the transaction (the backup comes before it); no secrets read from the file (token secrets and OAuth2 providers stay as the database has them); system collections are never dropped; a system collection left out of the file means upstream's default.

## Tests

All tests run through the CLI and the API on `mktemp -d` data:
- add, change and remove a collection and a field (base, auth and view), including rules, options and indexes;
- a failing record check rolls everything back (`pb_data` is byte-identical afterwards, apart from the backup);
- `plan` changes nothing;
- the data-loss guard refuses, and `--allow-data-loss` allows;
- nothing changes, so no backup is made and startup is fast;
- a backup failure refuses to start;
- the retention keeps 3;
- a pending JavaScript migration that creates a collection the file also lists (the adoption case in D40);
- an apply after a restore.

**Differential check.** Apply a file on iglo.base, make the same change through the collections API on upstream PocketBase v0.41.0, and compare `_collections` and `sqlite_schema` (ids aside, where they differ only by generation). Then open the applied data with the upstream binary. Put it in `test/differential/` so `test:reference` runs it.

## Measurements

Startup with and without `--schema`, on a database of about 20 collections and 10,000 records: unchanged schema, one added field, one new constraint that checks every record. Write the numbers to `docs/perf/S.3-apply.md` (AGENTS.md requires measurements for database-layer changes).

## Docs

- `docs/schema.md`: sections on `schema plan`, applying at startup, the backup and its retention, the data-loss guard, and what a failed apply does.
- `docs/operations.md`: `serve --schema`.
- `docs/design/14-schema.md`: the apply's design.
- `docs/design/01-scope.md`: mark the built items.

## Verification

- Run `bun run check`, then `bun run test:reference`, one after the other.
- The worker rules in `docs/design/12-work-plan.md` and the worker instructions in `docs/chief-of-staff.md` apply.
- Open a PR titled "S.3: schema plan and applying the schema at startup" against `develop`, with "Part of #78" in the body. Do not merge.
