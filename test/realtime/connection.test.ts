// Upstream: apis/realtime.go (realtimeConnect's idle and max timers),
// with the deliberate differences of docs/design/04-api-compatibility.md
// (Realtime): the 8 MiB unsent queue bound (D27) and Bun's idle timeout
// turned off on the realtime request only.
//
// In-process: the router with injected timers (no sleeping), the SSE
// stream read from its response, records changed through the API or
// inside a transaction.

import { afterAll, beforeAll, expect, test } from "bun:test";

import { newRouter } from "@/apis/base";
import { runInAppTransaction } from "@/collections/collection-query";
import { findCollectionByNameOrId } from "@/collections/collection-query";
import { Record } from "@/records/record-model";
import { saveRecordSync } from "@/records/record-save";
import {
  findOAuth2RedirectClient,
  realtimeIdleTimeoutMs,
  realtimeMaxTimeoutMs,
  type RealtimeTimers,
  sendOAuth2Redirect,
} from "@/realtime/realtime";
import { handleRequest } from "@/server/serve";
import type { Mux } from "@/server/router";

import { openFixtureApp, type TestApp } from "@test/app/app";
import { superuserToken } from "@test/scenarios/record-crud";
import { serveTest } from "@test/support/router";

// timers that fire only when advanced
class FakeTimers implements RealtimeTimers {
  now = 0;
  #next = 1;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.set(id, { at: this.now + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let first: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.#timers) {
        if (entry[1].at <= target && (!first || entry[1].at < first[1].at)) {
          first = entry;
        }
      }
      if (!first) {
        break;
      }
      this.#timers.delete(first[0]);
      this.now = first[1].at;
      first[1].fn();
    }
    this.now = target;
  }
}

// an SSE stream read from an in-process response
class Stream {
  readonly events: { event: string; data: string }[] = [];
  done = false;
  #text = "";

  constructor(readonly res: Response) {}

  static async open(mux: Mux): Promise<Stream> {
    const stream = new Stream(await serveTest(mux, { target: "/api/realtime" }));
    stream.#read();
    await stream.waitFor(1);
    return stream;
  }

  get clientId(): string {
    return (JSON.parse(this.events[0]?.data ?? "{}") as { clientId: string }).clientId;
  }

  async #read(): Promise<void> {
    const reader = (this.res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        this.#text += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = this.#text.indexOf("\n\n")) !== -1) {
          const block = this.#text.slice(0, end);
          this.#text = this.#text.slice(end + 2);
          const field = (name: string): string =>
            block
              .split("\n")
              .find((l) => l.startsWith(name + ":"))
              ?.slice(name.length + 1) ?? "";
          this.events.push({ event: field("event"), data: field("data") });
        }
      }
    } catch {
      // aborted
    }
    this.done = true;
  }

  async waitFor(count: number): Promise<void> {
    for (let i = 0; i < 200 && this.events.length < count && !this.done; i++) {
      await Bun.sleep(5);
    }
    expect(this.events.length).toBeGreaterThanOrEqual(count);
  }

  // lets the stream and the broadcast queue run
  async settle(): Promise<void> {
    await Bun.sleep(30);
  }
}

let app: TestApp;

beforeAll(async () => {
  app = await openFixtureApp();
});

afterAll(() => app.cleanup());

async function subscribe(mux: Mux, clientId: string, subscriptions: string[]): Promise<number> {
  const res = await serveTest(mux, {
    method: "POST",
    target: "/api/realtime",
    headers: { "content-type": "application/json", Authorization: superuserToken },
    body: JSON.stringify({ clientId, subscriptions }),
  });
  return res.status;
}

let created = 0;

async function create(mux: Mux, collection: string, data: object): Promise<void> {
  const res = await serveTest(mux, {
    method: "POST",
    target: `/api/collections/${collection}/records`,
    headers: { "content-type": "application/json", Authorization: superuserToken },
    body: JSON.stringify(data),
  });
  expect(res.status).toBe(200);
}

// demo2 titles are unique
function createDemo2(mux: Mux): Promise<void> {
  return create(mux, "demo2", { title: `realtime ${++created}` });
}

test("the idle timeout closes a stream after 5 minutes without a message", async () => {
  const timers = new FakeTimers();
  const mux = newRouter(app, { realtime: { timers } }).buildMux();
  const stream = await Stream.open(mux);
  const clientId = stream.clientId;
  expect(await subscribe(mux, clientId, ["demo2/*"])).toBe(204);

  timers.advance(realtimeIdleTimeoutMs - 1);
  await stream.settle();
  expect(stream.done).toBe(false);

  timers.advance(1);
  await stream.settle();
  expect(stream.done).toBe(true);
  expect(await subscribe(mux, clientId, [])).toBe(404);
});

test("a delivered message restarts the idle timer", async () => {
  const timers = new FakeTimers();
  const mux = newRouter(app, { realtime: { timers } }).buildMux();
  const stream = await Stream.open(mux);
  expect(await subscribe(mux, stream.clientId, ["demo2/*"])).toBe(204);

  timers.advance(4 * 60 * 1000);
  await createDemo2(mux);
  await stream.waitFor(2);

  timers.advance(4 * 60 * 1000);
  await stream.settle();
  expect(stream.done).toBe(false);

  timers.advance(60 * 1000);
  await stream.settle();
  expect(stream.done).toBe(true);
});

