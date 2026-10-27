// Upstream: tools/router/event_test.go
//
// Moved to their owning tasks or left out (see the PR):
//   - the non-tracking http.ResponseWriter cases of TestEventWritten and
//     TestEventStatus: Go interface wrapping with no TypeScript equivalent;
//   - the "fields" picker parts of TestEventJSON, TestEventJSONPickError and
//     TestEventJSONIgnoredError: tools/picker, M2.4;
//   - TestFindUploadedFiles(Missing): filesystem.File, M3.2;
//   - TestEventFileFS: static files, M5.7;
//   - TestEventXML and TestEventSetCookie: no upstream endpoint uses them.

import { describe, expect, test } from "bun:test";

import { ErrInvalidRedirectStatusCode, Event } from "@/server/event";
import { ResponseWriter } from "@/server/router";
import { pointerTo, structOf, type StructType } from "@/server/unmarshal-request-data";
import { newTestRequest, type TestRequest } from "@test/support/router";

function newEvent(init: TestRequest = { target: "/" }, onCommit?: (r: Response) => void): Event {
  return new Event(new ResponseWriter(onCommit), newTestRequest(init));
}

describe("Written and Status", () => {
  test("non-written WriteTracker", () => {
    const e = newEvent();
    expect(e.written()).toBe(false);
    expect(e.status()).toBe(0);
  });

  test("written WriteTracker", () => {
    const e = newEvent();
    e.response.write("test");
    expect(e.written()).toBe(true);
    expect(e.status()).toBe(200);
  });

  test("written status", () => {
    const e = newEvent();
    e.response.writeHeader(123);
    expect(e.written()).toBe(true);
    expect(e.status()).toBe(123);
  });
});

test("IsTLS", () => {
  expect(newEvent().isTLS()).toBe(false);
  const req = newTestRequest({ target: "/" });
  const tls = new Event(
    new ResponseWriter(),
    Object.assign(Object.create(Object.getPrototypeOf(req) as object) as typeof req, req, {
      tls: true,
    }),
  );
  expect(tls.isTLS()).toBe(true);
});

describe("RemoteIP", () => {
  const scenarios: [string, string][] = [
    ["", "invalid IP"],
    ["1.2.3.4", "invalid IP"],
    ["1.2.3.4:8090", "1.2.3.4"],
    ["[0000:0000:0000:0000:0000:0000:0000:0002]:80", "0000:0000:0000:0000:0000:0000:0000:0002"],
    // should always return the expanded version
    ["[::2]:80", "0000:0000:0000:0000:0000:0000:0000:0002"],
  ];
  for (const [remoteAddr, expected] of scenarios) {
    test(JSON.stringify(remoteAddr), () => {
      expect(newEvent({ target: "/", remoteAddr }).remoteIP()).toBe(expected);
    });
  }
});

describe("Set and Get", () => {
  const e = newEvent();

  // get before any set
  expect(e.get("test")).toBeUndefined();

  e.set("a", 123);
  e.set("b", 456);

  const scenarios: [string, unknown][] = [
    ["", undefined],
    ["missing", undefined],
    ["a", 123],
    ["b", 456],
  ];
  scenarios.forEach(([key, expected], i) => {
    test(`${i}_${key}`, () => {
      expect(e.get(key)).toBe(expected);
    });
  });
});

test("SetAll and GetAll", () => {
  const data: Record<string, unknown> = { a: 123, b: 456 };

  const e = newEvent();
  e.setAll(data);

  // modify the data to ensure that the map was shallow copied
  data.c = 789;

  expect(Object.fromEntries(e.getAll())).toEqual({ a: 123, b: 456 });
});

interface WriteScenario {
  name: string;
  status: number;
  headers?: Record<string, string>;
  expectedStatus: number;
  expectedHeaders?: Record<string, string>;
  expectedBody?: string;
  expectedError?: Error;
}

