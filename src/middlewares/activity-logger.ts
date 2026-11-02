// Upstream: apis/middlewares.go (activityLogger, logRequest,
// SkipSuccessActivityLog, RequestEventKeyLogMeta)

import type { RequestEvent } from "@/app/event-request";
import { cutBytes } from "@/logs/log-model";
import { ApiError, errorsAs } from "@/server/error";
import type { Handler, HandlerResult } from "@/server/handler";
import { unescapeBytes } from "@/server/mux";
import {
  DefaultActivityLoggerMiddlewareId,
  DefaultActivityLoggerMiddlewarePriority,
  DefaultSkipSuccessActivityLogMiddlewareId,
} from "@/middlewares/middlewares";

export const RequestEventKeyLogMeta = "pbLogMeta"; // extra data to store with the request activity log

const requestEventKeyExecStart = "__execStart"; // the value is Bun.nanoseconds()
export const requestEventKeySkipSuccessActivityLog = "__skipSuccessActivityLogger"; // the value must be bool

// SkipSuccessActivityLog is a helper middleware that instructs the global
// activity logger to log only requests that have failed/returned an error.
export function skipSuccessActivityLog(): Handler<RequestEvent> {
  return {
    id: DefaultSkipSuccessActivityLogMiddlewareId,
    func: (e) => {
      e.set(requestEventKeySkipSuccessActivityLog, true);
      return e.next();
    },
  };
}

// activityLogger middleware takes care to save the request information
// into the logs database.
//
// Note that the failed requests are logged even when the route has the
// SkipSuccessActivityLog middleware.
export function activityLogger(): Handler<RequestEvent> {
  return {
    id: DefaultActivityLoggerMiddlewareId,
    priority: DefaultActivityLoggerMiddlewarePriority,
    func: async (e) => {
      e.set(requestEventKeyExecStart, Bun.nanoseconds());

      const err = await e.next();

      // a log never fails the response it describes (routine.FireAndForget)
      try {
        logRequest(e, err);
      } catch (cause) {
        e.app.stderrLog?.(`[FireAndForget] RECOVERED FROM PANIC: ${String(cause)}`);
      }

      return err;
    },
  };
}

function cutStr(str: string, max: number): string {
  if (Buffer.byteLength(str) > max) {
    return cutBytes(str, max) + "...";
  }
  return str;
}

function logRequest(event: RequestEvent, result: HandlerResult): void {
  const err = result ?? undefined;

  // no logs retention
  if (Number(event.app.settings.Logs.MaxDays) === 0) {
    return;
  }

  // the non-error route has explicitly disabled the activity logger
  if (err === undefined && event.get(requestEventKeySkipSuccessActivityLog) !== undefined) {
    return;
  }

  const attrs: { [key: string]: unknown } = { type: "request" };

  const started = event.get(requestEventKeyExecStart);
  if (typeof started === "number") {
    attrs.execTime = (Bun.nanoseconds() - started) / 1e6;
  }

  const meta = event.get(RequestEventKeyLogMeta);
  if (meta !== undefined && meta !== null) {
    attrs.meta = meta;
  }

  let status = event.status();
  const request = event.request;
  const method = cutStr(request.method.toUpperCase(), 50);
  const requestUri = cutStr(
    request.rawQuery === "" ? request.escapedPath : `${request.escapedPath}?${request.rawQuery}`,
    3000,
  );

  // parse the request error
  if (err !== undefined) {
    const apiErr = errorsAs(err, ApiError);
    if (apiErr) {
      // the status header wasn't written yet
      if (status === 0) {
        status = apiErr.status;
      }

      attrs.error = err.message;
      attrs.details = apiErr.rawData();
    } else {
      attrs.error = err.message;
    }
  }

  attrs.url = requestUri;
  attrs.method = method;
  attrs.status = status;
  attrs.referer = cutStr(request.headers.get("Referer") ?? "", 2000);
  attrs.userAgent = cutStr(request.headers.get("User-Agent") ?? "", 2000);

  const { Logs } = event.app.settings;

  if (event.auth) {
    attrs.auth = event.auth.collection().name;

    if (Logs.LogAuthId) {
      attrs.authId = event.auth.id;
    }
  } else {
    attrs.auth = "";
  }

  if (Logs.LogIP) {
    attrs.userIP = event.realIP();
    attrs.remoteIP = event.remoteIP();
  }

  const message = `${method} ${unescapeBytes(requestUri) ?? requestUri}`;

  if (err !== undefined) {
    event.app.logger.error(message, attrs);
  } else {
    event.app.logger.info(message, attrs);
  }
}
