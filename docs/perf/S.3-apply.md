# S.3 schema apply at startup

`serve --schema <file>` applies the schema file before the server starts (D40). This measures what that costs at startup: the server with no `--schema`, with a file that equals the database (nothing changes), with a file that adds one field (a pre-schema backup and the transaction), and with a file that adds a constraint that checks all 10,000 records. The baseline is the same server without `--schema`. This is the first measurement of this path, so there is no "before"; later changes to `src/schema/apply.ts`, `src/schema/backup.ts` or the record check compare against these numbers, measured the same way.

## Setup

| | |
|---|---|
| Date | 2026-11-12 |
| Machine | VM: 6 vCPUs (`nproc`), 16 GiB RAM (`MemTotal` 16,382,680 kB; about 8.7 GiB available at the start), Linux 6.12 (Debian 13) |
| Bun | 1.4.4 |
| Binary | `bun build --compile --bytecode --format=esm` of `src/main.ts`, `src/db/read-worker.ts`, `src/files/thumb-worker.ts`, `src/backups/backup-worker.ts`, `src/logs/log-worker.ts` (the flags of `test/support/executable.ts`), 121,665,712 bytes, built into the scratch directory. The worktree was at `82150bb` with uncommitted edits to `src/cli/schema.ts`, `docs/` and tests, which the executable includes; `src/cli/serve.ts`, `src/schema/apply.ts` and `src/schema/backup.ts` are unmodified. |
| Database | 26 collections: the 6 system collections (`_superusers`, `_externalAuths`, `_mfas`, `_otps`, `_authOrigins`, `users`) and 20 of ours: `items` (fields `title` text, `body` text, `qty` number, `flag` bool; 10,000 records) and `c01` to `c19` (fields `label` text, `count` number, `active` bool, `item` relation to `items`; no records). `pb_data` is 6,652 KiB (`du -sk`). |

## Method

The base database was created through the API of a setup server (not measured): a superuser made with `superuser upsert`, the collections with `POST /api/collections`, and the 10,000 records with single `POST /api/collections/items/records` requests, 8 in flight (`POST /api/batch` is off by default). The schema files come from `schema pull` run on a copy of the base database, and were checked with `schema plan` on copies:

- `schema-base.json`: the database's own schema (`schema plan`: "the schema is up to date").
- `schema-c.json`: `schema-base.json` plus a non-required text field `note` on `c01` (`schema plan`: `c01 (base) + note (text)`, "the schema would apply").
- `schema-d.json`: `schema-base.json` with `required: true` on `items.title` (`schema plan`: `items (base) ~ title: required`).

Each measured run: `cp -a` of the base `pb_data` into a new directory under the scratch directory (so each run starts from the same database and a case does not change the next one's input); then `iglo-base serve --http 127.0.0.1:<port> --dir <copy>` (plus `--schema <file>` for cases b to d), started from the copy's directory. The port is taken from 21000 upward, checked with `ss -ltn` before each start. The clock starts just before the spawn, and the run ends at the first `200` from `GET /api/health`, polled every 2 ms with `fetch`. The `Server started at` line was not used. Then `SIGTERM` and wait for the exit (all exits were code 0). One server at a time. One unmeasured run of the baseline came first, to warm the executable in the page cache. Cases ran in the order a, b, c, d, five runs each, and the table gives the median, minimum and maximum of those five. Each run's copy was checked afterwards: case b left no backup; cases c and d each left one `pre-schema-*.zip` (1.29 MB, plus its `.attrs` sidecar) and their changes were present (`schema plan` on the copy then said "up to date").

Measurement script: a Bun script (`measure.ts`) that spawns the server and polls with `fetch`; the supplementary runs used the same script with the cases interleaved. Raw rows are in `results.jsonl` in the scratch directory.

## Results

Startup from spawn to `GET /api/health` 200, in milliseconds, five runs per case.

| Case | `--schema` file | What the server does before listening | Median | Min | Max |
|---|---|---|---|---|---|
| (a) | none | `up()` for pending migrations (none) | 112.4 | 90.4 | 179.7 |
| (b) | `schema-base.json` (equal) | read the file, describe and diff the 26 collections; stop: no backup, no record check | 173.7 | 159.4 | 222.5 |
| (c) | `schema-c.json` (one field on `c01`) | (b) plus the pre-schema backup, the transaction, and the record check of `c01` (0 records) | 455.3 | 361.9 | 482.1 |
| (d) | `schema-d.json` (`required` on `items.title`) | (c) plus the record check of all 10,000 `items` records | 569.5 | 523.1 | 781.5 |

Supplementary runs, interleaved (five pairs each, to separate drift from cost):

| Comparison | Case | Median | Min | Max | Paired difference, median (range) |
|---|---|---|---|---|---|
| Baseline vs (b), session 1 | (a) | 114.8 | 101.3 | 145.4 | |
| | (b) | 204.3 | 149.9 | 244.5 | +87.8 (+5.3 to +143.2) |
| Baseline vs `--automigrate=false`, session 2 | (a) | 128.6 | 105.4 | 166.3 | |
| | `--automigrate=false`, no `--schema` | 109.4 | 93.6 | 156.7 | -10.7 (-40.3 to +14.7) |

Database size (`du -sk` of the copy's `pb_data`): 6,652 KiB before; 6,652 KiB after (a) and (b); 7,916 KiB after (c) and (d). The difference is the pre-schema backup zip.

## What the numbers mean

- The record check is linear in the records of the collection whose fields the apply added or changed, and it runs only for those. Case (d) minus case (c) is the check of 10,000 records: about +115 ms at the medians, roughly 11 µs per record. This is one size, so the linearity is the design's claim, not something this run tested at another size.
- The backup is linear in the size of `pb_data`. The backup of this 6.6 MB database compresses to 1.29 MB. Cases (c) and (d) both pay it, and it is most of the +280 ms that case (c) adds over (b). The run did not time the backup and the transaction apart, so that split is an inference from the design, not a measurement.
- Case (b) costs more than the baseline. This was not expected: with no change the apply only reads the file, describes the collections and diffs them. The interleaved pairs put the difference at about +90 ms (session 1), and `--automigrate=false` alone does not account for it (session 2: about -11 ms). The cause is in the schema read path (file parse, describe, diff, or first-use costs in those modules). It was not profiled.
- The grouped baseline was bimodal (the first two runs about 175 ms, the next three 90 to 110 ms), so its min and max are wide. The interleaved runs are the better comparison for (a) against (b); they show the same ordering.
- Startup on the record check is noisy (case d: 523 to 782 ms over five runs). The medians are the figures to compare.

## Commands

```sh
bun build --compile --bytecode --format=esm src/main.ts src/db/read-worker.ts \
  src/files/thumb-worker.ts src/backups/backup-worker.ts src/logs/log-worker.ts \
  --outfile <scratch>/bin/iglo-base
iglo-base superuser upsert <email> <password> --dir <dir>/pb_data
iglo-base serve --http 127.0.0.1:<port> --dir <dir>/pb_data        # setup, then the API calls of setup.ts
iglo-base schema pull --dir <copy>/pb_data > schema-base.json
iglo-base schema plan --schema <file> --dir <copy>/pb_data
iglo-base serve --http 127.0.0.1:<port> --dir <copy>/pb_data [--schema <file>]   # measured
bun measure.ts <runs dir>
```

The scratch directory held the binary, the base copy, the schema files, the run copies and the logs. Its data directories were deleted after this doc was written.