function testResponseWrite(
  scenario: WriteScenario,
  write: (e: Event) => Error | undefined | Promise<Error | undefined>,
): void {
  test(scenario.name, async () => {
    const e = newEvent();
    for (const [k, v] of Object.entries(scenario.headers ?? {})) {
      e.response.header.append(k, v);
    }

    const err = await write(e);
    expect(err).toBe(scenario.expectedError);

    const response = e.response.finish() as Response;
    expect(response.status).toBe(scenario.expectedStatus);

    let body = await response.text();
    try {
      body = JSON.stringify(sortKeys(JSON.parse(body)));
    } catch {
      // not JSON
    }
    expect(body).toBe(scenario.expectedBody ?? "");

    for (const [k, v] of Object.entries(scenario.expectedHeaders ?? {})) {
      expect(response.headers.get(k)).toBe(v);
    }
  });
}

function sortKeys(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
  );
}

describe("String", () => {
  testResponseWrite(
    {
      name: "no explicit content-type",
      status: 234,
      expectedStatus: 234,
      expectedHeaders: { "content-type": "text/plain; charset=utf-8" },
      expectedBody: "test",
    },
    (e) => e.string(234, "test"),
  );
  testResponseWrite(
    {
      name: "with explicit content-type",
      status: 234,
      headers: { "content-type": "text/test" },
      expectedStatus: 234,
      expectedHeaders: { "content-type": "text/test" },
      expectedBody: "test",
    },
    (e) => e.string(234, "test"),
  );
});

describe("HTML", () => {
  testResponseWrite(
    {
      name: "no explicit content-type",
      status: 234,
      expectedStatus: 234,
      expectedHeaders: { "content-type": "text/html; charset=utf-8" },
      expectedBody: "test",
    },
    (e) => e.html(234, "test"),
  );
  testResponseWrite(
    {
      name: "with explicit content-type",
      status: 234,
      headers: { "content-type": "text/test" },
      expectedStatus: 234,
      expectedHeaders: { "content-type": "text/test" },
      expectedBody: "test",
    },
    (e) => e.html(234, "test"),
  );
});

describe("JSON", () => {
  const body = { a: 123, b: true, c: "test" };
  const expectedFullBody = `{"a":123,"b":true,"c":"test"}`;

  testResponseWrite(
    {
      name: "no explicit content-type",
      status: 200,
      expectedStatus: 200,
      expectedHeaders: { "content-type": "application/json" },
      expectedBody: expectedFullBody,
    },
    (e) => e.json(200, body),
  );
  testResponseWrite(
    {
      name: "with explicit content-type (200)",
      status: 200,
      headers: { "content-type": "application/test" },
      expectedStatus: 200,
      expectedHeaders: { "content-type": "application/test" },
      expectedBody: expectedFullBody,
    },
    (e) => e.json(200, body),
  );
  testResponseWrite(
    {
      name: "with explicit content-type (400)",
      status: 400,
      headers: { "content-type": "application/test" },
      expectedStatus: 400,
      expectedHeaders: { "content-type": "application/test" },
      expectedBody: expectedFullBody,
    },
    (e) => e.json(400, body),
  );
});

describe("Stream", () => {
  testResponseWrite(
    {
      name: "stream",
      status: 234,
      headers: { "content-type": "text/test" },
      expectedStatus: 234,
      expectedHeaders: { "content-type": "text/test" },
      expectedBody: "test",
    },
    (e) => e.stream(234, "text/test", new Blob(["test"]).stream()),
  );
});

describe("Blob", () => {
  testResponseWrite(
    {
      name: "blob",
      status: 234,
      headers: { "content-type": "text/test" },
      expectedStatus: 234,
      expectedHeaders: { "content-type": "text/test" },
      expectedBody: "test",
    },
    (e) => e.blob(234, "text/test", new TextEncoder().encode("test")),
  );
});

describe("NoContent", () => {
  testResponseWrite(
    {
      name: "no content",
      status: 234,
      headers: { "content-type": "text/test" },
      expectedStatus: 234,
      expectedHeaders: { "content-type": "text/test" },
      expectedBody: "",
    },
    (e) => e.noContent(234),
  );
});

