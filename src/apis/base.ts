// Upstream: apis/base.go (NewRouter, Static, safeRedirectPath),
// tools/router/event.go (FileFS) and the static route that
// examples/base/main.go registers on serve (--publicDir, --indexFallback).
//
// Every route and middleware is bound here; there is no other registration
// path (AGENTS.md "No extension surface").

import type { App } from "@/app/app";
import { RequestEvent } from "@/app/event-request";
import { bindBackupApi } from "@/apis/backup";
import { bindBatchApi } from "@/batch/batch";
import { bindCollectionApi } from "@/apis/collection";
import { bindCronApi } from "@/apis/cron";
import { bindFileApi } from "@/files/file-api";
import { bindHealthApi } from "@/apis/health";
import { bindLogsApi } from "@/apis/logs";
import { bindRecordAuthApi } from "@/apis/record-auth";
import type { RecordAuthOptions } from "@/apis/record-auth-with-oauth2";
import { bindRecordCrudApi, type RecordCrudOptions } from "@/apis/record-crud";
import { bindSettingsApi } from "@/apis/settings";
import { bindSQLApi } from "@/apis/sql";
import { activityLogger } from "@/middlewares/activity-logger";
import { bodyLimit } from "@/middlewares/body-limit";
import { loadAuthToken } from "@/middlewares/load-auth-token";
import { panicRecover } from "@/middlewares/panic-recover";
import { rateLimit } from "@/middlewares/rate-limit";
import { securityHeaders } from "@/middlewares/security-headers";
import { bindRealtimeApi, type RealtimeOptions } from "@/realtime/realtime";
import { superuserIPsWhitelist } from "@/middlewares/superuser-ips-whitelist";
import { requestEventKeySkipSuccessActivityLog } from "@/middlewares/activity-logger";
import { dirFS, type StaticFileSystem } from "@/apis/static-fs";
import { ErrFileNotFound, IndexPage } from "@/server/event";
import type { HandlerFunc, HandlerResult } from "@/server/handler";
import { cleanSlashPath } from "@/server/mux";
import { Router } from "@/server/router";
import { serveContent } from "@/server/serve-content";

// StaticWildcardParam is the name of Static handler wildcard parameter.
export const StaticWildcardParam = "path";

export interface RouterOptions {
  // the prebuilt binary's --publicDir and --indexFallback (the static route);
  // without it, every path the routes above leave is 404 "File not found."
  publicDir?: { dir: string; indexFallback: boolean };
  recordAuth?: RecordAuthOptions;
  recordCrud?: RecordCrudOptions;
  realtime?: RealtimeOptions;
}

// NewRouter returns a new router instance loaded with the default app
// middlewares and routes.
//
// options carries test seams of the bound handlers (the records list
// throttle's sleep, the realtime connection timers, the OAuth2 provider and
// avatar download). The executable sets none of them.
export function newRouter(app: App, options: RouterOptions = {}): Router<RequestEvent> {
  const pbRouter = new Router<RequestEvent>((w, r) => [new RequestEvent(app, w, r), undefined]);

  // register default middlewares
  pbRouter.bind(activityLogger());
  pbRouter.bind(panicRecover());
  pbRouter.bind(rateLimit());
  pbRouter.bind(loadAuthToken());
  pbRouter.bind(superuserIPsWhitelist());
  pbRouter.bind(securityHeaders());
  pbRouter.bind(bodyLimit()); // BodyLimit(DefaultMaxBodySize)

  // API routes
  const apiGroup = pbRouter.group("/api");
  bindSettingsApi(app, apiGroup);
  bindCollectionApi(app, apiGroup);
  bindRecordCrudApi(app, apiGroup, options.recordCrud);
  bindRecordAuthApi(app, apiGroup, options.recordAuth);
  bindLogsApi(app, apiGroup);
  bindBackupApi(app, apiGroup);
  bindCronApi(app, apiGroup);
  bindFileApi(app, apiGroup);
  bindBatchApi(app, apiGroup);
  bindRealtimeApi(app, apiGroup, options.realtime);
  bindHealthApi(app, apiGroup);
  bindSQLApi(app, apiGroup);

  // the prebuilt binary's static route to serve files from the provided
  // public dir (examples/base/main.go), bound after every other route; the
  // dashboard routes `serve` adds are more specific, so they keep priority
  if (!pbRouter.hasRoute("GET", "/{path...}")) {
    const publicDir = options.publicDir;
    pbRouter.GET(
      `/{${StaticWildcardParam}...}`,
      publicDir
        ? staticHandler(dirFS(publicDir.dir, app.dataDir), publicDir.indexFallback)
        : () => ErrFileNotFound,
    );
  }

  return pbRouter;
}

