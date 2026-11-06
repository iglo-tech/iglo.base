// The differential comparison's normalization rules, on hand-made responses.

import { describe, expect, test } from "bun:test";

import {
  compareResponses,
  Pairing,
  tokenExpSlack,
  type Context,
} from "@test/differential/harness/compare";
import type { ScenarioResponse } from "@test/scenarios/request";

const fixtureId = "wsmn24bux7wo113";
const fixtureTime = "2022-10-01 12:00:00.000Z";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims: Record<string, unknown>, header: unknown = { alg: "HS256", typ: "JWT" }) =>
  `${b64(header)}.${b64(claims)}.sig`;
const authClaims = (over: Record<string, unknown> = {}) => ({
  id: "aaaaaaaaaaaaaaa",
  type: "auth",
  collectionId: "ccccccccccccccc",
  refreshable: true,
  exp: 2000000000,
  ...over,
});

const user = (n: string) => ({ id: n.repeat(15) });

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

const writeContext = (url = "/api/batch"): Context => ({
  start: { contains: () => false },
  request: { url },
});
const updatedBody = (updated: string) => res(`{"id":"sdkbatchfile001","updated":"${updated}"}`);
// a batch response with the create and the update of one record
const batchBody = (...updated: string[]) =>
  res(
    JSON.stringify(
      updated.map((value) => ({ status: 200, body: { id: "sdkbatchfile001", updated: value } })),
    ),
  );
const sqlBody = (execTime: string) =>
  res(`{"execTime":${execTime},"affectedRows":0,"columns":[],"rows":[]}`);

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

// an auth methods provider URL (apis/record_auth_methods.go)
function authURL(clientId: string, challenge: string, state: string): string {
  return `https://gitlab.com/oauth/authorize?client_id=${clientId}&code_challenge=${challenge}&code_challenge_method=S256&response_type=code&scope=read_user&state=${state}&redirect_uri=`;
}

function authMethodsBody(u: string, state: string): string {
  return JSON.stringify({ state, authURL: u, authUrl: u, legacy: [{ authURL: u }] });
}

const secrets = (up: string, ig: string, pairing = new Pairing()) =>
  compareResponses(
    res(`{"secret":"${up}"}`),
    res(`{"secret":"${ig}"}`),
    { start: { contains: () => false }, request: { url: "/api/x" } },
    pairing,
  );

