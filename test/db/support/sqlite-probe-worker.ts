// A worker thread that reports its SQLite (test/db/sqlite-lib.test.ts).

import { sqliteInfo } from "@test/db/support/sqlite-probe";

postMessage(sqliteInfo());
