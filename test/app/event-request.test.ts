// Upstream: core/event_request_test.go
//
// TestEventRequestRealIP sends each header as two lines; Bun.serve hands
// the handler the lines joined with ", " (D22), so the requests here carry
// the joined values. The rightmost IP is upstream's either way; with
// useLeftmostIP the joined value's leftmost IP is the first line's, where
// upstream reads the last line's (the D22 consequence for RealIP).

import { afterAll, describe, expect, test } from "bun:test";

import {
  RequestEvent,
  RequestEventKeyInfoContext,
  RequestInfo,
  snakecase,
} from "@/app/event-request";
import { newAuthCollection } from "@/collections/collection-model";
import { newRecord, type Record } from "@/records/record-model";
import { ResponseWriter } from "@/server/router";
import { newTestRequest, type TestRequest } from "@test/support/router";
import { openFixtureApp } from "@test/app/app";

// an auth record of a new auth collection with the given name
function authRecord(id: string, collectionName: string): Record {
  const record = newRecord(newAuthCollection(collectionName));
  record.id = id;
  return record;
}

const app = await openFixtureApp({ clock: { now: () => new Date(0) } });
afterAll(() => app.cleanup());

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
    auth: info.auth?.id,
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
  const scenarios: [string, Record | undefined, boolean][] = [
    ["nil record", undefined, false],
    ["regular user record", authRecord("u", "users"), false],
    ["superuser record", authRecord("s", "_superusers"), true],
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
  e.auth = authRecord("user1", "users");

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
  e.auth = authRecord("user2", "users");

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
  const scenarios: [string, Record | undefined, boolean][] = [
    ["nil record", undefined, false],
    ["regular user record", authRecord("u", "users"), false],
    ["superuser record", authRecord("s", "_superusers"), true],
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
  e.auth = authRecord("user1", "users");

  const info = (await e.requestInfo()) as RequestInfo;
  const clone = info.clone();

  // modify the clone fields to ensure that it is a shallow copy
  clone.headers.new_header = "test";
  clone.query.new_query = "test";
  (clone.body as { [key: string]: unknown }).new_body = "test";
  (clone.auth as Record).id = "user2"; // should be a fresh copy of the record

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

async function bodyOf(contentType: string, body: string): Promise<unknown> {
  const e = newEvent({
    method: "POST",
    target: "/",
    headers: { "content-type": contentType },
    body,
  });
  const info = await e.requestInfo();
  return info instanceof Error ? info : info.body;
}

const urlencoded = "application/x-www-form-urlencoded";
const payload = (json: string): string => `%40jsonPayload=${encodeURIComponent(json)}`;

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

  // round 2
  test("repeated @jsonPayload objects merge into existing map values", async () => {
    expect(
      await bodyOf(urlencoded, `${payload(`{"a":{"x":1}}`)}&${payload(`{"a":{"y":2},"b":[1]}`)}`),
    ).toEqual({ a: { x: 1, y: 2 }, b: [1] });
  });

  test("an existing slice value is replaced", async () => {
    expect(await bodyOf(urlencoded, `a=1&a=2&${payload(`{"a":[3]}`)}`)).toEqual({ a: [3] });
  });

  test("an existing value keeps its type", async () => {
    expect(await bodyOf(urlencoded, `a=x&${payload(`{"a":"y"}`)}`)).toEqual({ a: "y" });
    expect(await bodyOf(urlencoded, `a=1&${payload(`{"a":2}`)}`)).toEqual({ a: 2 });
    expect(await bodyOf(urlencoded, `a=true&${payload(`{"a":false}`)}`)).toEqual({ a: false });
    // a null resets it, so any type fits afterwards
    expect(
      await bodyOf(urlencoded, `a=1&${payload(`{"a":null}`)}&${payload(`{"a":"x"}`)}`),
    ).toEqual({ a: "x" });
    for (const body of [
      `a=1&${payload(`{"a":"x"}`)}`,
      `a=x&${payload(`{"a":1}`)}`,
      `a=true&${payload(`{"a":"true"}`)}`,
      `a=1&a=2&${payload(`{"a":{"x":1}}`)}`,
      `${payload(`{"a":{"x":1}}`)}&${payload(`{"a":[1]}`)}`,
      `${payload(`{"a":{"x":1}}`)}&${payload(`{"a":{"x":"y"}}`)}`,
    ]) {
      expect(await bodyOf(urlencoded, body)).toBeInstanceOf(Error);
    }
  });

  test("a top-level JSON null gives a null body", async () => {
    expect(await bodyOf(urlencoded, `a=1&${payload("null")}`)).toBeNull();
    expect(await bodyOf(urlencoded, `a=1&${payload("null")}&${payload(`{"b":2}`)}`)).toEqual({
      b: 2,
    });
    expect(await bodyOf("application/json", "null")).toBeNull();
    expect(await bodyOf("application/json", "  null  ")).toBeNull();

    const e = newEvent({
      method: "POST",
      target: "/",
      headers: { "content-type": "application/json" },
      body: "null",
    });
    const info = (await e.requestInfo()) as RequestInfo;
    expect(info.clone().body).toBeNull();
  });

  for (const contentType of [
    "multipart/form-data; boundary*=utf-8''XYZ",
    "multipart/form-data; boundary*=UTF-8'en'X%59Z",
    "multipart/form-data; boundary*0=XY; boundary*1=Z",
    "multipart/form-data; boundary*0*=us-ascii''X%59; boundary*1*=%5A",
    "multipart/form-data; boundary=ignored; boundary*=utf-8''XYZ",
  ]) {
    test(`RFC 2231 multipart boundary: ${contentType}`, async () => {
      const body = '--XYZ\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--XYZ--\r\n';
      expect(await bodyOf(contentType, body)).toEqual({ a: 1 });
    });
  }

  test("an RFC 2231 boundary with an unsupported charset is missing", async () => {
    const body = '--XYZ\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--XYZ--\r\n';
    expect(await bodyOf("multipart/form-data; boundary*=latin1''XYZ", body)).toBeInstanceOf(Error);
  });

  test("a quoted boundary with spaces is passed on as parsed", async () => {
    const body = '--a b:c\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--a b:c--\r\n';
    expect(await bodyOf('multipart/form-data; boundary="a b:c"', body)).toEqual({ a: 1 });
    expect(await bodyOf("multipart/form-data; boundary*=utf-8''a%20b%3Ac", body)).toEqual({ a: 1 });
  });

  test("query keys like __proto__ are kept as submitted", async () => {
    const e = newEvent({ target: "/?__proto__=test&constructor=x" });
    const info = (await e.requestInfo()) as RequestInfo;
    expect(Object.hasOwn(info.query, "__proto__")).toBe(true);
    expect(info.query["__proto__"]).toBe("test");
    expect(info.query["constructor"]).toBe("x");
  });
});

