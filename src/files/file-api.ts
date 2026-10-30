// Upstream: apis/file.go (bindFileApi, fileApi.fileToken, fileApi.download,
// fileApi.createThumb, imageContentTypes, defaultThumbSizes)
//
// The OnFileTokenRequest and OnFileDownloadRequest hooks are not ported (no
// extension surface, D5): their default actions run directly, so the
// download's ThumbError, which only a hook can read, is not kept. The
// thumb generation limits (singleflight, semaphore, PB_THUMBS_MAX_WORKERS,
// PB_THUMBS_MAX_WAIT) are the app's thumb pool (src/files/thumb-pool.ts,
// App.thumbs), whose Bun Workers decode, resize and encode off the main
// thread. Nothing here runs inside a database transaction.
//
// A failed thumb falls back to the original, as upstream. Upstream logs
// the failure as a warning in the app logs (`_logs`); the logs writer is
// M5.5, and until then the warning is not printed (no informational
// console output).

import type { App } from "@/app/app";
import {
  type RequestEvent,
  RequestInfo,
  RequestInfoContextProtectedFile,
} from "@/app/event-request";
import type { Collection } from "@/collections/collection-model";
import { findCachedCollectionByNameOrId } from "@/collections/collection-query";
import { findRecordByViewFile } from "@/collections/view";
import { HashExp } from "@/db/dbx/expression";
import { requireAuth } from "@/middlewares/require-auth";
import { collectionPathRateLimit } from "@/middlewares/rate-limit";
import { isIPInList } from "@/middlewares/superuser-ips-whitelist";
import type { Record } from "@/records/record-model";
import { findAuthRecordByToken, recordQuery, recordTarget } from "@/records/record-query";
import { canAccessRecordAsync } from "@/records/record-query-filter";
import { newFileToken, TokenTypeFile } from "@/records/record-tokens";
import type { RouterGroup } from "@/server/group";
import type { HandlerResult } from "@/server/handler";
import type { System } from "@/tools/filesystem/filesystem";

const imageContentTypes = ["image/png", "image/jpg", "image/jpeg", "image/gif", "image/webp"];
const defaultThumbSizes = ["100x100"];

// bindFileApi registers the file api endpoints and the corresponding handlers.
export function bindFileApi(_app: App, rg: RouterGroup<RequestEvent>): void {
  const sub = rg.group("/files");
  sub.POST("/token", fileToken).bind(requireAuth());
  sub
    .GET("/{collection}/{recordId}/{filename}", download)
    .bind(collectionPathRateLimit("", "file"));
}

function fileToken(e: RequestEvent): HandlerResult {
  // extra check for just in case the handler is called in a different context
  if (e.auth === undefined) {
    return e.unauthorizedError("Missing auth context.", null);
  }

  let token: string;
  try {
    token = newFileToken(e.auth, e.app.clock);
  } catch (err) {
    return e.internalServerError("Failed to generate file token", err);
  }

  // execAfterSuccessTx: the handler never runs in a transaction here
  return e.json(200, { token });
}

