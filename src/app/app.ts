// Upstream: core/app.go (the App interface; only the parts that exist so far)
//
// The app context passed to every module instead of process-global state.
// It carries only what exists now; later tasks add their fields in their
// own change. The databases,
// the runtime store (with the collections cache) and the clock make it a
// CollectionsApp (src/collections/collection-query.ts), so the collection
// and record functions take the app itself. bootstrap() (bootstrap.ts)
// builds the app that `serve` runs on.

import type { Clock } from "@/app/clock";
import { ThumbPool } from "@/files/thumb-pool";
import { type AppFilesystem, newAppFilesystem } from "@/app/filesystem";
import type { Databases } from "@/db/base";
import type { LogAttrs } from "@/logs/batch-handler";
import type { Mailer } from "@/mail/mailer";
import { newMailClient } from "@/mail/mail-client";
import { type LogsConfig, newDefaultSettings, type Settings } from "@/settings/settings-model";
import { Cron } from "@/tools/cron/cron";
import type { Store } from "@/tools/store/store";
import { Broker } from "@/tools/subscriptions/broker";

// The app's logger (src/logs/logger.ts): slog.Logger's calls, with the
// attributes as an object. Its logs are stored in `_logs`, and printed only
// with --dev. A log has no effect on the caller.
export interface AppLogger {
  debug(message: string, attrs?: LogAttrs): void;
  info(message: string, attrs?: LogAttrs): void;
  warn(message: string, attrs?: LogAttrs): void;
  error(message: string, attrs?: LogAttrs): void;
  // the logs settings changed
  setLevel(logs: LogsConfig): void;
  // writes the queued logs; called before the databases close
  close(): void;
  // writes the queued logs and stops the log writer thread; later logs wait
  // for resume (a backup or restore runs, D31)
  suspend(): Promise<void>;
  resume(): void;
}

// The part of the logger that the narrow app contexts use.
export type ErrorLogger = Pick<AppLogger, "debug" | "warn" | "error">;

export interface App {
  // DataDir returns the app data directory path (pb_data).
  readonly dataDir: string;
  // IsDev returns whether the app is in dev mode (--dev).
  readonly isDev: boolean;
  // EncryptionEnv returns the name of the app secret env key (--encryptionEnv).
  readonly encryptionEnv: string;
  // the default SELECT query timeout in seconds (--queryTimeout)
  readonly queryTimeout: number;
  readonly clock: Clock;
  readonly logger: AppLogger;
  // log.Println: a line on stderr, where upstream writes one
  readonly stderrLog?: (line: string) => void;
  // see CollectionsApp.afterTransaction
  readonly afterTransaction?: Promise<void>[];
  // DB, ConcurrentDB, AuxDB, ... of the opened pb_data (ClearBootstrap
  // closes them)
  readonly databases: Databases;
  // Store returns the app runtime store (the collections cache, the
  // active backup key).
  readonly store: Store<string, unknown>;
  // Settings returns the loaded app settings (src/settings; reloaded in
  // place by reloadSettings).
  readonly settings: Settings;
  // os.Getenv: the value of an environment variable, "" when unset (the
  // process environment, passed in by main.ts). Reads the settings
  // encryption key named by encryptionEnv.
  getenv(name: string): string;
  // NewFilesystem (pb_data/storage) and the storage cleanup after a
  // record or collection delete
  readonly filesystem: AppFilesystem;
  // NewMailClient creates a new SMTP or sendmail client from the current
  // settings (src/mail/mail-client.ts)
  newMailClient(): Mailer;
  // the file API's thumb generation: its limits and its lazily started
  // worker threads (src/files/thumb-pool.ts; ClearBootstrap stops them)
  readonly thumbs: ThumbPool;
  // SubscriptionsBroker returns the app realtime subscriptions broker
  // instance (src/realtime; serve closes its clients on shutdown).
  readonly subscriptionsBroker: Broker;
  // Cron returns the app cron instance (its built-in jobs are in
  // src/app/crons.ts; only serve starts it, ClearBootstrap stops it).
  readonly cron: Cron;
  // the migrations directory automigrate writes to (--automigrate,
  // plugins/migratecmd); undefined when it is off
  readonly automigrateDir?: string;
  // Restart restarts (aka. replaces) the current running application
  // process (src/cli/serve.ts): it stops the server and the app, then
  // execve. It returns only if that fails: revert has then run, on closed
  // databases, and the promise rejects while `serve` re-bootstraps.
  restart(revert: () => void): Promise<void>;
}

export interface AppConfig {
  dataDir: string;
  isDev: boolean;
  encryptionEnv: string;
  queryTimeout: number;
  clock: Clock;
  logger: AppLogger;
  databases: Databases;
  store: Store<string, unknown>;
  // the default settings (newDefaultSettings) unless set
  settings?: Settings;
  // log.Println: a line on stderr, where upstream writes one (a recovered
  // job panic, a failed `_logs` write); nowhere unless set
  stderrLog?: (line: string) => void;
  // an empty environment unless set
  getenv?: (name: string) => string;
  // the migrations directory, when --automigrate is on
  automigrateDir?: string;
  // Restart; outside `serve` it fails
  restart?: App["restart"];
}

async function notServing(revert: () => void): Promise<void> {
  revert();
  throw new Error("the app can restart only under serve");
}

export function newApp(config: AppConfig): App {
  const settings = config.settings ?? newDefaultSettings();
  const getenv = config.getenv ?? (() => "");
  return Object.freeze({
    ...config,
    settings,
    getenv,
    restart: config.restart ?? notServing,
    filesystem: newAppFilesystem({
      dataDir: config.dataDir,
      settings: () => settings,
      getenv,
      logger: config.logger,
    }),
    newMailClient: () => newMailClient(settings, config.clock, getenv),
    thumbs: new ThumbPool({ getenv }),
    subscriptionsBroker: new Broker(),
    cron: new Cron({
      clock: config.clock,
      // routine.FireAndForget
      logPanic: (cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        config.stderrLog?.(`[FireAndForget] RECOVERED FROM PANIC: ${message}`);
        if (cause instanceof Error && cause.stack !== undefined) {
          config.stderrLog?.(cause.stack);
        }
      },
    }),
  });
}
