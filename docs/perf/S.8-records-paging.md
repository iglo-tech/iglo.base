# S.8: records() in a migration, ids first, then pages

`records()` in a TypeScript migration (D40, S.5) used to read its matches with `OFFSET` pages: the first pass read every page of ids through the filter and the sort, and each page ran the whole query again. The S.8 review found that the cost grows faster than the number of rows (10 times the rows took 20 times as long on the PR head before this change). The fix (S.8 round 1) reads the matching ids in one query that selects only `id`, then reads the records by id in pages of 500, with the ids bound as one JSON array (`json_each`).

This note records the sorted iteration cost before and after, and against `main`, which has no paging: it loads every matching record in one query.

## Method

- Code: `main` (`ee95961`, the same `src/` as the PR's base), the PR head before this change (`20b1946`, "before"), and the branch after this change ("head"). Each is a compiled executable (`bun run build`) run on the same host (linux-x64, 2026-11-14).
- Data: one `pb_data` per size, with `posts { title text, grp number }`, 10,000 or 40,000 rows, written by a seed migration (`tx.create`) at the first start. Each measured run copies the seeded directory, so every run starts from the same files.
- Measurement: a pending migration `20261114000100_bench.ts` runs `tx.records("posts", { sort: "-grp" })` and then `tx.records("posts")`, times each loop with `performance.now()`, and throws with the times. `schema plan` runs the migration in its dry run and rolls it back, so the data does not change. The figure is the in-process time of the loop, not the process time.
- Runs: 7 runs per binary and size, interleaved (main, before, head in turn), so the binaries see the same host conditions. The host was shared with another session's `bun test` (about 110% CPU) during the runs, so the spread is wide. Both the median and the minimum are given.

## Results

Sorted iteration (`sort: "-grp"`), milliseconds, from the interleaved run that includes "before" (7 runs each):

| Rows | main median (min) | before median (min) | head median (min) | head vs main, median |
|---|---|---|---|---|
| 10,000 | 67.6 (59.0) | 356.4 (304.7) | 85.5 (73.3) | +26% |
| 40,000 | 179.5 (165.8) | 3,224.3 (3,155.3) | 313.8 (272.8) | +75% |

A second run of main and head, after the last change (a direct loop in place of `new Map(... .map(...))` for each page), on the same host:

| Rows | main median (min) | head median (min) | head vs main, median |
|---|---|---|---|
| 10,000 | 59.2 (53.9) | 89.7 (76.3) | +52% |
| 40,000 | 189.9 (183.9) | 307.2 (281.4) | +62% |

Unsorted iteration (`tx.records("posts")`), for reference: 10,000 rows, main 40.0 ms, head 59.2 ms; 40,000 rows, main 156.4 ms, head 269.4 ms (second run). The "before" column for unsorted, first run: 10,000 rows 200.1 ms, 40,000 rows 824.5 ms.

## Reading

- The change removes most of the superlinear cost: the before-to-head ratio is about 4x at 10,000 rows and 10x at 40,000 rows. The head still grows faster than `main` with the number of rows (3.7x from 10,000 to 40,000 in the first run, against 2.7x for `main`).
- The head is still slower than `main` on sorted iteration, by about 25% to 75% in the two runs. That misses the 20% bound in the S.8 brief.
- Where the time goes (one run, at 40,000 rows, with the same records, timed with `tx.sql` inside a migration, best of three): the sorted id query 27 ms; the full sorted read that `main` pays once, 34 ms; the 80 page reads by id, 56 ms. The head therefore does about 49 ms more SQL work than `main` before any record is built. Record construction and the `rowOf` step cost the same on both sides.
- Raw SQLite, outside the migration, on the same data: id-keyed page reads 55 ms and rowid-keyed page reads 39 ms at 40,000 rows, against 35 ms for the full sorted read. A rowid lookup would close part of the gap, but it needs a second path for views, which have no rowid. This is not implemented.
- The two runs disagree by about 25 points, mostly from the host load. Neither run meets the 20% bound.

## Open for the lead

The bound and the bounded memory conflict for this design: reading the ids first costs one more sorted scan than `main`, and that scan is most of the gap at 40,000 rows. Options, not decided here:

1. Accept the measured cost: sorted iteration about 25% to 75% slower than `main`, in exchange for memory that holds ids plus one page instead of every matching record.
2. Rowid pages for base collections (about 40 ms instead of 55 ms at 40,000 rows, raw), with the id path kept for views. Expected to bring the cost near the bound, not measured through dbx.
3. One sorted query for matches up to a size limit, as `main` does, and pages above it. Meets the bound for sets below the limit; the limit decides the memory use.
