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
  // (a UTF-16 unit is at most 3 bytes, so a short text needs no byte count)
  if (str.length * 3 > max && Buffer.byteLength(str) > max) {
    return cutBytes(str, max) + "...";
  }
  return str;
}

// benignErrors are usually returned after OK status has been already
// written and are mostly informative (aka. can be safely ignored).
//
// See https://ganigeorgiev.com/pocketbase/discussions/8361.
//
// The last one is what the response writer returns when the client went
// away mid-response (router.ts ResponseWriter.write), in place of Go's
// write errors.
const benignErrors = [
  "http2: request body closed due to handler exiting",
  "http2: stream closed",
  "write: broken pipe",
  "write error: client disconnected",
];

function canBeIgnored(err: Error | undefined): boolean {
  if (err === undefined) {
    return true;
  }

  return benignErrors.some((benign) => err.message.includes(benign));
}

function logRequest(event: RequestEvent, result: HandlerResult): void {
  const err = result ?? undefined;

  // no logs retention
  if (Number(event.app.settings.Logs.MaxDays) === 0) {
    return;
  }

  let status = event.status();

  // check if it is "benign" to decide whether to log it as error or just info
  const isOKState = status < 400 && status > 199 && canBeIgnored(err);

  // the OK route has explicitly disabled the activity logger
  if (isOKState && event.get(requestEventKeySkipSuccessActivityLog) !== undefined) {
    return;
  }

  const request = event.request;
  const method = cutStr(request.method.toUpperCase(), 50);
  const requestUri = cutStr(
    request.rawQuery === "" ? request.escapedPath : `${request.escapedPath}?${request.rawQuery}`,
    3000,
  );

  const attrs: { [key: string]: unknown } = {
    type: "request",
    url: requestUri,
    method,
    referer: cutStr(request.headers.get("Referer") ?? "", 2000),
    userAgent: cutStr(request.headers.get("User-Agent") ?? "", 2000),
  };

  // parse the request error state no matter of the log type
  if (err !== undefined) {
    const errMsgSuffix = isOKState ? " (often benign, see #8361)" : "";

    const apiErr = errorsAs(err, ApiError);
    if (apiErr) {
      // in case the status header wasn't written yet
      if (status === 0) {
        status = apiErr.status;
      }

      attrs.error = err.message + errMsgSuffix;
      attrs.details = apiErr.rawData();
    } else {
      attrs.error = err.message + errMsgSuffix;
    }
  }

  attrs.status = status;

  const started = event.get(requestEventKeyExecStart);
  if (typeof started === "number") {
    attrs.execTime = (Bun.nanoseconds() - started) / 1e6;
  }

  const meta = event.get(RequestEventKeyLogMeta);
  if (meta !== undefined && meta !== null) {
    attrs.meta = meta;
  }

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

  if (isOKState) {
    event.app.logger.info(message, attrs);
  } else {
    event.app.logger.error(message, attrs);
  }
}
