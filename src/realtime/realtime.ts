// Upstream: apis/realtime.go (bindRealtimeApi, realtimeConnect,
// realtimeSubscribeForm, realtimeSetSubscriptions)
//
// The record and collection events are in realtime-events.ts.
//
// realtimeConnect: upstream's handler blocks until the connection ends,
// reading the client's channel. Here the handler returns the SSE stream as
// the response body, and the client's messages are written into the
// stream as they are sent. The stream ends as upstream's handler returns:
// after 5 minutes without a delivered message (IdleTimeout), after 30
// minutes in all (MaxTimeout), when the client goes away or is discarded
// (unregistered, or the server shuts down: closeRealtimeConnections). The
// timers are injected (RealtimeOptions) so tests do not sleep.
//
// Bun's server-wide idle timeout (10 s) would close an idle stream, so it
// is turned off for the realtime request only (upstream's
// SetWriteDeadline(time.Time{})).
//
// Deliberate difference (docs/design/04-api-compatibility.md, D27): the
// bytes a client has not read yet are counted, and a client with more than
// 8 MiB unsent is closed. Upstream holds an unbounded amount for it.
//
// Not ported: the OnRealtimeConnectRequest, OnRealtimeMessageSend and
// OnRealtimeSubscribeRequest hooks (D5).

import { requestEventKeySkipSuccessActivityLog } from "@/middlewares/activity-logger";
import type { App } from "@/app/app";
import type { RequestEvent } from "@/app/event-request";
import type { LogAttrs } from "@/logs/batch-handler";
import {
  clientAuthRecord,
  isSameAuth,
  RealtimeClientAuthKey,
  RealtimeClientIPKey,
  RealtimeOAuth2SubscriptionClientIPKey,
} from "@/realtime/realtime-events";
import type { RouterGroup } from "@/server/group";
import type { HandlerResult } from "@/server/handler";
import { sliceOf, structOf } from "@/server/unmarshal-request-data";
import { Client } from "@/tools/subscriptions/client";
import { Message } from "@/tools/subscriptions/message";
import { Each } from "@/validation/each";
import { Length } from "@/validation/length";
import { Required } from "@/validation/required";
import { Field, ValidateStruct } from "@/validation/struct";

// the connection timeouts of realtimeConnect (RealtimeConnectRequestEvent)
export const realtimeIdleTimeoutMs = 5 * 60 * 1000;
export const realtimeMaxTimeoutMs = 30 * 60 * 1000;

const cancelledRequestMessage = "Realtime connection closed (cancelled request)";

// the unsent bytes after which a client is closed (D27)
export const realtimeMaxQueuedBytes = 8 * 1024 * 1024;

// the stream's high water mark: what Bun may hold before the queue counts
const streamHighWaterMark = 64 * 1024;

const encoder = new TextEncoder();

// The timers of the realtime connections.
export interface RealtimeTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RealtimeOptions {
  // the global timers unless set
  timers?: RealtimeTimers;
}

const globalTimers: RealtimeTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// bindRealtimeApi registers the realtime api endpoints.
export function bindRealtimeApi(
  _app: App,
  rg: RouterGroup<RequestEvent>,
  options: RealtimeOptions = {},
): void {
  const timers = options.timers ?? globalTimers;
  const sub = rg.group("/realtime");
  sub.GET("", (e) => realtimeConnect(e, timers));
  sub.POST("", realtimeSetSubscriptions);
}

// oauth2SubscriptionTopic is the topic of the OAuth2 popup flow
// (apis/record_auth_with_oauth2_redirect.go).
export const oauth2SubscriptionTopic = "@oauth2";

