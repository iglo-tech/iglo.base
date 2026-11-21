// Upstream: the built-in cron jobs of core/base.go (registerBaseHooks,
// initLogger), core/mfa_model.go and core/otp_model.go
//
// Registered once per app, in upstream's order: GET /api/crons lists the jobs
// in registration order. `__pbRateLimitersCleanup__` is added by the first
// limiter (src/middlewares/rate-limit.ts) and `__pbAutoBackup__` by
// loadAutobackupJob (src/backups/autobackup.ts).
// Only `serve` starts the ticker; the app's other commands register the jobs
// and never run them.

import type { App } from "@/app/app";
import { driverError } from "@/collections/driver-error";
import { auxVacuum } from "@/db/table";
import { countLogs, deleteOldLogs } from "@/logs/log-query";
import { deleteExpiredMFAs } from "@/records/mfa-query";
import { deleteExpiredOTPs } from "@/records/otp-query";
import { DateTime } from "@/tools/types/datetime";

export function registerCrons(app: App): void {
  app.cron.add("__pbDBOptimize__", "0 0 * * *", () => {
    // a checkpoint that a reader holds up is no error: SQLite reports it in
    // the pragma's result row, which upstream ignores too
    try {
      app.databases.nonconcurrentDB().newQuery("PRAGMA wal_checkpoint(TRUNCATE)").execute();
    } catch (error) {
      app.logger.warn("Failed to run periodic PRAGMA wal_checkpoint for the main DB", {
        error: driverError(error),
      });
    }

    try {
      app.databases.auxNonconcurrentDB().newQuery("PRAGMA wal_checkpoint(TRUNCATE)").execute();
    } catch (error) {
      app.logger.warn("Failed to run periodic PRAGMA wal_checkpoint for the auxiliary DB", {
        error: driverError(error),
      });
    }

    try {
      app.databases.nonconcurrentDB().newQuery("PRAGMA optimize").execute();
    } catch (error) {
      app.logger.warn("Failed to run periodic PRAGMA optimize", { error: driverError(error) });
    }
  });

  // run on every hour to cleanup expired mfa sessions
  app.cron.add("__pbMFACleanup__", "0 * * * *", async () => {
    try {
      await deleteExpiredMFAs(app);
    } catch (error) {
      app.logger.warn("Failed to delete expired MFA sessions", { error });
    }
  });

  // run on every hour to cleanup expired otp sessions
  app.cron.add("__pbOTPCleanup__", "0 * * * *", async () => {
    try {
      await deleteExpiredOTPs(app);
    } catch (error) {
      app.logger.warn("Failed to delete expired OTP sessions", { error });
    }
  });

  // cleanup old logs
  //
  // note: need to count before/after delete manually because drivers
  // are not required to support returning affected rows
  // ---
  // the logs deleted since the last VACUUM of the auxiliary db; the counter
  // belongs to this app, not to the process
  let totalDeletedSinceVacuum = 0;
  app.cron.add("__pbLogsCleanup__", "0 */6 * * *", () => {
    let oldCount = 0;
    try {
      oldCount = countLogs(app);
    } catch (error) {
      app.logger.warn("Failed to count logs before delete", { error });
    }

    try {
      deleteOldLogs(
        app,
        DateTime.fromDate(app.clock.now()).addDate(0, 0, -Number(app.settings.Logs.MaxDays)),
      );
    } catch (error) {
      app.logger.warn("Failed to delete old logs", { error });
    }

    let newCount = 0;
    try {
      newCount = countLogs(app);
    } catch (error) {
      app.logger.warn("Failed to count logs after delete", { error });
    }

    // try to free up unused disk space if a lot of logs have been deleted
    // (its racy but its ok in our use case as it is not expected to run frequently)
    totalDeletedSinceVacuum += Math.max(oldCount - newCount, 0);
    if (totalDeletedSinceVacuum >= 50_000) {
      totalDeletedSinceVacuum = 0;

      try {
        auxVacuum(app.databases);
      } catch (error) {
        app.logger.warn("Failed to VACUUM aux database after cleanup", { error });
      }
    }

    // force a checkpoint to minimize the risk of excessive wal file
    // growth due to slower delete or vacuum
    try {
      app.databases.auxNonconcurrentDB().newQuery("PRAGMA wal_checkpoint(TRUNCATE)").execute();
    } catch (error) {
      app.logger.warn("Failed to run PRAGMA wal_checkpoint after logs cleanup", {
        error: driverError(error),
      });
    }
  });
}
