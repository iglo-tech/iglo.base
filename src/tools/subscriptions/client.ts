// Upstream: tools/subscriptions/client.go (DefaultClient)
//
// Upstream's Client interface has a single implementation and no other
// registration path here (no extension surface), so Client is the class.
//
// Go's unbuffered message channel becomes a receiver: the realtime
// connection that serves the client sets it with listen() and gets every
// sent message, in order, synchronously. Messages sent before a receiver is
// set wait for it, as Go's senders block until the channel is read.
// Discard calls the receiver's onDiscard instead of closing the channel.

import { snakecase } from "@/tools/inflector/inflector";
import { randomString } from "@/tools/security/random";
import { toString } from "@/tools/types/cast";
import { anyType, mapOf, unmarshalStruct } from "@/tools/types/go-json";
import { parseQuery } from "@/server/request";
import { Parse } from "@/validation/is/go-url";
import type { Message } from "@/tools/subscriptions/message";

const optionsParam = "options";

// SubscriptionOptions defines the request options (query params, headers, etc.)
// for a single subscription topic.
export interface SubscriptionOptions {
  query: { [key: string]: string };
  headers: { [key: string]: string };
}

export interface ClientReceiver {
  // receives every message sent to the client
  message(m: Message): void;
  // called once when the client is discarded
  discarded(): void;
}

// Client defines a generic subscription client.
export class Client {
  readonly #id: string;
  readonly #store = new Map<string, unknown>();
  readonly #subscriptions = new Map<string, SubscriptionOptions>();
  #receiver: ClientReceiver | null = null;
  // messages sent before a receiver is set
  #pending: Message[] = [];
  #isDiscarded = false;

  // NewDefaultClient creates and returns a new Client instance.
  constructor() {
    this.#id = randomString(40);
  }

  // Id returns the unique id of the client.
  id(): string {
    return this.#id;
  }

  // Channel: sets the receiver of the client's messages (the messages sent
  // so far are delivered to it first).
  listen(receiver: ClientReceiver): void {
    if (this.#isDiscarded) {
      receiver.discarded();
      return;
    }
    this.#receiver = receiver;
    const pending = this.#pending;
    this.#pending = [];
    for (const m of pending) {
      receiver.message(m);
    }
  }

  // Subscriptions returns a shallow copy of the client subscriptions matching the prefixes.
  // If no prefix is specified, returns all subscriptions.
  subscriptions(...prefixes: string[]): Map<string, SubscriptionOptions> {
    // no prefix -> return copy of all subscriptions
    if (prefixes.length === 0) {
      return new Map(this.#subscriptions);
    }

    const result = new Map<string, SubscriptionOptions>();

    for (const prefix of prefixes) {
      for (const [s, options] of this.#subscriptions) {
        // "?" ensures that the options query start character is always there
        // so that it can be used as an end separator when looking only for the main subscription topic
        if ((s + "?").startsWith(prefix)) {
          result.set(s, options);
        }
      }
    }

    return result;
  }

  // Subscribe subscribes the client to the provided subscriptions list.
  //
  // Each subscription can also have "options" (json serialized SubscriptionOptions) as query parameter.
  //
  // Example:
  //
  //	subscribe(
  //	    "subscriptionA",
  //	    `subscriptionB?options={"query":{"a":1},"headers":{"x_token":"abc"}}`,
  //	)
  //
  // Empty subscriptions (aka. "") are ignored.
  subscribe(...subs: string[]): void {
    for (const s of subs) {
      if (s === "") {
        continue; // skip empty
      }

      // extract subscription options (if any)
      // note: any instead of string to minimize the breaking changes with earlier versions
      let rawQuery: { [key: string]: unknown } | undefined;
      let rawHeaders: { [key: string]: unknown } | undefined;
      const raw = optionsQueryValue(s);
      if (raw !== "") {
        try {
          unmarshalStruct(
            raw,
            {
              query: (v) => (rawQuery = v as typeof rawQuery),
              headers: (v) => (rawHeaders = v as typeof rawHeaders),
            },
            { query: mapOf(anyType), headers: mapOf(anyType) },
            () => {},
          );
        } catch {
          // ignored as upstream does; the members decoded before the error are kept
        }
      }

      const options: SubscriptionOptions = { query: {}, headers: {} };

      // normalize query
      // (currently only single string values are supported for consistency with the default routes handling)
      for (const [k, v] of Object.entries(rawQuery ?? {})) {
        setOwn(options.query, k, toString(v));
      }

      // normalize headers name and values, eg. "X-Token" is converted to "x_token"
      // (currently only single string values are supported for consistency with the default routes handling)
      for (const [k, v] of Object.entries(rawHeaders ?? {})) {
        setOwn(options.headers, snakecase(k), toString(v));
      }

      this.#subscriptions.set(s, options);
    }
  }

  // Unsubscribe unsubscribes the client from the provided subscriptions list.
  //
  // If subs is not set, this method removes all registered client's subscriptions.
  unsubscribe(...subs: string[]): void {
    if (subs.length > 0) {
      for (const s of subs) {
        this.#subscriptions.delete(s);
      }
    } else {
      // unsubscribe all
      this.#subscriptions.clear();
    }
  }

  // HasSubscription checks if the client is subscribed to `sub`.
  hasSubscription(sub: string): boolean {
    return this.#subscriptions.has(sub);
  }

  // Get retrieves the key value from the client's context.
  get(key: string): unknown {
    return this.#store.get(key);
  }

  // Set stores any value to the client's context.
  set(key: string, value: unknown): void {
    this.#store.set(key, value);
  }

  // Unset removes a single value from the client's context.
  unset(key: string): void {
    this.#store.delete(key);
  }

  // Discard marks the client as "discarded" (and notifies its receiver),
  // meaning that it shouldn't be used anymore for sending new messages.
  //
  // It is safe to call Discard() multiple times.
  discard(): void {
    if (this.#isDiscarded) {
      return;
    }

    this.#isDiscarded = true;
    this.#pending = [];

    const receiver = this.#receiver;
    this.#receiver = null;
    receiver?.discarded();
  }

  // IsDiscarded indicates whether the client has been "discarded"
  // and should no longer be used.
  isDiscarded(): boolean {
    return this.#isDiscarded;
  }

  // Send sends the specified message to the client's receiver (if not discarded).
  send(m: Message): void {
    if (this.#isDiscarded) {
      return;
    }

    if (this.#receiver === null) {
      this.#pending.push(m);
      return;
    }

    this.#receiver.message(m);
  }
}

// url.Parse(s).Query().Get("options"): "" when s is not a valid URL
function optionsQueryValue(s: string): string {
  try {
    Parse(s);
  } catch {
    return "";
  }
  // Go's RawQuery: after the first "?", before the fragment
  const hash = s.indexOf("#");
  const beforeFragment = hash === -1 ? s : s.slice(0, hash);
  const q = beforeFragment.indexOf("?");
  if (q === -1) {
    return "";
  }
  return parseQuery(beforeFragment.slice(q + 1)).values.get(optionsParam)?.[0] ?? "";
}

// an own property, so keys like "__proto__" are kept as submitted
function setOwn(target: { [key: string]: string }, key: string, value: string): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
