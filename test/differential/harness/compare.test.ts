// The differential comparison's normalization rules, on hand-made responses.

import { describe, expect, test } from "bun:test";

import { compareResponses, type Context } from "@test/differential/harness/compare";
import type { ScenarioResponse } from "@test/scenarios/request";

const fixtureId = "wsmn24bux7wo113";
const fixtureTime = "2022-10-01 12:00:00.000Z";

const json = { "content-type": "application/json" };

function res(body: string, headers: Record<string, string> = json, status = 200): ScenarioResponse {
  return { status, headers: new Headers(headers), body: new TextEncoder().encode(body) };
}

function diff(
  upstream: ScenarioResponse,
  igloBase: ScenarioResponse,
  request: Context["request"] = { url: "/api/collections/demo2/records" },
): string[] {
  return compareResponses(upstream, igloBase, {
    start: { contains: (text) => [fixtureId, "achvryl401bhse3", fixtureTime].includes(text) },
    request,
  });
}

describe("status and headers", () => {
  test("equal responses have no differences", () => {
    expect(diff(res('{"a":1}'), res('{"a":1}'))).toEqual([]);
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

  test("JSON bodies are compared byte for byte, reported structurally", () => {
    expect(diff(res('{"a":1,"b":2}'), res('{"b":2,"a":1}'))).toEqual([
      'body: members [a, b] vs [b, a]: upstream {"a":1,"b":2}, iglo.base {"b":2,"a":1}',
    ]);
    expect(diff(res('{"n":[1.0]}'), res('{"n":[1]}'))).toEqual([
      "body n.0: different values: upstream 1.0, iglo.base 1",
    ]);
    expect(diff(res('{"n":"1"}'), res('{"n":1}'))).toEqual([
      'body n: different kinds: upstream "1", iglo.base 1',
    ]);
    expect(diff(res('{"s":"\\u0041"}'), res('{"s":"A"}'))).toEqual([
      'body: same JSON, different bytes at character 6: upstream "{\\"s\\":\\"\\\\u0041\\"}", iglo.base "{\\"s\\":\\"A\\"}"',
    ]);
    expect(diff(res('{"a":1}'), res('{ "a":1}'))).toEqual([
      'body: same JSON, different bytes at character 1: upstream "{\\"a\\":1}", iglo.base "{ \\"a\\":1}"',
    ]);
  });

  // Sol's council finding 2 on PR #6: with `?fields=json` a record has no
  // collectionId, and json field values were then compared structurally.
  test("json field values differ under any projection", () => {
    expect(
      diff(
        res('{"items":[{"json":[1,2,3]}],"page":1}'),
        res('{"items":[{"json":[1, 2, 3]}],"page":1}'),
      ),
    ).toEqual([
      'body: same JSON, different bytes at character 21: upstream "\\"items\\":[{\\"json\\":[1,2,3]}],\\"page\\":1}", iglo.base "\\"items\\":[{\\"json\\":[1, 2, 3]}],\\"page\\":1}"',
    ]);
    expect(diff(res('{"json":{"b":1,"a":2}}'), res('{"json":{"a":2,"b":1}}'))).toEqual([
      'body json: members [b, a] vs [a, b]: upstream {"b":1,"a":2}, iglo.base {"a":2,"b":1}',
    ]);
  });
});

describe("unordered objects", () => {
  test("with `fields`, every object of a successful response is unordered", () => {
    const fields = { url: "/api/collections/demo1/records?fields=json,id" };
    expect(
      diff(
        res('{"page":1,"items":[{"json":{"b":1,"a":[2]},"id":"x"}]}'),
        res('{"items":[{"id":"x","json":{"a":[2],"b":1}}],"page":1}'),
        fields,
      ),
    ).toEqual([]);
    // member bytes still count
    expect(diff(res('{"a":[1,2]}'), res('{"a":[1, 2]}'), fields)).toHaveLength(1);
    // errors are written in a fixed order
    expect(diff(res('{"b":1,"a":2}', json, 400), res('{"a":2,"b":1}', json, 400), fields)).toEqual([
      'body: members [b, a] vs [a, b]: upstream {"b":1,"a":2}, iglo.base {"a":2,"b":1}',
    ]);
  });

  test("health data is unordered", () => {
    expect(
      diff(
        res('{"code":200,"data":{"realIP":"127.0.0.1","canBackup":true}}'),
        res('{"code":200,"data":{"canBackup":true,"realIP":"127.0.0.1"}}'),
        { url: "/api/health" },
      ),
    ).toEqual([]);
    expect(
      diff(res('{"data":{},"code":200}'), res('{"code":200,"data":{}}'), { url: "/api/health" }),
    ).toEqual([
      'body: members [data, code] vs [code, data]: upstream {"data":{},"code":200}, iglo.base {"code":200,"data":{}}',
    ]);
  });
});

describe("generated values", () => {
  test("new IDs, tokens and timestamps at generated keys are compared by format", () => {
    expect(
      diff(
        res('{"id":"aaaaaaaaaaaaaaa","token":"a.b.c","created":"2026-10-28 10:00:00.123Z"}'),
        res('{"id":"bbbbbbbbbbbbbbb","token":"x.y.z","created":"2026-10-28 10:00:01.456Z"}'),
      ),
    ).toEqual([]);
    expect(diff(res('{"id":"aaaaaaaaaaaaaaa"}'), res('{"id":"short"}'))).toEqual([
      'body id: not both ids: upstream "aaaaaaaaaaaaaaa", iglo.base "short"',
      'body id: different strings: upstream "aaaaaaaaaaaaaaa", iglo.base "short"',
    ]);
  });

  // Sol's council finding 1 on PR #6: any new string that matched a
  // format was compared by format only.
  test("other values compare exactly, even when they look generated", () => {
    expect(
      diff(
        res('{"id":"aaaaaaaaaaaaaaa","title":"abcdefghijklmno"}'),
        res('{"id":"bbbbbbbbbbbbbbb","title":"pqrstuvwxyzabcd"}'),
      ),
    ).toEqual([
      'body title: different strings: upstream "abcdefghijklmno", iglo.base "pqrstuvwxyzabcd"',
    ]);
  });

  test("values the scenario sends compare exactly", () => {
    const body = '{"id":"aaaaaaaaaaaaaaa"}';
    expect(diff(res(body), res('{"id":"bbbbbbbbbbbbbbb"}'), { url: "/api/x", body })).toEqual([
      'body id: different strings: upstream "aaaaaaaaaaaaaaa", iglo.base "bbbbbbbbbbbbbbb"',
    ]);
    expect(
      diff(res('{"token":"a.b.c"}'), res('{"token":"x.y.z"}'), { url: "/api/x?t=a%2Eb.c" }),
    ).toEqual(['body token: different strings: upstream "a.b.c", iglo.base "x.y.z"']);
  });

  test("values from the starting data must match exactly", () => {
    expect(diff(res(`{"id":"${fixtureId}"}`), res('{"id":"bbbbbbbbbbbbbbb"}'))).toEqual([
      `body id: different strings: upstream "${fixtureId}", iglo.base "bbbbbbbbbbbbbbb"`,
    ]);
    expect(diff(res('{"id":"aaaaaaaaaaaaaaa"}'), res('{"id":"achvryl401bhse3"}'))).toEqual([
      'body id: generated id expected, iglo.base\'s is in the starting data or request: upstream "aaaaaaaaaaaaaaa", iglo.base "achvryl401bhse3"',
      'body id: different strings: upstream "aaaaaaaaaaaaaaa", iglo.base "achvryl401bhse3"',
    ]);
  });

  test("a value equal to a paired generated value is replaced too", () => {
    expect(
      diff(
        res('{"rel":"aaaaaaaaaaaaaaa","expand":{"rel":{"id":"aaaaaaaaaaaaaaa"}}}'),
        res('{"rel":"bbbbbbbbbbbbbbb","expand":{"rel":{"id":"bbbbbbbbbbbbbbb"}}}'),
      ),
    ).toEqual([]);
    expect(
      diff(
        res('{"rel":"aaaaaaaaaaaaaaa","expand":{"rel":{"id":"aaaaaaaaaaaaaaa"}}}'),
        res('{"rel":"ccccccccccccccc","expand":{"rel":{"id":"bbbbbbbbbbbbbbb"}}}'),
      ),
    ).toEqual([
      'body rel: different strings: upstream "<generated id 1>", iglo.base "ccccccccccccccc"',
    ]);
  });

  test("generated values pair consistently within a scenario", () => {
    expect(
      diff(
        res('[{"id":"aaaaaaaaaaaaaaa"},{"id":"aaaaaaaaaaaaaaa"},{"id":"ccccccccccccccc"}]'),
        res('[{"id":"bbbbbbbbbbbbbbb"},{"id":"bbbbbbbbbbbbbbb"},{"id":"ddddddddddddddd"}]'),
      ),
    ).toEqual([]);
    expect(
      diff(
        res('[{"id":"aaaaaaaaaaaaaaa"},{"id":"aaaaaaaaaaaaaaa"}]'),
        res('[{"id":"bbbbbbbbbbbbbbb"},{"id":"ddddddddddddddd"}]'),
      ),
    ).toEqual([
      'body 1.id: ids not paired consistently: upstream "aaaaaaaaaaaaaaa", iglo.base "ddddddddddddddd"',
      'body 1.id: different strings: upstream "<generated id 1>", iglo.base "ddddddddddddddd"',
    ]);
    expect(
      diff(
        res('[{"id":"aaaaaaaaaaaaaaa"},{"id":"ccccccccccccccc"}]'),
        res('[{"id":"bbbbbbbbbbbbbbb"},{"id":"bbbbbbbbbbbbbbb"}]'),
      ),
    ).toEqual([
      'body 1.id: ids not paired consistently: upstream "ccccccccccccccc", iglo.base "bbbbbbbbbbbbbbb"',
      'body 1.id: different strings: upstream "ccccccccccccccc", iglo.base "<generated id 1>"',
    ]);
  });
});