// safeRedirectPath normalizes the path string by replacing all beginning slashes
// (`\\`, `//`, `\/`) with a single forward slash to prevent open redirect attacks
export function safeRedirectPath(path: string): string {
  if (
    path.length > 1 &&
    (path[0] === "\\" || path[0] === "/") &&
    (path[1] === "\\" || path[1] === "/")
  ) {
    path = `/${path.replace(/^[/\\]+/, "")}`;
  }
  return path;
}

function baseName(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

// FileFS serves the specified filename from fsys (a directory serves its
// index.html), as http.ServeContent does.
async function fileFS(
  e: RequestEvent,
  fsys: StaticFileSystem,
  filename: string,
): Promise<HandlerResult> {
  const kind = fsys.stat(filename);
  if (kind === undefined) {
    return ErrFileNotFound;
  }

  // if it is a directory try to open its index.html file
  if (kind === "dir") {
    filename = filename === "." ? IndexPage : `${filename}/${IndexPage}`;
  }

  const file = fsys.open(filename);
  if (!file) {
    return ErrFileNotFound;
  }
  await serveContent(e.response, e.request, baseName(filename), file.content, file.modTime);
  return undefined;
}

// Static is a handler function to serve static directory content from fsys.
//
// If a file resource is missing and indexFallback is true, the request
// will be forwarded to the base index.html (useful for SPA with pretty urls).
//
// NB! Expects the route to have a "{path...}" wildcard parameter.
//
// Special redirects:
//   - if "path" is a file that ends in index.html, it is redirected to its non-index.html version (eg. /test/index.html -> /test/)
//   - if "path" is a directory that has index.html, the index.html file is rendered,
//     otherwise if missing - returns 404 or fallback to the root index.html if indexFallback is true
export function staticHandler(
  fsys: StaticFileSystem,
  indexFallback: boolean,
): HandlerFunc<RequestEvent> {
  return async (e) => {
    // disable the activity logger to avoid flooding with messages
    //
    // note: errors are still logged
    if (e.get(requestEventKeySkipSuccessActivityLog) === undefined) {
      e.set(requestEventKeySkipSuccessActivityLog, true);
    }

    let filename = e.request.pathValue(StaticWildcardParam);
    filename = cleanSlashPath(filename.startsWith("/") ? filename.slice(1) : filename);

    // eagerly check for directory traversal
    //
    // note: this is just out of an abundance of caution because the fs.FS implementation could be non-std,
    // but usually shouldn't be necessary since os.DirFS.Open is expected to fail if the filename starts with dots
    if (
      filename.length > 2 &&
      filename[0] === "." &&
      filename[1] === "." &&
      (filename[2] === "/" || filename[2] === "\\")
    ) {
      if (indexFallback && filename !== IndexPage) {
        return fileFS(e, fsys, IndexPage);
      }
      return ErrFileNotFound;
    }

    const kind = fsys.stat(filename);
    if (kind === undefined) {
      if (indexFallback && filename !== IndexPage) {
        return fileFS(e, fsys, IndexPage);
      }
      return ErrFileNotFound;
    }

    const urlPath = e.request.path;
    if (kind === "dir") {
      // redirect to a canonical dir url, aka. with trailing slash
      if (!urlPath.endsWith("/")) {
        return e.redirect(301, safeRedirectPath(`${urlPath}/`));
      }
    } else if (urlPath.endsWith("/")) {
      // redirect to a non-trailing slash file route
      const trimmed = urlPath.replace(/\/+$/, "");
      if (trimmed.length > 0) {
        return e.redirect(301, safeRedirectPath(trimmed));
      }
    } else if (urlPath.endsWith(IndexPage)) {
      // redirect without the index.html
      return e.redirect(301, safeRedirectPath(urlPath.slice(0, -IndexPage.length)));
    }

    const fileErr = await fileFS(e, fsys, filename);

    if (fileErr && indexFallback && filename !== IndexPage && fileErr === ErrFileNotFound) {
      return fileFS(e, fsys, IndexPage);
    }

    return fileErr;
  };
}
