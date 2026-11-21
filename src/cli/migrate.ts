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
import { joinErrors, wrapError } from "@/collections/view";
import { argsMinusFirst, FlagError, parseFlags } from "@/cli/flags";
import type { FlagSpec, FlagValue } from "@/cli/flags";
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
  removeMissingAppliedMigrations,
  up,
  DefaultMigrationsTable,
} from "@/migrations/migrations-runner";
import type { Migration } from "@/migrations/migrations-runner";
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
  args: Array<string>,
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
  } catch (error) {
    throw wrapError(`failed to save migration file ${goQuote(resultFilePath)}`, error);
  }

  ctx.out.stdout(`Successfully created file ${goQuote(resultFilePath)}\n`);
}

// migrateCollectionsHandler
function migrateCollections(app: App, dir: string, args: Array<string>, ctx: CliContext): void {
  let collections: Array<Collection>;
  try {
    collections = collectionQuery(app)
      .orderBy("created ASC")
      .all<Collection>(() => new Collection());
  } catch (error) {
    throw wrapError("failed to fetch migrations list", error);
  }

  migrateCreate(dir, jsSnapshotTemplate(collections), ["collections_snapshot", ...args], ctx);
}

// MigrationsRunner.Run
function run(app: App, list: ReadonlyArray<Migration>, args: Array<string>, ctx: CliContext): void {
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

// Upstream's transaction runs its afterFuncs before RunInTransaction returns,
// so the S3 delete of a file that a migration's save cleared has ended before
// the command exits. Here they outlive the synchronous run: wait for them
// before the app is closed. A failure fails the command, as upstream's
// "transaction afterFunc errors" does.
async function runAndWaitForFileDeletes(
  app: App,
  list: ReadonlyArray<Migration>,
  args: Array<string>,
  ctx: CliContext,
): Promise<void> {
  const afterTransaction: Array<Promise<void>> = [];
  // oxlint-disable-next-line quality/no-known-value-widening -- a caught value of any thrown type, rethrown unchanged (runCli's catch reads it)
  let runErr: unknown = null;
  try {
    run({ ...app, afterTransaction }, list, args, ctx);
  } catch (error) {
    runErr = error;
  }
  const failures = (await Promise.allSettled(afterTransaction)).flatMap((r) =>
    r.status === "rejected" ? [r.reason as unknown] : [],
  );
  if (runErr !== null) {
    // oxlint-disable-next-line typescript/only-throw-error -- runCli's top-level catch in src/cli/root.ts reads it (instanceof, then its message for stderr)
    throw runErr;
  }
  if (failures.length > 0) {
    throw wrapError("transaction afterFunc errors", joinErrors(failures));
  }
}

export async function runMigrateCommand(
  resolveConfig: (values: Map<string, FlagValue>) => AppConfig,
  persistent: Array<FlagSpec>,
  list: ReadonlyArray<Migration>,
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
  } catch (error) {
    if (error instanceof FlagError) {
      throw new CommandError(error.message);
    }
    throw error;
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
        await runAndWaitForFileDeletes(app, list, parsed.args, ctx);
    }
  } finally {
    await clearBootstrap(app);
  }
}
