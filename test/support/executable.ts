// Builds the compiled executable once per test run and starts it as a child
// process. Tests talk to it only through argv, exit codes, the standard
// streams and HTTP.

import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { prepareEmbeddedSQLite } from "@scripts/sqlite-embed";

const repoRoot = resolve(import.meta.dir, "../..");

let built: Promise<string> | undefined;

// Path to a freshly compiled executable (`bun build --compile`), built from
// the current source on first use.
export function executable(): Promise<string> {
  built ??= (async () => {
    // the dashboard pack src/main.ts embeds
    const ui = Bun.spawn([process.execPath, "scripts/ui/build.ts"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await ui.exited) !== 0) {
      throw new Error(`dashboard build failed:\n${await new Response(ui.stderr).text()}`);
    }
    // the SQLite library src/main.ts embeds (D34): the real one on macOS
    await prepareEmbeddedSQLite("");
    const outfile = join(mkdtempSync(join(tmpdir(), "iglo-base-build-")), "iglo-base");
    const proc = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        // the same flags as scripts/build.ts
        "--bytecode",
        "--format=esm",
        "src/main.ts",
        "src/db/read-worker.ts",
        "src/files/thumb-worker.ts",
        "src/backups/backup-worker.ts",
        "src/logs/log-worker.ts",
        "--outfile",
        outfile,
      ],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
    );
    if ((await proc.exited) !== 0) {
      throw new Error(
        `build failed:\n${await new Response(proc.stderr).text()}${await new Response(proc.stdout).text()}`,
      );
    }
    return outfile;
  })();
  return built;
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "iglo-base-test-"));
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Runs the executable to completion.
export async function run(args: string[], options: { cwd?: string } = {}): Promise<RunResult> {
  const proc = Bun.spawn([await executable(), ...args], {
    cwd: options.cwd ?? tempDir(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 10_000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

// Ports are taken below the OS's ephemeral range (Linux 32768+, macOS 49152+),
// so outgoing connections never hold one, and each is claimed with an
// exclusive marker file in the temp dir so that parallel test processes and
// agents on a shared host cannot hand out the same port. A marker whose
// process is gone is reused.
const portRange = { from: 20_000, to: 32_000 };
const claimDir = join(tmpdir(), "iglo-base-ports");
const claimedHere = new Set<number>();

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function claim(port: number): boolean {
  if (claimedHere.has(port)) return false;
  mkdirSync(claimDir, { recursive: true });
  const marker = join(claimDir, String(port));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(marker, String(process.pid), { flag: "wx" });
      claimedHere.add(port);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner = 0;
      try {
        owner = Number(readFileSync(marker, "utf8"));
      } catch {
        continue;
      }
      if (owner === process.pid || pidAlive(owner)) return false;
      try {
        unlinkSync(marker);
      } catch {}
    }
  }
  return false;
}

export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = portRange.from + Math.floor(Math.random() * (portRange.to - portRange.from));
    if (!claim(port)) continue;
    try {
      const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
      listener.stop(true);
      return port;
    } catch {
      // in use by an unrelated process: the marker stays so it is not retried
    }
  }
  throw new Error("no free port in the test range");
}

export interface RunningServer {
  url: string;
  // the server's process id (for memory measurements)
  pid: number;
  // stops the server with SIGTERM and returns its exit code and output
  stop(): Promise<RunResult>;
  // waits until the standard output so far contains text, and returns it
  waitForOutput(text: string, timeoutMs?: number): Promise<string>;
}

// Starts `serve --http <host>:<port>` (a free port unless one is given, by
// number or service name) with the extra args and waits for the start
// banner. The returned url always uses 127.0.0.1 and urlPort, if given.
// --automigrate is off unless args turn it on: a test's collection changes
// write no pb_migrations next to its pb_data.
export async function startServer(
  args: string[],
  dataDir: string,
  host = "127.0.0.1",
  listenPort?: { name: string; urlPort: number },
  extraEnv: Record<string, string> = {},
): Promise<RunningServer> {
  const port = listenPort?.urlPort ?? (await freePort());
  const proc = Bun.spawn(
    [
      await executable(),
      "serve",
      "--http",
      `${host}:${listenPort?.name ?? port}`,
      "--dir",
      dataDir,
      "--automigrate=false",
      ...args,
    ],
    {
      cwd: tempDir(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1", ...extraEnv },
    },
  );
  const stderrText = new Response(proc.stderr).text();

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let stdout = "";
  const deadline = Date.now() + 10_000;
  while (!stdout.includes("Server started at")) {
    const timeLeft = deadline - Date.now();
    const chunk = await Promise.race([
      reader.read(),
      Bun.sleep(Math.max(timeLeft, 0)).then(() => undefined),
    ]);
    if (!chunk || chunk.done) {
      proc.kill();
      throw new Error(`server did not start:\n${stdout}\n${await stderrText}`);
    }
    stdout += decoder.decode(chunk.value, { stream: true });
  }

  // the rest of the output is read as it comes
  const pumped = (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      stdout += decoder.decode(chunk.value, { stream: true });
    }
  })();

  return {
    url: `http://127.0.0.1:${port}`,
    pid: proc.pid,
    async stop() {
      proc.kill("SIGTERM");
      await pumped;
      return { exitCode: await proc.exited, stdout, stderr: await stderrText };
    },
    async waitForOutput(text, timeoutMs = 10_000) {
      const until = Date.now() + timeoutMs;
      while (!stdout.includes(text)) {
        if (Date.now() > until) {
          throw new Error(`no ${JSON.stringify(text)} in the output:\n${stdout}`);
        }
        await Bun.sleep(20);
      }
      return stdout;
    },
  };
}
