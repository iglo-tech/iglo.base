// Upstream: core/app.go (the App interface; only the parts that exist so far)
//
// The app context passed to every module instead of process-global state.
// It carries only what exists now; later tasks add their fields (settings
// M1.3, filesystem and backups M5.x) in their own change. The databases,
// the runtime store (with the collections cache) and the clock make it a
// CollectionsApp (src/collections/collection-query.ts), so the collection
// and record functions take the app itself. bootstrap() (bootstrap.ts)
// builds the app that `serve` runs on.

import type { Clock } from "@/app/clock";
import type { Databases } from "@/db/base";
import type { Store } from "@/tools/store/store";

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
}

export function newApp(config: AppConfig): App {
  return Object.freeze({ ...config });
}
