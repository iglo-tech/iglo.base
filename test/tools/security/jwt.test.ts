// Upstream: tools/security/jwt_test.go
//
// Upstream validates against time.Now(); here the clock is injected. The
// fixture tokens expire in 2018 (1516239022) or 2050 (2524604461), so any
// clock between works like upstream's.

import { describe, expect, test } from "bun:test";

import type { Clock } from "@/app/clock";
import { RawURLEncoding } from "@/tools/security/base64";
import { type MapClaims, newJWT, parseJWT, parseUnverifiedJWT } from "@/tools/security/jwt";
import { Second } from "@/tools/types/datetime";

const clockAt = (ms: number): Clock => ({ now: () => new Date(ms) });
const clock = clockAt(Date.UTC(2026, 9, 28, 12, 0, 0));

function parseUnverified(token: string): [MapClaims, boolean] {
  try {
    return [parseUnverifiedJWT(token, clock), false];
  } catch (err) {
    return [(err as { claims?: MapClaims }).claims ?? {}, true];
  }
}

describe("ParseUnverifiedJWT", () => {
  test("invalid formatted JWT", () => {
    const [claims, hasErr] = parseUnverified(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJuYW1lIjoidGVzdCJ9",
    );
    expect(hasErr).toBe(true);
    expect(Object.keys(claims)).toHaveLength(0);
  });

  test("properly formatted JWT with INVALID claims", () => {
    // {"name": "test", "exp":1516239022}
    const [claims, hasErr] = parseUnverified(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJuYW1lIjoidGVzdCIsImV4cCI6MTUxNjIzOTAyMn0.xYHirwESfSEW3Cq2BL47CEASvD_p_ps3QCA54XtNktU",
    );
    expect(hasErr).toBe(true);
    expect(Object.keys(claims)).toHaveLength(2);
    expect(claims["name"]).toBe("test");
  });

  test("properly formatted JWT with VALID claims (missing exp)", () => {
    // {"name": "test"}
    const [claims, hasErr] = parseUnverified(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJuYW1lIjoidGVzdCJ9.ml0QsTms3K9wMygTu41ZhKlTyjmW9zHQtoS8FUsCCjU",
    );
    expect(hasErr).toBe(false);
    expect(Object.keys(claims)).toHaveLength(1);
    expect(claims["name"]).toBe("test");
  });

  test("properly formatted JWT with VALID claims (valid exp)", () => {
    // {"name": "test", "exp": 2524604461}
    const [claims, hasErr] = parseUnverified(
      "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJuYW1lIjoidGVzdCIsImV4cCI6MjUyNDYwNDQ2MX0.VIEO73GP5QRQOSfHgQhaqeuYqcx59vL3xlxmFP-fytQ",
    );
    expect(hasErr).toBe(false);
    expect(Object.keys(claims)).toHaveLength(2);
    expect(claims["name"]).toBe("test");
  });
});

