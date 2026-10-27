// Upstream: apis/middlewares.go (panicRecover)
//
// A thrown exception is iglo.base's equivalent of a Go panic (handlers
// return errors, see @/server/handler). It is turned into a 500 ApiError
// whose raw data holds the exception; the body never exposes it.

import type { RequestEvent } from "@/app/event-request";
import type { Handler } from "@/server/handler";
import {
  DefaultPanicRecoverMiddlewareId,
  DefaultPanicRecoverMiddlewarePriority,
} from "@/middlewares/middlewares";

export function panicRecover(): Handler<RequestEvent> {
  return {
    id: DefaultPanicRecoverMiddlewareId,
    priority: DefaultPanicRecoverMiddlewarePriority,
    func: async (e) => {
      try {
        return await e.next();
      } catch (recovered) {
        const recoverErr = recovered instanceof Error ? recovered : new Error(String(recovered));
        return e.internalServerError(
          "",
          new Error(`[PANIC RECOVER] ${recoverErr.message} ${recoverErr.stack ?? ""}`, {
            cause: recoverErr,
          }),
        );
      }
    },
  };
}
