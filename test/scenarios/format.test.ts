// The scenario format's own behavior: Go's body normalization and content
// checks from tests/api.go, the request a scenario sends, and the pending
// and difference markers.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { checkExpectations, outcome } from "@test/scenarios/expectations";
import { healthAPI } from "@test/scenarios/health";
import { goNormalizedBody } from "@test/scenarios/json";
import { sendScenarioRequest } from "@test/scenarios/request";
import { runAgainstIgloBase } from "@test/scenarios/runner";
import type { Scenario } from "@test/scenarios/scenario";

const bytes = (text: string) => new TextEncoder().encode(text);
const normalized = (body: string | Uint8Array) =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    goNormalizedBody(typeof body === "string" ? bytes(body) : body),
  );

describe("goNormalizedBody (jsontext Encoder.WriteValue)", () => {
  test("removes whitespace and adds the top-level newline", () => {
    expect(normalized(' { "a" : [ 1 , true , null ] ,\n "b" : { } } ')).toBe(
      '{"a":[1,true,null],"b":{}}\n',
    );
  });

  test("keeps numbers verbatim", () => {
    expect(normalized("[1.50, -0, 1E+2, 10000000000000000001]")).toBe(
      "[1.50,-0,1E+2,10000000000000000001]\n",
    );
  });

  test("rewrites strings in their shortest escaping", () => {
    expect(normalized('"\\u0041\\/\\u00e9\\u003c&>\\ud83d\\ude00"')).toBe(
      '"A/\u00e9<&>\u{1f600}"\n',
    );
    expect(normalized('"\\u0008\\u000a\\u001f\\u007f\\"\\\\"')).toBe(
      '"\\b\\n\\u001f\u007f\\"\\\\"\n',
    );
    expect(normalized('"\\ud800"')).toBe('"\ufffd"\n');
  });

  test("leaves bodies jsontext rejects unchanged", () => {
    for (const body of ["", "not json", "{}{}", '{"a":1,"a":2}', "[1,]", "\ufeff{}", "'a'"]) {
      expect(normalized(body)).toBe(body);
    }
    const invalidUtf8 = new Uint8Array([0x22, 0xff, 0x22]);
    expect(goNormalizedBody(invalidUtf8)).toEqual(invalidUtf8);
  });
});

describe("checkExpectations", () => {
  test("an empty body is required when no content is expected", () => {
    expect(checkExpectations({ expectedStatus: 204 }, 204, new Uint8Array())).toEqual([]);
    expect(checkExpectations({ expectedStatus: 204 }, 200, bytes("{}"))).toEqual([
      "Expected status code 204, got 200",
      "Expected empty body, got \n{}",
    ]);
  });

  test("content is matched in the normalized body, reporting the first miss of each list", () => {
    const body = bytes('{ "code": 200, "data": {} }');
    expect(
      checkExpectations(
        { expectedStatus: 200, expectedContent: ['"code":200', '"data":{}'] },
        200,
        body,
      ),
    ).toEqual([]);
    expect(
      checkExpectations(
        {
          expectedStatus: 200,
          expectedContent: ['"x"', '"y"'],
          notExpectedContent: ["code", "data"],
        },
        200,
        body,
      ),
    ).toEqual([
      'Cannot find "x" in response body \n{"code":200,"data":{}}\n',
      'Didn\'t expect code in response body \n{"code":200,"data":{}}\n',
    ]);
  });
});

describe("outcome", () => {
  const scenario: Scenario = { name: "s", method: "GET", url: "/", expectedStatus: 200 };
  const pending = { ...scenario, pending: { task: "M9.9", reason: "not yet" } };

  test("a scenario passes without failures", () => {
    expect(outcome(scenario, [])).toEqual({ ok: true });
    expect(outcome(scenario, ["a", "b"])).toEqual({ ok: false, message: "a\nb" });
  });

  test("a pending scenario passes while it fails, and fails once it passes", () => {
    expect(outcome(pending, ["Expected status code 200, got 404\nmore"])).toEqual({
      ok: true,
      report:
        'pending on M9.9 (not yet): "s", 1 failure(s), first: Expected status code 200, got 404',
    });
    expect(outcome(pending, [])).toEqual({
      ok: false,
      message: '"s" passes now: remove its pending marker (M9.9)',
    });
  });
});

describe("the scenario request", () => {
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const headers = Object.fromEntries(req.headers);
        return Response.json({ method: req.method, url: req.url, headers, body: await req.text() });
      },
    });
  });
  afterAll(() => server.stop(true));

  test("carries only the scenario's headers, like httptest.NewRequest", async () => {
    const res = await sendScenarioRequest(server.url.href, {
      name: "echo",
      method: "POST",
      url: "/a//b?c=%20",
      body: '{"x":1}',
      headers: { Authorization: "  token  ", "X-Other": "1" },
      expectedStatus: 200,
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(res.body))).toEqual({
      method: "POST",
      url: "http://example.com/a//b?c=%20",
      headers: {
        host: "example.com",
        "content-type": "application/json",
        authorization: "token",
        "x-other": "1",
        "content-length": "7",
      },
      body: '{"x":1}',
    });
  });

  test("a scenario header replaces the default content-type", async () => {
    const res = await sendScenarioRequest(server.url.href, {
      name: "echo",
      method: "GET",
      url: "/",
      headers: { "Content-Type": "text/plain" },
      expectedStatus: 200,
    });
    const echoed = JSON.parse(new TextDecoder().decode(res.body)) as {
      headers: Record<string, string>;
    };
    expect(echoed.headers["content-type"]).toBe("text/plain");
  });
});

describe("markers against iglo.base", () => {
  const [guest] = healthAPI.scenarios as [Scenario];

  test("a pending scenario that passes is reported as passing", async () => {
    const failures = await runAgainstIgloBase({
      ...guest,
      pending: { task: "M9.9", reason: "test" },
    });
    expect(failures).toEqual([]);
    expect(outcome({ ...guest, pending: { task: "M9.9", reason: "test" } }, failures).ok).toBe(
      false,
    );
  });

  test("a deliberate difference checks iglo.base against its own expectations", async () => {
    const failures = await runAgainstIgloBase({
      ...guest,
      expectedStatus: 418,
      difference: {
        name: "Custom routes from hooks or Go",
        igloBase: { expectedStatus: 200, expectedContent: ['"code":200'] },
      },
    });
    expect(failures).toEqual([]);
  });

  test("prepare runs on the copy and after sees the response", async () => {
    let prepared = "";
    let seen = 0;
    const failures = await runAgainstIgloBase({
      ...guest,
      prepare: ({ dataDir }) => {
        prepared = dataDir;
      },
      after: ({ dataDir, status }) => {
        expect(dataDir).toBe(prepared);
        seen = status;
      },
    });
    expect(failures).toEqual([]);
    expect(prepared).toEndWith("/pb_data");
    expect(seen).toBe(200);
  });
});
