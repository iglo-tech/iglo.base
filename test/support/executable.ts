// Builds the compiled executable once per test run and starts it as a child
// process. Tests talk to it only through argv, exit codes, the standard
// streams and HTTP.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

let built: Promise<string> | undefined;

// Path to a freshly compiled executable (`bun build --compile`), built from
// the current source on first use.
export function executable(): Promise<string> {
  built ??= (async () => {
    const outfile = join(mkdtempSync(join(tmpdir(), "iglo-base-build-")), "iglo-base");
    const proc = Bun.spawn(
      [process.execPath, "build", "--compile", "src/main.ts", "--outfile", outfile],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
    );
    if ((await proc.exited) !== 0) {
      throw new Error(`build failed:\n${await new Response(proc.stderr).text()}`);
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

export async function freePort(): Promise<number> {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const { port } = listener;
  listener.stop(true);
  return port;
}

export interface RunningServer {
  url: string;
  // stops the server with SIGTERM and returns its exit code and output
  stop(): Promise<RunResult>;
}

// Starts `serve --http 127.0.0.1:<free port>` with the extra args and waits
// for the start banner.
export async function startServer(args: string[], dataDir: string): Promise<RunningServer> {
  const port = await freePort();
  const proc = Bun.spawn(
    [await executable(), "serve", "--http", `127.0.0.1:${port}`, "--dir", dataDir, ...args],
    {
      cwd: tempDir(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
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

  return {
    url: `http://127.0.0.1:${port}`,
    async stop() {
      proc.kill("SIGTERM");
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        stdout += decoder.decode(chunk.value, { stream: true });
      }
      return { exitCode: await proc.exited, stdout, stderr: await stderrText };
    },
  };
}
