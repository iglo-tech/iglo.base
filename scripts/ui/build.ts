// Builds the vendored dashboard (ui/, docs/design/08-admin-ui.md) and packs
// its output into dist/ui.pack, which src/main.ts embeds in the executable
// (@/apis/ui-pack). Run by `bun run build` and by the test helper that
// compiles the executable.
//
// The dashboard is built with Vite under Bun (`bun install --frozen-lockfile`
// and `bun --bun run build` in ui/), with PB_VERSION set to the executable's
// version for the footer. A pack whose inputs (the ui/ sources, the lockfile
// and the version) are unchanged is not rebuilt.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { uiPackSource, writeUiPack } from "@/apis/ui-pack";
import { version } from "@/cli/root";

const repoRoot = resolve(import.meta.dir, "../..");
const uiDir = join(repoRoot, "ui");
const distDir = join(uiDir, "dist");
export const uiPackPath = join(repoRoot, "dist", "ui.pack");

function listFiles(dir: string, skip: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (skip(path)) {
      continue;
    }
    if (entry.isDirectory()) {
      out.push(...listFiles(path, skip));
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
  return out.toSorted();
}

function sourceHash(): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`version:${version}\n`);
  const skipped = new Set([join(uiDir, "node_modules"), distDir]);
  for (const path of listFiles(uiDir, (p) => skipped.has(p))) {
    hasher.update(`${relative(uiDir, path)}\n`);
    hasher.update(readFileSync(path));
  }
  return hasher.digest("hex");
}

async function exec(cmd: string[], env: Record<string, string> = {}): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd: uiDir,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${cmd.join(" ")} failed (exit ${code}):\n${stdout}${stderr}`);
  }
}

export async function buildUi(): Promise<void> {
  const source = sourceHash();
  if (existsSync(uiPackPath) && uiPackSource(readFileSync(uiPackPath)) === source) {
    return;
  }

  await exec([process.execPath, "install", "--frozen-lockfile"]);
  await exec([process.execPath, "--bun", "run", "build"], { PB_VERSION: version });

  const files = new Map<string, Uint8Array>();
  for (const path of listFiles(distDir, () => false)) {
    files.set(relative(distDir, path).replaceAll("\\", "/"), readFileSync(path));
  }
  if (!files.has("index.html")) {
    throw new Error("the dashboard build has no index.html");
  }

  mkdirSync(join(repoRoot, "dist"), { recursive: true });
  writeFileSync(uiPackPath, writeUiPack(source, files));
}

if (import.meta.main) {
  await buildUi();
}
