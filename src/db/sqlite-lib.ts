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

// Bun keeps one SQLite per process, and a second `setCustomSQLite` call in a
// worker may fail or be refused. The thread that loaded the library leaves
// this variable (process id and path); a worker copies the environment when it
// starts and then has nothing left to load. The process id keeps a child
// process, which inherits the variable but not the loaded library, from
// trusting it.
const loadedEnv = "IGLO_SQLITE_LOADED";

let loaded = false;

// `first` is true for the main thread's call at start-up: Bun keeps one
// SQLite per process, so a worker's call may be answered with false because
// the main thread loaded the library already; only the first call must
// get true.
export function loadSQLite(first = false, platform: string = process.platform): void {
  if (loaded || platform !== "darwin") {
    return;
  }
  if (process.env[loadedEnv]?.startsWith(`${process.pid}:`)) {
    loaded = true;
    return;
  }
  const path = resolveLibrary();
  let result: boolean;
  try {
    result = Database.setCustomSQLite(path);
  } catch (err) {
    if (!first && err instanceof Error && /already|twice/i.test(err.message)) {
      loaded = true;
      return;
    }
    throw failure(`${path}: ${err instanceof Error ? err.message : String(err)}`, err);
  }
  if (!result && first) {
    throw failure(`${path}: Bun did not accept it`);
  }
  process.env[loadedEnv] = `${process.pid}:${path}`;
  loaded = true;
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