describe("ParseJWT", () => {
  const scenarios: [string, string, string, boolean, MapClaims | undefined][] = [
    [
      "invalid formatted JWT",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJuYW1lIjoidGVzdCJ9",
      "test",
      true,
      undefined,
    ],
    [
      "properly formatted JWT with INVALID claims and INVALID secret",
      // {"name": "test", "exp": 1516239022}
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJuYW1lIjoidGVzdCIsImV4cCI6MTUxNjIzOTAyMn0.xYHirwESfSEW3Cq2BL47CEASvD_p_ps3QCA54XtNktU",
      "invalid",
      true,
      undefined,
    ],
    [
      "properly formatted JWT with INVALID claims and VALID secret",
      // {"name": "test", "exp": 1516239022}
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJuYW1lIjoidGVzdCIsImV4cCI6MTUxNjIzOTAyMn0.xYHirwESfSEW3Cq2BL47CEASvD_p_ps3QCA54XtNktU",
      "test",
      true,
      undefined,
    ],
    [
      "properly formatted JWT with VALID claims and INVALID secret",
      // {"name": "test", "exp": 2524604461}
      "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJuYW1lIjoidGVzdCIsImV4cCI6MjUyNDYwNDQ2MX0.VIEO73GP5QRQOSfHgQhaqeuYqcx59vL3xlxmFP-fytQ",
      "invalid",
      true,
      undefined,
    ],
    [
      "properly formatted JWT with VALID claims and VALID secret",
      // {"name": "test", "exp": 2524604461}
      "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJuYW1lIjoidGVzdCIsImV4cCI6MjUyNDYwNDQ2MX0.VIEO73GP5QRQOSfHgQhaqeuYqcx59vL3xlxmFP-fytQ",
      "test",
      false,
      { name: "test", exp: 2524604461.0 },
    ],
    [
      "properly formatted JWT with VALID claims (without exp) and VALID secret",
      // {"name": "test"}
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJuYW1lIjoidGVzdCJ9.ml0QsTms3K9wMygTu41ZhKlTyjmW9zHQtoS8FUsCCjU",
      "test",
      false,
      { name: "test" },
    ],
  ];

  for (const [name, token, secret, expectError, expectClaims] of scenarios) {
    test(name, () => {
      let result: MapClaims | undefined;
      let hasErr = false;
      try {
        result = parseJWT(token, secret, clock);
      } catch {
        hasErr = true;
      }
      expect(hasErr).toBe(expectError);
      expect(result).toEqual(expectClaims);
    });
  }
});

describe("NewJWT", () => {
  const scenarios: [string, MapClaims, string, number, boolean][] = [
    ["empty, zero duration", {}, "", 0, true],
    ["empty, 10 seconds duration", {}, "", 10 * Second, false],
    ["non-empty, 10 seconds duration", { name: "test" }, "test", 10 * Second, false],
  ];

  for (const [name, claims, key, duration, expectError] of scenarios) {
    test(name, () => {
      const token = newJWT(claims, key, duration, clock);

      let parsed: MapClaims = {};
      let hasParseErr = false;
      try {
        parsed = parseJWT(token, key, clock);
      } catch {
        hasParseErr = true;
      }
      expect(hasParseErr).toBe(expectError);
      if (expectError) {
        return;
      }

      expect(Object.hasOwn(parsed, "exp")).toBe(true);
      // clear exp claim to match with the scenario ones
      delete parsed["exp"];
      expect(parsed).toEqual(claims);
    });
  }
});

// Not in upstream's tests: tokens issued by upstream PocketBase v0.41.0 for
// a superuser of a throwaway, freshly created pb_data (generated data; the
// key is that record's tokenKey + the collection's token secret).
const segmentText = (seg: string) => new TextDecoder().decode(RawURLEncoding.decodeString(seg));

