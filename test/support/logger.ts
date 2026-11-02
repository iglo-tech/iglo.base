// A logger that keeps nothing, or hands the warnings and errors to onLog with
// their `error` attribute. The real one (src/logs/logger.ts) writes to the
// databases of a bootstrapped app.

import type { AppLogger } from "@/app/app";

export function testLogger(onLog?: (message: string, cause: unknown) => void): AppLogger {
  const log = (message: string, attrs?: { [key: string]: unknown }): void => {
    onLog?.(message, attrs?.error);
  };
  return {
    debug: () => {},
    info: () => {},
    warn: log,
    error: log,
    setLevel: () => {},
    close: () => {},
    suspend: () => Promise.resolve(),
    resume: () => {},
  };
}
