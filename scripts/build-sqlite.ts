// Builds the SQLite library the darwin-arm64 executable embeds (D34):
// dist/libsqlite3.dylib, from the official GitHub mirror of the SQLite source
// (https://github.com/sqlite/sqlite) at the release tag below, with the
// compile options of the SQLite inside Bun on Linux
// (test/fixtures/sqlite-linux.json). macOS only (needs clang and tclsh).
//
//   bun scripts/build-sqlite.ts [outfile]      default dist/libsqlite3.dylib
//
// The tag is checked against its commit, so a moved tag fails the build.
// Bumping Bun may change the SQLite version or options on Linux: the test in
// test/db/sqlite-lib.test.ts then fails until this file and the fixture
// follow.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const tag = "version-3.53.4";
const commit = "b09c88c14082339b66c7b7158d609a771e64ca69";
const repository = "https://github.com/sqlite/sqlite";

// The options Bun's SQLite sets beyond SQLite's own defaults (the others in
// the fixture are defaults and appear in PRAGMA compile_options by
// themselves; passing them here could change them, for example
// DEFAULT_AUTOVACUUM without a value would define it as 1).
const defines: readonly string[] = [
  "SQLITE_ENABLE_COLUMN_METADATA",
  "SQLITE_ENABLE_DBSTAT_VTAB",
  "SQLITE_ENABLE_FTS3",
  "SQLITE_ENABLE_FTS3_PARENTHESIS",
  "SQLITE_ENABLE_FTS5",
  "SQLITE_ENABLE_GEOPOLY",
  "SQLITE_ENABLE_MATH_FUNCTIONS",
  "SQLITE_ENABLE_PERCENTILE",
  "SQLITE_ENABLE_PREUPDATE_HOOK",
  "SQLITE_ENABLE_RBU",
  "SQLITE_ENABLE_RTREE",
  "SQLITE_ENABLE_SESSION",
  "SQLITE_ENABLE_UPDATE_DELETE_LIMIT",
  "SQLITE_DEFAULT_RECURSIVE_TRIGGERS",
  "SQLITE_MAX_VARIABLE_NUMBER=250000",
  "SQLITE_THREADSAFE=1",
];

function run(cmd: string[], cwd: string): void {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) {
    console.error(`${cmd.join(" ")} failed with exit code ${proc.exitCode}`);
    process.exit(1);
  }
}

function output(cmd: string[], cwd: string): string {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "inherit" });
  if (proc.exitCode !== 0) {
    console.error(`${cmd.join(" ")} failed with exit code ${proc.exitCode}`);
    process.exit(1);
  }
  return proc.stdout.toString().trim();
}

if (process.platform !== "darwin") {
  console.error("build-sqlite.ts builds the macOS library and runs on macOS only");
  process.exit(1);
}

const outfile = resolve(process.argv[2] ?? join(repoRoot, "dist", "libsqlite3.dylib"));
mkdirSync(dirname(outfile), { recursive: true });
const work = mkdtempSync(join(tmpdir(), "iglo-sqlite-"));
try {
  const src = join(work, "sqlite");
  run(["git", "clone", "--quiet", "--depth", "1", "--branch", tag, repository, src], work);
  const head = output(["git", "rev-parse", "HEAD"], src);
  if (head !== commit) {
    console.error(`${tag} is ${head}, expected ${commit}`);
    process.exit(1);
  }
  run(["./configure", "--quiet"], src);
  run(["make", "sqlite3.c"], src);
  run(
    [
      "clang",
      "-dynamiclib",
      "-arch",
      "arm64",
      "-O2",
      "-install_name",
      "@rpath/libsqlite3.dylib",
      ...defines.map((d) => `-D${d}`),
      "-o",
      outfile,
      "sqlite3.c",
    ],
    src,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

// the result must report the fixture's version and options (COMPILER aside)
const fixture = JSON.parse(readFileSync(join(repoRoot, "test/fixtures/sqlite-linux.json"), "utf8"));
const probe = `
  import { Database } from "bun:sqlite";
  if (!Database.setCustomSQLite(process.env.PROBE_LIB)) throw new Error("setCustomSQLite returned false");
  const db = new Database(":memory:");
  const version = db.query("select sqlite_version() v").get().v;
  const options = db.query("pragma compile_options").all().map((r) => r.compile_options).filter((o) => !o.startsWith("COMPILER="));
  console.log(JSON.stringify({ version, options }));
`;
const got = JSON.parse(
  output(["env", `PROBE_LIB=${outfile}`, process.execPath, "-e", probe], repoRoot),
);
const missing = fixture.compileOptions.filter((o: string) => !got.options.includes(o));
const extra = got.options.filter((o: string) => !fixture.compileOptions.includes(o));
if (got.version !== fixture.version || missing.length > 0 || extra.length > 0) {
  console.error(
    `${outfile} differs from Bun's SQLite on Linux: version ${got.version} (want ${fixture.version}), missing ${JSON.stringify(missing)}, extra ${JSON.stringify(extra)}`,
  );
  process.exit(1);
}
console.log(
  `built ${outfile}: SQLite ${got.version}, ${got.options.length} compile options as on Linux`,
);
