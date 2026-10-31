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
// OnRealtimeSubscribeRequest hooks (D5) and the debug logs.

import type { App } from "@/app/app";
import type { RequestEvent } from "@/app/event-request";
import {
  clientAuthRecord,
  isSameAuth,
  RealtimeClientAuthKey,
  RealtimeClientIPKey,
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

// the unsent bytes after which a client is closed (D27)
export const realtimeMaxQueuedBytes = 8 * 1024 * 1024;

// the stream's high water mark: what Bun may hold before the queue counts
const streamHighWaterMark = 64 * 1024;

// requestEventKeySkipSuccessActivityLog (apis/middlewares.go): read by the
// activity logger (M5.5)
const requestEventKeySkipSuccessActivityLog = "__skipSuccessActivityLogger";

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
  } catch {
    return undefined;
  }
  if (client.isDiscarded() || !client.hasSubscription(oauth2SubscriptionTopic)) {
    return undefined;
  }

  // the client IP that completed the authentication must be the one that
  // initialized the OAuth2 realtime connection
  const clientIP = client.get(RealtimeClientIPKey);
  if (typeof clientIP === "string" && clientIP !== "" && clientIP !== realIP) {
    // the subscription is removed in any case (upstream's deferred Unsubscribe)
    client.unsubscribe(oauth2SubscriptionTopic);
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

  // writes a message; false when the connection ended
  const write = (m: Message): boolean => {
    if (ended) {
      return false;
    }
    try {
      m.writeSSE((chunk) => controller.enqueue(chunk), client.id());
    } catch {
      // the client went away
      end();
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
        end();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: streamHighWaterMark }),
  );

  // register new subscription client
  broker.register(client);

  // signalize established connection (aka. fire "connect" message)
  write(new Message("PB_CONNECT", encoder.encode(`{"clientId":"${client.id()}"}`)));

  if (!ended) {
    // start a max lifetime timer to prevent accumulating too much
    // connection resources and to allow the GC to run more regularly
    maxTimer = timers.setTimeout(() => end(), realtimeMaxTimeoutMs);

    // start an idle timer to keep track of inactive/forgotten connections
    idleTimer = timers.setTimeout(() => end(), realtimeIdleTimeoutMs);
  }

  client.listen({
    message: (m) => {
      if (write(m)) {
        timers.clearTimeout(idleTimer);
        idleTimer = timers.setTimeout(() => end(), realtimeIdleTimeoutMs);
      }
    },
    // channel is closed
    discarded: () => end(),
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
  Subscriptions: string[] | null;
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

  // for just in case to prevent someone changing a guest subscription
  //
  // note1: this is an extra precaution against clientId bruteforce attempts
  // for installations allowing longer realtime connections duration
  //
  // note2: custom registered clients (aka. those without IP in the store)
  // are excluded from the check for backward compatibility
  const clientIP = client.get(RealtimeClientIPKey);
  if (typeof clientIP === "string" && clientIP !== "" && clientIP !== e.realIP()) {
    return e.badRequestError(
      "Invalid realtime client.",
      new Error("the subscription request IP doesn't match with the realtime client IP"),
    );
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

  // unsubscribe from any previous existing subscriptions
  client.unsubscribe();

  // subscribe to the new subscriptions
  client.subscribe(...(form.Subscriptions ?? []));

  // execAfterSuccessTx: the handler never runs in a transaction here
  return e.noContent(204);
}