test("the max timeout closes an active stream after 30 minutes", async () => {
  const timers = new FakeTimers();
  const mux = newRouter(app, { realtime: { timers } }).buildMux();
  const stream = await Stream.open(mux);
  expect(await subscribe(mux, stream.clientId, ["demo2/*"])).toBe(204);

  let delivered = 1;
  while (timers.now + 4 * 60 * 1000 < realtimeMaxTimeoutMs) {
    timers.advance(4 * 60 * 1000);
    await createDemo2(mux);
    await stream.waitFor(++delivered);
  }
  expect(stream.done).toBe(false);

  timers.advance(realtimeMaxTimeoutMs - timers.now);
  await stream.settle();
  expect(stream.done).toBe(true);
  expect(await subscribe(mux, stream.clientId, [])).toBe(404);
});

test("a client with more than 8 MiB unsent is closed (D27)", async () => {
  const mux = newRouter(app).buildMux();
  const collection = await serveTest(mux, {
    method: "POST",
    target: "/api/collections",
    headers: { "content-type": "application/json", Authorization: superuserToken },
    body: JSON.stringify({
      name: "rt_big",
      type: "base",
      listRule: "",
      fields: [{ name: "body", type: "text", max: 2_000_000 }],
    }),
  });
  expect(collection.status).toBe(200);

  // never read: everything stays queued
  const res = await serveTest(mux, { target: "/api/realtime" });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toStartWith("id:");
  const clientId = (/^id:(\w+)/.exec(first) as RegExpExecArray)[1] as string;
  expect(await subscribe(mux, clientId, ["rt_big/*"])).toBe(204);

  // a reading client of the same topic gets everything
  const reading = await Stream.open(mux);
  expect(await subscribe(mux, reading.clientId, ["rt_big/*"])).toBe(204);

  const body = "x".repeat(1024 * 1024);
  for (let i = 0; i < 9; i++) {
    await create(mux, "rt_big", { body });
  }
  await reading.waitFor(10);
  await Bun.sleep(30);

  expect(await subscribe(mux, clientId, [])).toBe(404);
  expect(reading.done).toBe(false);
  await expect(
    (async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) {
          return "ended";
        }
      }
    })(),
  ).rejects.toThrow();
  expect(await subscribe(mux, reading.clientId, [])).toBe(204);
});

test("a record saved in a transaction is broadcast after the commit, never on rollback", async () => {
  const mux = newRouter(app).buildMux();
  const stream = await Stream.open(mux);
  expect(await subscribe(mux, stream.clientId, ["demo2/*"])).toBe(204);
  const demo2 = findCollectionByNameOrId(app, "demo2");

  // rolled back after the save
  expect(() =>
    runInAppTransaction(app, (txApp) => {
      const record = new Record(demo2);
      record.set("title", "rolled back");
      saveRecordSync(txApp, record);
      throw new Error("rollback");
    }),
  ).toThrow("rollback");
  await stream.settle();
  expect(stream.events.length).toBe(1);

  // committed: nothing is sent while the transaction runs
  let duringTx = -1;
  runInAppTransaction(app, (txApp) => {
    const record = new Record(demo2);
    record.set("title", "committed");
    saveRecordSync(txApp, record);
    duringTx = stream.events.length;
  });
  expect(duringTx).toBe(1);
  await stream.waitFor(2);
  expect(stream.events[1]?.data).toContain(`"title":"committed"`);
  expect(stream.events[1]?.data).toEndWith(`"action":"create"}`);
});

test("Bun's idle timeout is turned off for the realtime request only", async () => {
  const mux = newRouter(app).buildMux();
  // a 1 second server idle timeout instead of Bun's 10 s default
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 1,
    fetch: (request, s) =>
      handleRequest(app, mux, request, s.requestIP(request), () => s.timeout(request, 0)),
  });
  try {
    const res = await fetch(`${server.url}api/realtime`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toStartWith("id:");
    const next = reader.read();
    const outcome = await Promise.race([
      next.then(
        (r) => (r.done ? "closed" : "data"),
        () => "closed",
      ),
      Bun.sleep(2500).then(() => "open"),
    ]);
    expect(outcome).toBe("open");
    await reader.cancel();
  } finally {
    await server.stop(true);
  }
});

test("the OAuth2 redirect reaches the @oauth2 subscriber of the same IP once (for M4.5)", async () => {
  const mux = newRouter(app).buildMux();
  const stream = await Stream.open(mux);
  const other = await Stream.open(mux);
  expect(await subscribe(mux, stream.clientId, ["@oauth2"])).toBe(204);

  // not subscribed, unknown or from another IP
  expect(findOAuth2RedirectClient(app, other.clientId, "127.0.0.1")).toBeUndefined();
  expect(findOAuth2RedirectClient(app, "missing", "127.0.0.1")).toBeUndefined();

  const client = findOAuth2RedirectClient(app, stream.clientId, "127.0.0.1");
  expect(client).toBeDefined();
  sendOAuth2Redirect(
    client as NonNullable<typeof client>,
    new TextEncoder().encode(`{"state":"${stream.clientId}","code":"abc"}`),
  );
  await stream.waitFor(2);
  expect(stream.events[1]).toEqual({
    event: "@oauth2",
    data: `{"state":"${stream.clientId}","code":"abc"}`,
  });

  // the subscription is used once
  expect(findOAuth2RedirectClient(app, stream.clientId, "127.0.0.1")).toBeUndefined();

  // another IP fails and removes the subscription too
  expect(await subscribe(mux, stream.clientId, ["@oauth2"])).toBe(204);
  expect(findOAuth2RedirectClient(app, stream.clientId, "10.0.0.1")).toBeUndefined();
  expect(findOAuth2RedirectClient(app, stream.clientId, "127.0.0.1")).toBeUndefined();
});
