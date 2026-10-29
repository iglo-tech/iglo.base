// Upstream: tools/router/event_test.go
//
// Moved to their owning tasks or left out (see the PR):
//   - the non-tracking http.ResponseWriter cases of TestEventWritten and
//     TestEventStatus: Go interface wrapping with no TypeScript equivalent;
//   - the "fields" picker parts of TestEventJSON, TestEventJSONPickError and
//     TestEventJSONIgnoredError: tools/picker, M2.4;
//   - TestEventFileFS: static files, M5.7;
//   - TestEventXML and TestEventSetCookie: no upstream endpoint uses them.

import { describe, expect, test } from "bun:test";

import { ErrInvalidRedirectStatusCode, ErrMissingFile, Event } from "@/server/event";
import { ResponseWriter } from "@/server/router";
import { pointerTo, structOf, type MapRef, type StructType } from "@/server/unmarshal-request-data";
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

// a multipart/form-data body as Go's multipart.Writer writes it (one
// CreateFormFile part, or no parts)
function multipartRequest(file?: {
  field: string;
  filename: string;
  content: string;
}): TestRequest {
  const boundary = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab";
  let body = "";
  if (file) {
    body +=
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n${file.content}`;
  }
  body += `\r\n--${boundary}--\r\n`;
  return {
    method: "POST",
    target: "/",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  };
}

describe("FindUploadedFiles", () => {
  const scenarios: [filename: string, expectedPattern: RegExp][] = [
    ["ab.png", /^ab\w{10}_\w{10}\.png$/],
    ["test", /^test_\w{10}\.txt$/],
    ["a b c d!@$.j!@$pg", /^a_b_c_d_\w{10}\.jpg$/],
    ["a".repeat(150), /^a{100}_\w{10}\.txt$/],
  ];

  for (const [filename, expectedPattern] of scenarios) {
    test(filename, async () => {
      const event = newEvent(multipartRequest({ field: "test", filename, content: "test" }));

      const result = await event.findUploadedFiles("test");

      expect(result.length).toBe(1);
      expect(result[0]?.size).toBe(4);
      expect(result[0]?.name).toMatch(expectedPattern);
    });
  }

  test("missing", async () => {
    const event = newEvent(multipartRequest());

    await expect(event.findUploadedFiles("test")).rejects.toBe(ErrMissingFile);
  });

  // mime/multipart ReadForm: a part with an empty filename is a form value
  for (const content of ["", "hello"]) {
    test(`empty filename, content ${JSON.stringify(content)}`, async () => {
      const event = newEvent(multipartRequest({ field: "test", filename: "", content }));

      await expect(event.findUploadedFiles("test")).rejects.toBe(ErrMissingFile);
      expect(event.request.multipartForm?.value.get("test")).toEqual([content]);
      expect(event.request.form?.get("test")).toEqual([content]);
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

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

const xmlOf = (text: string): string => `<root><c>${text}</c></root>`;

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
    const first: MapRef = { map: {} };
    expect(await e.bindBody(first)).toBeUndefined();
    expect(first.map).toEqual({ a: 1 });

    const second: MapRef = { map: {} };
    expect(await e.bindBody(second)).toBeUndefined();
    expect(second.map).toEqual({ a: 1 });
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

  // json/v2 tracks duplicates by the resolved field, not the literal name
  test("JSON members resolving to the same field are duplicates", async () => {
    for (const body of [`{"a":1,"A":2}`, `{"c":"x","_C_":"y"}`, `{"A":1,"a":2}`]) {
      const e = newEvent({
        method: "POST",
        target: "/",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(await e.bindBody({}, testDstStruct)).toBeInstanceOf(Error);
    }
  });

  // json/v2 foldRune: the smallest member of the unicode.SimpleFold orbit
  describe("JSON names fold to the smallest character of their case orbit", () => {
    const type = structOf([
      { name: "Token", type: "string", tags: { json: "token" } },
      { name: "Size", type: "string", tags: { json: "\u00c5ngstr\u00f6m" } },
    ]);
    for (const [body, expected] of [
      // U+212A KELVIN SIGN folds to "K", as "k" does
      [`{"to\u212aen":"a"}`, { Token: "a" }],
      // U+212B ANGSTROM SIGN folds to U+00C5, as U+00E5 does
      [`{"\u212bngstr\u00f6m":"b"}`, { Size: "b" }],
      [`{"\u00e5NGSTR\u00d6M":"c"}`, { Size: "c" }],
    ] as const) {
      test(body, async () => {
        const e = newEvent({
          method: "POST",
          target: "/",
          headers: { "content-type": "application/json" },
          body,
        });
        const dst: Record<string, unknown> = {};
        expect(await e.bindBody(dst, type)).toBeUndefined();
        expect(dst).toEqual(expected);
      });
    }
  });

  test("a folded JSON name matching two fields is ambiguous", async () => {
    const e = newEvent({
      method: "POST",
      target: "/",
      headers: { "content-type": "application/json" },
      body: `{"ab":1}`,
    });
    const type = structOf([
      { name: "X", type: "int", tags: { json: "a_b" } },
      { name: "Y", type: "int", tags: { json: "A-B" } },
    ]);
    expect(await e.bindBody({}, type)).toBeInstanceOf(Error);
  });

  test("a top-level JSON null resets the struct to its zero value", async () => {
    const e = newEvent({
      method: "POST",
      target: "/",
      headers: { "content-type": "application/json" },
      body: "null",
    });
    const dst: Record<string, unknown> = { ...filledDst };
    expect(await e.bindBody(dst, testDstStruct)).toBeUndefined();
    expect(dst).toEqual(emptyDst);
  });

  const bind = async (body: string): Promise<[Error | undefined, unknown]> => {
    const e = newEvent({
      method: "POST",
      target: "/",
      headers: { "content-type": "text/xml" },
      body,
    });
    const dst: Record<string, unknown> = { ...emptyDst };
    const err = await e.bindBody(dst, testDstStruct);
    return [err, dst.C];
  };

  describe("XML element text follows encoding/xml's strict rules", () => {
    for (const [text, expected] of [
      ["&lt;&gt;&amp;&apos;&quot;", `<>&'"`],
      ["&#65;&#x42;&#x0043;", "ABC"],
      ["&#xD800;", "\ufffd"],
      ["a\r\nb\rc", "a\nb\nc"],
      ["&#13;", "\r"],
      ["<![CDATA[&bogus; ]]]]>", "&bogus; ]]"],
    ] as const) {
      test(`accepted: ${JSON.stringify(text)}`, async () => {
        expect(await bind(xmlOf(text))).toEqual([undefined, expected]);
      });
    }

    for (const text of [
      "&bogus;",
      "&nbsp;",
      "&lt",
      "& x",
      "&#0;",
      "&#1;",
      "&#xFFFE;",
      "&#x110000;",
      "&#;",
      "&#x;",
      "&#X41;",
      "&#12a;",
      "]]>",
      "\u0001",
      "<![CDATA[\u0001]]>",
    ]) {
      test(`rejected: ${JSON.stringify(text)}`, async () => {
        expect((await bind(xmlOf(text)))[0]).toBeInstanceOf(Error);
      });
    }
  });

  // Go's text() keeps all character data; comments and PIs only split it
  test("XML text around comments and processing instructions is kept", async () => {
    for (const [text, expected] of [
      ["a<!--c--> b", "a b"],
      ["a<?pi c?> b", "a b"],
      ["a <!--c-->\n<?pi?>\tb", "a \n\tb"],
    ] as const) {
      expect(await bind(xmlOf(text))).toEqual([undefined, expected]);
    }
  });

  const bindBytes = async (body: Uint8Array, contentType: string): Promise<Error | undefined> => {
    const e = newEvent({
      method: "POST",
      target: "/",
      headers: { "content-type": contentType },
      body,
    });
    return e.bindBody({ ...emptyDst }, testDstStruct);
  };

  test("invalid UTF-8 in XML text, attribute values and names is an error", async () => {
    for (const [before, after] of [
      ["<root><c>", "</c></root>"],
      ["<root><c><![CDATA[", "]]></c></root>"],
      ['<root><c x="', '">a</c></root>'],
      ["<root><c", ">a</c></root>"],
      ["", "<root/>"],
    ]) {
      const body = concat(utf8(before as string), new Uint8Array([0xff]), utf8(after as string));
      expect(await bindBytes(body, "text/xml")).toBeInstanceOf(Error);
    }
    // like Go, comments are not checked
    const comment = concat(utf8("<root><!--"), new Uint8Array([0xff]), utf8("--><c>a</c></root>"));
    expect(await bindBytes(comment, "text/xml")).toBeUndefined();
  });

  describe("XML names are validated like encoding/xml", () => {
    for (const body of [
      "<root><c>ok</c><1bad/></root>",
      "<root><c>ok</c><bad?name/></root>",
      "<root><c>ok</c><a:b:c/></root>",
      "<root><c>ok</c><-x/></root>",
      "<root><c 1x='a'>ok</c></root>",
      "<root><c x=a>ok</c></root>",
      "<root><c x>ok</c></root>",
      "<root><c x='<'>ok</c></root>",
      "<root><c>ok</c ></root",
      "<root><c>ok</c><x/ ></root>",
      "<root><c>ok</c></ root>",
      "<root><?1pi?><c>ok</c></root>",
      "<root><!--a--b--><c>ok</c></root>",
      "<root><!-x--><c>ok</c></root>",
      "<root><![CDATX[a]]><c>ok</c></root>",
      '<?xml version="1.1"?><root/>',
      '<?xml version="1.0" encoding="latin1"?><root/>',
      "</x><root/>",
    ]) {
      test(`rejected: ${JSON.stringify(body)}`, async () => {
        expect((await bind(body))[0]).toBeInstanceOf(Error);
      });
    }

    for (const [body, expected] of [
      ["<root><c>ok</c><x:y/><\u00e9t\u00e9/><_a.b-c/></root>", "ok"],
      ["<root x='1' y=\"]]>\"><c a = 'v' >ok</c ></root>", "ok"],
      ["<root><c>ok</c></root>trailing <garbage", "ok"],
      ["leading text <root><c>ok</c></root>", "ok"],
      [
        '<?xml version="1.0" encoding="utf-8"?><!DOCTYPE root [<!ENTITY e "x">]><root><c>ok</c></root>',
        "ok",
      ],
    ] as const) {
      test(`accepted: ${JSON.stringify(body)}`, async () => {
        expect(await bind(body)).toEqual([undefined, expected]);
      });
    }
  });

  describe("XML scalars follow strconv", () => {
    const numbers: StructType = structOf([
      { name: "F", type: "float64" },
      { name: "G", type: "float32" },
      { name: "N", type: "int8" },
      { name: "U", type: "uint" },
      { name: "B", type: "bool" },
    ]);
    const bindNumbers = async (inner: string): Promise<[Error | undefined, unknown]> => {
      const e = newEvent({
        method: "POST",
        target: "/",
        headers: { "content-type": "text/xml" },
        body: `<root>${inner}</root>`,
      });
      const dst: Record<string, unknown> = {};
      return [await e.bindBody(dst, numbers), dst];
    };

    for (const [inner, expected] of [
      ["<F>0x1p2</F>", { F: 4 }],
      ["<F> -0X1.8P1 </F>", { F: -3 }],
      ["<F>1_000.5</F>", { F: 1000.5 }],
      ["<F>-Inf</F>", { F: -Infinity }],
      ["<F></F><G/><N></N><U/><B></B>", { F: 0, G: 0, N: 0, U: 0, B: false }],
      ["<G>3.4e38</G>", { G: Math.fround(3.4e38) }],
      ["<N>\n-128\t</N><U>18</U><B> T </B>", { N: -128, U: 18, B: true }],
    ] as const) {
      test(`accepted: ${JSON.stringify(inner)}`, async () => {
        expect(await bindNumbers(inner)).toEqual([undefined, expected]);
      });
    }

    for (const inner of [
      "<F>1e400</F>",
      "<F>-1e400</F>",
      "<F>0x1p2000</F>",
      "<G>1e39</G>",
      "<F> </F>",
      "<F>+NaN</F>",
      "<F>0x1</F>",
      "<N> </N>",
      "<N>128</N>",
      "<N>0x1</N>",
      "<N>1_0</N>",
      "<U>+1</U>",
      "<U>-1</U>",
      "<B> </B>",
    ]) {
      test(`rejected: ${JSON.stringify(inner)}`, async () => {
        expect((await bindNumbers(inner))[0]).toBeInstanceOf(Error);
      });
    }
  });

  test("a leading UTF-8 BOM in a JSON body is rejected", async () => {
    const body = concat(new Uint8Array([0xef, 0xbb, 0xbf]), utf8(`{"a":1}`));
    expect(await bindBytes(body, "application/json")).toBeInstanceOf(Error);
  });

  test("only the first JSON value must be valid UTF-8", async () => {
    const trailing = concat(utf8(`{"a":1}`), new Uint8Array([0xff]));
    expect(await bindBytes(trailing, "application/json")).toBeUndefined();
    const trailingSpace = concat(utf8(`{"a":1} `), new Uint8Array([0xc3]));
    expect(await bindBytes(trailingSpace, "application/json")).toBeUndefined();
    const inside = concat(utf8(`{"c":"`), new Uint8Array([0xff]), utf8(`"}`));
    expect(await bindBytes(inside, "application/json")).toBeInstanceOf(Error);
    const surrogate = concat(utf8(`{"c":"`), new Uint8Array([0xed, 0xa0, 0x80]), utf8(`"}`));
    expect(await bindBytes(surrogate, "application/json")).toBeInstanceOf(Error);
    // valid multi-byte characters are kept
    const e = newEvent({
      method: "POST",
      target: "/",
      headers: { "content-type": "application/json" },
      body: concat(utf8(`{"c":"\u00e9\u{1f600}"}`), new Uint8Array([0xff])),
    });
    const dst: Record<string, unknown> = {};
    expect(await e.bindBody(dst, testDstStruct)).toBeUndefined();
    expect(dst.C).toBe("\u00e9\u{1f600}");
  });

  test("XML into a map is an error", async () => {
    const e = newEvent({
      method: "POST",
      target: "/",
      headers: { "content-type": "text/xml" },
      body: xmlDst,
    });
    expect(await e.bindBody({ map: {} })).toBeInstanceOf(Error);
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
