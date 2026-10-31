// Upstream: apis/record_auth_with_oauth2_redirect_test.go
//
// Upstream's test registers stub clients in Go; here they are real SSE
// streams (test/realtime/scenario.ts), so both servers can run them. The Go
// checks of a client's state become what a client can observe:
//
//   - "the @oauth2 subscription was removed": a second redirect for the same
//     client fails;
//   - "client with different IP": the redirect comes from the connection's
//     source address 127.0.0.2 instead of a trusted proxy header
//     (iglo.base reads the trusted proxy settings in M5.7);
//   - "discarded client with @oauth2 subscription": the stream was closed.
//
// The Apple name in the store is checked in-process
// (test/apis/record-auth-with-oauth2.test.ts). ExpectedEvents are dropped.

import { expect } from "bun:test";

import { type HttpResult, request } from "@test/realtime/client";
import {
  events,
  type Observation,
  type RealtimeScenario,
  type ScenarioContext,
} from "@test/realtime/scenario";
import type { RealtimeStream } from "@test/realtime/client";

const failure = "../_/#/auth/oauth2-redirect-failure";
const success = "../_/#/auth/oauth2-redirect-success";

const formHeaders = { "Content-Type": "application/x-www-form-urlencoded" };

function redirectResult(res: HttpResult): Observation {
  return { status: res.status, location: res.headers.get("location"), body: res.body };
}

function get(ctx: ScenarioContext, query: string, localAddress?: string): Promise<HttpResult> {
  return request(ctx.url, `/api/oauth2-redirect${query}`, { localAddress });
}

function post(
  ctx: ScenarioContext,
  body: string,
  headers: Record<string, string> = formHeaders,
): Promise<HttpResult> {
  return request(ctx.url, "/api/oauth2-redirect", { method: "POST", headers, body });
}

// a client subscribed to the topics
async function subscribed(ctx: ScenarioContext, ...topics: string[]): Promise<RealtimeStream> {
  const stream = await ctx.open();
  const res = await ctx.subscribe(stream.clientId, topics);
  if (res.status !== 204) {
    throw new Error(`subscribe: ${res.status} ${res.body}`);
  }
  return stream;
}

const urlEncoded = (values: Record<string, string>): string =>
  new URLSearchParams(values).toString();

function expectRedirect(o: Observation, status: number, location: string): void {
  expect(o["status"]).toBe(status);
  expect(o["location"]).toBe(location);
}

// runs one redirect for a client, then a second one that must fail because
// the subscription is gone
function clientScenario(
  name: string,
  topics: string[],
  send: (ctx: ScenarioContext, id: string) => Promise<HttpResult>,
  status: number,
  location: string,
  message?: (id: string) => string,
): RealtimeScenario {
  return {
    func: "TestRecordAuthWithOAuth2Redirect",
    name,
    run: async (ctx) => {
      const stream = await subscribed(ctx, ...topics);
      const id = stream.clientId;
      const first = redirectResult(await send(ctx, id));
      const second = redirectResult(await get(ctx, `?code=again&state=${id}`));
      return { first, second, id, messages: events(await stream.settle()) };
    },
    check(o) {
      expectRedirect(o["first"] as Observation, status, location);
      expectRedirect(o["second"] as Observation, 307, failure);
      const messages = o["messages"] as { event: string; data: string }[];
      expect(messages.map((m) => m.event)).toEqual(message ? ["@oauth2"] : []);
      if (message) {
        expect(messages[0]?.data).toBe(message(o["id"] as string));
      }
    },
  };
}

const appleUser = `{"name":{"firstName":"aaa","lastName":"${"b".repeat(200)}"}}`;