describe("NewJWT matches golang-jwt byte for byte", () => {
  const tokenKey = "HF2cNsZysAlYI8WZy2pxsDoMGKDK7RTcNVMBFbjDcZgqpJmzVD";

  test("auth token", () => {
    const expected =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjb2xsZWN0aW9uSWQiOiJwYmNfMzE0MjYzNTgyMyIsImV4cCI6MTc5MzI0MDE3NCwiaWQiOiI2cnB1NXBuZXE5NXhzNXYiLCJyZWZyZXNoYWJsZSI6dHJ1ZSwidHlwZSI6ImF1dGgifQ.TrR7hWJki1rt1i4r2vI_1GkxLKKb_8ZEzo1bM8CS28k";
    const duration = 86400 * Second;
    // exp 1793240174 = now + duration, now with a sub-second part
    const issuedAt = clockAt((1793240174 - 86400) * 1000 + 999);
    const token = newJWT(
      { id: "6rpu5pneq95xs5v", type: "auth", collectionId: "pbc_3142635823", refreshable: true },
      tokenKey + "u5B2BTLuo2n4LMKBV4kweuPLNe0PtqOtX2S5lbQmQ6kcCAh1jR",
      duration,
      issuedAt,
    );
    expect(token).toBe(expected);
  });

  test("file token", () => {
    const expected =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjb2xsZWN0aW9uSWQiOiJwYmNfMzE0MjYzNTgyMyIsImV4cCI6MTc5MzE1Mzk1NCwiaWQiOiI2cnB1NXBuZXE5NXhzNXYiLCJ0eXBlIjoiZmlsZSJ9.lZ4LbLpF2oVV-v3Fc_8Z1bOZ5Zb63oeTeMSNviXnoaY";
    const token = newJWT(
      { id: "6rpu5pneq95xs5v", type: "file", collectionId: "pbc_3142635823" },
      tokenKey + "ZEUIDzrv3aXMwu3X6LnXamcSi81kfvo9ilgHe8GJoAEE1WFubO",
      180 * Second,
      clockAt((1793153954 - 180) * 1000),
    );
    expect(token).toBe(expected);
  });

  test("claims JSON is encoding/json's: sorted keys, HTML and JS escapes", () => {
    const token = newJWT(
      { b: "<a>&\u2028", a: 1.5, c: [true, null], é: -0 },
      "k",
      0,
      clockAt(1000_500),
    );
    const [header, claims] = token.split(".") as [string, string];
    expect(segmentText(header)).toBe(`{"alg":"HS256","typ":"JWT"}`);
    expect(segmentText(claims)).toBe(
      `{"a":1.5,"b":"\\u003ca\\u003e\\u0026\\u2028","c":[true,null],"exp":1000,"é":-0}`,
    );
  });

  test("a payload exp replaces the computed one", () => {
    const token = newJWT({ exp: 42 }, "k", 10 * Second, clock);
    const claims = (token.split(".") as [string, string])[1];
    expect(new TextDecoder().decode(RawURLEncoding.decodeString(claims))).toBe(`{"exp":42}`);
  });
});

