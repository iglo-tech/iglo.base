// Upstream: pocketbase.go (root command, eagerParseFlags, default data dir,
// Version) and examples/base/main.go (the prebuilt binary's --publicDir and
// --indexFallback flags), with cobra's Execute flow (command lookup, help,
// version, error output via log.Fatal).
//
// Not ported: bootstrap (opening pb_data, M0.4), the superuser command (M6.2),
// and everything plugin related (see @/cli/removed).

import { basename, dirname, join } from "node:path";

import { argsMinusFirst, FlagError, parseFlags, stripFlags, type FlagSpec } from "@/cli/flags";
import { helpText, usageText, type CommandHelp } from "@/cli/help";
import { findRemovedFlag, removedCommandMessage, removedFlagMessage } from "@/cli/removed";
import { runServeCommand, serveFlags, serveShort, serveUse } from "@/cli/serve";
import { logTime, type Output } from "@/server/serve";

// Version of iglo.base, set by the release build (M7.3).
export const version = "(untracked)";

// core.DefaultQueryTimeout, in seconds.
const defaultQueryTimeout = 30;

export interface CliContext {
  // os.Args[1:]
  args: string[];
  // os.Args[0], the path the executable was invoked as
  argv0: string;
  cwd: string;
  // true when running the compiled executable, false when running from
  // source (upstream's "go run" check)
  isCompiled: boolean;
  out: Output;
  // aborted on SIGINT or SIGTERM
  shutdown: AbortSignal;
  // os.Getenv ("" when unset); an empty environment unless set
  getenv?: (name: string) => string;
}

// The persistent flags shared by every command.
export interface AppConfig {
  dataDir: string;
  isDev: boolean;
  encryptionEnv: string;
  queryTimeout: number;
  publicDir: string;
  indexFallback: boolean;
}

class CliError extends Error {
  constructor(
    message: string,
    readonly usage?: string,
  ) {
    super(message);
  }
}

const subcommands = [
  { name: "serve", short: serveShort },
  { name: "superuser", short: "Manage superusers" },
];

function rootFlags(defaults: AppConfig): FlagSpec[] {
  return [
    {
      name: "dir",
      kind: "string",
      usage: "the PocketBase data directory",
      defaultText: JSON.stringify(defaults.dataDir),
    },
    {
      name: "encryptionEnv",
      kind: "string",
      usage:
        "the env variable whose value of 32 characters will be used \nas encryption key for the app settings (default none)",
    },
    {
      name: "dev",
      kind: "bool",
      usage: "enable dev mode, aka. printing logs and sql statements to the console",
      defaultText: defaults.isDev ? "true" : undefined,
    },
    {
      name: "queryTimeout",
      kind: "int",
      usage: "the default SELECT queries timeout in seconds",
      defaultText: String(defaults.queryTimeout),
    },
    {
      name: "publicDir",
      kind: "string",
      usage: "the directory to serve static files",
      defaultText: JSON.stringify(defaults.publicDir),
    },
    {
      name: "indexFallback",
      kind: "bool",
      usage:
        "fallback the request to index.html on missing static path, e.g. when pretty urls are used with SPA",
      defaultText: "true",
    },
  ];
}

function defaultConfig(ctx: CliContext): AppConfig {
  // inspectRuntime: next to the executable, or the working directory when
  // running from source
  const baseDir = ctx.isCompiled ? dirname(ctx.argv0) : ctx.cwd;
  return {
    dataDir: join(baseDir, "pb_data"),
    isDev: !ctx.isCompiled,
    encryptionEnv: "",
    queryTimeout: defaultQueryTimeout,
    // examples/base/main.go defaultPublicDir
    publicDir: ctx.isCompiled ? join(ctx.argv0, "../pb_public") : "./pb_public",
    indexFallback: true,
  };
}

function resolveConfig(defaults: AppConfig, values: Map<string, unknown>): AppConfig {
  return {
    dataDir: (values.get("dir") as string | undefined) ?? defaults.dataDir,
    isDev: (values.get("dev") as boolean | undefined) ?? defaults.isDev,
    encryptionEnv: (values.get("encryptionEnv") as string | undefined) ?? defaults.encryptionEnv,
    queryTimeout: (values.get("queryTimeout") as number | undefined) ?? defaults.queryTimeout,
    publicDir: (values.get("publicDir") as string | undefined) ?? defaults.publicDir,
    indexFallback: (values.get("indexFallback") as boolean | undefined) ?? defaults.indexFallback,
  };
}