test("Flush", async () => {
  let committed: Response | undefined;
  const e = newEvent({ target: "/" }, (r) => {
    committed = r;
  });
  e.response.write("test");
  expect(e.flush()).toBeUndefined();

  // the response is sent at the flush, the later writes are streamed
  expect(committed).toBeDefined();
  e.response.write("-more");
  expect(e.response.finish()).toBeUndefined();
  expect(await (committed as Response).text()).toBe("test-more");
});

describe("Redirect", () => {
  testResponseWrite(
    {
      name: "non-30x status",
      status: 200,
      expectedStatus: 200,
      expectedError: ErrInvalidRedirectStatusCode,
    },
    (e) => e.redirect(200, "example"),
  );
  testResponseWrite(
    {
      name: "30x status",
      status: 302,
      // should be overwritten with the argument
      headers: { location: "test" },
      expectedStatus: 302,
      expectedHeaders: { location: "example" },
    },
    (e) => e.redirect(302, "example"),
  );
});

describe("ApiError helpers", () => {
  // validation.Required is a rule, not an error: both values fall back to
  // the default public safe error
  class RequiredRule {
    validate(): undefined {
      return undefined;
    }
  }
  const errData = { a: new RequiredRule(), b: "test" };
  const invalid = { code: "validation_invalid_value", message: "Invalid value." };
  const scenarios: [string, (e: Event) => Error, string][] = [
    [
      "Error",
      (e) => e.error(123, "message_test", errData),
      `{"data":{"a":${JSON.stringify(invalid)},"b":${JSON.stringify(invalid)}},"message":"Message_test.","status":123}`,
    ],
    [
      "BadRequestError",
      (e) => e.badRequestError("message_test", errData),
      `{"data":{"a":${JSON.stringify(invalid)},"b":${JSON.stringify(invalid)}},"message":"Message_test.","status":400}`,
    ],
    [
      "NotFoundError",
      (e) => e.notFoundError("message_test", errData),
      `{"data":{"a":${JSON.stringify(invalid)},"b":${JSON.stringify(invalid)}},"message":"Message_test.","status":404}`,
    ],
    [
      "ForbiddenError",
      (e) => e.forbiddenError("message_test", errData),
      `{"data":{"a":${JSON.stringify(invalid)},"b":${JSON.stringify(invalid)}},"message":"Message_test.","status":403}`,
    ],
    [
      "UnauthorizedError",
      (e) => e.unauthorizedError("message_test", errData),
      `{"data":{"a":${JSON.stringify(invalid)},"b":${JSON.stringify(invalid)}},"message":"Message_test.","status":401}`,
    ],
    [
      "TooManyRequestsError",
      (e) => e.tooManyRequestsError("message_test", errData),
      `{"data":{"a":${JSON.stringify(invalid)},"b":${JSON.stringify(invalid)}},"message":"Message_test.","status":429}`,
    ],
    [
      "InternalServerError",
      (e) => e.internalServerError("message_test", errData),
      `{"data":{"a":${JSON.stringify(invalid)},"b":${JSON.stringify(invalid)}},"message":"Message_test.","status":500}`,
    ],
  ];
  for (const [name, create, expected] of scenarios) {
    test(name, () => {
      expect(JSON.stringify(create(newEvent()))).toBe(expected);
    });
  }
});