describe("generated values", () => {
  test("new IDs, tokens and timestamps at generated keys are compared by format", () => {
    expect(
      diff(
        res(
          `{"id":"aaaaaaaaaaaaaaa","token":"${jwt(authClaims())}","created":"2026-10-28 10:00:00.123Z"}`,
        ),
        res(
          `{"id":"bbbbbbbbbbbbbbb","token":"${jwt(authClaims({ id: "bbbbbbbbbbbbbbb", collectionId: "ccccccccccccccc" }))}","created":"2026-10-28 10:00:01.456Z"}`,
        ),
      ),
    ).toEqual([]);
    expect(diff(res('{"id":"aaaaaaaaaaaaaaa"}'), res('{"id":"short"}'))).toEqual([
      'body id: not both ids: upstream "aaaaaaaaaaaaaaa", iglo.base "short"',
      'body id: different strings: upstream "aaaaaaaaaaaaaaa", iglo.base "short"',
    ]);
  });

  // two sign-ins in one second: upstream's tokens are equal (exp has whole
  // seconds), iglo.base's may not be, or the other way round
  describe("tokens are decoded and their claims compared", () => {
    const start = { contains: (v: string) => ["ccccccccccccccc", "fixture0000000x"].includes(v) };
    const checkWith = (pairing: Pairing, up: string, ig: string): string[] =>
      compareResponses(
        res(`{"token":"${up}"}`),
        res(`{"token":"${ig}"}`),
        { start, request: { url: "/api/collections/users/auth-refresh" } },
        pairing,
      );
    const check = (up: string, ig: string) => checkWith(new Pairing(), up, ig);

    test("the same claims pass whatever the signature and a whole-second exp variation", () => {
      const pairing = new Pairing();
      const up = jwt(authClaims(user("a")));
      expect(checkWith(pairing, up, jwt(authClaims({ ...user("b"), exp: 2000000001 })))).toEqual(
        [],
      );
      // the same-second sign-in: upstream's equal tokens against two of ours
      expect(checkWith(pairing, up, jwt(authClaims({ ...user("b"), exp: 2000000002 })))).toEqual(
        [],
      );
      expect(check(jwt(authClaims({ exp: 2000000003 })), jwt(authClaims()))).toEqual([]);
    });

    test("a different type, collectionId, refreshable, header or id is a difference", () => {
      const up = jwt(authClaims());
      expect(check(up, jwt(authClaims({ type: "file" })))).not.toEqual([]);
      expect(check(up, jwt(authClaims({ collectionId: "ddddddddddddddd" })))).not.toEqual([]);
      expect(check(up, jwt(authClaims({ refreshable: false })))).not.toEqual([]);
      expect(check(up, jwt(authClaims({ extra: 1 })))).not.toEqual([]);
      expect(check(up, jwt(authClaims(), { alg: "HS512", typ: "JWT" }))).not.toEqual([]);
      expect(check(up, jwt(authClaims({ id: "fixture0000000x" })))).not.toEqual([]);
    });

    test("an exp beyond the bound is a difference", () => {
      const up = jwt(authClaims());
      expect(check(up, jwt(authClaims({ exp: 2000000000 + tokenExpSlack + 1 })))).not.toEqual([]);
      expect(check(up, jwt(authClaims({ exp: 2000000000 - tokenExpSlack - 1 })))).not.toEqual([]);
      expect(check(up, jwt(authClaims({ exp: "2000000000" })))).not.toEqual([]);
    });

    test("exp follows the clock offset of legs that run one after the other", () => {
      const offset = new Pairing({ clockOffset: 13 });
      const up = jwt(authClaims());
      expect(checkWith(offset, up, jwt(authClaims({ exp: 2000000013 })))).toEqual([]);
      expect(checkWith(new Pairing({ clockOffset: 13 }), up, jwt(authClaims()))).not.toEqual([]);
    });

    test("two different users on one side mapped to one token on the other", () => {
      const pairing = new Pairing();
      expect(checkWith(pairing, jwt(authClaims(user("a"))), jwt(authClaims(user("x"))))).toEqual(
        [],
      );
      // upstream's second user is another record, ours repeats the first
      expect(
        checkWith(pairing, jwt(authClaims(user("b"))), jwt(authClaims(user("x")))),
      ).not.toEqual([]);
      // and the reverse
      expect(
        checkWith(pairing, jwt(authClaims(user("a"))), jwt(authClaims(user("y")))),
      ).not.toEqual([]);
    });

    test("a value that is not a decodable token is a difference", () => {
      expect(check("d.e.f", "x.y.z")).not.toEqual([]);
      expect(check(jwt(authClaims()), "not a token")).not.toEqual([]);
    });

    test("a secret pairs by value, whatever its claims", () => {
      expect(secrets("a.b.c", "x.y.z")).toEqual([]);
      const pairing = new Pairing();
      expect(secrets("a.b.c", "x.y.z", pairing)).toEqual([]);
      expect(secrets("d.e.f", "x.y.z", pairing)).not.toEqual([]);
    });
  });

  // upstream reads the clock once per autodate field (M3.1)
  test("timestamps need not pair: created and updated may differ on either side", () => {
    expect(
      diff(
        res('{"created":"2026-10-28 10:00:00.124Z","updated":"2026-10-28 10:00:00.123Z"}'),
        res('{"created":"2026-10-28 10:00:01.456Z","updated":"2026-10-28 10:00:01.456Z"}'),
      ),
    ).toEqual([]);
    expect(diff(res('{"created":"2026-10-28 10:00:00.124Z"}'), res('{"created":"x"}'))).toEqual([
      'body created: not both timestamps: upstream "2026-10-28 10:00:00.124Z", iglo.base "x"',
      'body created: different strings: upstream "2026-10-28 10:00:00.124Z", iglo.base "x"',
    ]);
  });

  // Sol's council finding 3 on PR #28: a record's timestamps must stay
  // the same across its write response and read-back
  test("a record's timestamp pairs with one value across responses", () => {
    const pairing = new Pairing();
    const context: Context = {
      start: { contains: () => false },
      request: { url: "/api/collections/demo2/records" },
    };
    const write = compareResponses(
      res('{"id":"aaaaaaaaaaaaaaa","created":"2026-10-29 10:00:00.123Z"}'),
      res('{"id":"bbbbbbbbbbbbbbb","created":"2026-10-29 10:00:01.456Z"}'),
      context,
      pairing,
    );
    expect(write).toEqual([]);
    const readBack = compareResponses(
      res('{"id":"aaaaaaaaaaaaaaa","created":"2026-10-29 10:00:00.123Z"}'),
      res('{"id":"bbbbbbbbbbbbbbb","created":"2026-10-29 11:11:11.111Z"}'),
      context,
      pairing,
    );
    expect(readBack).toContain(
      'body created: timestamps not paired consistently: upstream "2026-10-29 10:00:00.123Z", iglo.base "2026-10-29 11:11:11.111Z"',
    );
    // the same values read back again still pair
    expect(
      compareResponses(
        res('{"id":"aaaaaaaaaaaaaaa","created":"2026-10-29 10:00:00.123Z"}'),
        res('{"id":"bbbbbbbbbbbbbbb","created":"2026-10-29 10:00:01.456Z"}'),
        context,
        pairing,
      ),
    ).toEqual([]);
  });

  // P.6: two writes of one record within a millisecond share an `updated`
  // on one server and not on the other (batch create + update)
  test("a batch's create and update of one record may share a millisecond on one side", () => {
    const pairing = new Pairing();
    const context = writeContext();
    // upstream: one millisecond for both; iglo.base: the next one
    expect(
      compareResponses(
        batchBody("2026-11-06 10:00:00.123Z", "2026-11-06 10:00:00.123Z"),
        batchBody("2026-11-06 10:00:05.100Z", "2026-11-06 10:00:05.101Z"),
        context,
        pairing,
      ),
    ).toEqual([]);
    // the read-back shows the last draw on both
    expect(
      compareResponses(
        updatedBody("2026-11-06 10:00:00.123Z"),
        updatedBody("2026-11-06 10:00:05.101Z"),
        writeContext("/api/collections/x/records/y"),
        pairing,
      ),
    ).toEqual([]);
    expect(
      compareResponses(
        updatedBody("2026-11-06 10:00:00.123Z"),
        updatedBody("2026-11-06 10:00:05.100Z"),
        writeContext("/api/collections/x/records/y"),
        pairing,
      ),
    ).toContain(
      'body updated: timestamps not paired consistently: upstream "2026-11-06 10:00:00.123Z", iglo.base "2026-11-06 10:00:05.100Z"',
    );
    // the other way around
    expect(
      compareResponses(
        batchBody("2026-11-06 11:00:00.100Z", "2026-11-06 11:00:00.101Z"),
        batchBody("2026-11-06 11:00:05.123Z", "2026-11-06 11:00:05.123Z"),
        context,
        new Pairing(),
      ),
    ).toEqual([]);
    // a gap of more than a few milliseconds is a difference
    expect(
      compareResponses(
        batchBody("2026-11-06 10:00:00.123Z", "2026-11-06 10:00:00.123Z"),
        batchBody("2026-11-06 10:00:05.100Z", "2026-11-06 10:00:05.300Z"),
        context,
        new Pairing(),
      ),
    ).not.toEqual([]);
  });

  test("with history a step shows an earlier pair again, other callers do not", () => {
    const up = batchBody("2026-11-06 10:00:00.123Z", "2026-11-06 10:00:00.123Z");
    const ig = batchBody("2026-11-06 10:00:05.100Z", "2026-11-06 10:00:05.101Z");
    for (const step of [true, false]) {
      const pairing = new Pairing({ history: step });
      expect(compareResponses(up, ig, writeContext(), pairing)).toEqual([]);
      const again = compareResponses(up, ig, writeContext(), pairing);
      expect(again.length === 0).toBe(step);
    }
  });

  test("a plain update must advance updated as upstream's does", () => {
    const create = (pairing: Pairing) =>
      compareResponses(
        updatedBody("2026-11-06 10:00:00.100Z"),
        updatedBody("2026-11-06 10:00:00.200Z"),
        writeContext("/api/collections/x/records"),
        pairing,
      );
    const patch = writeContext("/api/collections/x/records/y");
    // no advance on iglo.base one minute later
    let pairing = new Pairing();
    expect(create(pairing)).toEqual([]);
    expect(
      compareResponses(
        updatedBody("2026-11-06 10:01:00.100Z"),
        updatedBody("2026-11-06 10:00:00.200Z"),
        patch,
        pairing,
      ),
    ).not.toEqual([]);
    // an extra bump by iglo.base (auth-refresh of a user the scenario made)
    pairing = new Pairing();
    expect(create(pairing)).toEqual([]);
    expect(
      compareResponses(
        updatedBody("2026-11-06 10:00:00.100Z"),
        updatedBody("2026-11-06 10:00:09.200Z"),
        writeContext("/api/collections/users/auth-refresh"),
        pairing,
      ),
    ).not.toEqual([]);
    // updated going backwards
    pairing = new Pairing();
    expect(create(pairing)).toEqual([]);
    expect(
      compareResponses(
        updatedBody("2026-11-06 10:01:00.100Z"),
        updatedBody("2026-11-05 10:00:00.200Z"),
        patch,
        pairing,
      ),
    ).not.toEqual([]);
    // an update that advances on both sides pairs its new values
    pairing = new Pairing();
    expect(create(pairing)).toEqual([]);
    expect(
      compareResponses(
        updatedBody("2026-11-06 10:01:00.100Z"),
        updatedBody("2026-11-06 10:01:00.200Z"),
        patch,
        pairing,
      ),
    ).toEqual([]);
  });

  test("a record's updated pairs on its own, the other way around too", () => {
    const pairing = new Pairing();
    const context: Context = {
      start: { contains: () => false },
      request: { url: "/api/collections/demo2/records" },
    };
    expect(
      compareResponses(
        res('{"id":"aaaaaaaaaaaaaaa","updated":"2026-10-29 10:00:00.123Z"}'),
        res('{"id":"bbbbbbbbbbbbbbb","updated":"2026-10-29 10:00:01.456Z"}'),
        context,
        pairing,
      ),
    ).toEqual([]);
    // a different upstream value for the same iglo.base value
    expect(
      compareResponses(
        res('{"id":"aaaaaaaaaaaaaaa","updated":"2026-10-29 10:00:00.999Z"}'),
        res('{"id":"bbbbbbbbbbbbbbb","updated":"2026-10-29 10:00:01.456Z"}'),
        context,
        pairing,
      ),
    ).toContain(
      'body updated: timestamps not paired consistently: upstream "2026-10-29 10:00:00.999Z", iglo.base "2026-10-29 10:00:01.456Z"',
    );
    // another record's updated is independent
    expect(
      compareResponses(
        res('{"id":"ccccccccccccccc","updated":"2026-10-29 10:00:00.123Z"}'),
        res('{"id":"ddddddddddddddd","updated":"2026-10-29 10:00:02.000Z"}'),
        context,
        pairing,
      ),
    ).toEqual([]);
  });

  test("autogenerated usernames are compared by format", () => {
    expect(diff(res('{"username":"users12345"}'), res('{"username":"users67890"}'))).toEqual([]);
    expect(diff(res('{"username":"users12345"}'), res('{"username":"Users67890"}'))).toHaveLength(
      2,
    );
  });

  test("auth methods URLs compare all but their state and code challenge", () => {
    const state1 = "XPCatjZu1UhljN91JA8eDalssocVDU";
    const state2 = "Lu3IMq9sUqKbnpJWTSNVTXLNQEUTy3";
    const challenge1 = "NowJUF9SooC3NppZdEDMpx2IYzXhIsntBB5U_GJo4SQ";
    const challenge2 = "yG0NPADHZcoGEoP6pmSHMlN9kt3J_A8N68Gqnp5-IDk";
    const url = authURL;
    const body = authMethodsBody;
    const request = { url: "/api/collections/users/auth-methods" };

    const up = url("test1", challenge1, state1);
    expect(
      diff(res(body(up, state1)), res(body(url("test1", challenge2, state2), state2)), request),
    ).toEqual([]);
    const formatDiffs = (ig: string, state: string) =>
      diff(res(body(up, state1)), res(body(ig, state)), request).filter((d) =>
        d.includes("not both authURLs"),
      );
    // anything else in the URL must match
    expect(formatDiffs(url("test2", challenge2, state2), state2)).toHaveLength(3);
    // a state of the wrong format
    expect(formatDiffs(url("test1", challenge2, "short"), state2)).toHaveLength(3);
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

// Sol's council round-2 findings on PR #6.
describe("council round 2", () => {
  test("file downloads are compared byte for byte, even when they hold JSON", () => {
    const url = "/api/files/wsmn24bux7wo113/84nmscqy84lsi1t/test_MaWC6mWyrP.txt";
    const plain = { "content-type": "text/plain; charset=utf-8" };
    expect(
      diff(res('{"id":"aaaaaaaaaaaaaaa"}', plain), res('{"id":"bbbbbbbbbbbbbbb"}', plain), { url }),
    ).toEqual([
      'body: upstream "{\\"id\\":\\"aaaaaaaaaaaaaaa\\"}", iglo.base "{\\"id\\":\\"bbbbbbbbbbbbbbb\\"}"',
    ]);
    expect(
      diff(res('{"id":"aaaaaaaaaaaaaaa"}'), res('{"id":"bbbbbbbbbbbbbbb"}'), { url }),
    ).toHaveLength(1);
  });

  test("a value sent with JSON string escapes compares exactly", () => {
    const body = '{"id":"\\u0061aaaaaaaaaaaaaa","title":"review"}';
    expect(
      diff(res('{"id":"aaaaaaaaaaaaaaa"}'), res('{"id":"bbbbbbbbbbbbbbb"}'), {
        url: "/api/collections/demo2/records",
        body,
      }),
    ).toEqual([
      'body id: different strings: upstream "aaaaaaaaaaaaaaa", iglo.base "bbbbbbbbbbbbbbb"',
    ]);
  });

  test("bytes around the top-level value are compared", () => {
    expect(diff(res('{"a":1}'), res(' \n{"a":1}\n '))).toHaveLength(1);
    expect(diff(res('{"a":1}\n'), res('{"a":1}\n'))).toEqual([]);
  });
});

// Council round 3 on PR #6 (Opus 1, Sol 1 and 2).
describe("council round 3", () => {
  test("the file token endpoint answers API JSON with a generated token", () => {
    expect(
      diff(
        res(`{"token":"${jwt(authClaims({ type: "file" }))}"}`),
        res(`{"token":"${jwt(authClaims({ type: "file", exp: 2000000001 }))}"}`),
        { url: "/api/files/token" },
      ),
    ).toEqual([]);
  });

  test("a value sent percent-encoded in a urlencoded form compares exactly", () => {
    expect(
      diff(res('{"id":"aaaaaaaaaaaaaaa"}'), res('{"id":"bbbbbbbbbbbbbbb"}'), {
        url: "/api/collections/demo2/records",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "id=%61aaaaaaaaaaaaaa&title=review",
      }),
    ).toEqual([
      'body id: different strings: upstream "aaaaaaaaaaaaaaa", iglo.base "bbbbbbbbbbbbbbb"',
    ]);
  });

  test("a value sent escaped in a multipart @jsonPayload part compares exactly", () => {
    const body = [
      "--b0",
      'Content-Disposition: form-data; name="@jsonPayload"',
      "",
      '{"id":"\\u0061aaaaaaaaaaaaaa"}',
      "--b0--",
      "",
    ].join("\r\n");
    expect(
      diff(res('{"id":"aaaaaaaaaaaaaaa"}'), res('{"id":"bbbbbbbbbbbbbbb"}'), {
        url: "/api/collections/demo2/records",
        headers: { "Content-Type": "multipart/form-data; boundary=b0" },
        body,
      }),
    ).toEqual([
      'body id: different strings: upstream "aaaaaaaaaaaaaaa", iglo.base "bbbbbbbbbbbbbbb"',
    ]);
  });
});

describe("generated file names", () => {
  test("only the random parts may differ", () => {
    expect(
      diff(
        res('{"f":["my_doc_abcdefghij.txt","ab0123456789_abcdefghij.tar.gz"]}'),
        res('{"f":["my_doc_0123456789.txt","abzzzzzzzzzz_zzzzzzzzzz.tar.gz"]}'),
      ),
    ).toEqual([]);
    expect(
      diff(res('{"f":"my_doc_abcdefghij.txt"}'), res('{"f":"my_dox_0123456789.txt"}')),
    ).toContain(
      'body f: not both file names: upstream "my_doc_abcdefghij.txt", iglo.base "my_dox_0123456789.txt"',
    );
    expect(
      diff(res('{"f":"my_doc_abcdefghij.txt"}'), res('{"f":"my_doc_0123456789.png"}')),
    ).toContain(
      'body f: not both file names: upstream "my_doc_abcdefghij.txt", iglo.base "my_doc_0123456789.png"',
    );
  });

  test("names pair consistently", () => {
    expect(
      diff(
        res('{"a":"x_abcdefghij.txt","b":"x_abcdefghij.txt"}'),
        res('{"a":"x_0123456789.txt","b":"x_9999999999.txt"}'),
      ),
    ).toContain(
      'body b: file names not paired consistently: upstream "x_abcdefghij.txt", iglo.base "x_9999999999.txt"',
    );
  });

  test("names sent in the request are compared exactly", () => {
    expect(
      diff(res('{"f":"x_abcdefghij.txt"}'), res('{"f":"x_0123456789.txt"}'), {
        url: "/api/collections/demo2/records/x?f=x_abcdefghij.txt",
      }),
    ).not.toEqual([]);
  });
});

describe("execTime of the SQL console", () => {
  const sql: Context = {
    start: { contains: () => false },
    request: { url: "/api/sql" },
  };
  test("compares as a non-negative integer only", () => {
    expect(compareResponses(sqlBody("0"), sqlBody("17"), sql)).toEqual([]);
    expect(compareResponses(sqlBody("0"), sqlBody("0.31"), sql)).not.toEqual([]);
    expect(compareResponses(sqlBody("0.31"), sqlBody("1.7"), sql)).not.toEqual([]);
    expect(compareResponses(sqlBody("1"), sqlBody("-1"), sql)).not.toEqual([]);
    expect(compareResponses(sqlBody("1"), sqlBody('"x"'), sql)).not.toEqual([]);
    expect(
      compareResponses(
        sqlBody("1"),
        res('{"execTime":1,"affectedRows":1,"columns":[],"rows":[]}'),
        sql,
      ),
    ).not.toEqual([]);
  });

  test("other endpoints compare it exactly", () => {
    const other: Context = { ...sql, request: { url: "/api/x" } };
    expect(compareResponses(sqlBody("1"), sqlBody("2"), other)).not.toEqual([]);
  });
});