// Not in upstream's tests: the accept/reject decisions of golang-jwt
// v5.3.1 with upstream's parser options. The same cases were checked
// against the upstream binary (auth-refresh with a token signed by the
// record's key) and agree.
describe("ParseJWT and ParseUnverifiedJWT edge cases", () => {
  const key = "secret";
  const now = 1_800_000_000; // seconds
  const at = clockAt(now * 1000 + 250);
  const enc = new TextEncoder();
  const b64 = (s: string | Uint8Array) =>
    RawURLEncoding.encodeToString(typeof s === "string" ? enc.encode(s) : s);
  const sign = (algorithm: "sha256" | "sha512", text: string) => {
    const h = new Bun.CryptoHasher(algorithm, enc.encode(key));
    h.update(enc.encode(text));
    return b64(h.digest());
  };
  const tok = (
    header: string,
    claims: string | Uint8Array,
    algorithm: "sha256" | "sha512" = "sha256",
  ) => {
    const t = b64(header) + "." + b64(claims);
    return t + "." + sign(algorithm, t);
  };
  const H = `{"alg":"HS256","typ":"JWT"}`;
  const valid = tok(H, `{"id":"a"}`);
  const withNewline = b64(H) + ".\r\n" + b64(`{"id":"a"}`);

  // name, token, ParseUnverifiedJWT accepts, ParseJWT accepts
  const scenarios: [string, string, boolean, boolean][] = [
    ["valid", valid, true, true],
    ["alg none", b64(`{"alg":"none","typ":"JWT"}`) + "." + b64(`{"id":"a"}`) + ".", true, false],
    ["alg HS512", tok(`{"alg":"HS512","typ":"JWT"}`, `{"id":"a"}`, "sha512"), true, false],
    ["alg RS256", tok(`{"alg":"RS256"}`, `{"id":"a"}`), true, false],
    ["alg unknown", tok(`{"alg":"hs256"}`, `{"id":"a"}`), false, false],
    ["alg missing", tok(`{"typ":"JWT"}`, `{"id":"a"}`), false, false],
    ["alg not a string", tok(`{"alg":256}`, `{"id":"a"}`), false, false],
    ["duplicate alg, last wins", tok(`{"alg":"none","alg":"HS256"}`, `{"id":"a"}`), true, true],
    [
      "duplicate alg, number then string",
      tok(`{"alg":256,"alg":"HS256"}`, `{"id":"a"}`),
      true,
      true,
    ],
    [
      "duplicate alg, string then number",
      tok(`{"alg":"HS256","alg":256}`, `{"id":"a"}`),
      false,
      false,
    ],
    ["duplicate exp, string then number", tok(H, `{"exp":"old","exp":${now + 60}}`), true, true],
    ["duplicate exp, number then string", tok(H, `{"exp":${now + 60},"exp":"old"}`), false, false],
    ["header null", tok(`null`, `{"id":"a"}`), false, false],
    ["header array", tok(`["HS256"]`, `{"id":"a"}`), false, false],
    ["claims null", tok(H, `null`), true, true],
    ["claims array", tok(H, `[1]`), false, false],
    ["claims trailing data", tok(H, `{"id":"a"} x`), false, false],
    ["claims number overflow", tok(H, `{"x":1e400}`), false, false],
    [
      "claims invalid UTF-8",
      tok(H, new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])),
      true,
      true,
    ],
    ["claims lone surrogate escape", tok(H, `{"x":"\\ud800"}`), true, true],
    ["exp missing", tok(H, `{}`), true, true],
    ["exp 0", tok(H, `{"exp":0}`), true, true],
    ["exp string", tok(H, `{"exp":"${now + 60}"}`), false, false],
    ["exp null", tok(H, `{"exp":null}`), false, false],
    ["exp bool", tok(H, `{"exp":true}`), false, false],
    ["exp exactly at now", tok(H, `{"exp":${now}}`), false, false],
    ["exp now + 1", tok(H, `{"exp":${now + 1}}`), true, true],
    ["exp fraction within now's second", tok(H, `{"exp":${now}.9}`), false, false],
    ["exp past", tok(H, `{"exp":${now - 60}}`), false, false],
    ["exp 1e19 is MinInt64 on amd64", tok(H, `{"exp":1e19}`), false, false],
    ["exp wrapping int64 internal seconds", tok(H, `{"exp":9223372026854775808}`), false, false],
    ["exp 9.2e18", tok(H, `{"exp":9.2e18}`), true, true],
    ["nbf exactly at now", tok(H, `{"nbf":${now}}`), true, true],
    ["nbf future", tok(H, `{"nbf":${now + 1}}`), false, false],
    ["nbf string", tok(H, `{"nbf":"1"}`), false, false],
    ["iat exactly at now", tok(H, `{"iat":${now}}`), true, true],
    ["iat future (ParseJWT does not check iat)", tok(H, `{"iat":${now + 1}}`), false, true],
    ["iat string (ParseJWT does not check iat)", tok(H, `{"iat":"1"}`), false, true],
    ["signature padding", valid + "=", false, false],
    ["four segments", valid + ".x", false, false],
    ["two segments", valid.split(".").slice(0, 2).join("."), false, false],
    ["header padding", b64(H) + "==." + valid.split(".").slice(1).join("."), false, false],
    [
      "bad signature",
      valid.split(".").slice(0, 2).join(".") + "." + sign("sha256", "x"),
      true,
      false,
    ],
    [
      "signature base64 std alphabet",
      valid.split(".").slice(0, 2).join(".") + ".ab+/",
      false,
      false,
    ],
    [
      "newline in a segment is skipped",
      withNewline + "." + sign("sha256", withNewline),
      true,
      true,
    ],
  ];

  test("duplicate claims replace earlier values of any type", () => {
    const token = tok(H, `{"a":{"x":1},"a":{"y":2},"b":[1],"b":"s","c":"s","c":{"z":3}}`);
    const expected = { a: { y: 2 }, b: "s", c: { z: 3 } };
    expect(parseUnverifiedJWT(token, at)).toEqual(expected);
    expect(parseJWT(token, key, at)).toEqual(expected);
  });

  for (const [name, token, unverifiedOk, verifiedOk] of scenarios) {
    test(name, () => {
      let u = true;
      try {
        parseUnverifiedJWT(token, at);
      } catch {
        u = false;
      }
      let v = true;
      try {
        parseJWT(token, key, at);
      } catch {
        v = false;
      }
      expect([u, v]).toEqual([unverifiedOk, verifiedOk]);
    });
  }
});
