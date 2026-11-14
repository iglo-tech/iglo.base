// The development mode of serve (D40, S.6): the schema file follows the
// database and back. Not an upstream file.
//
//   - write-back: after a collection create, update, delete or import through
//     the dashboard or the collections API, the file is written from the
//     database (schemaFileText) and the types file is regenerated. The text
//     written is recorded, so the watcher ignores this write.
//   - re-apply: a change of the schema file's content, or of a TypeScript
//     migration file's content in the migrations directory, is applied with the
//     same steps as at startup but without the backup (applySchema with backup:
//     false). Any other change in those directories is ignored. A failure
//     prints the report once per content and modification time, and leaves the
//     database as it was; the server keeps running on the old schema. A save or
//     a touch of one of the files after a failure applies it again, so a fix
//     that is in the data (a duplicate deleted through the API) takes effect
//     without an edit of the text.
//   - watch: the schema file's directory is watched, and the migrations
//     directory when it exists. Its parent is watched too, so a migrations
//     directory made, removed or replaced after the start is noticed.
//   - the write-back refuses to write over a file whose text the server has
//     not recorded (someone edited it and the change is not applied yet): the
//     database change would be replaced by that edit. The message says so.
//
// The server never watches anything in production (--mode prod).

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import type { App } from "@/app/app";
import { findAllCollections } from "@/collections/collection-query";
import { applySchema, parseSchemaFile, SchemaApplyError } from "@/schema/apply";
import { schemaFileText } from "@/schema/file-text";
import { loadSchemaMigrations } from "@/schema/migration-files";
import { generateTypes } from "@/schema/typegen";
import { formatReport } from "@/schema/report";
import type { SchemaObject } from "@/schema/types";
import type { Migration } from "@/migrations/migrations-runner";

export interface SyncOptions {
  // the schema file, absolute
  schemaPath: string;
  // the TypeScript migrations directory, absolute
  migrationsDir: string;
  // whether the migrations directory was named by a flag (a missing one is an error then)
  migrationsNamed: boolean;
  // the types file, absolute; undefined: no types
  typesPath?: string;
  // the value of "$schema" in the written file
  schemaURL: string;
  // the JavaScript migrations of pb_migrations, as serve loaded them
  migrations: readonly Migration[];
  allowDataLoss: boolean;
  // a line on the terminal (standard error), with its time
  log: (line: string) => void;
  // the app of the running server (set after bootstrap)
  app: () => App;
}

// the state the server last applied or wrote: the hash of the schema text, and
// the signature of the migration files (migrationSignature). A write-back
// records only the schema: the migrations are not applied by it.
interface Recorded {
  schema: string;
  migrations: string;
}

// a watched directory, with its inode: a directory that is replaced is watched again
interface Watch {
  watcher: FSWatcher;
  ino: number;
}

export class SchemaSync {
  private recorded: Recorded | undefined;
  // the state of the last apply that failed (the content and the modification
  // times, see reapply): it is reported once
  private failed: string | undefined;
  private watches = new Map<string, Watch>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> = Promise.resolve();

  constructor(private readonly options: SyncOptions) {}

  // The file as it is now is applied: the server runs on it (startup, or the
  // first start of the process). Writes the types file too.
  adopt(text: string): void {
    this.recorded = { schema: hashOf(text), migrations: this.migrationSignature() };
    this.failed = undefined;
    this.writeTypes(this.options.app(), text);
  }

