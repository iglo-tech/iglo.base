// The TypeScript migrations of the schema file (D40, S.5). Not an upstream
// file.
//
// A migration file is `<digits>_<name>.ts`, in `migrations/` next to the
// schema file or in the directory --schemaMigrationsDir names. It default
// exports an object that `satisfies Migration` (the generated types file's
// Migration, `schema types`): declared renames, and an `up(tx)` that runs in
// the apply transaction, synchronously. Bun imports the file; a file that does
// not load, a name that does not fit, or an export of another shape fails the
// load with the file's name.
//
// The files run once: the apply records each one in `_migrations` as
// `@schema/<file name>` (see apply.ts), a name no pb_migrations file produces.

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { MigrationTx } from "@/schema/migration-tx";

// the file names a migration may have: a number (a timestamp, so the names
// sort in the order they were made), an underscore and a lowercase name
export const migrationFilePattern = /^\d+_[a-z0-9][a-z0-9_-]*\.ts$/;

// the prefix of the `_migrations` rows of the TypeScript migrations
export const schemaMigrationPrefix = "@schema/";

// the row a migration file is recorded under
export function schemaMigrationRecord(file: string): string {
  return schemaMigrationPrefix + file;
}

export type MigrationUp = (tx: MigrationTx) => unknown;

// the renames a migration declares: a field of a collection, and a collection.
// Both are keyed by the name before the file's own renames: a collection renamed
// in the same file is keyed by its old name in `renames`
export interface DeclaredRenames {
  renames: Record<string, Record<string, string>>;
  renameCollections: Record<string, string>;
}

export interface SchemaMigration extends DeclaredRenames {
  // the file name, as the directory has it
  file: string;
  up: MigrationUp | null;
}

// the directory of the migration files: the one the flag names, else
// `migrations/` next to the schema file
export function schemaMigrationsDir(schemaPath: string, given: string | undefined): string {
  return given ?? join(dirname(schemaPath), "migrations");
}

// the migrations of the schema file at schemaFile (a path, resolved by the
// caller), from the flag's directory when it is given (resolved by the caller
// too), else from migrations/ next to the file
export async function loadSchemaMigrationsFor(
  schemaFile: string,
  given: string | undefined,
): Promise<SchemaMigration[]> {
  return loadSchemaMigrations(schemaMigrationsDir(schemaFile, given), given !== undefined);
}

export class MigrationFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationFileError";
  }
}

// Loads the migration files of a directory, in file name order. A missing
// directory has no migrations, unless the flag named it (a typo must not
// skip the migrations silently).
export async function loadSchemaMigrations(
  dir: string,
  named: boolean,
): Promise<SchemaMigration[]> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    if (named) {
      throw new MigrationFileError(
        `the migrations directory ${JSON.stringify(dir)} does not exist`,
      );
    }
    return [];
  }
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const migrations: SchemaMigration[] = [];
  for (const file of files) {
    if (!migrationFilePattern.test(file)) {
      throw new MigrationFileError(
        `the migration file ${JSON.stringify(file)} does not fit <digits>_<name>.ts (for example 20261113120000_fill_category.ts): rename it`,
      );
    }
    migrations.push(await loadMigration(join(dir, file), file));
  }
  return migrations;
}

// the default export of one file, checked: an object with an up function and
// the declarations, and no other key (a misspelled key would do nothing)
async function loadMigration(path: string, file: string): Promise<SchemaMigration> {
  let exported: unknown;
  try {
    const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
    exported = mod.default;
  } catch (err) {
    throw new MigrationFileError(
      `the migration file ${file} does not load: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const shape = (message: string): MigrationFileError =>
    new MigrationFileError(`the migration file ${file}: ${message}`);
  if (exported === null || typeof exported !== "object" || Array.isArray(exported)) {
    throw shape(
      "the default export must be an object (export default { up(tx) { ... } } satisfies Migration)",
    );
  }
  const members = exported as Record<string, unknown>;
  for (const key of Object.keys(members)) {
    if (key !== "up" && key !== "renames" && key !== "renameCollections") {
      throw shape(
        `unknown key ${JSON.stringify(key)}; a migration has up, renames and renameCollections`,
      );
    }
  }
  if (members.up !== undefined && typeof members.up !== "function") {
    throw shape("up must be a function");
  }
  const renames = members.renames ?? {};
  if (!isPlainObject(renames)) {
    throw shape("renames must be an object: { <collection>: { <old field>: <new field> } }");
  }
  const renamesByCollection: Record<string, Record<string, string>> = {};
  for (const [collection, fields] of Object.entries(renames)) {
    if (!isPlainObject(fields) || !Object.values(fields).every((to) => typeof to === "string")) {
      throw shape(`renames.${collection} must map old field names to new ones`);
    }
    renamesByCollection[collection] = fields as Record<string, string>;
  }
  const renameCollections = members.renameCollections ?? {};
  if (
    !isPlainObject(renameCollections) ||
    !Object.values(renameCollections).every((to) => typeof to === "string")
  ) {
    throw shape("renameCollections must map old collection names to new ones");
  }
  return {
    file,
    up: typeof members.up === "function" ? (members.up as MigrationUp) : null,
    renames: renamesByCollection,
    renameCollections: renameCollections as Record<string, string>,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
