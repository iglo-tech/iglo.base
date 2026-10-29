// Upstream: examples/base/main.go (the prebuilt binary's entry point).
//
// The only place that touches process globals: it wires argv, the standard
// streams, the clock and the shutdown signals into the CLI.

import { readUiPack } from "@/apis/ui-pack";
import { runCli } from "@/cli/root";
// the dashboard build, packed by scripts/ui/build.ts (bun run build)
import uiPack from "@dist/ui.pack" with { type: "file" };

// osutils.LaunchURL: xdg-open on Linux (open on macOS), not waited for;
// skipped without a display, where it cannot open a browser
function launchURL(url: string): void {
  if (process.platform === "darwin") {
    Bun.spawn(["open", url], { stdio: ["ignore", "ignore", "ignore"] }).unref();
    return;
  }
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return;
  }
  Bun.spawn(["xdg-open", url], { stdio: ["ignore", "ignore", "ignore"] }).unref();
}

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
  getenv: (name) => process.env[name] ?? "",
  ui: readUiPack(await Bun.file(uiPack).bytes()),
  launchURL,
});

process.exit(exitCode);
