// Upstream: golang.org/x/oauth2 token.go (Token.Type, Extra, Valid). The token
// endpoint round trip is covered against the upstream binary in
// test/differential/auth/oauth2-cases.ts.

import { describe, expect, test } from "bun:test";

import { Token, validToken } from "@/oauth2/token";

const clock = { now: () => new Date("2030-01-01T00:00:00Z") };
const inSeconds = (s: number): Date => new Date(clock.now().getTime() + s * 1000);

describe("Token.type", () => {
  for (const [tokenType, expected] of [
    ["", "Bearer"],
    ["bearer", "Bearer"],
    ["BEARER", "Bearer"],
    ["mac", "MAC"],
    ["basic", "Basic"],
    ["DPoP", "DPoP"],
  ] as const) {
    test(JSON.stringify(tokenType), () => {
      expect(new Token({ tokenType }).type()).toBe(expected);
    });
  }
});

describe("Token.extra", () => {
  test("a JSON response", () => {
    const token = new Token({ raw: { id_token: "abc", n: 1 } });
    expect(token.extra("id_token")).toBe("abc");
    expect(token.extra("n")).toBe(1);
    expect(token.extra("missing")).toBeUndefined();
    expect(token.extra("toString")).toBeUndefined();
  });

  test("a query string response", () => {
    const token = new Token({
      raw: new Map([
        ["text", ["abc"]],
        ["int", ["123"]],
        ["float", ["1.5"]],
        ["dots", ["1.2.3"]],
      ]),
    });
    expect(token.extra("text")).toBe("abc");
    expect(token.extra("int")).toBe(123);
    expect(token.extra("float")).toBe(1.5);
    expect(token.extra("dots")).toBe("1.2.3");
    expect(token.extra("missing")).toBe("");
  });

  test("no raw response", () => {
    expect(new Token().extra("id_token")).toBeUndefined();
  });
});

describe("Token.valid", () => {
  test("needs an access token", () => {
    expect(new Token().valid(clock)).toBe(false);
  });

  test("without an expiry it never expires", () => {
    expect(new Token({ accessToken: "abc" }).valid(clock)).toBe(true);
  });

  test("expires 10 seconds early", () => {
    expect(new Token({ accessToken: "abc", expiry: inSeconds(11) }).valid(clock)).toBe(true);
    expect(new Token({ accessToken: "abc", expiry: inSeconds(9) }).valid(clock)).toBe(false);
  });
});

test("an expired token without a refresh token fails before any request", async () => {
  const config = {
    clientId: "",
    clientSecret: "",
    tokenURL: "http://127.0.0.1:1/never",
    signal: undefined,
    clock,
  };
  const token = new Token({ accessToken: "abc", expiry: inSeconds(-1) });
  await expect(validToken(config, token)).rejects.toThrow("refresh token is not set");
});