// The realtime part of oauth2SubscriptionRedirect, for the
// /api/oauth2-redirect route: the client the OAuth2 state names,
// when it is still connected, subscribed to "@oauth2" and connected from
// realIP; undefined otherwise (upstream answers with its failure redirect).
export function findOAuth2RedirectClient(
  app: App,
  state: string,
  realIP: string,
): Client | undefined {
  let client: Client;
  try {
    client = app.subscriptionsBroker.clientById(state);
  } catch (err) {
    app.logger.warn("Missing or invalid OAuth2 subscription client", {
      error: err,
      clientId: state,
    });
    return undefined;
  }
  if (client.isDiscarded() || !client.hasSubscription(oauth2SubscriptionTopic)) {
    app.logger.warn("Missing or invalid OAuth2 subscription client", {
      error: null,
      clientId: state,
    });
    return undefined;
  }

  // additional check to minimize the risk of XSRF attack vectors
  //
  // note1: custom registered clients (aka. those without RealtimeClientIPKey in the store)
  // are excluded from the check for backward compatibility
  //
  // note2: the extra subscriptionClientIP check is performed as fallback
  // to minimize false-positives in case Google/Apple app reviewers use virtualized
  // devices with multiple network interfaces during the OAuth2 "All in one" flow
  // (https://ganigeorgiev.com/pocketbase/discussions/7758#comment-7ccdsr6gi1nd0y3)
  const connectionClientIP = stringValue(client.get(RealtimeClientIPKey));
  const subscriptionClientIP = stringValue(client.get(RealtimeOAuth2SubscriptionClientIPKey));
  if (
    connectionClientIP !== "" &&
    realIP !== connectionClientIP &&
    realIP !== subscriptionClientIP
  ) {
    // the subscription is removed in any case (upstream's deferred Unsubscribe)
    client.unsubscribe(oauth2SubscriptionTopic);
    app.logger.warn(
      "The client IP that completed the authentication is different from the one that initialized the OAuth2 realtime connection/subscription",
      { connectionClientIP, subscriptionClientIP, redirectClientIP: realIP },
    );
    return undefined;
  }

  return client;
}

// Sends the encoded OAuth2 redirect data (json.Marshal of
// oauth2RedirectData) to the client found by findOAuth2RedirectClient and
// removes its "@oauth2" subscription.
export function sendOAuth2Redirect(client: Client, encodedData: Uint8Array): void {
  client.send(new Message(oauth2SubscriptionTopic, encodedData));
  client.unsubscribe(oauth2SubscriptionTopic);
}

// the client store value as a string, "" when it is missing or not a string
// (Go's `client.Get(key).(string)`)
function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// closeRealtimeConnections ends every realtime stream of the app (graceful
// shutdown).
export function closeRealtimeConnections(app: App): void {
  const broker = app.subscriptionsBroker;
  for (const id of broker.clients().keys()) {
    broker.unregister(id);
  }
}

function realtimeConnect(e: RequestEvent, timers: RealtimeTimers): HandlerResult {
  // SkipSuccessActivityLog
  e.set(requestEventKeySkipSuccessActivityLog, true);

  // disable the server idle timeout for the SSE connection
  // (not supported in-process, where upstream falls back to the server's
  // WriteTimeout and only logs a warning)
  e.response.disableTimeout();

  e.response.header.set("Content-Type", "text/event-stream");
  e.response.header.set("Cache-Control", "no-store");
  // https://ganigeorgiev.com/pocketbase/discussions/480#discussioncomment-3657640
  // https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering
  e.response.header.set("X-Accel-Buffering", "no");

  const broker = e.app.subscriptionsBroker;
  const client = new Client();

  // could be used as an optional cross-reference check in other API endpoints
  client.set(RealtimeClientIPKey, e.realIP());

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  let idleTimer: unknown;
  let maxTimer: unknown;

  // ends the connection: closes the stream (error: aborts it, dropping
  // what is unsent) and unregisters the client
  const end = (error?: Error): void => {
    if (ended) {
      return;
    }
    ended = true;
    timers.clearTimeout(idleTimer);
    timers.clearTimeout(maxTimer);
    broker.unregister(client.id());
    try {
      if (error) {
        controller.error(error);
      } else {
        controller.close();
      }
    } catch {
      // the client went away
    }
  };

  // logs why the connection closed, then ends it
  const closed = (message: string, attrs: LogAttrs = {}): void => {
    if (ended) {
      return;
    }
    e.app.logger.debug(message, { clientId: client.id(), ...attrs });
    end();
  };

  // writes a message; false when the connection ended
  const write = (m: Message): boolean => {
    if (ended) {
      return false;
    }
    try {
      m.writeSSE((chunk) => controller.enqueue(chunk), client.id());
    } catch (err) {
      // the client went away
      closed(
        m === connectMessage
          ? "Realtime connection closed (failed to deliver PB_CONNECT)"
          : "Realtime connection closed (failed to deliver message)",
        { error: err },
      );
      return false;
    }
    const queued = streamHighWaterMark - (controller.desiredSize ?? 0);
    if (queued > realtimeMaxQueuedBytes) {
      end(new Error("realtime client unsent queue limit exceeded"));
      return false;
    }
    return true;
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      start: (c) => {
        controller = c;
      },
      cancel: () => {
        // connection is closed
        closed(cancelledRequestMessage);
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: streamHighWaterMark }),
  );

  // register new subscription client
  broker.register(client);

  e.app.logger.debug("Realtime connection established", { clientId: client.id() });

  // signalize established connection (aka. fire "connect" message)
  const connectMessage = new Message("PB_CONNECT", encoder.encode(`{"clientId":"${client.id()}"}`));
  write(connectMessage);

  if (!ended) {
    // start a max lifetime timer to prevent accumulating too much
    // connection resources and to allow the GC to run more regularly
    maxTimer = timers.setTimeout(() => closed(cancelledRequestMessage), realtimeMaxTimeoutMs);

    // start an idle timer to keep track of inactive/forgotten connections
    idleTimer = timers.setTimeout(() => closed(cancelledRequestMessage), realtimeIdleTimeoutMs);
  }

  client.listen({
    message: (m) => {
      if (write(m)) {
        timers.clearTimeout(idleTimer);
        idleTimer = timers.setTimeout(() => closed(cancelledRequestMessage), realtimeIdleTimeoutMs);
      }
    },
    // channel is closed
    discarded: () => closed("Realtime connection closed (closed channel)"),
  });

  return e.response.writeBody(stream);
}

