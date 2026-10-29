// Upstream: apis/base.go (NewRouter, safeRedirectPath) and the static route
// that examples/base/main.go registers on serve.
//
// Every route and middleware is bound here; there is no other registration
// path (AGENTS.md "No extension surface").

import type { App } from "@/app/app";
import { RequestEvent } from "@/app/event-request";
import { bindHealthApi } from "@/apis/health";
import { bindRecordCrudApi, type RecordCrudOptions } from "@/apis/record-crud";
import { activityLogger } from "@/middlewares/activity-logger";
import { bodyLimit } from "@/middlewares/body-limit";
import { loadAuthToken } from "@/middlewares/load-auth-token";
import { panicRecover } from "@/middlewares/panic-recover";
import { rateLimit } from "@/middlewares/rate-limit";
import { securityHeaders } from "@/middlewares/security-headers";
import { superuserIPsWhitelist } from "@/middlewares/superuser-ips-whitelist";
import { ErrFileNotFound } from "@/server/event";
import { Router } from "@/server/router";

// StaticWildcardParam is the name of Static handler wildcard parameter.
export const StaticWildcardParam = "path";

export interface RouterOptions {
  recordCrud?: RecordCrudOptions;
}

// NewRouter returns a new router instance loaded with the default app
// middlewares and routes.
//
// options carries test seams of the bound handlers (the records list
// throttle's sleep).
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
  // settings, collections, auth, logs, backups, crons, files, batch,
  // realtime and SQL are bound by their own tasks, in upstream's order:
  // settings, collections, record crud, record auth, logs, backups, crons,
  // files, batch, realtime, health, SQL
  bindRecordCrudApi(app, apiGroup, options.recordCrud);
  bindHealthApi(app, apiGroup);

  // the prebuilt binary's static route (examples/base/main.go), bound after
  // every other route; serving --publicDir is M5.7
  if (!pbRouter.hasRoute("GET", "/{path...}")) {
    pbRouter.GET(`/{${StaticWildcardParam}...}`, () => ErrFileNotFound);
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
