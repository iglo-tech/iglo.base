// Preloaded by `bun test` (bunfig.toml). Every temporary directory of one test
// run, including the compiled executable and the upstream binary's files,
// goes into one fresh root that is deleted after the last test file.

import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "iglo-base-run-"));
process.env.TMPDIR = root;

// a global hook: in a preload file it runs once, after every test file
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
