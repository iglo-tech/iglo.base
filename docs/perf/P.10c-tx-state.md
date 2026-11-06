# P.10c transaction state guard

`TxExecutor` now also refuses statements when SQLite ended the transaction itself (`conn.inTransaction` is false while the transaction is not done), throwing `TxDoneError`. The check is one `sqlite3_get_autocommit` call per statement on the db hot path.

## Method

`nice -n 10 bun test/db/bench.ts` (see `docs/perf/M0.4-db-layer.md`), same machine and Bun (1.4.4) as the baseline, under the host's heavy-check lock. Other P.10 workers share the host, so numbers are noisy; the "outside a transaction" rows do not touch the changed code and show the noise level.

## Results (ops/s; before: 3 runs, after: 3 runs, run in the same session)

| Measurement | Before | After |
|---|---|---|
| Insert, inside one transaction | 134,839 / 146,030 / 141,562 | 153,016 / 136,914 / 157,385 |
| Select by id, inside one transaction | 98,405 / 97,600 / 131,219 | 107,197 / 137,605 / 116,781 |
| Insert, outside (unchanged code) | 40,071 / 39,853 / 38,175 | 41,646 / 31,952 / 27,413 |
| Select by id, outside (unchanged code) | 84,719 / 77,859 / 89,807 | 93,047 / 90,247 / 84,747 |

An earlier "after" series taken while the host was busy (load average above 4) showed every row, including the unchanged ones, about 25% lower; the final series is within the run-to-run spread of the baseline. No measurable cost.
