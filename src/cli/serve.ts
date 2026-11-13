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
//
// app.restart (core/base.go Restart) stops the server and the app, as
// OnTerminate's pbGracefulShutdown and ClearBootstrap do, and calls execve
// (ctx.restart). If execve fails, the failed restore reverts pb_data and
// this loop bootstraps and serves again; upstream bootstraps and reverts
// but its server stays down, and the process exits after 3 seconds.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { FlagSpec, FlagValue } from "@/cli/flags";
import { httpsNotSupportedMessage, ignoredDirWarning } from "@/cli/removed";
import type { AppConfig, CliContext } from "@/cli/root";
import type { App } from "@/app/app";
import { bootstrap, clearBootstrap } from "@/app/bootstrap";
import { applySchema } from "@/schema/apply";
import { loadSchemaMigrationsFor } from "@/schema/migration-files";
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
  {
    name: "schema",
    kind: "string",
    usage:
      "the schema file (iglo.schema.json) to apply before the server starts, at every start (D40)",
  },
  {
    name: "allow-data-loss",
    kind: "bool",
    usage:
      "with --schema: let the apply delete fields and collections that hold data (without it the apply stops)",
  },
  {
    name: "schemaMigrationsDir",
    kind: "string",
    usage:
      "with --schema: the directory of the TypeScript migrations (default migrations/ next to the schema file)",
  },
];

type AppContextRestart = App["restart"];

// The app bootstrap that pocketbase.go's Execute runs before a command
// (serve, superuser).
export async function bootstrapApp(
  app: AppConfig,
  ctx: CliContext,
  restart?: AppContextRestart,
): Promise<App> {
  return bootstrap({
    dataDir: app.dataDir,
    isDev: app.isDev,
    encryptionEnv: app.encryptionEnv,
    queryTimeout: app.queryTimeout,
    clock: { now: () => ctx.out.now() },
    stderrLog: (line) => ctx.out.stderr(`${logTime(ctx.out.now())} ${line}\n`),
    logPrint: ctx.out.stdout,
    logColor: ctx.out.color,
    getenv: ctx.getenv,
    // color.HiBlack, as upstream's dev mode prints the statements
    devSQLLog: (line) => ctx.out.stdout(ctx.out.color ? `\x1b[90m${line}\x1b[0m\n` : `${line}\n`),
    warn: (message) => ctx.out.stderr(`${logTime(ctx.out.now())} WARN ${message}\n`),
    automigrateDir: app.automigrate ? app.migrationsDir : undefined,
    restart,
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
  const httpsAddr = (values.get("https") as string | undefined) ?? "";
  const allowedOrigins = (values.get("origins") as string[] | undefined) ?? ["*"];

  // no TLS in the app (D30): refuse before pb_data is opened or created
  if (domains.length > 0 || httpsAddr !== "") {
    throw new Error(httpsNotSupportedMessage);
  }

  if (httpAddr === "") {
    httpAddr = "127.0.0.1:8090";
  }

  const hooksDir = join(app.dataDir, "..", "pb_hooks");
  if (existsSync(hooksDir)) {
    ctx.out.stderr(`${logTime(ctx.out.now())} WARN ${ignoredDirWarning(hooksDir)}\n`);
  }

  // the schema file is read at every start (D40): a restart after a restore
  // applies the file again
  const schemaPath = values.get("schema") as string | undefined;
  const allowDataLoss = values.get("allow-data-loss") === true;
  const migrationsDir = values.get("schemaMigrationsDir") as string | undefined;

  for (;;) {
    const schemaText =
      schemaPath === undefined
        ? undefined
        : readSchemaFile(resolve(ctx.cwd, schemaPath), schemaPath);
    // the TypeScript migrations load before the database opens: a file that
    // does not load stops the start (D40, S.5)
    const schemaMigrations =
      schemaPath === undefined
        ? []
        : await loadSchemaMigrationsFor(
            resolve(ctx.cwd, schemaPath),
            migrationsDir === undefined ? undefined : resolve(ctx.cwd, migrationsDir),
          );
    // --automigrate is off while --schema is set (D40)
    const dbApp = schemaText === undefined ? app : { ...app, automigrate: false };

    const stop = new AbortController();
    // every app.restart call of this app instance, oldest first: the ones
    // that join the first restart settle with it, and every one of them
    // reverts if the process does not execve
    const restarts: { revert: () => void; failed: (err: unknown) => void }[] = [];

    const appContext = await bootstrapApp(
      dbApp,
      ctx,
      (revert) =>
        new Promise<void>((_resolve, reject) => {
          restarts.push({ revert, failed: reject });
          stop.abort();
        }),
    );

    try {
      if (schemaText === undefined) {
        // ensure that the latest migrations are applied before starting the server
        up(appContext, migrations);
      } else {
        // the file's apply runs the migrations inside its transaction (D40)
        await applySchema(appContext, schemaText, { allowDataLoss, migrations, schemaMigrations });
      }
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
          publicDir: app.publicDir,
          indexFallback: app.indexFallback,
          showStartBanner: true,
          ui: ctx.ui,
          executablePath: executablePath(ctx),
          launchURL: ctx.launchURL ?? (() => {}),
        },
        ctx.out,
        AbortSignal.any([ctx.shutdown, stop.signal]),
      );
    } finally {
      await clearBootstrap(appContext);
    }

    if (restarts.length === 0) {
      return;
    }

    // the restart did not happen: on a shutdown keep the new data dirs, else
    // (no execve) put them back, newest change first; settle every pending call
    let failure: unknown = new Error("restart is not supported here");
    if (ctx.shutdown.aborted) {
      // a process that is shutting down starts on the new data next time
      // (upstream does not revert on a signal): reject the calls only
      const err = new Error("the app is shutting down");
      for (const pending of restarts) {
        pending.failed(err);
      }
      return;
    } else if (ctx.restart !== undefined) {
      try {
        ctx.restart();
        continue;
      } catch (err) {
        failure = err;
      }
    }
    for (const pending of restarts.toReversed()) {
      try {
        pending.revert();
      } catch (err) {
        pending.failed(err);
        continue;
      }
      pending.failed(failure);
    }
    if (ctx.shutdown.aborted) {
      return;
    }
  }
}

// the text of the schema file; a file that cannot be read stops the start
function readSchemaFile(path: string, given: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read the schema file ${JSON.stringify(given)}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
