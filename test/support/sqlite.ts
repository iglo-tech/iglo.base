// Preloaded by `bun test` (bunfig.toml), before any test file: on macOS the
// tests that open a database themselves (`new Database(...)`) must use the
// same bundled SQLite as the code under test, and Bun loads its SQLite once
// per process (D34). Nothing happens on other platforms.

import { loadSQLite } from "@/db/sqlite-lib";

loadSQLite();
