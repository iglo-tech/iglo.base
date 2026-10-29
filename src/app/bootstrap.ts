// Upstream: core/base.go (Bootstrap, ClearBootstrap, initDataDB, initAuxDB,
// LocalTempDirName)
//
// Bootstrap opens pb_data: it creates the data directory, opens data.db and
// auxiliary.db (with the read worker pool, D8), runs the system migrations
// check (src/migrations), loads the collections cache and removes the
// pb_data temp directory. Not here yet: the logger's `_logs` writes (M5),
// the settings load (ReloadSettings, M1.3; upstream's fresh install also
// writes the default settings row then) and the multi-instance notify
// watcher (`.notify`).
//
// ClearBootstrap is clearBootstrap: it closes the databases. On a failed
// bootstrap the databases are closed before the error is thrown.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { type App, type AppConfig, newApp } from "@/app/app";
import { loadCollectionsCache } from "@/collections/collection-save";
import { Databases, defaultReadWorkers } from "@/db/base";
import { runSystemMigrations } from "@/migrations/system-migrations";
import { Store } from "@/tools/store/store";

// temp pb_data sub directory that will be deleted on each app.Bootstrap()
export const LocalTempDirName = ".pb_temp_to_delete";

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
export function bootstrap(config: BootstrapConfig): App {
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
  });

  try {
    const result = runSystemMigrations(app);
    for (const warning of result.warnings) {
      config.warn?.(warning);
    }

    loadCollectionsCache(app);
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
// db connections). Resolves once the read worker threads have exited.
export async function clearBootstrap(app: App): Promise<void> {
  try {
    app.databases.close();
  } finally {
    await app.databases.closed();
  }
}