describe("BindBody", () => {
  const testDstStruct: StructType = structOf([
    { name: "A", type: "int", tags: { json: "a", xml: "a", form: "a" } },
    { name: "B", type: "int", tags: { json: "b", xml: "b", form: "b" } },
    { name: "C", type: "string", tags: { json: "c", xml: "c", form: "c" } },
  ]);

  const emptyDst = { A: 0, B: 0, C: "" };
  const filledDst = { A: 123, B: -456, C: "test" };

  const queryDst = "a=123&b=-456&c=test";

  const xmlDst = `
		<?xml version="1.0" encoding="UTF-8" ?>
		<root>
			<a>123</a>
			<b>-456</b>
			<c>test</c>
		</root>
	`;

  const jsonDst = `{"a":123,"b":-456,"c":"test"}`;

  const boundary = "testboundary1234";
  const mpBody = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="@jsonPayload"',
    "",
    `{"a":123}`,
    `--${boundary}`,
    'Content-Disposition: form-data; name="b"',
    "",
    "-456",
    `--${boundary}`,
    'Content-Disposition: form-data; name="c"',
    "",
    "test",
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const scenarios: {
    contentType: string;
    body: string;
    expectDst: Record<string, unknown>;
    expectError?: boolean;
  }[] = [
    { contentType: "", body: jsonDst, expectDst: emptyDst, expectError: true },
    // unsupported
    { contentType: "application/rtf", body: jsonDst, expectDst: emptyDst, expectError: true },
    // empty body
    { contentType: "application/json;charset=emptybody", body: "", expectDst: emptyDst },
    // json
    { contentType: "application/json", body: jsonDst, expectDst: filledDst },
    { contentType: "application/json;charset=abc", body: jsonDst, expectDst: filledDst },
    // xml
    { contentType: "text/xml", body: xmlDst, expectDst: filledDst },
    { contentType: "text/xml;charset=abc", body: xmlDst, expectDst: filledDst },
    { contentType: "application/xml", body: xmlDst, expectDst: filledDst },
    { contentType: "application/xml;charset=abc", body: xmlDst, expectDst: filledDst },
    // x-www-form-urlencoded
    { contentType: "application/x-www-form-urlencoded", body: queryDst, expectDst: filledDst },
    {
      contentType: "application/x-www-form-urlencoded;charset=abc",
      body: queryDst,
      expectDst: filledDst,
    },
    // multipart
    {
      contentType: `multipart/form-data; boundary=${boundary}`,
      body: mpBody,
      expectDst: filledDst,
    },
  ];

  for (const s of scenarios) {
    test(JSON.stringify(s.contentType), async () => {
      const e = newEvent({
        method: "POST",
        target: "/",
        headers: s.contentType === "" ? {} : { "content-type": s.contentType },
        body: s.body,
      });

      const dst: Record<string, unknown> = { ...emptyDst };
      const err = await e.bindBody(dst, testDstStruct);

      expect(err !== undefined).toBe(s.expectError ?? false);
      expect(dst).toEqual(s.expectDst);
    });
  }

  test("JSON names are matched case-insensitively, ignoring - and _", async () => {
    const e = newEvent({
      method: "POST",
      target: "/",
      headers: { "content-type": "application/json" },
      body: `{"A":1,"_b_":2,"C":"x"}`,
    });
    const dst: Record<string, unknown> = {};
    expect(await e.bindBody(dst, testDstStruct)).toBeUndefined();
    expect(dst).toEqual({ A: 1, B: 2, C: "x" });
  });

  test("only the first JSON value is read and the body can be read again", async () => {
    const e = newEvent({
      method: "POST",
      target: "/",
      headers: { "content-type": "application/json" },
      body: `{"a":1} trailing`,
    });
    const first: Record<string, unknown> = {};
    expect(await e.bindBody(first)).toBeUndefined();
    expect(first).toEqual({ a: 1 });

    const second: Record<string, unknown> = {};
    expect(await e.bindBody(second)).toBeUndefined();
    expect(second).toEqual({ a: 1 });
  });

  test("duplicate JSON names and type mismatches are errors", async () => {
    for (const body of [`{"a":1,"a":2}`, `{"a":"1"}`, `{"a":1.5}`, `[1]`, "  "]) {
      const e = newEvent({
        method: "POST",
        target: "/",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(await e.bindBody({}, testDstStruct)).toBeInstanceOf(Error);
    }
  });

  test("XML into a map is an error", async () => {
    const e = newEvent({
      method: "POST",
      target: "/",
      headers: { "content-type": "text/xml" },
      body: xmlDst,
    });
    expect(await e.bindBody({})).toBeInstanceOf(Error);
  });

  test("urlencoded bodies are read only for POST, PUT and PATCH", async () => {
    const e = newEvent({
      method: "GET",
      target: "/?c=query",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: queryDst,
    });
    const dst: Record<string, unknown> = {};
    expect(
      await e.bindBody(
        dst,
        structOf([{ name: "C", type: pointerTo("string"), tags: { form: "c" } }]),
      ),
    ).toBe(undefined);
    expect(dst).toEqual({ C: "query" });
  });
});
