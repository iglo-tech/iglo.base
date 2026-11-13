# S.3 schema apply at startup

`serve --schema <file>` applies the schema file before the server starts (D40). This measures what that costs at startup: the server with no `--schema`, with a file that equals the database (nothing changes), with a file that adds one field (a dry run, a pre-schema backup and the transaction), with a file that adds a constraint that checks all 10,000 records, and with a file that fails its record check (the restart-loop case). The baseline is the same server without `--schema`.

This is the second measurement of this path. The first (2026-11-12, `82150bb`) is superseded: the round-1 fixes changed the apply, so the apply now runs a dry run before the backup and checks the records in the dry run and in the transaction. The table below is the one to compare against, and later changes to `src/schema/apply.ts`, `src/schema/backup.ts` or the record check compare against it, measured the same way.

## Setup

| | |
|---|---|
| Date | 2026-11-13 |
| Machine | VM: 6 vCPUs (`nproc`), 16 GiB RAM, Linux 6.12 (Debian 13) |
| Bun | 1.4.4 |
| Binary | `bun build --compile --bytecode --format=esm` of `src/main.ts`, `src/db/read-worker.ts`, `src/files/thumb-worker.ts`, `src/backups/backup-worker.ts`, `src/logs/log-worker.ts` (the flags of `test/support/executable.ts`), 121,682,096 bytes, built from commit `caa597b` (the round-1 fixes; this document is the next commit). |
| Database | 26 collections: the 6 system collections (`_superusers`, `_externalAuths`, `_mfas`, `_otps`, `_authOrigins`, `users`) and 20 of ours: `items` (fields `title` text, `body` text, `qty` number, `flag` bool; 10,000 records) and `c01` to `c19` (fields `label` text, `count` number, `active` bool, `item` relation to `items`; no records). `pb_data` is 6,188 KiB (`du -sk`). The database was made again for this measurement through the API, so its data is not byte-identical to the 2026-11-12 base. |

## Method

The base database was created through the API of a setup server (not measured): a superuser made with `superuser upsert`, the collections with `POST /api/collections`, and the 10,000 records with single `POST /api/collections/items/records` requests, 8 in flight. The schema files come from `schema pull` run on the base database, and each was checked with `schema plan` on a copy:

- `schema-base.json`: the database's own schema (`schema plan`: "the schema is up to date").
- `schema-c.json`: `schema-base.json` plus a non-required text field `note` on `c01` (`schema plan`: `c01 (base) + note (text)`, "the schema would apply").
- `schema-d.json`: `schema-base.json` with `required: true` on `items.title` (`schema plan`: `items (base) ~ title: required`, "the schema would apply"; all 10,000 records are checked and pass).
- `schema-e.json`: `schema-base.json` with `max: 8` on `items.title` (`schema plan`: 9,000 records fail the check, "the schema would not apply").

Each measured run: `cp -a` of the base `pb_data` into a new directory (so each run starts from the same database), then `iglo-base serve --http 127.0.0.1:<port> --dir <copy>` (plus `--schema <file>` for cases b to e), started from the copy's directory. The port is an ephemeral port taken from the kernel and released before the start. The clock starts just before the spawn, and the run ends at the first `200` from `GET /api/health`, polled every 2 ms with `fetch`. For case (e) the run ends when the process exits (the start is refused). Then `SIGTERM` and wait for the exit. One server at a time. One unmeasured round came first, to warm the executable in the page cache. Five measured rounds per case, in the order a, b, c, d, e. Each run's copy was checked afterwards: cases (c) and (d) each left exactly one `pre-schema-*.zip` with its `.attrs` sidecar, case (e) and the others left none, and the change of case (d) was present afterwards (`schema plan` on a copy of a run then said "the schema is up to date").

Measurement script: a Bun script that builds the base database, writes the four schema files and runs the rounds (kept in the scratch directory, not in the repository). The raw rows are in its `results.json`.

## Results

Startup from spawn to `GET /api/health` 200 (or, for case e, from spawn to exit), in milliseconds, five runs per case.

| Case | `--schema` file | What the server does before listening | Median | Min | Max | Backups left |
|---|---|---|---|---|---|---|
| (a) | none | `up()` for pending migrations (none) | 88.1 | 81.3 | 99.8 | 0 |
| (b) | `schema-base.json` (equal) | read the file, describe and diff the 26 collections; stop: no dry run, no backup, no record check | 153.3 | 134.8 | 183.3 | 0 |
| (c) | `schema-c.json` (one field on `c01`) | (b) plus the dry run, the pre-schema backup, the transaction and the record check of `c01` (0 records) | 402.7 | 360.6 | 434.3 | 1 |
| (d) | `schema-d.json` (`required` on `items.title`) | (c) plus the record check of all 10,000 `items` records, in the dry run and again in the transaction | 443.2 | 425.2 | 468.2 | 1 |
| (e) | `schema-e.json` (`max: 8` on `items.title`, 9,000 records fail) | the dry run, which fails: the report is printed, the start exits with status 1; no backup | 295.5 | 269.2 | 321.2 | 0 |

The backup of this database is 1,231,552 bytes (the zip of a 6,188 KiB `pb_data`).

## What the numbers mean

- Case (a) is the baseline. Case (b) costs about 65 ms more than (a), with no change to apply: the file is read, the 26 collections are described and diffed. This is the same cost as the 2026-11-12 measurement (about 60 ms), and it has not been profiled.
- Case (c) costs about 250 ms more than (b). That is the dry run (the transaction, rolled back), the pre-schema backup (a 6 MB database compresses to 1.2 MB) and the transaction. The run does not time these apart, so the split is an inference from the design, not a measurement.
- Case (d) costs about 40 ms more than (c) at the medians. The record check of 10,000 records now runs twice on an apply that changes a constraint: once in the dry run and once in the transaction. The two medians are close and their ranges overlap, so five runs do not resolve the record check's cost. The 2026-11-12 measurement, which ran the check once, had 115 ms for the same 10,000 records. The machine's state differs between the two sessions (the baseline moved from 112 ms to 88 ms), so the two sessions are not compared directly. The linearity of the check in the number of records is the design's claim, not something this run tested at another size.
- Case (e) is the restart loop. A file that fails its check costs the dry run and nothing more: no backup is made, and the start exits with the report. Before the round-1 fix, each such start also made a full backup of `pb_data`, with no retention, so a restart loop filled the disk. This table does not re-measure that old behaviour.
- The medians are the figures to compare. The runs were not interleaved in this measurement; the ranges show the run-to-run noise (about 20 to 40 ms).

## Commands

```sh
bun build --compile --bytecode --format=esm src/main.ts src/db/read-worker.ts \
  src/files/thumb-worker.ts src/backups/backup-worker.ts src/logs/log-worker.ts \
  --outfile <scratch>/bin/iglo-base
iglo-base superuser upsert <email> <password> --dir <dir>/pb_data
iglo-base serve --http 127.0.0.1:<port> --dir <dir>/pb_data        # setup, then the API calls of the setup script
iglo-base schema pull --dir <base>/pb_data > schema-base.json
iglo-base schema plan --schema <file> --dir <copy>/pb_data
iglo-base serve --http 127.0.0.1:<port> --dir <copy>/pb_data [--schema <file>]   # measured
bun measure.ts setup
bun measure.ts measure 5
```

The scratch directory held the binary, the base database, the schema files, the run copies, the logs and the script. Its data directories were deleted after this document was written.