  // Called after a collection change through the API. Writes the file and the
  // types of the database; never throws (the change itself is done). `changed`
  // names the collections the change is to.
  writeBack(changed: readonly string[]): void {
    const { schemaPath, schemaURL, log } = this.options;
    try {
      const app = this.options.app();
      const existing = existsSync(schemaPath) ? readFileSync(schemaPath, "utf8") : undefined;
      if (
        existing !== undefined &&
        this.recorded !== undefined &&
        hashOf(existing) !== this.recorded.schema
      ) {
        log(
          `schema: the dashboard change to ${namesOf(changed)} will be replaced by the pending file edit: ${basename(schemaPath)} has edits that are not applied, and the file is the source of truth (apply or revert the edit, and make the change in the file)`,
        );
        return;
      }
      const result = schemaFileText(app, existing, schemaURL);
      for (const note of result.notes) {
        log(`schema: note: ${note}`);
      }
      if (existing !== result.text) {
        writeFileSync(schemaPath, result.text);
        // the watcher's event for this write arrives after this call, and
        // finds the schema recorded; the migrations keep their applied state,
        // so a migration that has not applied yet is still applied
        this.recorded = {
          schema: hashOf(result.text),
          migrations: this.recorded?.migrations ?? this.migrationSignature(),
        };
      }
      this.writeTypes(app, result.text);
    } catch (err) {
      log(`schema: writing ${basename(schemaPath)} failed: ${messageOf(err)}`);
    }
  }

  // Starts the watchers. Changes are applied after a short pause, as editors
  // save in bursts. The returned function stops them.
  watchFiles(): () => void {
    this.refreshWatches();
    return () => {
      for (const { watcher } of this.watches.values()) {
        watcher.close();
      }
      this.watches.clear();
      if (this.timer !== undefined) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
    };
  }

