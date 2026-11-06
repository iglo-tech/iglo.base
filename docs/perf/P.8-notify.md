# P.8 notify watcher: settings and collection save

The notify watcher adds one empty-file create and remove in `pb_data/.notify` to every settings save and every collection save (upstream does the same). This compares the save cost before and after.

## Setup

| | |
|---|---|
| Date | 2026-11-06 |
| Machine | AMD Ryzen 5 1600 (6 cores), 16 GiB RAM, Linux 6.12 (Debian 13), VM, ext4 on the repository's disk |
| Bun | 1.4.4 |
| Before | `origin/main` at the P.8 branch point, `bun run build` |
| After | `task/P.8-notify-watcher`, `bun run build` |

## Method

Release executable (`dist/iglo-base serve`) on a copy of the vendored fixture, one server at a time, run with `nice -n 10`. Over HTTP, one request at a time, as a superuser:

- **Settings save:** `PATCH /api/settings` changing `meta.appName`; 20 warm-up requests, then 300 timed.
- **Collection save:** `POST /api/collections` creating an empty base collection; 100 timed.

Three alternating before/after runs. Times are in milliseconds, per request, client side.

## Results

| Run | Settings save median before | after | p95 before | after | Collection create median before | after | p95 before | after |
|---|---|---|---|---|---|---|---|---|
| 1 | 1.83 | 2.10 | 5.06 | 8.71 | 39.35 | 40.91 | 70.03 | 77.19 |
| 2 | 2.45 | 3.18 | 10.71 | 9.12 | 47.20 | 48.76 | 107.44 | 85.13 |
| 3 | 2.99 | 2.35 | 8.35 | 8.28 | 50.94 | 50.68 | 88.47 | 92.68 |

The run-to-run spread (1.8 to 3.0 ms before, 39 to 51 ms for the collection create) is larger than the difference between before and after, and run 3 has the after side faster. The marker create and remove is two small syscalls on the main thread (well under 0.1 ms); a collection save is dominated by the schema change and the cache reload. No measurable cost is attributed to the watcher.

An idle server adds one `fs.watch` handle (non-persistent) and no timers. Another instance's save costs the receiving server one debounced reload: `reloadSettings` or `reloadCachedCollections`, the same work upstream does.
