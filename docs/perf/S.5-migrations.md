# S.5: startup with TypeScript migrations

The apply (`serve --schema`) now checks the pending TypeScript migrations and runs their `up(tx)` inside the apply transaction (D40, S.5). This note records the startup time before and after, for the two cases the brief names: no pending migration, and one migration that updates 10,000 records.

## Method

- Code: `origin/develop` (before, S.4 merged) and this branch (after), both run from source with `bun src/main.ts --dev=false`, on the same host (linux-x64, 2026-11-13). `--dev=false` turns off the SQL log that dev mode prints.
- Data: one `pb_data` with the schema `posts { title text required, writer text }` and 10,000 rows, made by the develop build and copied for every run, so each run starts from the same files.
- Startup: the time from spawning `serve --schema` to the `Server started at` line. Each figure is the median of the runs listed (milliseconds).
- "No pending migration": the file matches the database and no `migrations/` file is pending. The start makes no backup and no record check.
- "One migration updating 10,000 records": the file matches the database, and one pending migration `20261113200000_bulk.ts` updates the title of every record through `tx.update`. The start makes a dry run, then the backup, then the apply transaction, which runs the migration again.

## Results

| Case | Code | Runs (ms) | Median (ms) |
|---|---|---|---|
| No pending migration | develop (before) | 254, 256, 267, 300, 330 | 267 |
| No pending migration | this branch (after) | 261, 273, 278, 295, 308 | 278 |
| One migration, 10,000 records updated | this branch (after) | 1742, 1781, 1869 | 1781 |

Before: develop cannot run TypeScript migrations, so there is no before figure for the migration case.

## Reading

- Without a pending migration, the two ranges overlap (develop 254–330 ms, this branch 261–308 ms), so the start costs the same within run-to-run noise. The start reads no record when nothing changes.
- The migration case runs the 10,000 updates twice: once in the dry run, which is rolled back, and once in the apply transaction. The passes were not timed separately; the difference from the no-migration start (about 1.5 s) covers both passes, the backup of the 10,000-row database (a 215 KB zip) and the save path's work. The dry run is what lets a failing file make no backup (D40, amended 2026-11-13); that cost is paid only when a migration is pending.
- After the start, all 10,000 titles had the new value and one `@schema/20261113200000_bulk.ts` row was present. Each start added one `pre-schema-*` backup; the 10 KB zip in the run directories is the empty-database backup from making the base copy.

## Rename apply (review round 1)

Round 1 of the review changed the rename step: with any pending rename, every stored rule of the non-view collections is cleared and every index except the implied auth ones is dropped, then the renames run, and the file sets the rules and indexes again (D40, amended 2026-11-14). This measures what that costs on the 10,000-record database. There is no "before" column: the comparison that matters is with a start that has nothing pending.

### Method

- Code: this branch, run from source with `bun src/main.ts serve --schema … --dev=false` on the same host (linux-x64, 2026-11-14). Each figure is the time from spawning the server to the `Server started at` line, the median of 5 starts; each start runs on a fresh copy of the same data directory.
- Data: `posts` with 10,000 rows (`title`, `writer`), written straight into `data.db` after a first start had made the table. Two base directories: one with an index on `title`, one with indexes on `title` and `writer`.
- Cases:
  - "No pending migration": the file matches the database, and there is no migration file.
  - "Rename, field not indexed": `writer` is renamed to `author` by `20261114120000_rename_writer.ts`. The index on `title` is dropped and built again with the other cleared indexes.
  - "Rename, field indexed": the same rename, with an index on `writer` that the apply drops and builds again as an index on `author`.
- A start with a rename makes a dry run, then the backup, then the apply transaction (D40, amended 2026-11-13), so the rename runs twice and the backup is made once.
- The benchmark script is a scratch file outside the repository; its method is the one above.

### Results

| Case | Runs (ms) | Median (ms) |
|---|---|---|
| No pending migration | 287, 257, 263, 265, 269 | 264 |
| Rename, field not indexed | 470, 441, 450, 432, 443 | 443 |
| Rename, field indexed | 481, 514, 474, 435, 473 | 474 |

After each rename start the table had the `author` column, all 10,000 rows, and one `@schema/20261114120000_rename_writer.ts` row.

### Reading

- A rename start costs about 180 ms more than a start with nothing pending, at 10,000 rows. The total covers the dry run, the backup, the clearing, the renames and the index rebuilds; this run did not time those parts separately.
- Indexing the renamed field adds about 30 ms (474 against 443): the one index that the rename drops and builds again. The index rebuild grows with the rows, so a collection with millions of rows pays for each index it has in a rename apply. That cost is the price of clearing every index instead of finding the ones that name the renamed field.
- The record check reads records only for fields whose constraints change; a rename changes no constraint, so the check adds nothing to these figures.

## Checks that were run

- `test/cli/schema-migrations.test.ts` (29 tests through the executable and the API: every reference form the review listed, the file-by-file chains, a helper's record with its hidden fields and email, and the type check of a rename to a hidden field), and `test/differential/schema/migrations.test.ts` (upstream v0.41.0 on the data).
- The benchmark script was a scratch script outside the repository; its method is the one above.
