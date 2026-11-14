// The development mode of serve (D40, S.6): the schema file follows the
// database and back. Not an upstream file.
//
//   - write-back: after a collection create, update, delete or import through
//     the dashboard or the collections API, the file is written from the
//     database (schemaFileText) and the types file is regenerated. The text
//     written is recorded first, so the watcher ignores this write.
//   - re-apply: a change of the schema file, or a new migration file in the
//     migrations directory, is applied with the same steps as at startup but
//     without the backup (applySchema with backup: false). A failure prints
//     the report and leaves the database as it was; the server keeps running
//     on the old schema, and the file is not recorded as applied.
//   - the write-back refuses to write over a file whose text the server has
//     not recorded (someone edited it and the change is not applied yet): the
//     edit would be lost. The message says so.
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
import { basename, dirname } from "node:path";

import type { App } from "@/app/app";
import { findAllCollections } from "@/collections/collection-query";
import type { Migration } from "@/migrations/migrations-runner";
import { applySchema, parseSchemaFile, SchemaApplyError } from "@/schema/apply";
import { schemaFileText } from "@/schema/file-text";
import { loadSchemaMigrations } from "@/schema/migration-files";
import { generateTypes } from "@/schema/typegen";
import { formatReport } from "@/schema/report";
import type { SchemaObject } from "@/schema/types";

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

// the schema file's state as the server last recorded it
interface Recorded {
  text: string;
  migrations: string;
}

export class SchemaSync {
  private recorded: Recorded | undefined;
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> = Promise.resolve();

  constructor(private readonly options: SyncOptions) {}

  // The file as it is now is applied: the server runs on it (startup, or the
  // first start of the process). Writes the types file too.
  adopt(text: string): void {
    this.recorded = { text, migrations: this.migrationsSignature() };
    this.writeTypes(this.options.app(), text);
  }

  // Called after a collection change through the API. Writes the file and the
  // types of the database; never throws (the change itself is done).
  writeBack(): void {
    const { schemaPath, schemaURL, log } = this.options;
    try {
      const app = this.options.app();
      const existing = existsSync(schemaPath) ? readFileSync(schemaPath, "utf8") : undefined;
      if (
        existing !== undefined &&
        this.recorded !== undefined &&
        existing !== this.recorded.text
      ) {
        log(
          `schema: ${basename(schemaPath)} has edits that are not applied; the database change is not written to it (apply or revert the file first)`,
        );
        return;
      }
      const result = schemaFileText(app, existing, schemaURL);
      for (const note of result.notes) {
        log(`schema: note: ${note}`);
      }
      if (existing !== result.text) {
        this.recorded = { text: result.text, migrations: this.migrationsSignature() };
        writeFileSync(schemaPath, result.text);
      }
      this.writeTypes(app, result.text);
    } catch (err) {
      log(`schema: writing ${basename(schemaPath)} failed: ${messageOf(err)}`);
    }
  }

  // Starts the watcher of the schema file's directory and of the migrations
  // directory. Changes are applied after a short pause, as editors save in
  // bursts. The returned function stops it.
  watchFiles(): () => void {
    const dirs = new Set([dirname(this.options.schemaPath)]);
    if (existsSync(this.options.migrationsDir)) {
      dirs.add(this.options.migrationsDir);
    }
    for (const dir of dirs) {
      this.watchers.push(
        watch(dir, () => {
          this.schedule();
        }),
      );
    }
    return () => {
      for (const watcher of this.watchers) {
        watcher.close();
      }
      this.watchers = [];
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

  // The apply of a changed file or a new migration. Our own write is the
  // recorded text, so it is not applied again.
  async reapply(): Promise<void> {
    const { schemaPath, log } = this.options;
    let text: string;
    try {
      text = readFileSync(schemaPath, "utf8");
    } catch (err) {
      log(`schema: cannot read ${basename(schemaPath)}: ${messageOf(err)}`);
      return;
    }
    const migrations = this.migrationsSignature();
    if (
      this.recorded !== undefined &&
      text === this.recorded.text &&
      migrations === this.recorded.migrations
    ) {
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
      this.recorded = { text, migrations };
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
      const detail = err instanceof SchemaApplyError ? formatReport(err.report) : messageOf(err);
      for (const line of detail.split("\n")) {
        log(`schema: ${line}`);
      }
      log(`schema: ${basename(schemaPath)} was not applied; the server keeps the old schema`);
    }
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

  // the names and modification times of the migration files: a new or
  // changed one changes the signature
  private migrationsSignature(): string {
    const dir = this.options.migrationsDir;
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      return "";
    }
    return readdirSync(dir)
      .filter((name) => name.endsWith(".ts"))
      .toSorted()
      .map((name) => `${name}@${statSync(`${dir}/${name}`).mtimeMs}`)
      .join("\n");
  }
}

const debounceMs = 200;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