// cobra.ld: Levenshtein distance, case-insensitive.
function distance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  let prev = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      cur[j] =
        s[i - 1] === t[j - 1]
          ? (prev[j - 1] ?? 0)
          : Math.min(prev[j] ?? 0, cur[j - 1] ?? 0, prev[j - 1] ?? 0) + 1;
    }
    prev = cur;
  }
  return prev[t.length] ?? 0;
}

function suggestionsFor(typed: string): string {
  const matches = subcommands
    .map((cmd) => cmd.name)
    .filter(
      (name) => distance(typed, name) <= 2 || name.toLowerCase().startsWith(typed.toLowerCase()),
    );
  return matches.length > 0
    ? `\n\nDid you mean this?\n${matches.map((name) => `\t${name}\n`).join("")}`
    : "";
}

async function execute(ctx: CliContext): Promise<number> {
  const name = basename(ctx.argv0);
  const defaults = defaultConfig(ctx);
  const persistent = rootFlags(defaults);

  const removedFlag = findRemovedFlag(ctx.args);
  if (removedFlag) {
    throw new CliError(removedFlagMessage(removedFlag));
  }

  // cobra Command.Find
  const commandWords = stripFlags(ctx.args, persistent);
  const commandName = commandWords[0];

  if (commandName !== undefined) {
    const removed = removedCommandMessage(commandName);
    if (removed) {
      throw new CliError(removed);
    }
  }

  if (commandName === "serve") {
    const helpFlag: FlagSpec = {
      name: "help",
      kind: "bool",
      shorthand: "h",
      usage: "help for serve",
    };
    const local = [...serveFlags, helpFlag];
    const parsed = parseFlags(
      argsMinusFirst(ctx.args, "serve", persistent),
      [...local, ...persistent],
      { allowUnknown: false },
    );
    if (parsed.values.get("help") === true) {
      ctx.out.stdout(
        helpText({
          path: `${name} serve`,
          use: serveUse,
          short: serveShort,
          runnable: true,
          subcommands: [],
          localFlags: local,
          inheritedFlags: persistent,
        }),
      );
      return 0;
    }
    await runServeCommand(resolveConfig(defaults, parsed.values), parsed.values, parsed.args, ctx);
    return 0;
  }

  if (commandName === "superuser") {
    throw new CliError(`command "superuser" is not implemented yet`);
  }

  if (commandName !== undefined) {
    throw new CliError(
      `unknown command ${JSON.stringify(commandName)} for ${JSON.stringify(name)}${suggestionsFor(commandName)}`,
    );
  }

  // the root command itself: only --help and --version do something
  const local: FlagSpec[] = [
    ...persistent,
    { name: "help", kind: "bool", shorthand: "h", usage: `help for ${name}` },
    { name: "version", kind: "bool", shorthand: "v", usage: `version for ${name}` },
  ];
  const help: CommandHelp = {
    path: name,
    short: `${name} CLI`,
    runnable: false,
    subcommands,
    localFlags: local,
    inheritedFlags: [],
  };
  let parsed;
  try {
    parsed = parseFlags(ctx.args, local, { allowUnknown: true });
  } catch (err) {
    if (err instanceof FlagError) {
      throw new CliError(err.message, usageText(help));
    }
    throw err;
  }
  if (parsed.values.get("help") !== true && parsed.values.get("version") === true) {
    ctx.out.stdout(`${name} version ${version}\n`);
    return 0;
  }
  ctx.out.stdout(helpText(help));
  return 0;
}

// Runs the CLI and returns the process exit code.
export async function runCli(ctx: CliContext): Promise<number> {
  try {
    return await execute(ctx);
  } catch (err) {
    if (err instanceof CliError && err.usage) {
      ctx.out.stderr(`${err.usage}\n`);
    }
    // log.Fatal
    const message = err instanceof Error ? err.message : String(err);
    ctx.out.stderr(`${logTime(ctx.out.now())} ${message}${message.endsWith("\n") ? "" : "\n"}`);
    return 1;
  }
}
