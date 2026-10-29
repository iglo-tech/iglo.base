// Upstream: cmd/serve.go, with the app bootstrap that pocketbase.go's
// Execute runs before the command (core/base.go Bootstrap, see
// @/app/bootstrap) and its ClearBootstrap on termination
//
// Only `serve` opens pb_data here; upstream also bootstraps for the root
// command without --help/--version and for `superuser` (M6.2).
//
// Also logs the one warning about pb_hooks and pb_migrations directories,
// which upstream's prebuilt binary would load (examples/base/main.go, jsvm
// defaults "pb_data/../pb_hooks" and "pb_data/../pb_migrations").

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { FlagSpec, FlagValue } from "@/cli/flags";
import { ignoredDirsWarning } from "@/cli/removed";
import type { AppConfig, CliContext } from "@/cli/root";
import { bootstrap, clearBootstrap } from "@/app/bootstrap";
import { logTime, serve } from "@/server/serve";

export const serveShort =
  "Starts the web server (default to 127.0.0.1:8090 if no domain is specified)";

export const serveUse = "[domain(s)]";

export const serveFlags: FlagSpec[] = [
  {
    name: "origins",
    kind: "stringSlice",
    usage: "CORS allowed domain origins list",
    defaultText: "[*]",
  },
  {
    name: "http",
    kind: "string",
    usage:
      "TCP address to listen for the HTTP server\n(if domain args are specified - default to 0.0.0.0:80, otherwise - default to 127.0.0.1:8090)",
  },
  {
    name: "https",
    kind: "string",
    usage:
      "TCP address to listen for the HTTPS server\n(if domain args are specified - default to 0.0.0.0:443, otherwise - default to empty string, aka. no TLS)\nThe incoming HTTP traffic also will be auto redirected to the HTTPS version",
  },
];

export async function runServeCommand(
  app: AppConfig,
  values: Map<string, FlagValue>,
  domains: string[],
  ctx: CliContext,
): Promise<void> {
  let httpAddr = (values.get("http") as string | undefined) ?? "";
  let httpsAddr = (values.get("https") as string | undefined) ?? "";
  const allowedOrigins = (values.get("origins") as string[] | undefined) ?? ["*"];

  // set default listener addresses if at least one domain is specified
  if (domains.length > 0) {
    if (httpAddr === "") {
      httpAddr = "0.0.0.0:80";
    }
    if (httpsAddr === "") {
      httpsAddr = "0.0.0.0:443";
    }
  } else if (httpAddr === "") {
    httpAddr = "127.0.0.1:8090";
  }

  const ignored = ["pb_hooks", "pb_migrations"]
    .map((name) => join(app.dataDir, "..", name))
    .filter((dir) => existsSync(dir));
  if (ignored.length > 0) {
    ctx.out.stderr(`${logTime(ctx.out.now())} WARN ${ignoredDirsWarning(ignored)}\n`);
  }

  const logError = (message: string, cause?: unknown): void => {
    const detail = cause instanceof Error ? (cause.stack ?? cause.message) : cause;
    ctx.out.stderr(
      `${logTime(ctx.out.now())} ERROR ${message}${detail === undefined ? "" : `: ${String(detail)}`}\n`,
    );
  };

  const appContext = await bootstrap({
    dataDir: app.dataDir,
    isDev: app.isDev,
    encryptionEnv: app.encryptionEnv,
    queryTimeout: app.queryTimeout,
    clock: { now: () => ctx.out.now() },
    logger: { error: logError },
    getenv: ctx.getenv,
    // color.HiBlack, as upstream's dev mode prints the statements
    devSQLLog: (line) => ctx.out.stdout(ctx.out.color ? `\x1b[90m${line}\x1b[0m\n` : `${line}\n`),
    warn: (message) => ctx.out.stderr(`${logTime(ctx.out.now())} WARN ${message}\n`),
  });

  try {
    await serve(
      appContext,
      {
        httpAddr,
        httpsAddr,
        certificateDomains: domains,
        allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : ["*"],
        showStartBanner: true,
      },
      ctx.out,
      ctx.shutdown,
    );
  } finally {
    await clearBootstrap(appContext);
  }
}
