// Upstream: core/base.go (Bootstrap, ClearBootstrap, initDataDB, initAuxDB)
//
// Bootstrap opens pb_data: it creates the data directory, opens data.db and
// auxiliary.db (with the read worker pool, D8), runs the system migrations
// check (src/migrations), loads the collections cache, loads the settings
// (ReloadSettings, src/settings; a pb_data without a settings row gets the
// default settings written, as upstream's fresh install does) and removes
// the pb_data temp directory. An existing data.db is checked without
// writing to pb_data first, so older data is refused before any file is
// created. Async because the settings may be encrypted (Web Crypto). Not
// here yet: the logger's `_logs` writes (M5) and the multi-instance notify
// watcher (`.notify`).
//
// ClearBootstrap is clearBootstrap: it stops the cron ticker, gives the jobs
// still running a moment to finish and closes the databases. On a failed
// bootstrap the databases are closed before the error is thrown.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { type App, type AppConfig, newApp } from "@/app/app";
import { registerCrons } from "@/app/crons";
import { LocalTempDirName } from "@/app/filesystem";
import { loadAutobackupJob } from "@/backups/autobackup";
import { loadCollectionsCache } from "@/collections/collection-save";
import { reloadSettings } from "@/settings/settings-query";
import { Databases, defaultReadWorkers } from "@/db/base";
import { checkExistingDataDir, runSystemMigrations } from "@/migrations/system-migrations";
import { Store } from "@/tools/store/store";

// how long clearBootstrap waits for running cron jobs; one that takes longer
// fails on the closed databases, into the log
const cronShutdownWaitMs = 5000;

export interface BootstrapConfig extends Omit<AppConfig, "databases" | "store"> {
  // the number of read workers (D8); defaultReadWorkers unless set
  readWorkers?: number;
  // --dev: receives every data.db statement
  devSQLLog?: (line: string) => void;
  // receives the warnings of the open (newer migrations), once each
  warn?: (message: string) => void;
}

// Bootstrap initializes the application
// (aka. create data dir, open db connections, load settings, etc.).
export async function bootstrap(config: BootstrapConfig): Promise<App> {
  // refuse older data before anything in pb_data is created or changed
  // (03-data-compatibility.md: the refusal writes nothing)
  checkExistingDataDir(config.dataDir);

  // ensure that data dir exist
  mkdirSync(config.dataDir, { recursive: true });

  const databases = Databases.open({
    dataDir: config.dataDir,
    queryTimeout: config.queryTimeout * 1000,
    readWorkers: config.readWorkers ?? defaultReadWorkers,
    devSQLLog: config.isDev ? config.devSQLLog : undefined,
  });

  const app = newApp({
    dataDir: config.dataDir,
    isDev: config.isDev,
    encryptionEnv: config.encryptionEnv,
    queryTimeout: config.queryTimeout,
    clock: config.clock,
    logger: config.logger,
    databases,
    store: new Store<string, unknown>(),
    settings: config.settings,
    getenv: config.getenv,
    automigrateDir: config.automigrateDir,
    restart: config.restart,
  });

  registerCrons(app);

  try {
    const result = runSystemMigrations(app);
    for (const warning of result.warnings) {
      config.warn?.(warning);
    }

    loadCollectionsCache(app);

    await reloadSettings(app);

    loadAutobackupJob(app);
  } catch (err) {
    try {
      databases.close();
    } catch {
      // the bootstrap error is the one reported
    }
    throw err;
  }

  // try to cleanup the pb_data temp directory (if any)
  try {
    rmSync(join(config.dataDir, LocalTempDirName), { recursive: true, force: true });
  } catch {
    // ignored, as upstream does
  }

  return app;
}

// ClearBootstrap releases the initialized core app resources (closing
// db connections, stopping cron ticker, stopping the thumb workers).
// Resolves once the read worker threads have exited.
export async function clearBootstrap(app: App): Promise<void> {
  app.cron.stop();
  await app.cron.waitForRunning(cronShutdownWaitMs);

  app.thumbs.close();
  try {
    app.databases.close();
  } finally {
    await app.databases.closed();
  }
}