const realtimeSubscribeFormType = structOf([
  { name: "ClientId", type: "string", tags: { form: "clientId", json: "clientId" } },
  {
    name: "Subscriptions",
    type: sliceOf("string"),
    tags: { form: "subscriptions", json: "subscriptions" },
  },
]);

interface RealtimeSubscribeForm {
  ClientId: string;
  Subscriptions: Array<string> | null;
}

function validateRealtimeSubscribeForm(form: RealtimeSubscribeForm): Error | null {
  return ValidateStruct(
    Field("clientId", form.ClientId, Required, Length(1, 255)),
    Field("subscriptions", form.Subscriptions, Length(0, 1000), Each(Length(0, 2500))),
  );
}

// note: in case of reconnect, clients will have to resubmit all subscriptions again
async function realtimeSetSubscriptions(e: RequestEvent): Promise<HandlerResult> {
  const form: RealtimeSubscribeForm = { ClientId: "", Subscriptions: null };

  const bindErr = await e.bindBody(
    form as unknown as { [key: string]: unknown },
    realtimeSubscribeFormType,
  );
  if (bindErr) {
    return e.badRequestError("", bindErr);
  }

  const validateErr = validateRealtimeSubscribeForm(form);
  if (validateErr) {
    return e.badRequestError("", validateErr);
  }

  // find subscription client
  let client: Client;
  try {
    client = e.app.subscriptionsBroker.clientById(form.ClientId);
  } catch (err) {
    return e.notFoundError("Missing or invalid client id.", err);
  }

  // for now allow only guest->auth upgrades and any other auth change is forbidden
  const clientAuth = clientAuthRecord(client);
  if (clientAuth !== undefined && !isSameAuth(clientAuth, e.auth)) {
    return e.forbiddenError(
      "The current and the previous request authorization don't match.",
      null,
    );
  }

  // update auth state
  client.set(RealtimeClientAuthKey, e.auth);

  // store the IP of the first "@oauth2" subscription request
  // to allow IP fallback checks in the redirect handler
  if (
    form.Subscriptions?.length === 1 &&
    form.Subscriptions[0] === oauth2SubscriptionTopic &&
    client.subscriptions().size === 0
  ) {
    client.set(RealtimeOAuth2SubscriptionClientIPKey, e.realIP());
  }

  // unsubscribe from any previous existing subscriptions
  client.unsubscribe();

  // subscribe to the new subscriptions
  client.subscribe(...(form.Subscriptions ?? []));

  e.app.logger.debug("Realtime subscriptions updated", {
    clientId: client.id(),
    subscriptions: form.Subscriptions ?? [],
  });

  // execAfterSuccessTx: the handler never runs in a transaction here
  return e.noContent(204);
}
