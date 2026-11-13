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

## Checks that were run

- `test/cli/schema-migrations.test.ts` (17 tests through the executable and the API), and `test/differential/schema/migrations.test.ts` (upstream v0.41.0 on the data).
- The benchmark script was a scratch script outside the repository; its method is the one above.
