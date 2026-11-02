// Upstream: core/base.go (initLogger, getLoggerMinLevel), the slog.Logger
// methods the app calls
//
// The app's logger. Logs wait in the BatchHandler's queue and reach `_logs`
// from a timer, at the batch size or when the app stops. A write is its own
// transaction on the auxiliary database, and a write that does not have to
// block runs from the event loop, so it is never inside a request's
// transaction (which is synchronous on the main thread, D8) and a rollback of
// one keeps its logs. It never touches data.db.
//
// There is one logger per bootstrapped app.

import type { AppLogger, App } from "@/app/app";
import type { Clock } from "@/app/clock";
import type { Databases } from "@/db/base";
import { generateDefaultRandomId } from "@/db/db";
import { newExp } from "@/db/dbx/expression";
import { auxVacuum } from "@/db/table";
import { auxRunInTransaction } from "@/db/tx";
import {
  BatchHandler,
  LevelDebug,
  LevelError,
  LevelInfo,
  LevelWarn,
  type Log,
  type LogAttrs,
} from "@/logs/batch-handler";
import { logDBExport, LogsTableName } from "@/logs/log-model";
import { formatLog } from "@/logs/log-printer";
import type { LogsConfig } from "@/settings/settings-model";
import { DateTime } from "@/tools/types/datetime";

const batchSize = 200;

const insertLogSQL = `INSERT INTO {{${LogsTableName}}} ([[id]], [[created]], [[level]], [[message]], [[data]]) VALUES ({:id}, {:created}, {:level}, {:message}, {:data})`;

// how long the queue may wait after the last log
const tickDuration = 3000;

// Go's time.Ticker as initLogger uses it: every log restarts the wait.
export interface LogTicker {
  reset(): void;
  stop(): void;
}

export type LogTickerFunc = (tick: () => void, ms: number) => LogTicker;

function defaultTicker(tick: () => void, ms: number): LogTicker {
  const timer = setTimeout(tick, ms);
  timer.unref();
  return {
    reset: () => void timer.refresh(),
    stop: () => clearTimeout(timer),
  };
}

export interface LoggerConfig {
  databases: Databases;
  // the app's logs settings, read at each use
  settings: () => LogsConfig;
  clock: Clock;
  isDev: boolean;
  // --dev: receives the printed logs
  print: (text: string) => void;
  // whether the printed logs may use ANSI colors
  color: boolean;
  // log.Println: a failed `_logs` write
  stderrLog: (line: string) => void;
  ticker?: LogTickerFunc;
}

// getLoggerMinLevel returns the logger min level based on the
// app configurations (dev mode, settings, etc.).
//
// If not in dev mode - returns the level from the app settings.
//
// If the app is in dev mode it returns -9999 level allowing to print
// practically all logs to the terminal.
// In this case DB logs are still filtered but the checks for the min level are done
// in the BatchOptions.BeforeAddFunc instead of the slog.Handler.Enabled() method.
function getLoggerMinLevel(isDev: boolean, logs: LogsConfig): number {
  return isDev ? -99999 : Number(logs.MinLevel);
}

export class Logger implements AppLogger {
  readonly #config: LoggerConfig;
  readonly #handler: BatchHandler;
  readonly #ticker: LogTicker;
  // batches waiting for their turn on the event loop
  readonly #pending = new Set<Log[]>();
  #stopped = false;

