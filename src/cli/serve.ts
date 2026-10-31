// Upstream: cmd/serve.go, with the app bootstrap that pocketbase.go's
// Execute runs before the command (core/base.go Bootstrap, see
// @/app/bootstrap) and its ClearBootstrap on termination
//
// `serve` and `superuser` (@/cli/superuser) open pb_data with bootstrapApp;
// upstream also bootstraps for the root command without --help/--version.
//
// Also logs the one warning about a pb_hooks directory, which upstream's
// prebuilt binary would load (examples/base/main.go, jsvm default
// "pb_data/../pb_hooks"), and runs the app migrations before the server
// starts (apis/serve.go Serve).

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { FlagSpec, FlagValue } from "@/cli/flags";
import { ignoredDirWarning } from "@/cli/removed";
import type { AppConfig, CliContext } from "@/cli/root";
import type { App } from "@/app/app";
import { bootstrap, clearBootstrap } from "@/app/bootstrap";
import { type Migration, up } from "@/migrations/migrations-runner";
import { logTime, serve } from "@/server/serve";
import { reloadSettings } from "@/settings/settings-query";

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

// The app bootstrap that pocketbase.go's Execute runs before a command
// (serve, superuser).
export async function bootstrapApp(app: AppConfig, ctx: CliContext): Promise<App> {
  const log =
    (level: string) =>
    (message: string, cause?: unknown): void => {
      const detail = cause instanceof Error ? (cause.stack ?? cause.message) : cause;
      ctx.out.stderr(
        `${logTime(ctx.out.now())} ${level} ${message}${detail === undefined ? "" : `: ${String(detail)}`}\n`,
      );
    };

  return bootstrap({
    dataDir: app.dataDir,
    isDev: app.isDev,
    encryptionEnv: app.encryptionEnv,
    queryTimeout: app.queryTimeout,
    clock: { now: () => ctx.out.now() },
    logger: { error: log("ERROR"), warn: log("WARN") },
    getenv: ctx.getenv,
    // color.HiBlack, as upstream's dev mode prints the statements
    devSQLLog: (line) => ctx.out.stdout(ctx.out.color ? `\x1b[90m${line}\x1b[0m\n` : `${line}\n`),
    warn: (message) => ctx.out.stderr(`${logTime(ctx.out.now())} WARN ${message}\n`),
    automigrateDir: app.automigrate ? app.migrationsDir : undefined,
  });
}

// apis/installer.go executablePath: os.Args[0], or how the program runs
// from source (upstream's "go run .").
function executablePath(ctx: CliContext): string {
  return ctx.isCompiled ? ctx.argv0 : "bun src/main.ts";
}

export async function runServeCommand(
  app: AppConfig,
  values: Map<string, FlagValue>,
  domains: string[],
  ctx: CliContext,
  migrations: readonly Migration[],
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

  const hooksDir = join(app.dataDir, "..", "pb_hooks");
  if (existsSync(hooksDir)) {
    ctx.out.stderr(`${logTime(ctx.out.now())} WARN ${ignoredDirWarning(hooksDir)}\n`);
  }

  const appContext = await bootstrapApp(app, ctx);

  try {
    // ensure that the latest migrations are applied before starting the server
    up(appContext, migrations);
    await reloadSettings(appContext);

    // the jobs tick only under serve (OnServe's __pbCronStart__)
    appContext.cron.start();

    await serve(
      appContext,
      {
        httpAddr,
        httpsAddr,
        certificateDomains: domains,
        allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : ["*"],
        showStartBanner: true,
        ui: ctx.ui,
        executablePath: executablePath(ctx),
        launchURL: ctx.launchURL ?? (() => {}),
      },
      ctx.out,
      ctx.shutdown,
    );
  } finally {
    await clearBootstrap(appContext);
  }
}
