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
import { dirname, join } from "node:path";

// a library built by scripts/build-sqlite.ts, for running from source
// (tests, development), where nothing is embedded; ignored by the executable
export const sqliteLibraryEnv = "IGLO_SQLITE_LIB";

// the SQLite release scripts/build-sqlite.ts builds (test/fixtures/sqlite-linux.json)
export const bundledSQLiteVersion = "3.53.4";

let loaded = false;

// Bun keeps one SQLite per process, so only the first thread to call
// `Database.setCustomSQLite` loads the library; a later call in a worker
// may fail or be refused. Every call therefore ends with a check that the
// SQLite in use is the bundled version, and that check decides.
export function loadSQLite(platform: string = process.platform): void {
  if (loaded || platform !== "darwin") {
    return;
  }
  const path = resolveLibrary();
  let problem = "Bun did not accept it";
  try {
    if (Database.setCustomSQLite(path)) {
      problem = "";
    }
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err);
  }
  const version = activeVersion();
  if (version !== bundledSQLiteVersion) {
    throw failure(`${path}: ${problem || "loaded"}, but SQLite ${version} is in use`);
  }
  loaded = true;
}

function activeVersion(): string {
  const db = new Database(":memory:");
  try {
    return (db.query("select sqlite_version() as v").get() as { v: string }).v;
  } finally {
    db.close();
  }
}

function failure(reason: string, cause?: unknown): Error {
  return new Error(
    `cannot load the bundled SQLite library (${reason}); iglo-base does not fall back to the system SQLite on macOS`,
    cause === undefined ? undefined : { cause },
  );
}

function resolveLibrary(): string {
  // the executable never reads the variable: it uses what it carries
  const compiled = Bun.main.startsWith("/$bunfs/");
  const fromEnv = compiled ? undefined : process.env[sqliteLibraryEnv];
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!existsSync(fromEnv)) {
      throw failure(`${sqliteLibraryEnv}=${fromEnv} does not exist`);
    }
    return fromEnv;
  }
  const embedded = (Bun.embeddedFiles as readonly { name?: string }[]).find((f) =>
    /^libsqlite3.*\.dylib$/.test(f.name ?? ""),
  );
  if (embedded?.name === undefined) {
    throw failure(
      `this build has none embedded; build one with scripts/build-sqlite.ts and set ${sqliteLibraryEnv}`,
    );
  }
  return extractLibrary(join(dirname(Bun.main), embedded.name));
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
