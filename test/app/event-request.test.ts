// Upstream: core/event_request_test.go
//
// Records and settings do not exist yet: the auth record is a stand-in with
// isSuperuser() and fresh(), and the trusted proxy scenarios of
// TestEventRequestRealIP move to M5.7 (settings.TrustedProxy).

import { describe, expect, test } from "bun:test";

import { newApp } from "@/app/app";
import {
  RequestEvent,
  RequestEventKeyInfoContext,
  RequestInfo,
  snakecase,
  type AuthRecord,
} from "@/app/event-request";
import { ResponseWriter } from "@/server/router";
import { newTestRequest, type TestRequest } from "@test/support/router";

class TestRecord implements AuthRecord {
  constructor(
    public id: string,
    readonly collectionName: string,
  ) {}

  isSuperuser(): boolean {
    return this.collectionName === "_superusers";
  }

  fresh(): TestRecord {
    return new TestRecord(this.id, this.collectionName);
  }
}

const app = newApp({
  dataDir: "/tmp/pb_data",
  isDev: false,
  encryptionEnv: "",
  queryTimeout: 30,
  clock: { now: () => new Date(0) },
  logger: { error: () => {} },
});

function newEvent(init: TestRequest): RequestEvent {
  return new RequestEvent(app, new ResponseWriter(), newTestRequest(init));
}

const testRequest: TestRequest = {
  method: "POST",
  target: "/test?q1=123&q2=456",
  headers: { "content-type": "application/json" },
  body: `{"a":123,"b":"test"}`,
};

function plain(info: RequestInfo): unknown {
  return {
    query: info.query,
    headers: info.headers,
    body: info.body,
    auth: (info.auth as TestRecord | undefined)?.id,
    method: info.method,
    context: info.context,
  };
}

test("RealIP without trusted proxy headers is the remote IP", () => {
  const e = newEvent({
    target: "/",
    remoteAddr: "127.0.0.1:80",
    headers: { "X-Forwarded-For": "1.2.3.4" },
  });
  expect(e.realIP()).toBe("127.0.0.1");
});

describe("HasSuperuserAuth", () => {
  const scenarios: [string, AuthRecord | undefined, boolean][] = [
    ["nil record", undefined, false],
    ["regular user record", new TestRecord("u", "users"), false],
    ["superuser record", new TestRecord("s", "_superusers"), true],
  ];
  for (const [name, record, expected] of scenarios) {
    test(name, () => {
      const e = newEvent({ target: "/" });
      e.auth = record;
      expect(e.hasSuperuserAuth()).toBe(expected);
    });
  }
});

test("RequestInfo", async () => {
  const e = newEvent({
    ...testRequest,
    headers: { ...testRequest.headers, "x-test": "test" },
  });
  e.set(RequestEventKeyInfoContext, "test");
  e.auth = new TestRecord("user1", "users");

  // init
  let info = await e.requestInfo();
  expect(info).toBeInstanceOf(RequestInfo);
  expect(plain(info as RequestInfo)).toEqual({
    query: { q1: "123", q2: "456" },
    headers: { content_type: "application/json", x_test: "test" },
    body: { a: 123, b: "test" },
    auth: "user1",
    method: "POST",
    context: "test",
  });

  // change user and context
  e.set(RequestEventKeyInfoContext, "test2");
  e.auth = new TestRecord("user2", "users");

  info = await e.requestInfo();
  expect(plain(info as RequestInfo)).toEqual({
    query: { q1: "123", q2: "456" },
    headers: { content_type: "application/json", x_test: "test" },
    body: { a: 123, b: "test" },
    auth: "user2",
    method: "POST",
    context: "test2",
  });
});

test("RequestInfo fails with the body binding error", async () => {
  const e = newEvent({ ...testRequest, body: "{" });
  expect(await e.requestInfo()).toBeInstanceOf(Error);
});

describe("RequestInfo.HasSuperuserAuth", () => {
  const e = newEvent(testRequest);
  const scenarios: [string, AuthRecord | undefined, boolean][] = [
    ["nil record", undefined, false],
    ["regular user record", new TestRecord("u", "users"), false],
    ["superuser record", new TestRecord("s", "_superusers"), true],
  ];
  for (const [name, record, expected] of scenarios) {
    test(name, async () => {
      e.auth = record;
      const info = (await e.requestInfo()) as RequestInfo;
      expect(info.hasSuperuserAuth()).toBe(expected);
    });
  }
});

