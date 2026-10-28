# Upstream test fixture

A byte-for-byte copy of PocketBase's `tests/data` directory at v0.41.0, commit `f6baa0c43f379de21cd806de97ad6a2b8ca97b83` (https://ganigeorgiev.com/git/pocketbase/pocketbase, MIT, see `LICENSE`). It is upstream's test data, not production data. The tokens in the scenarios (`test/scenarios/`) belong to its users and superusers.

Everything here except this README is upstream's. Tests only ever use copies (`test/scenarios/fixture.ts`); never open these files directly, because SQLite would add `-shm` and `-wal` files next to them. `bun run test:reference` checks that the directory still matches `.upstream/pocketbase/tests/data` (`test/differential/harness/vendored-fixture.test.ts`).
