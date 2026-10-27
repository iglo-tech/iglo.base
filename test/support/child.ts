// Runs a reference tool as a child process, keeps its output for failure
// messages and stops it. Each call returns its own handle; nothing is shared.

export interface Child {
  // stdout and stderr so far
  output(): string;
  hasExited(): boolean;
  // SIGTERM, then SIGKILL after 5 seconds; resolves once the process is gone
  stop(): Promise<void>;
}

export function spawnChild(command: string[], options: { cwd: string }): Child {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });

  let output = "";
  let exited = false;
  void proc.exited.then(() => {
    exited = true;
  });

  const decoder = new TextDecoder();
  const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true });
    }
  };
  const readers = Promise.all([collect(proc.stdout), collect(proc.stderr)]);

  return {
    output: () => output,
    hasExited: () => exited,
    async stop() {
      if (!exited) {
        proc.kill("SIGTERM");
        const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
        await proc.exited;
        clearTimeout(timer);
      }
      await readers;
    },
  };
}

// Polls check() until it returns true. Fails early if the process exits, and
// after timeoutMs with the process output.
export async function waitUntilReady(
  child: Child,
  what: string,
  check: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.hasExited()) {
      throw new Error(`${what} exited during startup:\n${child.output()}`);
    }
    if (await check().catch(() => false)) {
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`${what} was not ready after ${timeoutMs} ms:\n${child.output()}`);
}