  private schedule(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // one apply at a time: the next one waits for this one
      this.running = this.running.then(() => this.reapply());
    }, debounceMs);
  }

  // The apply of a changed file or migration. The state the server recorded is
  // not applied again. A failed state is not reported again, until one of the
  // files is saved or touched: the modification times are part of that key
  // only, so the recorded content still counts as applied.
  async reapply(): Promise<void> {
    const { schemaPath, log } = this.options;
    let text: string;
    try {
      text = readFileSync(schemaPath, "utf8");
    } catch (err) {
      log(`schema: cannot read ${basename(schemaPath)}: ${messageOf(err)}`);
      return;
    }
    const schema = hashOf(text);
    const migrations = this.migrationSignature();
    if (
      this.recorded !== undefined &&
      this.recorded.schema === schema &&
      this.recorded.migrations === migrations
    ) {
      return;
    }
    const failedState = `${schema}\n${migrations}\n${this.modificationTimes()}`;
    if (this.failed === failedState) {
      return;
    }
    const app = this.options.app();
    try {
      const schemaMigrations = await loadSchemaMigrations(
        this.options.migrationsDir,
        this.options.migrationsNamed,
      );
      const report = await applySchema(app, text, {
        allowDataLoss: this.options.allowDataLoss,
        migrations: this.options.migrations,
        schemaMigrations,
        backup: false,
      });
      this.recorded = { schema, migrations };
      this.failed = undefined;
      this.writeTypes(app, text);
      if (report.changes.collections.length > 0 || report.migrations.length > 0) {
        log(`schema: applied ${basename(schemaPath)}`);
        for (const line of formatReport(report).split("\n")) {
          log(`schema: ${line}`);
        }
      }
    } catch (err) {
      // the report (or the file's problem, or a variable that is not set)
      // goes to the terminal; the database is unchanged
      this.failed = failedState;
      const detail = err instanceof SchemaApplyError ? formatReport(err.report) : messageOf(err);
      for (const line of detail.split("\n")) {
        log(`schema: ${line}`);
      }
      log(`schema: ${basename(schemaPath)} was not applied; the server keeps the old schema`);
    }
  }

  // Watches the schema file's directory, the migrations directory when it
  // exists, and the parent of the migrations directory (for its creation,
  // removal and replacement). A watch whose directory has another inode, or is
  // gone, is closed; a directory without a watch is watched.
  private refreshWatches(): void {
    const { schemaPath, migrationsDir, log } = this.options;
    const wanted = new Set([dirname(schemaPath), dirname(migrationsDir)]);
    if (isDirectory(migrationsDir)) {
      wanted.add(migrationsDir);
    }
    for (const [dir, entry] of this.watches) {
      if (!wanted.has(dir) || inodeOf(dir) !== entry.ino) {
        entry.watcher.close();
        this.watches.delete(dir);
      }
    }
    for (const dir of wanted) {
      const ino = inodeOf(dir);
      if (this.watches.has(dir) || ino === undefined) {
        continue;
      }
      try {
        const watcher = watch(dir, (_event, name) => this.onEvent(dir, name));
        this.watches.set(dir, { watcher, ino });
      } catch (err) {
        log(`schema: cannot watch ${dir}: ${messageOf(err)}`);
      }
    }
  }

  private onEvent(dir: string, name: string | null): void {
    this.refreshWatches();
    if (this.isRelevant(dir, name)) {
      this.schedule();
    }
  }

  // The events that can change what is applied: the schema file, a TypeScript
  // file of the migrations directory, and the migrations directory itself
  // appearing or going. Everything else in those directories (editor files,
  // logs) is ignored.
  private isRelevant(dir: string, name: string | null): boolean {
    const { schemaPath, migrationsDir } = this.options;
    if (name === null) {
      return true;
    }
    if (dir === dirname(schemaPath) && name === basename(schemaPath)) {
      return true;
    }
    if (dir === migrationsDir && name.endsWith(".ts")) {
      return true;
    }
    return dir === dirname(migrationsDir) && name === basename(migrationsDir);
  }

  // the types file of the applied (or written) schema, when it changed
  private writeTypes(app: App, text: string): void {
    const { typesPath, log } = this.options;
    if (typesPath === undefined) {
      return;
    }
    try {
      const collections = findAllCollections(app).map(
        (collection) => JSON.parse(collection.marshalJSON()) as SchemaObject,
      );
      const types = generateTypes(collections, parseSchemaFile(text));
      if (existsSync(typesPath) && readFileSync(typesPath, "utf8") === types) {
        return;
      }
      writeFileSync(typesPath, types);
    } catch (err) {
      log(`schema: writing the types failed: ${messageOf(err)}`);
    }
  }

  // The modification times of the schema file and of the TypeScript migration
  // files, in name order. Only a failed apply's key holds them: a save or a
  // touch retries the apply, and a file that is not one of these never gets here
  // (isRelevant).
  private modificationTimes(): string {
    const { schemaPath, migrationsDir } = this.options;
    const migrationFiles = isDirectory(migrationsDir)
      ? listTypeScript(migrationsDir).map((name) => join(migrationsDir, name))
      : [];
    return [schemaPath, ...migrationFiles].map(mtimeOf).join("\n");
  }

  // The TypeScript migration files of the directory, by name, each with a
  // content hash: a change of content changes it, and nothing else does (a
  // touched file does not).
  private migrationSignature(): string {
    const dir = this.options.migrationsDir;
    if (!isDirectory(dir)) {
      return "";
    }
    return listTypeScript(dir)
      .map((name) => `${name} ${hashOf(readOrEmpty(join(dir, name)))}`)
      .join("\n");
  }
}

const debounceMs = 200;

function hashOf(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

// a file's text, or "" when it cannot be read (it was removed meanwhile: the
// removal is an event of its own)
function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// a file's modification time in nanoseconds, or "" when it cannot be read
function mtimeOf(path: string): string {
  try {
    return String(statSync(path, { bigint: true }).mtimeNs);
  } catch {
    return "";
  }
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

// the names of the TypeScript files of a directory, in name order; a directory
// that goes away meanwhile has none
function listTypeScript(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith(".ts"))
      .toSorted();
  } catch {
    return [];
  }
}

function inodeOf(path: string): number | undefined {
  try {
    return statSync(path).ino;
  } catch {
    return undefined;
  }
}

// the collections a change is to, for the terminal
function namesOf(names: readonly string[]): string {
  return names.length > 0 ? names.join(", ") : "collections";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
