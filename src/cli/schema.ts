// iglo.base's own command for the schema file (D40, issue #77), in the shape
// of cmd/superuser.go's subcommands (help, flags, bootstrap). Not an upstream
// file.
//
// `schema pull` reads the collections of the database through the app
// (findAllCollections, never SQL on _collections) and writes the schema file
// to --out, or to stdout; it writes nothing to the database.
//
// `schema plan` runs the apply of a file (src/schema/apply.ts) and rolls it
// back: it prints what applying the file would change, and makes no backup.

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
import { parseSchemaFile, planSchema, SchemaFileError } from "@/schema/apply";
import { loadSchemaMigrationsFor, type SchemaMigration } from "@/schema/migration-files";
import { JSONSyntaxError } from "@/schema/json-tree";
import type { Collection } from "@/collections/collection-model";
import { schemaFileText, type SchemaFileText } from "@/schema/file-text";
import { schemaJSONText } from "@/schema/json-schema";
import { formatReport, reportIsOK } from "@/schema/report";
import { schemaURL } from "@/schema/url";
import { generateTypes, TypesError } from "@/schema/typegen";
import { extractExtras } from "@/schema/write";
import type { Migration } from "@/migrations/migrations-runner";
import type { SchemaDescription, SchemaObject } from "@/schema/types";

export const schemaShort = "Manage the schema file (schema as code)";

const pullShort = "Writes the schema file from the database";
const pullExample = "schema pull --out iglo.schema.json";
const jsonSchemaShort = "Prints the JSON Schema of the schema file, as this build embeds it";
const planShort =
  "Shows what applying the schema file would change, and whether it would apply, without changing the database. On a live database it holds the write lock while it runs";
const planExample = "schema plan --schema iglo.schema.json";
const typesShort =
  "Writes the TypeScript types of the collections, generated from the database (with --schema, from the file after it is applied in a rolled-back transaction)";
const typesExample = "schema types --schema iglo.schema.json --out src/iglo.types.ts";

function helpFlag(cmd: string): FlagSpec {
  return { name: "help", kind: "bool", shorthand: "h", usage: `help for ${cmd}` };
}

const outFlag: FlagSpec = {
  name: "out",
  kind: "string",
  usage: "the file to write (default stdout)",
};

const schemaFlag: FlagSpec = {
  name: "schema",
  kind: "string",
  usage: "the schema file to plan (required)",
};

const typesSchemaFlag: FlagSpec = {
  name: "schema",
  kind: "string",
  usage:
    "apply this schema file first, in a rolled-back transaction, and generate the types of the result (no backup is made)",
};

const checkFlag: FlagSpec = {
  name: "check",
  kind: "bool",
  usage: "exit nonzero when --out differs from what would be generated, and write nothing",
};

const allowDataLossFlag: FlagSpec = {
  name: "allow-data-loss",
  kind: "bool",
  usage: "plan the deletion of the fields and collections that hold data",
};

const schemaMigrationsDirFlag: FlagSpec = {
  name: "schemaMigrationsDir",
  kind: "string",
  usage:
    "the directory of the TypeScript migrations of the schema (default migrations/ next to the schema file)",
};

