// Upstream: examples/base/main.go (the prebuilt binary's entry point).
//
// The only place that touches process globals: it wires argv, the standard
// streams, the clock and the shutdown signals into the CLI.

import { runCli } from "@/cli/root";

const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => shutdown.abort());
}

const exitCode = await runCli({
  args: process.argv.slice(2),
  argv0: process.argv0,
  cwd: process.cwd(),
  isCompiled: Bun.main.startsWith("/$bunfs/") || /^[A-Z]:\\~BUN\\/.test(Bun.main),
  out: {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    now: () => new Date(),
    color: process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb",
  },
  shutdown: shutdown.signal,
});

process.exit(exitCode);
