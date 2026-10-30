// Upstream: plugins/migratecmd/migratecmd.go (the migrate command) and
// core/migrations_runner.go (Run: the interactive up, down and
// history-sync), with the bootstrap pocketbase.go's Execute runs before the
// command (skipped for -h, --help, -v and --version)
//
// The template language is always JS, as in the prebuilt binary.

import { mkdirSync, writeFileSync } from "node:fs";
import { posix } from "node:path";

import type { App } from "@/app/app";
import { clearBootstrap } from "@/app/bootstrap";
import { Collection } from "@/collections/collection-model";
import { collectionQuery } from "@/collections/collection-query";
import { wrapError } from "@/collections/view";
import { argsMinusFirst, FlagError, parseFlags, type FlagSpec, type FlagValue } from "@/cli/flags";
import { helpText } from "@/cli/help";
import { yesNoPrompt } from "@/cli/prompt";
import type { AppConfig, CliContext } from "@/cli/root";
import { bootstrapApp } from "@/cli/serve";
import { CommandError, green } from "@/cli/superuser";
import { goQuote } from "@/fields/field";
import {
  down,
  initMigrationsTable,
  lastAppliedMigrations,
  type Migration,
  removeMissingAppliedMigrations,
  up,
  DefaultMigrationsTable,
} from "@/migrations/migrations-runner";
import { jsBlankTemplate, jsSnapshotTemplate } from "@/migrations/templates";
import { toInt } from "@/records/cast";
import { snakecase } from "@/tools/inflector/inflector";

export const migrateShort = "Executes app DB migration scripts";

const migrateLong = `Supported arguments are:
- up            - runs all available migrations
- down [number] - reverts the last [number] applied migrations
- create name   - creates new blank migration template file
- collections   - creates new migration file with snapshot of the local collections configuration
- history-sync  - ensures that the _migrations history table doesn't have references to deleted migration files`;

// migrateCreateHandler
function migrateCreate(
  dir: string,
  template: string | null,
  args: string[],
  ctx: CliContext,
): void {
  const [name] = args;
  if (name === undefined) {
    throw new CommandError("missing migration file name");
  }

  const now = Math.floor(ctx.out.now().getTime() / 1000);
  const filename = `${now}_${snakecase(name)}.js`;

  const resultFilePath = posix.join(dir, filename);

  const confirm = yesNoPrompt(
    ctx.out.stderr,
    `Do you really want to create migration ${goQuote(resultFilePath)}?`,
    false,
  );
  if (!confirm) {
    ctx.out.stdout("The command has been cancelled\n");
    return;
  }

  // ensure that the migrations dir exist
  mkdirSync(dir, { recursive: true });

  // save the migration file
  try {
    writeFileSync(resultFilePath, template ?? jsBlankTemplate(), { mode: 0o644 });
  } catch (err) {
    throw wrapError(`failed to save migration file ${goQuote(resultFilePath)}`, err);
  }

  ctx.out.stdout(`Successfully created file ${goQuote(resultFilePath)}\n`);
}

// migrateCollectionsHandler
function migrateCollections(app: App, dir: string, args: string[], ctx: CliContext): void {
  let collections: Collection[];
  try {
    collections = collectionQuery(app)
      .orderBy("created ASC")
      .all<Collection>(() => new Collection());
  } catch (err) {
    throw wrapError("failed to fetch migrations list", err);
  }

  migrateCreate(dir, jsSnapshotTemplate(collections), ["collections_snapshot", ...args], ctx);
}

// MigrationsRunner.Run
function run(app: App, list: readonly Migration[], args: string[], ctx: CliContext): void {
  initMigrationsTable(app.databases);

  const [cmd = "up"] = args;

  switch (cmd) {
    case "up": {
      const applied = up(app, list);

      if (applied.length === 0) {
        green(ctx, "No new migrations to apply.");
      } else {
        for (const file of applied) {
          green(ctx, `Applied ${file}`);
        }
      }
      return;
    }
    case "down": {
      let toRevertCount = 1;
      if (args.length > 1) {
        toRevertCount = Number(toInt(args[1]));
        if (toRevertCount < 0) {
          // revert all applied migrations
          toRevertCount = list.length;
        }
      }

      const names = lastAppliedMigrations(app.databases, list, toRevertCount);

      const confirm = yesNoPrompt(
        ctx.out.stderr,
        `\n${names.join("\n")}\nDo you really want to revert the last ${toRevertCount} applied migration(s)?`,
        false,
      );
      if (!confirm) {
        ctx.out.stdout("The command has been cancelled\n");
        return;
      }

      const reverted = down(app, list, toRevertCount);

      if (reverted.length === 0) {
        green(ctx, "No migrations to revert.");
      } else {
        for (const file of reverted) {
          green(ctx, `Reverted ${file}`);
        }
      }
      return;
    }
    case "history-sync":
      removeMissingAppliedMigrations(app.databases, list);

      green(ctx, `The ${DefaultMigrationsTable} table was synced with the available migrations.`);
      return;
    default:
      throw new CommandError(`unsupported command: ${goQuote(cmd)}`);
  }
}

export async function runMigrateCommand(
  resolveConfig: (values: Map<string, FlagValue>) => AppConfig,
  persistent: FlagSpec[],
  list: readonly Migration[],
  migrationsDir: string,
  ctx: CliContext,
  name: string,
): Promise<void> {
  const helpFlag: FlagSpec = {
    name: "help",
    kind: "bool",
    shorthand: "h",
    usage: "help for migrate",
  };

  let parsed;
  try {
    parsed = parseFlags(
      argsMinusFirst(ctx.args, "migrate", persistent),
      [helpFlag, ...persistent],
      { allowUnknown: false },
    );
  } catch (err) {
    if (err instanceof FlagError) {
      throw new CommandError(err.message);
    }
    throw err;
  }

  if (parsed.values.get("help") === true) {
    ctx.out.stdout(
      helpText({
        path: `${name} migrate`,
        short: migrateLong,
        runnable: true,
        subcommands: [],
        localFlags: [helpFlag],
        inheritedFlags: persistent,
      }),
    );
    return;
  }

  const app = await bootstrapApp(resolveConfig(parsed.values), ctx);

  try {
    const [cmd = ""] = parsed.args;

    switch (cmd) {
      case "create":
        migrateCreate(migrationsDir, null, parsed.args.slice(1), ctx);
        break;
      case "collections":
        migrateCollections(app, migrationsDir, parsed.args.slice(1), ctx);
        break;
      default:
        // note: system migrations are always applied as part of the bootstrap process
        run(app, list, parsed.args, ctx);
    }
  } finally {
    await clearBootstrap(app);
  }
}