describe("TestEventRequestRealIP", () => {
  // the two header lines of upstream's test, joined as Bun.serve joins them
  const headers = {
    "CF-Connecting-IP": "1.2.3.4, 1.1.1.1",
    "Fly-Client-IP": "1.2.3.4, 1.1.1.2",
    "X-Real-IP": "1.2.3.4, 1.1.1.3,1.1.1.4",
    "X-Forwarded-For": "1.2.3.4, invalid,1.1.1.5,1.1.1.6,invalid",
  };

  const scenarios: {
    name: string;
    headers: { [name: string]: string };
    trustedHeaders: string[] | null;
    useLeftmostIP: boolean;
    expected: string;
  }[] = [
    {
      name: "no trusted headers",
      headers,
      trustedHeaders: null,
      useLeftmostIP: false,
      expected: "127.0.0.1",
    },
    {
      name: "non-matching trusted header",
      headers,
      trustedHeaders: ["header1", "header2"],
      useLeftmostIP: false,
      expected: "127.0.0.1",
    },
    {
      name: "trusted X-Real-IP (rightmost)",
      headers,
      trustedHeaders: ["header1", "x-real-ip", "x-forwarded-for"],
      useLeftmostIP: false,
      expected: "1.1.1.4",
    },
    {
      // upstream: 1.1.1.3, the leftmost of the last line
      name: "trusted X-Real-IP (leftmost)",
      headers,
      trustedHeaders: ["header1", "x-real-ip", "x-forwarded-for"],
      useLeftmostIP: true,
      expected: "1.2.3.4",
    },
    {
      name: "trusted X-Forwarded-For (rightmost)",
      headers,
      trustedHeaders: ["header1", "x-forwarded-for"],
      useLeftmostIP: false,
      expected: "1.1.1.6",
    },
    {
      // upstream: 1.1.1.5, the leftmost of the last line
      name: "trusted X-Forwarded-For (leftmost)",
      headers,
      trustedHeaders: ["header1", "x-forwarded-for"],
      useLeftmostIP: true,
      expected: "1.2.3.4",
    },
    {
      name: "a single line: trusted X-Real-IP (leftmost)",
      headers: { "X-Real-IP": "1.1.1.3,1.1.1.4" },
      trustedHeaders: ["x-real-ip"],
      useLeftmostIP: true,
      expected: "1.1.1.3",
    },
    {
      name: "a single line: trusted X-Forwarded-For (leftmost)",
      headers: { "X-Forwarded-For": "invalid,1.1.1.5,1.1.1.6,invalid" },
      trustedHeaders: ["x-forwarded-for"],
      useLeftmostIP: true,
      expected: "1.1.1.5",
    },
    {
      name: "IPv6 addresses are expanded, zones kept",
      headers: { "X-Real-IP": " 2001:db8::1 ", "X-Forwarded-For": "fe80::1%eth0" },
      trustedHeaders: ["x-real-ip"],
      useLeftmostIP: false,
      expected: "2001:0db8:0000:0000:0000:0000:0000:0001",
    },
    {
      name: "a zone is kept",
      headers: { "X-Forwarded-For": "fe80::1%eth0" },
      trustedHeaders: ["x-forwarded-for"],
      useLeftmostIP: false,
      expected: "fe80:0000:0000:0000:0000:0000:0000:0001%eth0",
    },
    {
      name: "no valid IP: the next header, then the remote address",
      headers: { "X-Real-IP": "nope, 01.2.3.4", "X-Forwarded-For": "1.2.3.4.5" },
      trustedHeaders: ["x-real-ip", "x-forwarded-for"],
      useLeftmostIP: false,
      expected: "127.0.0.1",
    },
    {
      name: "an invalid header name is never found",
      headers: { "Fly-Client-IP": "9.9.9.9" },
      trustedHeaders: ["bad header", "fly-client-ip"],
      useLeftmostIP: false,
      expected: "9.9.9.9",
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const trustedProxy = app.settings.TrustedProxy;
      const saved = { ...trustedProxy };
      trustedProxy.Headers = s.trustedHeaders;
      trustedProxy.UseLeftmostIP = s.useLeftmostIP;
      try {
        const event = newEvent({ target: "/", headers: s.headers, remoteAddr: "127.0.0.1:80" });
        expect(event.realIP()).toBe(s.expected);
      } finally {
        Object.assign(trustedProxy, saved);
      }
    });
  }
});
