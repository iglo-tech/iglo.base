// Layout of the reference tools that scripts/upstream/prepare.ts downloads
// and verifies from test/differential/upstream.lock. Everything lives under
// .upstream/ at the repository root, which is git-ignored:
//
//   .upstream/pocketbase/        PocketBase v0.41.0 source checkout (read only)
//   .upstream/bin/<tool>         host binaries: pocketbase, mailpit, versitygw
//   .upstream/archives/          downloaded archives, kept for the next run

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type Tool = "pocketbase" | "mailpit" | "versitygw";

export interface Layout {
  upstreamDir: string;
  sourceDir: string;
  binDir: string;
  archiveDir: string;
  toolPath(tool: Tool): string;
}

export function layoutFor(upstreamDir: string): Layout {
  const binDir = join(upstreamDir, "bin");
  return {
    upstreamDir,
    sourceDir: join(upstreamDir, "pocketbase"),
    binDir,
    archiveDir: join(upstreamDir, "archives"),
    toolPath: (tool) => join(binDir, tool),
  };
}

export const repoRoot = resolve(import.meta.dir, "../..");
export const defaultLayout = layoutFor(join(repoRoot, ".upstream"));
export const defaultLockPath = join(repoRoot, "test/differential/upstream.lock");

export interface PlatformEntry {
  archive: string;
  sha256: string;
  // path of the executable inside the archive
  binaryPath: string;
}

export interface Lock {
  upstream: {
    repository: string;
    tag: string;
    commit: string;
    downloadBase: string;
    platforms: Record<string, PlatformEntry>;
  };
  mailpit: ToolLock;
  versitygw: ToolLock;
}

export interface ToolLock {
  version: string;
  repository: string;
  downloadBase: string;
  platforms: Record<string, PlatformEntry>;
}

export function readLock(path = defaultLockPath): Lock {
  return JSON.parse(readFileSync(path, "utf8")) as Lock;
}

// "linux-x64", "linux-arm64" or "darwin-arm64" for this host (D18); other
// hosts are not in the lock and are rejected by the prepare command.
export function hostPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

// Throws a message that names the prepare command when the tool is missing.
export function requireTool(tool: Tool, layout = defaultLayout): string {
  const path = layout.toolPath(tool);
  if (!existsSync(path)) {
    throw new Error(`${tool} not found at ${path}; run \`bun run upstream:prepare\` first`);
  }
  return path;
}
