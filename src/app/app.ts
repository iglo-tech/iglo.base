// Upstream: core/app.go (the App interface; only the parts that exist so far)
//
// The app context passed to every module instead of process-global state.
// It carries only what exists now; later tasks add their fields (database
// handles M0.4, settings M1.3, store and backups M5.x) in their own change.

import type { Clock } from "@/app/clock";

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
}

export interface AppConfig {
  dataDir: string;
  isDev: boolean;
  encryptionEnv: string;
  queryTimeout: number;
  clock: Clock;
  logger: ErrorLogger;
}

export function newApp(config: AppConfig): App {
  return Object.freeze({ ...config });
}
