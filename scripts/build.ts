// Builds the dashboard pack and the compiled executable (dist/iglo-base).
// `IGLO_VERSION=0.1.0 bun run build` sets the version `--version` prints and
// the dashboard footer shows (the release workflow passes the tag without its
// leading "v"); without it the version is "(untracked)".
// `IGLO_TARGET=bun-linux-arm64 bun run build` cross-compiles for a Bun target
// (bun-linux-x64, bun-linux-arm64, bun-darwin-arm64; default: this host).
// A darwin executable embeds the SQLite library dist/libsqlite3.dylib (D34),
// which scripts/build-sqlite.ts builds on macOS, so only macOS builds it.

import { resolve } from "node:path";

import { prepareEmbeddedSQLite } from "@scripts/sqlite-embed";

const repoRoot = resolve(import.meta.dir, "..");
const version = process.env.IGLO_VERSION ?? "";
if (version !== "" && !/^\d+\.\d+\.\d+([-+][0-9A-Za-z.+-]+)?$/.test(version)) {
  console.error(`invalid IGLO_VERSION ${JSON.stringify(version)}`);
  process.exit(1);
}

const target = process.env.IGLO_TARGET ?? "";
if (target !== "" && !["bun-linux-x64", "bun-linux-arm64", "bun-darwin-arm64"].includes(target)) {
  console.error(`unsupported IGLO_TARGET ${JSON.stringify(target)}`);
  process.exit(1);
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd: repoRoot, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    process.exit(code);
  }
}

await prepareEmbeddedSQLite(target);
await run([process.execPath, "scripts/ui/build.ts"]);
await run([
  process.execPath,
  "build",
  "--compile",
  // bytecode of the bundle is stored in the executable, so the start does not
  // parse about 400 modules (P.3: start-up 290 to 137 ms); it needs ESM output
  "--bytecode",
  "--format=esm",
  ...(target === "" ? [] : [`--target=${target}`]),
  ...(version === "" ? [] : ["--define", `IGLO_VERSION=${JSON.stringify(version)}`]),
  "src/main.ts",
  "src/db/read-worker.ts",
  "src/files/thumb-worker.ts",
  "src/backups/backup-worker.ts",
  "src/logs/log-worker.ts",
  "--outfile",
  "dist/iglo-base",
]);