export const oauth2RedirectScenarios: RealtimeScenario[] = [
  {
    func: "TestRecordAuthWithOAuth2Redirect",
    name: "no state query param",
    run: async (ctx) => redirectResult(await get(ctx, "?code=123")),
    check: (o) => expectRedirect(o, 307, failure),
  },
  {
    func: "TestRecordAuthWithOAuth2Redirect",
    name: "invalid or missing client",
    run: async (ctx) => redirectResult(await get(ctx, "?code=123&state=missing")),
    check: (o) => expectRedirect(o, 307, failure),
  },
  clientScenario(
    "no code query param",
    ["test1", "@oauth2"],
    (ctx, id) => get(ctx, `?state=${id}`),
    307,
    failure,
    (id) => `{"state":"${id}","code":""}`,
  ),
  clientScenario(
    "error query param",
    ["test1", "@oauth2"],
    (ctx, id) => get(ctx, `?error=example&code=123&state=${id}`),
    307,
    failure,
    (id) => `{"state":"${id}","code":"123","error":"example"}`,
  ),
  {
    func: "TestRecordAuthWithOAuth2Redirect",
    name: "discarded client with @oauth2 subscription",
    run: async (ctx) => {
      const stream = await subscribed(ctx, "@oauth2");
      const id = stream.clientId;
      stream.close();
      // the client is unregistered once the server notices the closed stream
      for (let i = 0; i < 50 && (await ctx.subscribe(id, [])).status !== 404; i++) {
        await Bun.sleep(20);
      }
      return redirectResult(await get(ctx, `?code=123&state=${id}`));
    },
    check: (o) => expectRedirect(o, 307, failure),
  },
  {
    func: "TestRecordAuthWithOAuth2Redirect",
    name: "client without @oauth2 subscription",
    run: async (ctx) => {
      const stream = await subscribed(ctx, "test1", "test2");
      const result = redirectResult(await get(ctx, `?code=123&state=${stream.clientId}`));
      return { result, messages: events(await stream.settle()) };
    },
    check(o) {
      expectRedirect(o["result"] as Observation, 307, failure);
      expect(o["messages"]).toEqual([]);
    },
  },
  clientScenario(
    "client with @oauth2 subscription",
    ["test1", "@oauth2"],
    (ctx, id) => get(ctx, `?code=123&state=${id}`),
    307,
    success,
    (id) => `{"state":"${id}","code":"123"}`,
  ),
  clientScenario(
    "(POST) client with @oauth2 subscription",
    ["test1", "@oauth2"],
    (ctx, id) => post(ctx, urlEncoded({ code: "123", state: id })),
    303,
    success,
    (id) => `{"state":"${id}","code":"123"}`,
  ),
  clientScenario(
    "(POST) Apple user's name json (nameKey error)",
    ["test1", "@oauth2"],
    (ctx, id) => post(ctx, urlEncoded({ code: "a".repeat(986), state: id, user: appleUser })),
    303,
    success,
    (id) => `{"state":"${id}","code":"${"a".repeat(986)}"}`,
  ),
  clientScenario(
    "(POST) Apple user's name json",
    ["test1", "@oauth2"],
    (ctx, id) => post(ctx, urlEncoded({ code: "a".repeat(985), state: id, user: appleUser })),
    303,
    success,
    (id) => `{"state":"${id}","code":"${"a".repeat(985)}"}`,
  ),
  {
    func: "TestRecordAuthWithOAuth2Redirect",
    name: "client with different IP",
    run: async (ctx) => {
      const stream = await subscribed(ctx, "test1", "@oauth2");
      const id = stream.clientId;
      const result = redirectResult(await get(ctx, `?code=123&state=${id}`, "127.0.0.2"));
      // the subscription is removed in any case
      const again = redirectResult(await get(ctx, `?code=123&state=${id}`));
      return { result, again, messages: events(await stream.settle()) };
    },
    check(o) {
      expectRedirect(o["result"] as Observation, 307, failure);
      expectRedirect(o["again"] as Observation, 307, failure);
      expect(o["messages"]).toEqual([]);
    },
  },

  // beyond upstream's scenarios
  // -----------------------------------------------------------
  {
    func: "differential",
    name: "(POST) no state",
    run: async (ctx) => redirectResult(await post(ctx, urlEncoded({ code: "123" }))),
    check: (o) => expectRedirect(o, 303, failure),
  },
  {
    func: "differential",
    name: "(POST) unknown client",
    run: async (ctx) => redirectResult(await post(ctx, urlEncoded({ state: "missing" }))),
    check: (o) => expectRedirect(o, 303, failure),
  },
  {
    func: "differential",
    name: "(POST) an unreadable body",
    run: async (ctx) =>
      redirectResult(await post(ctx, `{"state"`, { "Content-Type": "application/json" })),
    check: (o) => expectRedirect(o, 303, failure),
  },
  clientScenario(
    "(POST) error in the form",
    ["@oauth2"],
    (ctx, id) => post(ctx, urlEncoded({ error: "denied", state: id })),
    303,
    failure,
    (id) => `{"state":"${id}","code":"","error":"denied"}`,
  ),
  clientScenario(
    "(POST) a JSON body, where the Apple user is ignored",
    ["@oauth2"],
    (ctx, id) =>
      post(ctx, JSON.stringify({ state: id, code: "123", user: appleUser }), {
        "Content-Type": "application/json",
      }),
    303,
    success,
    (id) => `{"state":"${id}","code":"123"}`,
  ),
  clientScenario(
    "(POST) the query string is not read",
    ["@oauth2"],
    (ctx, id) =>
      request(ctx.url, `/api/oauth2-redirect?state=${id}&code=fromquery`, {
        method: "POST",
        headers: formHeaders,
        body: urlEncoded({ state: id, code: "fromform" }),
      }),
    303,
    success,
    (id) => `{"state":"${id}","code":"fromform"}`,
  ),
  clientScenario(
    "the code is escaped in the message",
    ["@oauth2"],
    (ctx, id) => get(ctx, `?code=a%22b%3Cc%3E%26%C3%A9&state=${id}`),
    307,
    success,
    (id) => `{"state":"${id}","code":"a\\"b<c>&é"}`,
  ),
];
