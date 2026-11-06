// No upstream counterpart (upstream links its SQLite driver statically).
//
// On macOS `bun:sqlite` loads the system libsqlite3.dylib, whose version and
// compile options depend on the macOS version. The darwin release executable
// instead carries a SQLite built from the same release tag and with the same
// compile options as the SQLite inside Bun on Linux (scripts/build-sqlite.ts,
// D34). This module writes it to a private cache directory on first use and
// points `Database.setCustomSQLite` at it. It must run before the first
// `new Database(...)` in every entry point and worker; `loadSQLite()` is
// idempotent per thread. There is no fallback to the system SQLite: if the
// library cannot be loaded, the process fails with a message that says so.
//
// Elsewhere (Linux) SQLite is compiled into Bun and this does nothing.

import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// a library built by scripts/build-sqlite.ts, for running from source
// (tests, development), where nothing is embedded; ignored by the executable
export const sqliteLibraryEnv = "IGLO_SQLITE_LIB";

// the SQLite release scripts/build-sqlite.ts builds (test/fixtures/sqlite-linux.json)
export const bundledSQLiteVersion = "3.53.4";

// the hash of that release's source, the end of sqlite_source_id(); a system
// SQLite of the same version has another one
export const bundledSQLiteSourceHash =
  "bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc";

let loaded = false;

// Bun keeps one SQLite per process, so only the first thread to call
// `Database.setCustomSQLite` loads the library; a later call in a worker
// may fail or be refused. Every call therefore ends with a check that the
// SQLite in use is the bundled release (version and source hash), and that
// check decides.
// `embeddedPath` is the embedded library's path when the caller knows it
// (src/main.ts imports it); threads that cannot import it look it up.
export function loadSQLite(embeddedPath?: string): void {
  if (loaded || process.platform !== "darwin") {
    return;
  }
  // Nothing may open a database before setCustomSQLite: that would load the
  // system SQLite. But when the library cannot be written (a full disk, a
  // cache macOS purged) and an earlier thread has loaded it already, Bun's
  // SQLite is the bundled one and no file is needed.
  let path: string;
  try {
    path = resolveLibrary(embeddedPath);
  } catch (err) {
    if (isBundled()) {
      loaded = true;
      return;
    }
    throw err;
  }
  let problem = "Bun did not accept it";
  try {
    if (Database.setCustomSQLite(path)) {
      problem = "";
    }
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err);
  }
  if (!isBundled()) {
    throw failure(`${path}: ${problem || "loaded"}, but ${activeSQLite()} is in use`);
  }
  loaded = true;
}

function activeSQLite(): string {
  const db = new Database(":memory:");
  try {
    const row = db.query("select sqlite_version() as v, sqlite_source_id() as s").get() as {
      v: string;
      s: string;
    };
    return `SQLite ${row.v} (${row.s})`;
  } finally {
    db.close();
  }
}

// the version and the source hash are both the bundled release's
function isBundled(): boolean {
  const active = activeSQLite();
  return (
    active.startsWith(`SQLite ${bundledSQLiteVersion} (`) &&
    active.endsWith(` ${bundledSQLiteSourceHash})`)
  );
}

function failure(reason: string, cause?: unknown): Error {
  return new Error(
    `cannot load the bundled SQLite library (${reason}); iglo-base does not fall back to the system SQLite on macOS`,
    cause === undefined ? undefined : { cause },
  );
}

function resolveLibrary(embeddedPath: string | undefined): string {
  // the executable never reads the variable: it uses what it carries
  const compiled = Bun.main.startsWith("/$bunfs/");
  const fromEnv = compiled ? undefined : process.env[sqliteLibraryEnv];
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!existsSync(fromEnv)) {
      throw failure(`${sqliteLibraryEnv}=${fromEnv} does not exist`);
    }
    return fromEnv;
  }
  if (embeddedPath !== undefined) {
    return extractLibrary(embeddedPath);
  }
  const embedded = (Bun.embeddedFiles as readonly { name?: string }[]).find((f) =>
    /^libsqlite3.*\.dylib$/.test(f.name ?? ""),
  );
  if (embedded?.name === undefined) {
    throw failure(
      `this build has none embedded; build one with scripts/build-sqlite.ts and set ${sqliteLibraryEnv}`,
    );
  }
  // embedded files sit in the root of the executable's virtual file system,
  // whichever module (a worker is nested) asks
  return extractLibrary(join("/$bunfs/root", embedded.name));
}

// Writes the embedded library (a file in the executable's virtual file system)
// to <cache>/iglo-base/sqlite/libsqlite3-<SHA-256 prefix>.dylib and returns
// the path. An existing file is used only if its content hashes the same; the
// directory must belong to the current user and not be writable by others.
function extractLibrary(embeddedPath: string): string {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(embeddedPath);
  } catch (err) {
    throw failure("the embedded copy cannot be read", err);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), "Library", "Caches");
  const dir = join(cache, "iglo-base", "sqlite");
  const target = join(dir, `libsqlite3-${digest.slice(0, 16)}.dylib`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o022) !== 0) {
      throw new Error(`${dir} is not a private directory of the current user`);
    }
    if (
      existsSync(target) &&
      createHash("sha256").update(readFileSync(target)).digest("hex") === digest
    ) {
      return target;
    }
    const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temp, bytes, { mode: 0o755 });
    renameSync(temp, target);
  } catch (err) {
    throw failure(
      `cannot write ${target}: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  return target;
}
