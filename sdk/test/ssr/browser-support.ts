// Shared helpers for the browser-side SSR unit tests (docs/design/13-ssr.md, "Browser client and
// realtime"): a stub iglo.base for fetch, an injected clock and fake timers. Nothing here sleeps.
import { dummyJWT } from "@sdk-test/mocks";

export const API = "http://localhost:8090";
export const APP = "http://localhost:3000";

/** The injected clock: milliseconds since the epoch, moved by the tests. */
export interface TestClock {
  now: number;
  (): number;
}

export function testClock(startMs: number): TestClock {
  const clock = (() => clock.now) as TestClock;
  clock.now = startMs;
  return clock;
}

/** A token shaped like the server's: `exp` in seconds and no `iat` claim. */
export function authToken(exp: number, id = "u1", collectionId = "users"): string {
  return dummyJWT({ exp, id, collectionId, type: "auth", refreshable: true });
}

/** A superuser token that cannot be refreshed, so no auto-refresh runs. */
export function superuserToken(exp: number): string {
  return dummyJWT({
    exp,
    id: "su1",
    collectionId: "_superusers",
    type: "auth",
    refreshable: false,
  });
}

export function record(id = "u1", collectionName = "users") {
  return { id, collectionId: collectionName, collectionName, email: `${id}@example.com` };
}

export interface Call {
  method: string;
  path: string;
  url: string;
  headers: Headers;
  body: unknown;
}

export type Handler = (call: Call) => Response | Promise<Response>;

/** A JSON answer whose `Date` header is the clock's time (the server clock, in the tests). */
export function json(clock: TestClock, status: number, body: unknown, headers?: HeadersInit) {
  const merged = new Headers(headers);
  merged.set("Content-Type", "application/json");
  merged.set("Date", new Date(clock()).toUTCString());
  return new Response(JSON.stringify(body), { status, headers: merged });
}

/**
 * A stub iglo.base. Routes are `METHOD /path`; an unrouted request fails the test. Every call
 * is recorded in `calls`.
 */
export function stubApi(clock: TestClock, routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: Call = {
      method,
      path: url.pathname,
      url: url.href,
      headers: new Headers(init?.headers),
      body,
    };
    calls.push(call);
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) {
      throw new Error(`no stub route for ${method} ${url.pathname}`);
    }
    return handler(call);
  };
  return { fetch, calls };
}

/** Timers the test runs by hand: `advance` fires every timer that is due, in order. */
export function fakeTimers(clock: TestClock) {
  let seq = 0;
  const pending = new Map<number, { due: number; fn: () => void }>();
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number): unknown => {
        seq++;
        pending.set(seq, { due: clock.now + ms, fn });
        return seq;
      },
      clearTimeout: (handle: unknown): void => {
        pending.delete(handle as number);
      },
    },
    /**
     * Moves the clock forward, running the timers that come due on the way. Each timer's
     * async work settles before the next one runs, and the clock reads the timer's due time
     * while that work runs.
     */
    async advance(ms: number): Promise<void> {
      const target = clock.now + ms;
      for (;;) {
        let nextId: number | undefined;
        let nextDue = Infinity;
        for (const [id, timer] of pending) {
          if (timer.due <= target && timer.due < nextDue) {
            nextId = id;
            nextDue = timer.due;
          }
        }
        if (nextId === undefined) {
          break;
        }
        const timer = pending.get(nextId);
        pending.delete(nextId);
        clock.now = Math.max(clock.now, nextDue);
        timer?.fn();
        await settle();
      }
      clock.now = target;
    },
    /** Delays (ms from now) of the timers still pending, in the order they were set. */
    delays(): number[] {
      return [...pending.values()].map((t) => t.due - clock.now);
    },
    get count(): number {
      return pending.size;
    },
  };
}

/** Lets pending promise callbacks and Response body reads settle (no timers involved). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
