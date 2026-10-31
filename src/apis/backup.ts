// Upstream: apis/backup.go
//
// The handlers call the backups filesystem directly: it has no contexts
// (D5, src/tools/filesystem/filesystem.ts). backupRestore starts the restore
// off the request, as upstream's routine.FireAndForget.

import { backupCreate } from "@/apis/backup-create";
import { backupUpload } from "@/apis/backup-upload";
import { StoreKeyActiveBackup } from "@/apis/health";
import type { App } from "@/app/app";
import type { RequestEvent } from "@/app/event-request";
import { restoreBackup } from "@/backups/restore";
import { bodyLimit } from "@/middlewares/body-limit";
import { requireSuperuserAuth } from "@/middlewares/require-auth";
import { isIPInList } from "@/middlewares/superuser-ips-whitelist";
import { findAuthRecordByToken } from "@/records/record-query";
import { TokenTypeFile } from "@/records/record-tokens";
import type { Record } from "@/records/record-model";
import type { RouterGroup } from "@/server/group";
import type { HandlerResult } from "@/server/handler";
import { goBase } from "@/tools/filesystem/file";
import type { System } from "@/tools/filesystem/filesystem";
import { DateTime } from "@/tools/types/datetime";

// give some optimistic time to write the response before restarting the app
const restoreDelayMs = 1000;

// bindBackupApi registers the file api endpoints and the corresponding handlers.
export function bindBackupApi(_app: App, rg: RouterGroup<RequestEvent>): void {
  const sub = rg.group("/backups");
  sub.GET("", backupsList).bind(requireSuperuserAuth());
  sub.POST("", backupCreate).bind(requireSuperuserAuth());
  sub.POST("/upload", backupUpload).bind(bodyLimit(0), requireSuperuserAuth());
  sub.GET("/{key}", backupDownload); // relies on superuser file token
  sub.DELETE("/{key}", backupDelete).bind(requireSuperuserAuth());
  sub.POST("/{key}/restore", backupRestore).bind(requireSuperuserAuth());
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function backupsList(e: RequestEvent): HandlerResult {
  let fsys: System;
  try {
    fsys = e.app.filesystem.newBackupsFilesystem();
  } catch (err) {
    return e.badRequestError("Failed to load backups filesystem.", err);
  }

  try {
    let backups;
    try {
      backups = fsys.list("");
    } catch (err) {
      return e.badRequestError(
        "Failed to retrieve backup items. Raw error: \n" + errorText(err),
        null,
      );
    }

    return e.json(
      200,
      backups.map((obj) => ({
        modified: DateTime.fromDate(new Date(Number(obj.modTime / 1_000_000n))).string(),
        key: obj.key,
        size: obj.size,
      })),
    );
  } finally {
    fsys.close();
  }
}

function backupDownload(e: RequestEvent): HandlerResult {
  const fileToken = e.request.query().get("token")?.[0] ?? "";

  let authRecord: Record;
  try {
    authRecord = findAuthRecordByToken(e.app, fileToken, TokenTypeFile);
  } catch (err) {
    return e.forbiddenError("Insufficient permissions to access the resource.", err);
  }
  if (!authRecord.isSuperuser()) {
    return e.forbiddenError("Insufficient permissions to access the resource.", null);
  }

  const allowedIPs = e.app.settings.SuperuserIPs ?? [];
  if (allowedIPs.length > 0 && !isIPInList(allowedIPs, e.realIP())) {
    return e.forbiddenError("Insufficient permissions to access the resource.", null);
  }

  let fsys: System;
  try {
    fsys = e.app.filesystem.newBackupsFilesystem();
  } catch (err) {
    return e.internalServerError("Failed to load backups filesystem.", err);
  }

  try {
    const key = e.request.pathValue("key");

    try {
      fsys.serve(
        e.response,
        e.request,
        key,
        goBase(key), // without the path prefix (if any)
      );
    } catch (err) {
      return e.notFoundError("", err);
    }

    return undefined;
  } finally {
    fsys.close();
  }
}

function backupDelete(e: RequestEvent): HandlerResult {
  let fsys: System;
  try {
    fsys = e.app.filesystem.newBackupsFilesystem();
  } catch (err) {
    return e.internalServerError("Failed to load backups filesystem.", err);
  }

  try {
    const key = e.request.pathValue("key");

    if (key !== "" && e.app.store.get(StoreKeyActiveBackup) === key) {
      return e.badRequestError("The backup is currently being used and cannot be deleted.", null);
    }

    try {
      fsys.delete(key);
    } catch (err) {
      return e.badRequestError(
        "Invalid or already deleted backup file. Raw error: \n" + errorText(err),
        null,
      );
    }

    return e.noContent(204);
  } finally {
    fsys.close();
  }
}

function backupRestore(e: RequestEvent): HandlerResult {
  if (e.app.store.has(StoreKeyActiveBackup)) {
    return e.badRequestError(
      "Try again later - another backup/restore process has already been started.",
      null,
    );
  }

  const key = e.request.pathValue("key");

  let fsys: System;
  try {
    fsys = e.app.filesystem.newBackupsFilesystem();
  } catch (err) {
    return e.internalServerError("Failed to load backups filesystem.", err);
  }

  try {
    let exists = false;
    let existsErr: unknown = null;
    try {
      exists = fsys.exists(key);
    } catch (err) {
      existsErr = err;
    }
    if (!exists) {
      return e.badRequestError("Missing or invalid backup file.", existsErr);
    }
  } finally {
    fsys.close();
  }

  const { app } = e;

  setTimeout(() => {
    restoreBackup(app, key).catch((err: unknown) => {
      app.logger.error(`Failed to restore backup: ${key}`, err);
    });
  }, restoreDelayMs);

  return e.noContent(204);
}