async function download(e: RequestEvent): Promise<HandlerResult> {
  let collection: Collection;
  try {
    collection = findCachedCollectionByNameOrId(e.app, e.request.pathValue("collection"));
  } catch {
    return e.notFoundError("", null);
  }

  const recordId = e.request.pathValue("recordId");
  if (recordId === "") {
    return e.notFoundError("", null);
  }

  // FindRecordById, read through the read pool
  let record: Record;
  try {
    record = await recordQuery(e.app, collection)
      .andWhere(new HashExp({ [collection.name + ".id"]: recordId }))
      .limit(1)
      .oneAsync<Record>(recordTarget);
  } catch (err) {
    return e.notFoundError("", err);
  }

  const filename = e.request.pathValue("filename");

  const fileField = record.findFileFieldByFile(filename);
  if (fileField === null) {
    return e.notFoundError("", null);
  }

  // check whether the request is authorized to view the protected file
  if (fileField.protected) {
    const originalRequestInfo = await e.requestInfo();
    if (originalRequestInfo instanceof Error) {
      return e.internalServerError("Failed to load request info", originalRequestInfo);
    }

    const token = e.request.query().get("token")?.[0] ?? "";
    let authRecord: Record | undefined;
    try {
      authRecord = findAuthRecordByToken(e.app, token, TokenTypeFile);
    } catch {
      authRecord = undefined;
    }

    // reset the auth state if it is superuser and it is not whitelisted
    // (not critical because file tokens are short-lived but checked nonetheless as an extra precaution)
    if (authRecord !== undefined && authRecord.isSuperuser()) {
      const allowedIPs = e.app.settings.SuperuserIPs ?? [];
      if (allowedIPs.length > 0 && !isIPInList(allowedIPs, e.realIP())) {
        authRecord = undefined;
      }
    }

    // create a shallow copy of the cached request data and adjust it to the current auth record (if any)
    const requestInfo = Object.assign(new RequestInfo(), originalRequestInfo);
    requestInfo.context = RequestInfoContextProtectedFile;
    requestInfo.auth = authRecord;

    let ok = false;
    try {
      ok = await canAccessRecordAsync(e.app, record, requestInfo, record.collection().viewRule);
    } catch {
      ok = false;
    }
    if (!ok) {
      return e.notFoundError("", new Error("insufficient permissions to access the file resource"));
    }
  }

  let baseFilesPath = record.baseFilesPath();

  // fetch the original view file field related record
  if (collection.isView()) {
    let fileRecord: Record;
    try {
      fileRecord = findRecordByViewFile(e.app, collection.id, fileField.getName(), filename);
    } catch (err) {
      return e.notFoundError(
        "",
        new Error(`failed to fetch view file field record: ${(err as Error).message}`, {
          cause: err,
        }),
      );
    }
    baseFilesPath = fileRecord.baseFilesPath();
  }

  let fsys: System;
  try {
    fsys = e.app.filesystem.newFilesystem();
  } catch (err) {
    return e.internalServerError("Filesystem initialization failure.", err);
  }

  try {
    const originalPath = baseFilesPath + "/" + filename;

    let servedPath = originalPath;
    let servedName = filename;

    // check for valid thumb size param
    const thumbSize = e.request.query().get("thumb")?.[0] ?? "";
    if (
      thumbSize !== "" &&
      (defaultThumbSizes.includes(thumbSize) || fileField.thumbs.includes(thumbSize))
    ) {
      // extract the original file meta attributes and check it existence
      let originalContentType: string;
      try {
        originalContentType = fsys.attributes(originalPath).contentType;
      } catch {
        // upstream passes the (nil) error of NewFilesystem
        return e.notFoundError("", null);
      }

      // check if it is an image
      if (imageContentTypes.includes(originalContentType)) {
        // add thumb size as file suffix
        servedName = thumbSize + "_" + filename;
        servedPath = baseFilesPath + "/thumbs_" + filename + "/" + servedName;

        // create a new thumb if it doesn't exist
        let exists = false;
        try {
          exists = fsys.exists(servedPath);
        } catch {
          exists = false;
        }
        if (!exists) {
          try {
            await createThumb(e.app, fsys, originalPath, servedPath, thumbSize);
          } catch {
            // fallback to the original (upstream logs a warning, see the
            // top of the file)
            servedName = filename;
            servedPath = originalPath;
          }
        }
      }
    }

    // clickjacking shouldn't be a concern when serving uploaded files,
    // so it safe to unset the global X-Frame-Options to allow files embedding
    // (note: it is out of the hook to allow users to customize the behavior)
    e.response.header.delete("X-Frame-Options");

    // execAfterSuccessTx: the handler never runs in a transaction here
    try {
      fsys.serve(e.response, e.request, servedPath, servedName);
    } catch (err) {
      return e.notFoundError("", err);
    }

    return undefined;
  } finally {
    fsys.close();
  }
}

// fileApi.createThumb: one generation per thumb path at a time, bounded
// by the app's thumb pool
function createThumb(
  app: App,
  fsys: System,
  originalPath: string,
  thumbPath: string,
  thumbSize: string,
): Promise<void> {
  return app.thumbs.generate(thumbPath, () =>
    fsys.createThumb(originalPath, thumbPath, thumbSize, (input, contentType, size) =>
      app.thumbs.render(input, contentType, size),
    ),
  );
}
