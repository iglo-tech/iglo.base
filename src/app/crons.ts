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
import { deleteOldLogs } from "@/logs/log-query";
import { deleteExpiredMFAs } from "@/records/mfa-query";
import { deleteExpiredOTPs } from "@/records/otp-query";
import { DateTime } from "@/tools/types/datetime";

export function registerCrons(app: App): void {
  app.cron.add("__pbDBOptimize__", "0 0 * * *", () => {
    // a checkpoint that a reader holds up is no error: SQLite reports it in
    // the pragma's result row, which upstream ignores too
    try {
      app.databases.nonconcurrentDB().newQuery("PRAGMA wal_checkpoint(TRUNCATE)").execute();
    } catch (err) {
      app.logger.warn(
        "Failed to run periodic PRAGMA wal_checkpoint for the main DB",
        driverError(err),
      );
    }

    try {
      app.databases.auxNonconcurrentDB().newQuery("PRAGMA wal_checkpoint(TRUNCATE)").execute();
    } catch (err) {
      app.logger.warn(
        "Failed to run periodic PRAGMA wal_checkpoint for the auxiliary DB",
        driverError(err),
      );
    }

    try {
      app.databases.nonconcurrentDB().newQuery("PRAGMA optimize").execute();
    } catch (err) {
      app.logger.warn("Failed to run periodic PRAGMA optimize", driverError(err));
    }
  });

  // run on every hour to cleanup expired mfa sessions
  app.cron.add("__pbMFACleanup__", "0 * * * *", async () => {
    try {
      await deleteExpiredMFAs(app);
    } catch (err) {
      app.logger.warn("Failed to delete expired MFA sessions", err);
    }
  });

  // run on every hour to cleanup expired otp sessions
  app.cron.add("__pbOTPCleanup__", "0 * * * *", async () => {
    try {
      await deleteExpiredOTPs(app);
    } catch (err) {
      app.logger.warn("Failed to delete expired OTP sessions", err);
    }
  });

  // cleanup old logs
  app.cron.add("__pbLogsCleanup__", "0 */6 * * *", () => {
    try {
      deleteOldLogs(
        app,
        DateTime.fromDate(app.clock.now()).addDate(0, 0, -Number(app.settings.Logs.MaxDays)),
      );
    } catch (err) {
      app.logger.warn("Failed to delete old logs", err);
    }
  });
}