  constructor(config: LoggerConfig) {
    this.#config = config;
    this.#ticker = (config.ticker ?? defaultTicker)(() => this.#handler.writeAll(), tickDuration);
    this.#handler = new BatchHandler({
      level: getLoggerMinLevel(config.isDev, config.settings()),
      batchSize,
      beforeAddFunc: (log) => this.#beforeAdd(log),
      writeFunc: (logs, block) => {
        if (block) {
          this.#runLogsWrite(logs);
        } else {
          this.#writeLater(logs);
        }
      },
    });
  }

  debug(message: string, attrs?: LogAttrs): void {
    this.log(LevelDebug, message, attrs);
  }

  info(message: string, attrs?: LogAttrs): void {
    this.log(LevelInfo, message, attrs);
  }

  warn(message: string, attrs?: LogAttrs): void {
    this.log(LevelWarn, message, attrs);
  }

  error(message: string, attrs?: LogAttrs): void {
    this.log(LevelError, message, attrs);
  }

  log(level: number, message: string, attrs?: LogAttrs): void {
    if (this.#handler.enabled(level)) {
      this.#handler.handle({ time: this.#config.clock.now(), level, message, attrs });
    }
  }

  setLevel(logs: LogsConfig): void {
    this.#handler.setLevel(getLoggerMinLevel(this.#config.isDev, logs));
  }

  // attempt to write all queued logs before clearing the application
  // bootstrap state; later logs are dropped
  close(): void {
    if (this.#stopped) {
      return;
    }
    for (const logs of this.#pending) {
      this.#pending.delete(logs);
      this.#runLogsWrite(logs);
    }
    this.#handler.writeAll(true);
    this.#stopped = true;
    this.#ticker.stop();
  }

  #beforeAdd(log: Log): boolean {
    const { isDev, print, color } = this.#config;
    const settings = this.#config.settings();

    if (isDev) {
      print(formatLog(log, color));

      // manually check the log level and skip if necessary
      if (log.level < Number(settings.MinLevel)) {
        return false;
      }
    }

    if (!this.#stopped) {
      this.#ticker.reset();
    }

    return Number(settings.MaxDays) > 0;
  }

  // don't block and wait for the write transaction to complete
  #writeLater(logs: Log[]): void {
    this.#pending.add(logs);
    setImmediate(() => {
      if (this.#pending.delete(logs)) {
        this.#runLogsWrite(logs);
      }
    });
  }

  #runLogsWrite(logs: Log[]): void {
    const { databases, stderrLog } = this.#config;
    const settings = this.#config.settings();

    if (this.#stopped || Number(settings.MaxDays) === 0) {
      return;
    }

    // write the accumulated logs; a transaction that fails loses them, as
    // upstream ignores its error, and nothing here goes back to the logger
    try {
      auxRunInTransaction(databases, (txDatabases) => {
        const insert = txDatabases.auxNonconcurrentDB().newQuery(insertLogSQL).prepare();
        for (const log of logs) {
          try {
            const row = logDBExport(generateDefaultRandomId(), log, Number(settings.MaxDataSize));
            insert.bind(row).execute();
          } catch (err) {
            stderrLog(`Failed to write log ${log.message} ${String(err)}`);
          }
        }
        insert.close();
      });
    } catch {
      // see above
    }
  }
}

// __pbAppLoggerOnSettingsReload__: reloads the log handler level and tries to
// clear the old logs not matching the new settings.
export function logsSettingsReloaded(
  app: Pick<App, "logger" | "settings" | "clock" | "databases">,
): void {
  const logs = app.settings.Logs;

  app.logger.setLevel(logs);

  const createdBefore = DateTime.fromDate(app.clock.now()).addDate(0, 0, -Number(logs.MaxDays));
  const expr = newExp("[[created]] <= {:date} OR [[level]] < {:level}", {
    date: createdBefore.toString(),
    level: Number(logs.MinLevel),
  });
  try {
    app.databases.auxNonconcurrentDB().delete(LogsTableName, expr).execute();
  } catch (err) {
    app.logger.debug("Failed to cleanup old logs", { error: err });
  }

  // no logs are allowed -> try to reclaim preserved disk space after the previous delete operation
  if (Number(logs.MaxDays) === 0) {
    try {
      auxVacuum(app.databases);
    } catch (err) {
      app.logger.debug("Failed to VACUUM aux database", { error: err });
    }
  }
}
