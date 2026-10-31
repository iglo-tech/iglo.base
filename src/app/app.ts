// Upstream: core/app.go (the App interface; only the parts that exist so far)
//
// The app context passed to every module instead of process-global state.
// It carries only what exists now; later tasks add their fields
// (backups M5.x) in their own change. The databases,
// the runtime store (with the collections cache) and the clock make it a
// CollectionsApp (src/collections/collection-query.ts), so the collection
// and record functions take the app itself. bootstrap() (bootstrap.ts)
// builds the app that `serve` runs on.

import type { Clock } from "@/app/clock";
import { ThumbPool } from "@/files/thumb-pool";
import { type AppFilesystem, newAppFilesystem } from "@/app/filesystem";
import type { Databases } from "@/db/base";
import type { Mailer } from "@/mail/mailer";
import { newMailClient } from "@/mail/mail-client";
import { newDefaultSettings, type Settings } from "@/settings/settings-model";
import { Cron } from "@/tools/cron/cron";
import type { Store } from "@/tools/store/store";
import { Broker } from "@/tools/subscriptions/broker";

// Reports errors and things that need attention (AGENTS.md: no
// informational output).
export interface ErrorLogger {
  error(message: string, cause?: unknown): void;
}

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
  readonly logger: ErrorLogger;
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
  // Cron returns the app cron instance (the jobs M5.6 will run).
  readonly cron: Cron;
  // the migrations directory automigrate writes to (--automigrate,
  // plugins/migratecmd); undefined when it is off
  readonly automigrateDir?: string;
}

export interface AppConfig {
  dataDir: string;
  isDev: boolean;
  encryptionEnv: string;
  queryTimeout: number;
  clock: Clock;
  logger: ErrorLogger;
  databases: Databases;
  store: Store<string, unknown>;
  // the default settings (newDefaultSettings) unless set
  settings?: Settings;
  // an empty environment unless set
  getenv?: (name: string) => string;
  // the migrations directory, when --automigrate is on
  automigrateDir?: string;
}

export function newApp(config: AppConfig): App {
  const settings = config.settings ?? newDefaultSettings();
  const getenv = config.getenv ?? (() => "");
  return Object.freeze({
    ...config,
    settings,
    getenv,
    filesystem: newAppFilesystem({
      dataDir: config.dataDir,
      settings: () => settings,
      getenv,
      logger: config.logger,
    }),
    newMailClient: () => newMailClient(settings, config.clock, getenv),
    thumbs: new ThumbPool({ getenv }),
    subscriptionsBroker: new Broker(),
    cron: new Cron(),
  });
}
