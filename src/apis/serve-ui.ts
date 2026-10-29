// Upstream: apis/serve.go (the /_/{path...} dashboard route, defaultCSP),
// apis/extensions.go (the /_ group with /_/extensions.js), apis/base.go
// (Static) and tools/router/event.go (FileFS), for the embedded dashboard
// build (@/apis/ui-pack).
//
// There are no dashboard extensions (D5, docs/design/04-api-compatibility.md):
// /_/extensions.js is always an empty script, kept for cached old builds,
// and /_/extensions/{name}/... is not a route, so it is the dashboard's 404.

import { safeRedirectPath, StaticWildcardParam } from "@/apis/base";
import type { StaticFS } from "@/apis/ui-pack";
import type { RequestEvent } from "@/app/event-request";
import { gzip } from "@/middlewares/gzip";
import { ErrFileNotFound, IndexPage } from "@/server/event";
import type { HandlerFunc, HandlerResult } from "@/server/handler";
import { cleanSlashPath } from "@/server/mux";
import type { Router } from "@/server/router";
import { serveContent } from "@/server/serve-content";

export const defaultCSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' http://127.0.0.1:* https://tile.openstreetmap.org data: blob:; connect-src 'self' http://127.0.0.1:* https://nominatim.openstreetmap.org; script-src 'self' http://127.0.0.1:*; frame-ancestors 'none'";

const cacheControl = "max-age=1209600, stale-while-revalidate=86400";

// requestEventKeySkipSuccessActivityLog (apis/middlewares.go), read by the
// activity logger (M5.5)
const requestEventKeySkipSuccessActivityLog = "__skipSuccessActivityLogger";

// fs.ValidPath: a slash-separated path without empty, "." or ".." elements
// (except "." itself), no leading or trailing slash.
function validPath(name: string): boolean {
  if (name === ".") {
    return true;
  }
  return name.split("/").every((elem) => elem !== "" && elem !== "." && elem !== "..");
}

function stat(fsys: StaticFS, name: string): "file" | "dir" | undefined {
  if (!validPath(name)) {
    return undefined;
  }
  if (fsys.isDir(name)) {
    return "dir";
  }
  return fsys.file(name) ? "file" : undefined;
}

function baseName(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

// FileFS serves the specified filename from fsys (a directory serves its
// index.html).
function fileFS(e: RequestEvent, fsys: StaticFS, filename: string): HandlerResult {
  let kind = stat(fsys, filename);
  if (kind === undefined) {
    return ErrFileNotFound;
  }

  // if it is a directory try to open its index.html file
  if (kind === "dir") {
    filename = filename === "." ? IndexPage : `${filename}/${IndexPage}`;
    kind = stat(fsys, filename);
    if (kind !== "file") {
      return ErrFileNotFound;
    }
  }

  const content = fsys.file(filename);
  if (!content) {
    return ErrFileNotFound;
  }
  serveContent(e.response, e.request, baseName(filename), content);
  return undefined;
}

// Static is a handler function to serve static directory content from fsys.
//
// If a file resource is missing and indexFallback is set, the request
// will be forwarded to the base index.html (useful for SPA with pretty urls).
export function staticHandler(fsys: StaticFS, indexFallback: boolean): HandlerFunc<RequestEvent> {
  return (e) => {
    // disable the activity logger to avoid flooding with messages
    //
    // note: errors are still logged
    if (e.get(requestEventKeySkipSuccessActivityLog) === undefined) {
      e.set(requestEventKeySkipSuccessActivityLog, true);
    }

    let filename = e.request.pathValue(StaticWildcardParam);
    filename = cleanSlashPath(filename.startsWith("/") ? filename.slice(1) : filename);

    // eagerly check for directory traversal
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

    const kind = stat(fsys, filename);
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

    const fileErr = fileFS(e, fsys, filename);

    if (fileErr && indexFallback && filename !== IndexPage && fileErr === ErrFileNotFound) {
      return fileFS(e, fsys, IndexPage);
    }

    return fileErr;
  };
}

// Binds the dashboard routes (Serve's /_/{path...} route and
// bindUIExtensions' /_ group), in upstream's order: after the router's own
// routes.
export function bindDashboard(router: Router<RequestEvent>, ui: StaticFS): void {
  router
    .GET(`/_/{${StaticWildcardParam}...}`, staticHandler(ui, false))
    .bindFunc((e) => {
      if (
        !e.app.isDev &&
        // exclude root path
        e.request.pathValue(StaticWildcardParam) !== "" &&
        !e.response.header.get("Cache-Control")
      ) {
        e.response.header.set("Cache-Control", cacheControl);
      }

      if (!e.response.header.get("Content-Security-Policy")) {
        e.response.header.set("Content-Security-Policy", defaultCSP);
      }

      return e.next();
    })
    .bind(gzip());

  const uiGroup = router
    .group("/_")
    .bindFunc((e) => {
      if (!e.app.isDev && !e.response.header.get("Cache-Control")) {
        e.response.header.set("Cache-Control", cacheControl);
      }

      if (!e.response.header.get("Content-Security-Policy")) {
        e.response.header.set("Content-Security-Policy", defaultCSP);
      }

      return e.next();
    })
    .bind(gzip());

  // the combined main.js of the extensions: there are none
  uiGroup
    .GET("/extensions.js", (e) =>
      e.stream(200, "text/javascript", new ReadableStream({ start: (c) => c.close() })),
    )
    .bindFunc((e) => {
      // SkipSuccessActivityLog
      e.set(requestEventKeySkipSuccessActivityLog, true);
      return e.next();
    });
}