test("RequestInfo.Clone", async () => {
  const e = newEvent(testRequest);
  e.auth = new TestRecord("user1", "users");

  const info = (await e.requestInfo()) as RequestInfo;
  const clone = info.clone();

  // modify the clone fields to ensure that it is a shallow copy
  clone.headers.new_header = "test";
  clone.query.new_query = "test";
  clone.body.new_body = "test";
  (clone.auth as TestRecord).id = "user2"; // should be a fresh copy of the record

  expect(plain(info)).toEqual({
    query: { q1: "123", q2: "456" },
    headers: { content_type: "application/json" },
    body: { a: 123, b: "test" },
    auth: "user1",
    method: "POST",
    context: "default",
  });

  expect(plain(clone)).toEqual({
    query: { new_query: "test", q1: "123", q2: "456" },
    headers: { content_type: "application/json", new_header: "test" },
    body: { a: 123, b: "test", new_body: "test" },
    auth: "user2",
    method: "POST",
    context: "default",
  });
});

// Upstream: tools/inflector/inflector_test.go (TestSnakecase)
describe("snakecase", () => {
  const scenarios: [string, string][] = [
    ["", ""],
    [" ", ""],
    ["!@#$%^", ""],
    ["...", ""],
    ["_", ""],
    ["John Doe", "john_doe"],
    ["John_Doe", "john_doe"],
    [".a!b@c#d$e%123. ", "a_b_c_d_e_123"],
    ["HelloWorld", "hello_world"],
    ["HelloWorld1HelloWorld2", "hello_world1_hello_world2"],
    ["TEST", "test"],
    ["testABR", "test_abr"],
  ];
  for (const [input, expected] of scenarios) {
    test(JSON.stringify(input), () => {
      expect(snakecase(input)).toBe(expected);
    });
  }
});

// Council findings on PR #3, checked against upstream's json/v2, mime and
// RequestInfo behavior.
describe("RequestInfo body and query edge cases", () => {
  for (const body of [`{"n":1e400}`, `{"n":[1,-1e400]}`]) {
    test(`JSON number out of float64 range fails: ${body}`, async () => {
      const e = newEvent({
        method: "POST",
        target: "/",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(await e.requestInfo()).toBeInstanceOf(Error);
    });
  }

  test("JSON number that underflows binds as 0", async () => {
    const e = newEvent({
      method: "POST",
      target: "/",
      headers: { "content-type": "application/json" },
      body: `{"n":1e-400}`,
    });
    const info = await e.requestInfo();
    expect(info).toBeInstanceOf(RequestInfo);
    expect((info as RequestInfo).body).toEqual({ n: 0 });
  });

  for (const contentType of [
    "application/x-www-form-urlencoded; broken",
    'application/x-www-form-urlencoded; charset="utf-8',
    "application/x-www-form-urlencoded; charset=a; charset=b",
    "application/x-www-form-urlencoded/x",
  ]) {
    test(`malformed media type fails form binding: ${contentType}`, async () => {
      const e = newEvent({
        method: "POST",
        target: "/",
        headers: { "content-type": contentType },
        body: "a=1",
      });
      expect(await e.requestInfo()).toBeInstanceOf(Error);
    });
  }

  for (const contentType of [
    "application/x-www-form-urlencoded;",
    "application/x-www-form-urlencoded; charset=utf-8; charset=utf-8",
    'application/x-www-form-urlencoded; charset="utf-8"',
  ]) {
    test(`valid media type binds the form: ${contentType}`, async () => {
      const e = newEvent({
        method: "POST",
        target: "/",
        headers: { "content-type": contentType },
        body: "a=1",
      });
      const info = await e.requestInfo();
      expect(info).toBeInstanceOf(RequestInfo);
      expect((info as RequestInfo).body).toEqual({ a: 1 });
    });
  }

  test("query keys like __proto__ are kept as submitted", async () => {
    const e = newEvent({ target: "/?__proto__=test&constructor=x" });
    const info = (await e.requestInfo()) as RequestInfo;
    expect(Object.hasOwn(info.query, "__proto__")).toBe(true);
    expect(info.query["__proto__"]).toBe("test");
    expect(info.query["constructor"]).toBe("x");
  });
});
