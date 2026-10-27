// The differential comparison's normalization rules, on hand-made responses.

import { describe, expect, test } from "bun:test";

import { compareResponses, type StartingData } from "@test/differential/harness/compare";
import type { ScenarioResponse } from "@test/scenarios/request";

const fixtureId = "wsmn24bux7wo113";
const fixtureTime = "2022-10-01 12:00:00.000Z";

const start: StartingData = {
  contains: (text) => [fixtureId, "achvryl401bhse3", fixtureTime].includes(text),
  jsonFields: new Map([[fixtureId, new Set(["json"])]]),
};

const json = { "content-type": "application/json" };

function res(body: string, headers: Record<string, string> = json, status = 200): ScenarioResponse {
  return { status, headers: new Headers(headers), body: new TextEncoder().encode(body) };
}

// a record of the collection with the json field "json"
function record(value: string): ScenarioResponse {
  return res(`{"collectionId":"${fixtureId}","json":${value},"other":${value}}`);
}

function diff(upstream: ScenarioResponse, igloBase: ScenarioResponse): string[] {
  return compareResponses(upstream, igloBase, start);
}

describe("status and headers", () => {
  test("equal responses have no differences", () => {
    expect(diff(res('{"a":1}'), res('{ "a" : 1 }'))).toEqual([]);
  });

  test("status and compared headers must match", () => {
    expect(
      diff(
        res("{}", { ...json, "x-frame-options": "SAMEORIGIN", "x-other": "1" }),
        res("{}", { "content-type": "text/plain", "x-other": "2" }, 404),
      ),
    ).toEqual([
      "status: upstream 200, iglo.base 404",
      'header content-type: upstream "application/json", iglo.base "text/plain"',
      'header x-frame-options: upstream "SAMEORIGIN", iglo.base (absent)',
    ]);
  });
});

describe("bodies", () => {
  test("non-JSON bodies are compared byte for byte", () => {
    expect(diff(res("abc"), res("abc"))).toEqual([]);
    expect(diff(res("abc"), res("abd"))).toEqual(['body: upstream "abc", iglo.base "abd"']);
    expect(diff(res("{}"), res("abc"))).toEqual(["body: upstream is JSON, iglo.base is not"]);
  });

  test("JSON compares member order, number text and decoded strings", () => {
    expect(diff(res('{"s":"\\u0041"}'), res('{"s":"A"}'))).toEqual([]);
    expect(diff(res('{"a":1,"b":2}'), res('{"b":2,"a":1}'))).toEqual([
      'body: members [a, b] vs [b, a]: upstream {"a":1,"b":2}, iglo.base {"b":2,"a":1}',
    ]);
    expect(diff(res('{"n":[1.0]}'), res('{"n":[1]}'))).toEqual([
      "body n.0: different values: upstream 1.0, iglo.base 1",
    ]);
    expect(diff(res('{"n":"1"}'), res('{"n":1}'))).toEqual([
      'body n: different kinds: upstream "1", iglo.base 1',
    ]);
  });

  test("json field values of records are compared as raw bytes", () => {
    expect(diff(record('{"b":1,"a":2}'), record('{"b":1,"a":2}'))).toEqual([]);
    expect(diff(record('{"a":1}'), record('{ "a":1}'))).toEqual([
      'body json: raw JSON differs: upstream {"a":1}, iglo.base { "a":1}',
    ]);
  });
});

describe("generated values", () => {
  test("new IDs, tokens and timestamps are compared by format", () => {
    expect(
      diff(
        res('{"id":"aaaaaaaaaaaaaaa","token":"a.b.c","created":"2026-10-28 10:00:00.123Z"}'),
        res('{"id":"bbbbbbbbbbbbbbb","token":"x.y.z","created":"2026-10-28 10:00:01.456Z"}'),
      ),
    ).toEqual([]);
    expect(diff(res('{"id":"aaaaaaaaaaaaaaa"}'), res('{"id":"short"}'))).toEqual([
      'body id: not both ids: upstream "aaaaaaaaaaaaaaa", iglo.base "short"',
    ]);
  });

  test("values from the starting data must match exactly", () => {
    expect(diff(res(`{"id":"${fixtureId}"}`), res('{"id":"bbbbbbbbbbbbbbb"}'))).toEqual([
      `body id: different strings: upstream "${fixtureId}", iglo.base "bbbbbbbbbbbbbbb"`,
    ]);
    expect(diff(res('{"id":"aaaaaaaaaaaaaaa"}'), res('{"id":"achvryl401bhse3"}'))).toEqual([
      'body id: generated id expected, iglo.base\'s is in the starting data: upstream "aaaaaaaaaaaaaaa", iglo.base "achvryl401bhse3"',
    ]);
  });

  test("generated values pair consistently within a scenario", () => {
    expect(
      diff(
        res('["aaaaaaaaaaaaaaa","aaaaaaaaaaaaaaa","ccccccccccccccc"]'),
        res('["bbbbbbbbbbbbbbb","bbbbbbbbbbbbbbb","ddddddddddddddd"]'),
      ),
    ).toEqual([]);
    expect(
      diff(
        res('["aaaaaaaaaaaaaaa","aaaaaaaaaaaaaaa"]'),
        res('["bbbbbbbbbbbbbbb","ddddddddddddddd"]'),
      ),
    ).toEqual([
      'body 1: ids not paired consistently: upstream "aaaaaaaaaaaaaaa", iglo.base "ddddddddddddddd"',
    ]);
    expect(
      diff(
        res('["aaaaaaaaaaaaaaa","ccccccccccccccc"]'),
        res('["bbbbbbbbbbbbbbb","bbbbbbbbbbbbbbb"]'),
      ),
    ).toEqual([
      'body 1: ids not paired consistently: upstream "ccccccccccccccc", iglo.base "bbbbbbbbbbbbbbb"',
    ]);
  });
});
