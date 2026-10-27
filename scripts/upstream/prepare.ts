// Prepares the reference tools pinned in test/differential/upstream.lock under
// .upstream/ (git-ignored): the PocketBase v0.41.0 source checkout at the
// pinned commit, and the host's pocketbase, Mailpit and versitygw binaries.
//
// Every archive is checked against its lock SHA-256 before it is unpacked. A
// mismatch removes the archive and fails, so no tool is left half-prepared.
// A second run with everything present downloads nothing.
//
// Usage: bun run upstream:prepare [--dir <upstream dir>] [--lock <lock file>]

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";

import {
  defaultLayout,
  defaultLockPath,
  hostPlatform,
  layoutFor,
  readLock,
  type Layout,
  type PlatformEntry,
  type Tool,
} from "@test/support/reference-tools";

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    lock: { type: "string" },
  },
  strict: true,
});

async function main(): Promise<void> {
  const layout = values.dir ? layoutFor(resolve(values.dir)) : defaultLayout;
  const lockPath = values.lock ? resolve(values.lock) : defaultLockPath;
  const lock = readLock(lockPath);
  const platform = hostPlatform();

  // checked before anything is written, so an unsupported host changes nothing
  const pick = (
    tool: Tool,
    tracked: { downloadBase: string; platforms: Record<string, PlatformEntry> },
  ) => {
    const entry = tracked.platforms[platform];
    if (!entry) {
      throw new Error(`${tool} has no ${platform} archive in ${lockPath}`);
    }
    return { tool, downloadBase: tracked.downloadBase, entry };
  };
  const tools = [
    pick("pocketbase", lock.upstream),
    pick("mailpit", lock.mailpit),
    pick("versitygw", lock.versitygw),
  ];

  // staging for unpacking and the source fetch; a killed run leaves it behind
  // until the next run, which removes it first
  const staging = join(layout.upstreamDir, "tmp");
  mkdirSync(layout.upstreamDir, { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  try {
    await prepareSource(lock.upstream.repository, lock.upstream.tag, lock.upstream.commit, layout);
    for (const { tool, downloadBase, entry } of tools) {
      await prepareTool(tool, downloadBase, entry, layout);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function prepareSource(
  repository: string,
  tag: string,
  commit: string,
  layout: Layout,
): Promise<void> {
  const target = layout.sourceDir;
  if (existsSync(target)) {
    const head = await git(["rev-parse", "HEAD"], target).catch(() => "");
    if (head === commit) {
      console.log(`source: present at ${commit}`);
      return;
    }
    console.log("source: checkout is not at the pinned commit; fetching again");
    rmSync(target, { recursive: true, force: true });
  }

  const staging = join(layout.upstreamDir, "tmp", "source");
  mkdirSync(staging, { recursive: true });
  try {
    console.log(`source: fetching ${repository} ${tag}`);
    await git(["init", "--quiet"], staging);
    await git(["fetch", "--quiet", "--depth", "1", repository, `refs/tags/${tag}`], staging);
    await git(["checkout", "--quiet", "--detach", "FETCH_HEAD"], staging);
    const head = await git(["rev-parse", "HEAD"], staging);
    if (head !== commit) {
      throw new Error(`source: ${tag} is at ${head}, but the lock pins ${commit}`);
    }
    renameSync(staging, target);
    console.log(`source: ready at ${commit}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function prepareTool(
  tool: Tool,
  downloadBase: string,
  entry: PlatformEntry,
  layout: Layout,
): Promise<void> {
  const binary = layout.toolPath(tool);
  // the archive hash this binary was unpacked from; a changed lock replaces it
  const stamp = join(layout.binDir, `${tool}.sha256`);
  if (
    existsSync(binary) &&
    existsSync(stamp) &&
    readFileSync(stamp, "utf8").trim() === entry.sha256
  ) {
    console.log(`${tool}: present`);
    return;
  }

  const archive = await fetchArchive(tool, downloadBase, entry, layout);
  const staging = join(layout.upstreamDir, "tmp", tool);
  mkdirSync(staging, { recursive: true });
  try {
    await unpack(archive, staging);
    const extracted = join(staging, entry.binaryPath);
    if (!existsSync(extracted)) {
      throw new Error(`${entry.archive} does not contain ${entry.binaryPath}`);
    }
    chmodSync(extracted, 0o755);
    mkdirSync(layout.binDir, { recursive: true });
    rmSync(stamp, { force: true });
    renameSync(extracted, binary);
    writeFileSync(stamp, `${entry.sha256}\n`);
    console.log(`${tool}: ready at ${binary}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// Returns the path of a verified archive, downloading it only when it is not
// already in the archive directory with the locked hash.
async function fetchArchive(
  tool: Tool,
  downloadBase: string,
  entry: PlatformEntry,
  layout: Layout,
): Promise<string> {
  mkdirSync(layout.archiveDir, { recursive: true });
  const path = join(layout.archiveDir, entry.archive);
  if (existsSync(path)) {
    if ((await sha256(path)) === entry.sha256) {
      return path;
    }
    console.log(`${tool}: cached ${entry.archive} does not match the lock; downloading again`);
    rmSync(path, { force: true });
  }

  const url = `${downloadBase}/${entry.archive}`;
  console.log(`${tool}: downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  }
  const partial = `${path}.partial`;
  try {
    await Bun.write(partial, response);
    const actual = await sha256(partial);
    if (actual !== entry.sha256) {
      throw new Error(
        `SHA-256 mismatch for ${entry.archive} from ${url}: the lock pins ${entry.sha256}, the download is ${actual}. Nothing was unpacked; check the lock or the release before updating it.`,
      );
    }
    renameSync(partial, path);
  } finally {
    rmSync(partial, { force: true });
  }
  return path;
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).bytes());
  return hasher.digest("hex");
}

async function unpack(archive: string, destination: string): Promise<void> {
  const command = archive.endsWith(".zip")
    ? ["unzip", "-q", archive, "-d", destination]
    : ["tar", "-xzf", archive, "-C", destination];
  await run(command, `unpacking ${archive}`);
}

async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
  }
  return stdout.trim();
}

async function run(command: string[], what: string): Promise<void> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    throw new Error(`${what} failed: ${stderr.trim()}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `upstream:prepare failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
