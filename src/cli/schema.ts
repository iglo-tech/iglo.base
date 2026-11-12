// iglo.base's own command for the schema file (D40, issue #77), in the shape
// of cmd/superuser.go's subcommands (help, flags, bootstrap). Not an upstream
// file.
//
// `schema pull` reads the collections of the database through the app
// (findAllCollections, never SQL on _collections) and writes the schema file
// to --out, or to stdout. Nothing here writes to the database: applying a
// file is S.3.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { App } from "@/app/app";
import { clearBootstrap } from "@/app/bootstrap";
import {
  argsMinusFirst,
  FlagError,
  parseFlags,
  stripFlags,
  type FlagSpec,
  type FlagValue,
} from "@/cli/flags";
import { helpText, usageText, type CommandHelp } from "@/cli/help";
import type { AppConfig, CliContext } from "@/cli/root";
import { bootstrapApp } from "@/cli/serve";
import { CommandError } from "@/cli/superuser";
import { findAllCollections } from "@/collections/collection-query";
import { dataDBFilename } from "@/db/base";
import { JSONSyntaxError } from "@/schema/json-tree";
import { describeCollections } from "@/schema/describe";
import { schemaJSONText } from "@/schema/json-schema";
import { schemaURL } from "@/schema/url";
import { extractExtras, formatSchema } from "@/schema/write";

export const schemaShort = "Manage the schema file (schema as code)";

const pullShort = "Writes the schema file from the database";
const pullExample = "schema pull --out iglo.schema.json";
const jsonSchemaShort = "Prints the JSON Schema of the schema file, as this build embeds it";

function helpFlag(cmd: string): FlagSpec {
  return { name: "help", kind: "bool", shorthand: "h", usage: `help for ${cmd}` };
}

const outFlag: FlagSpec = {
  name: "out",
  kind: "string",
  usage: "the file to write (default stdout)",
};

// Runs `schema ...`; ctx.args still starts with the command words. version
// is the running version (the $schema URL of the file).
export async function runSchemaCommand(
  resolveConfig: (values: Map<string, FlagValue>) => AppConfig,
  persistent: FlagSpec[],
  ctx: CliContext,
  name: string,
  version: string,
): Promise<void> {
  const rest = argsMinusFirst(ctx.args, "schema", persistent);
  // cobra Command.Find: the first argument that is not a flag (or a flag's value)
  const [subName] = stripFlags(rest, [helpFlag("schema"), ...persistent]);

  const help: CommandHelp = {
    path: `${name} schema`,
    short: schemaShort,
    runnable: false,
    subcommands: [
      { name: "json-schema", short: jsonSchemaShort },
      { name: "pull", short: pullShort },
    ],
    localFlags: [helpFlag("schema")],
    inheritedFlags: persistent,
  };

  if (subName === undefined) {
    try {
      parseFlags(rest, [helpFlag("schema"), ...persistent], { allowUnknown: false });
    } catch (err) {
      if (err instanceof FlagError) {
        throw new CommandError(err.message, usageText(help));
      }
      throw err;
    }
    ctx.out.stdout(helpText(help));
    return;
  }
  if (subName === "json-schema") {
    let parsedJSON;
    try {
      parsedJSON = parseFlags(
        argsMinusFirst(rest, "json-schema", persistent),
        [helpFlag("schema json-schema"), ...persistent],
        { allowUnknown: false },
      );
    } catch (err) {
      if (err instanceof FlagError) {
        throw new CommandError(err.message);
      }
      throw err;
    }
    if (parsedJSON.values.get("help") === true) {
      ctx.out.stdout(
        helpText({
          path: `${name} schema json-schema`,
          short: jsonSchemaShort,
          runnable: true,
          subcommands: [],
          localFlags: [helpFlag("schema json-schema")],
          inheritedFlags: persistent,
        }),
      );
      return;
    }
    ctx.out.stdout(schemaJSONText);
    return;
  }
  if (subName !== "pull") {
    throw new CommandError(
      `unknown command ${JSON.stringify(subName)} for ${JSON.stringify(`${name} schema`)}`,
      usageText(help),
    );
  }

  const local = [helpFlag("schema pull"), outFlag];
  let parsed;
  try {
    parsed = parseFlags(argsMinusFirst(rest, "pull", persistent), [...local, ...persistent], {
      allowUnknown: false,
    });
  } catch (err) {
    if (err instanceof FlagError) {
      throw new CommandError(err.message);
    }
    throw err;
  }
  if (parsed.values.get("help") === true) {
    ctx.out.stdout(
      helpText({
        path: `${name} schema pull`,
        short: pullShort,
        example: pullExample,
        runnable: true,
        subcommands: [],
        localFlags: local,
        inheritedFlags: persistent,
      }),
    );
    return;
  }

  // pocketbase.go eagerParseFlags: the persistent flags of the whole line
  let config: AppConfig;
  try {
    config = resolveConfig(parseFlags(ctx.args, persistent, { allowUnknown: true }).values);
  } catch {
    config = resolveConfig(new Map());
  }

  // a pull reads an existing database: it never creates a data directory or
  // a database (bootstrap would create both), so a wrong --dir is an error
  requireExistingDatabase(resolve(ctx.cwd, config.dataDir));

  const app: App = await bootstrapApp(config, logsToStderr(ctx));
  try {
    await pull(app, parsed.values.get("out") as string | undefined, ctx, version);
  } finally {
    await clearBootstrap(app);
  }
}

// The stdout of `schema pull` is the schema and nothing else (D40): the
// app's logs, the dev-mode SQL statements and the console output of JS
// migration files go to stderr while the command runs.
function logsToStderr(ctx: CliContext): CliContext {
  return { ...ctx, out: { ...ctx.out, stdout: (text) => ctx.out.stderr(text) } };
}

function requireExistingDatabase(dataDir: string): void {
  if (!existsSync(dataDir)) {
    throw new CommandError(
      `data directory ${JSON.stringify(dataDir)} does not exist: schema pull reads an existing database and does not create one (check --dir)`,
    );
  }
  const database = join(dataDir, dataDBFilename);
  if (!existsSync(database)) {
    throw new CommandError(
      `database ${JSON.stringify(database)} does not exist: schema pull reads an existing database and does not create one (check --dir)`,
    );
  }
}

// the writer of `schema pull`: keeps the extra keys of an existing file
async function pull(
  app: App,
  out: string | undefined,
  ctx: CliContext,
  version: string,
): Promise<void> {
  const path = out === undefined ? undefined : resolve(ctx.cwd, out);

  let extras;
  if (path !== undefined && existsSync(path)) {
    try {
      extras = extractExtras(readFileSync(path, "utf8"));
    } catch (err) {
      if (err instanceof JSONSyntaxError) {
        throw new CommandError(
          `cannot keep the descriptions of ${JSON.stringify(out)}: ${err.message} (fix the file or remove it)`,
        );
      }
      throw err;
    }
  }

  let text: string;
  try {
    text = formatSchema(describeCollections(findAllCollections(app)), {
      schemaURL: schemaURL(version),
      extras,
    });
  } catch (err) {
    throw new CommandError(err instanceof Error ? err.message : String(err));
  }

  if (path === undefined) {
    ctx.out.stdout(text);
  } else {
    writeFileSync(path, text);
  }
}
