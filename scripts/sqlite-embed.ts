// Makes sure dist/libsqlite3.dylib exists before an executable is compiled:
// src/main.ts embeds it (D34). On macOS it is the real library, built by
// scripts/build-sqlite.ts if missing; on other hosts it is an empty
// placeholder, which only a darwin target must not get.

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const sqliteLibraryPath = join(resolve(import.meta.dir, ".."), "dist", "libsqlite3.dylib");

// `target` is a Bun compile target ("" for the host)
export async function prepareEmbeddedSQLite(target: string): Promise<void> {
  const darwinTarget =
    target === "" ? process.platform === "darwin" : target.startsWith("bun-darwin");
  // rebuilt when missing, empty or older than the build script (a changed
  // define must not embed a stale library)
  const buildScript = join(import.meta.dir, "build-sqlite.ts");
  const stale =
    !existsSync(sqliteLibraryPath) ||
    statSync(sqliteLibraryPath).size === 0 ||
    (darwinTarget &&
      process.platform === "darwin" &&
      statSync(sqliteLibraryPath).mtimeMs < statSync(buildScript).mtimeMs);
  if (darwinTarget && stale) {
    if (process.platform !== "darwin") {
      console.error(
        `a darwin executable embeds ${sqliteLibraryPath}, which only macOS can build (bun scripts/build-sqlite.ts)`,
      );
      process.exit(1);
    }
    const proc = Bun.spawn([process.execPath, buildScript, sqliteLibraryPath], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await proc.exited) !== 0) {
      process.exit(1);
    }
  }
  if (!existsSync(sqliteLibraryPath)) {
    mkdirSync(dirname(sqliteLibraryPath), { recursive: true });
    writeFileSync(sqliteLibraryPath, "");
  }
}