// Runs `schema ...`; ctx.args still starts with the command words. version
// is the running version (the $schema URL of the file). migrations are the
// JavaScript migrations of pb_migrations (plan runs them in its transaction).
export async function runSchemaCommand(
  resolveConfig: (values: Map<string, FlagValue>) => AppConfig,
  persistent: FlagSpec[],
  ctx: CliContext,
  name: string,
  version: string,
  migrations: readonly Migration[],
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
      { name: "plan", short: planShort },
      { name: "pull", short: pullShort },
      { name: "types", short: typesShort },
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
  if (subName === "plan") {
    await runPlan(resolveConfig, persistent, ctx, name, migrations, rest);
    return;
  }
  if (subName === "types") {
    await runTypes(resolveConfig, persistent, ctx, name, migrations, rest);
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

// the writer of `schema pull`: keeps the extra keys and provider references of
// an existing file (schema-file.ts); the secrets are never written (D40)
async function pull(
  app: App,
  out: string | undefined,
  ctx: CliContext,
  version: string,
): Promise<void> {
  const path = out === undefined ? undefined : resolve(ctx.cwd, out);

  let existing: string | undefined;
  if (path !== undefined && existsSync(path)) {
    existing = readFileSync(path, "utf8");
    try {
      extractExtras(existing);
    } catch (err) {
      if (err instanceof JSONSyntaxError) {
        throw new CommandError(
          `cannot keep the descriptions of ${JSON.stringify(out)}: ${err.message} (fix the file or remove it)`,
        );
      }
      throw err;
    }
  }

  let result: SchemaFileText;
  try {
    result = schemaFileText(app, existing, schemaURL(version));
  } catch (err) {
    throw new CommandError(err instanceof Error ? err.message : String(err));
  }
  for (const note of result.notes) {
    ctx.out.stderr(`note: ${note}\n`);
  }

  if (path === undefined) {
    ctx.out.stdout(result.text);
  } else {
    writeFileSync(path, result.text);
  }
}

// `schema plan --schema <file> [--allow-data-loss]`: prints the plan on
// standard output, and exits nonzero when the file would not apply.
async function runPlan(
  resolveConfig: (values: Map<string, FlagValue>) => AppConfig,
  persistent: FlagSpec[],
  ctx: CliContext,
  name: string,
  migrations: readonly Migration[],
  rest: string[],
): Promise<void> {
  const local = [helpFlag("schema plan"), schemaFlag, allowDataLossFlag, schemaMigrationsDirFlag];
  let parsed;
  try {
    parsed = parseFlags(argsMinusFirst(rest, "plan", persistent), [...local, ...persistent], {
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
        path: `${name} schema plan`,
        short: planShort,
        example: planExample,
        runnable: true,
        subcommands: [],
        localFlags: local,
        inheritedFlags: persistent,
      }),
    );
    return;
  }

  const given = parsed.values.get("schema") as string | undefined;
  if (given === undefined) {
    throw new CommandError("schema plan needs --schema <file>");
  }
  const schemaText = readPlanFile(resolve(ctx.cwd, given), given);
  const schemaMigrations = await migrationsOf(ctx, given, parsed.values);

  // pocketbase.go eagerParseFlags: the persistent flags of the whole line
  let config: AppConfig;
  try {
    config = resolveConfig(parseFlags(ctx.args, persistent, { allowUnknown: true }).values);
  } catch {
    config = resolveConfig(new Map());
  }

  // like pull, a plan reads an existing database and creates none
  requireExistingDatabase(resolve(ctx.cwd, config.dataDir));

  const app: App = await bootstrapApp(config, logsToStderr(ctx));
  try {
    let report;
    try {
      report = planSchema(app, schemaText, {
        allowDataLoss: parsed.values.get("allow-data-loss") === true,
        migrations,
        schemaMigrations,
      });
    } catch (err) {
      if (err instanceof SchemaFileError) {
        throw new CommandError(err.message);
      }
      throw err;
    }
    ctx.out.stdout(formatReport(report));
    if (!reportIsOK(report)) {
      throw new CommandError("schema plan: the schema would not apply");
    }
  } finally {
    await clearBootstrap(app);
  }
}

// the TypeScript migrations of the schema file, from --schemaMigrationsDir when
// it is given (D40, S.5); they load before the database is opened
async function migrationsOf(
  ctx: CliContext,
  schemaFile: string,
  values: Map<string, FlagValue>,
): Promise<SchemaMigration[]> {
  const dir = values.get("schemaMigrationsDir") as string | undefined;
  try {
    return await loadSchemaMigrationsFor(
      resolve(ctx.cwd, schemaFile),
      dir === undefined ? undefined : resolve(ctx.cwd, dir),
    );
  } catch (err) {
    throw new CommandError(err instanceof Error ? err.message : String(err));
  }
}

function readPlanFile(path: string, given: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new CommandError(
      `cannot read the schema file ${JSON.stringify(given)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// the API's JSON of each collection, parsed (upstream's MarshalJSON, with the
// fields a view has resolved)
function collectionsJSON(collections: readonly Collection[]): SchemaObject[] {
  return collections.map((collection) => JSON.parse(collection.marshalJSON()) as SchemaObject);
}

// `schema types [--out <file>] [--schema <file>] [--check]` (D40, S.4): the
// types of the collections, from the database. With --schema, the file is
// applied first in a rolled-back transaction (the plan, with its locks and
// notes), so the types are those of the file and no server is needed. The
// descriptions and tsType come from the file: the database does not hold them.
async function runTypes(
  resolveConfig: (values: Map<string, FlagValue>) => AppConfig,
  persistent: FlagSpec[],
  ctx: CliContext,
  name: string,
  migrations: readonly Migration[],
  rest: string[],
): Promise<void> {
  const local = [
    helpFlag("schema types"),
    outFlag,
    typesSchemaFlag,
    checkFlag,
    schemaMigrationsDirFlag,
  ];
  let parsed;
  try {
    parsed = parseFlags(argsMinusFirst(rest, "types", persistent), [...local, ...persistent], {
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
        path: `${name} schema types`,
        short: typesShort,
        example: typesExample,
        runnable: true,
        subcommands: [],
        localFlags: local,
        inheritedFlags: persistent,
      }),
    );
    return;
  }

  const out = parsed.values.get("out") as string | undefined;
  const check = parsed.values.get("check") === true;
  if (check && out === undefined) {
    throw new CommandError("schema types --check needs --out <file>, the file to compare");
  }
  const given = parsed.values.get("schema") as string | undefined;

  // pocketbase.go eagerParseFlags: the persistent flags of the whole line
  let config: AppConfig;
  try {
    config = resolveConfig(parseFlags(ctx.args, persistent, { allowUnknown: true }).values);
  } catch {
    config = resolveConfig(new Map());
  }

  // like pull and plan, types read an existing database and create none
  requireExistingDatabase(resolve(ctx.cwd, config.dataDir));

  const app: App = await bootstrapApp(config, logsToStderr(ctx));
  try {
    let collections: SchemaObject[];
    let schema: SchemaDescription | undefined;
    if (given === undefined) {
      collections = collectionsJSON(findAllCollections(app));
    } else {
      const schemaText = readPlanFile(resolve(ctx.cwd, given), given);
      const schemaMigrations = await migrationsOf(ctx, given, parsed.values);
      try {
        schema = parseSchemaFile(schemaText);
      } catch (err) {
        if (err instanceof SchemaFileError) {
          throw new CommandError(err.message);
        }
        throw err;
      }
      let applied: SchemaObject[] | undefined;
      const report = planSchema(app, schemaText, {
        allowDataLoss: false,
        migrations,
        schemaMigrations,
        inspect: (txApp) => {
          applied = collectionsJSON(findAllCollections(txApp));
        },
      });
      ctx.out.stderr(formatReport(report));
      if (!reportIsOK(report) || applied === undefined) {
        throw new CommandError(
          "schema types: the schema would not apply, so there are no types for it",
        );
      }
      collections = applied;
    }

    let text: string;
    try {
      text = generateTypes(collections, schema);
    } catch (err) {
      if (err instanceof TypesError) {
        throw new CommandError(err.message);
      }
      throw err;
    }

    if (out === undefined) {
      ctx.out.stdout(text);
      return;
    }
    const path = resolve(ctx.cwd, out);
    if (check) {
      let current: string | undefined;
      try {
        current = readFileSync(path, "utf8");
      } catch {
        throw new CommandError(
          `${JSON.stringify(out)} does not exist: run schema types with --out to create it`,
        );
      }
      if (current !== text) {
        throw new CommandError(
          `${JSON.stringify(out)} is out of date with the database: run schema types again to update it`,
        );
      }
      return;
    }
    writeFileSync(path, text);
  } finally {
    await clearBootstrap(app);
  }
}
