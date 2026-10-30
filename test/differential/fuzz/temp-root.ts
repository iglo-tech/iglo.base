// Preloaded by `bun run fuzz:filters`: every temporary directory of the run,
// including the compiled executable and the upstream binary's files, goes
// into one fresh root that is deleted on exit (as test/support/temp-root.ts
// does for `bun test`).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "iglo-base-fuzz-run-"));
process.env.TMPDIR = root;

process.on("exit", () => {
  rmSync(root, { recursive: true, force: true });
});
