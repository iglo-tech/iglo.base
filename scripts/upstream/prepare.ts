// Prepares the reference tools pinned in test/differential/upstream.lock under
// .upstream/ (git-ignored): the PocketBase v0.41.0 source checkout at the
// pinned commit, and the host's pocketbase, Mailpit and versitygw binaries.
//
// Every archive is checked against its lock SHA-256 before it is unpacked. A
// mismatch removes the archive and fails, so no tool is left half-prepared.
// A second run with everything present downloads nothing.
//
// Without --dir, .upstream is a symlink to a cache shared by every checkout
// on the host ($IGLO_UPSTREAM_CACHE, default ~/.cache/iglo-base/upstream),
// in a directory named after the lock file's hash, so worktrees do not each
// keep their own copy and a changed lock gets its own directory. A real
// .upstream directory from an older checkout is used as it is. Runs that
// prepare the same cache at once each stage in their own directory and move
// finished files into place.
//
// Usage: bun run upstream:prepare [--dir <upstream dir>] [--lock <lock file>]

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { dirname, join, resolve } from "node:path";

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
  const lockPath = values.lock ? resolve(values.lock) : defaultLockPath;
  // the run works in the concrete cache directory, never through the
  // .upstream symlink, which a run with another lock may repoint meanwhile
  const layout = values.dir
    ? layoutFor(concreteDir(resolve(values.dir)))
    : layoutFor(linkSharedCache(defaultLayout.upstreamDir, lockPath));
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

  // this run's staging for unpacking and the source fetch; staging left by a
  // killed run is removed by the next run
  mkdirSync(layout.upstreamDir, { recursive: true });
  removeStaleStaging(layout);
  if (!values.dir) {
    removeDeadRunFiles(dirname(defaultLayout.upstreamDir), /^\.upstream\.(\d+)$/);
  }
  const staging = join(layout.upstreamDir, `tmp-${process.pid}`);
  try {
    await prepareSource(
      lock.upstream.repository,
      lock.upstream.tag,
      lock.upstream.commit,
      layout,
      staging,
    );
    for (const { tool, downloadBase, entry } of tools) {
      await prepareTool(tool, downloadBase, entry, layout, staging);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// the directory with every symlink in its path resolved, created if missing,
// so a link replaced later cannot redirect this run's writes
function concreteDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

// Points the default .upstream at the shared cache directory for this lock
// and returns that directory (or .upstream itself when it is a real one).
function linkSharedCache(upstreamDir: string, lockPath: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(readFileSync(lockPath));
  const cacheRoot =
    process.env.IGLO_UPSTREAM_CACHE ?? join(homedir(), ".cache", "iglo-base", "upstream");
  const target = join(cacheRoot, hasher.digest("hex").slice(0, 16));
  mkdirSync(target, { recursive: true });

  let current: string | undefined;
  try {
    const stat = lstatSync(upstreamDir);
    if (!stat.isSymbolicLink()) {
      console.log(`.upstream: using the existing directory ${upstreamDir}`);
      return upstreamDir;
    }
    current = readlinkSync(upstreamDir);
  } catch {
    // no .upstream yet
  }
  if (current === target) {
    return target;
  }
  // replaced through a temporary link, so readers never see it missing
  const link = `${upstreamDir}.${process.pid}`;
  rmSync(link, { force: true });
  symlinkSync(target, link);
  renameSync(link, upstreamDir);
  console.log(`.upstream: linked to the shared cache ${target}`);
  return target;
}

// Removes what runs that are no longer alive left behind: tmp-<pid> staging
// directories, <archive>.<pid>.partial downloads and <tool>.sha256.<pid>
// stamps.
function removeStaleStaging(layout: Layout): void {
  removeDeadRunFiles(layout.upstreamDir, /^tmp(?:-(\d+))?$/);
  removeDeadRunFiles(layout.archiveDir, /\.(\d+)\.partial$/);
  removeDeadRunFiles(layout.binDir, /\.sha256\.(\d+)$/);
}

// Removes the entries of dir whose name matches pattern and whose captured
// pid is not a live process other than this one (no pid: always stale).
function removeDeadRunFiles(dir: string, pattern: RegExp): void {
  if (!existsSync(dir)) {
    return;
  }
  for (const name of readdirSync(dir)) {
    const match = pattern.exec(name);
    if (!match) {
      continue;
    }
    const pid = match[1] ? Number(match[1]) : undefined;
    if (pid !== undefined && pid !== process.pid && isAlive(pid)) {
      continue;
    }
    rmSync(join(dir, name), { recursive: true, force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function prepareSource(
  repository: string,
  tag: string,
  commit: string,
  layout: Layout,
  stagingRoot: string,
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

  const staging = join(stagingRoot, "source");
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
    try {
      renameSync(staging, target);
    } catch (error) {
      // another run moved its checkout into place first
      if ((await git(["rev-parse", "HEAD"], target).catch(() => "")) !== commit) {
        throw error;
      }
    }
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
  stagingRoot: string,
): Promise<void> {
  const binary = layout.toolPath(tool);
  // the archive hash this binary was unpacked from; a changed lock replaces it
  const stamp = join(layout.binDir, `${tool}.sha256`);
  if (existsSync(binary) && readStamp(stamp) === entry.sha256) {
    console.log(`${tool}: present`);
    return;
  }

  const archive = await fetchArchive(tool, downloadBase, entry, layout);
  const staging = join(stagingRoot, tool);
  mkdirSync(staging, { recursive: true });
  try {
    await unpack(archive, staging);
    const extracted = join(staging, entry.binaryPath);
    if (!existsSync(extracted)) {
      throw new Error(`${entry.archive} does not contain ${entry.binaryPath}`);
    }
    chmodSync(extracted, 0o755);
    mkdirSync(layout.binDir, { recursive: true });
    // the old stamp goes first, so a run that fails before the new stamp is
    // written leaves the binary unstamped (a cache miss), never stamped with
    // the old hash; a concurrent reader treats the missing stamp as a miss
    rmSync(stamp, { force: true });
    renameSync(extracted, binary);
    // written through a rename, so no run ever reads half a stamp
    writeFileSync(`${stamp}.${process.pid}`, `${entry.sha256}\n`);
    renameSync(`${stamp}.${process.pid}`, stamp);
    console.log(`${tool}: ready at ${binary}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// the archive hash in a stamp, or "" when there is none (a missing stamp is a
// cache miss)
function readStamp(stamp: string): string {
  try {
    return readFileSync(stamp, "utf8").trim();
  } catch {
    return "";
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
  const partial = `${path}.${process.pid}.partial`;
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
