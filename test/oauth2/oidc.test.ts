// Upstream: tools/auth/oidc.go. Upstream has no oidc_test.go at v0.41.0; these
// are the boundaries of the id_token checks with an injected clock and
// PB_ID_TOKEN_LEEWAY, which the servers read once.
// test/differential/auth/oauth2-cases.ts runs the same checks on both servers.

import { afterEach, describe, expect, test } from "bun:test";

import { OIDC } from "@/oauth2/oidc";
import { Token } from "@/oauth2/token";

const nowSeconds = 1_900_000_000;
const clock = { now: () => new Date(nowSeconds * 1000) };

const b64url = (value: string): string => Buffer.from(value).toString("base64url");

function idToken(claims: { [key: string]: unknown }): Token {
  const jwt = [
    b64url(JSON.stringify({ alg: "HS256" })),
    b64url(JSON.stringify({ sub: "abc", aud: "client", ...claims })),
    b64url("signature"),
  ].join(".");
  return new Token({ accessToken: "abc", raw: { id_token: jwt } });
}

function provider(): OIDC {
  const p = new OIDC();
  p.clientId = "client";
  p.clock = clock;
  return p;
}

afterEach(() => {
  delete process.env["PB_ID_TOKEN_LEEWAY"];
});

describe("the id_token leeway", () => {
  test("5 minutes by default", async () => {
    await expect(
      provider().fetchAuthUser(idToken({ exp: nowSeconds - 299 })),
    ).resolves.toMatchObject({ id: "abc" });
    await expect(provider().fetchAuthUser(idToken({ exp: nowSeconds - 301 }))).rejects.toThrow(
      "token is expired",
    );
  });

  test("PB_ID_TOKEN_LEEWAY sets it", async () => {
    process.env["PB_ID_TOKEN_LEEWAY"] = "10";
    await expect(provider().fetchAuthUser(idToken({ exp: nowSeconds - 9 }))).resolves.toMatchObject(
      { id: "abc" },
    );
    await expect(provider().fetchAuthUser(idToken({ exp: nowSeconds - 11 }))).rejects.toThrow(
      "token is expired",
    );
  });

  test("an invalid PB_ID_TOKEN_LEEWAY keeps the default", async () => {
    process.env["PB_ID_TOKEN_LEEWAY"] = "soon";
    await expect(
      provider().fetchAuthUser(idToken({ exp: nowSeconds - 299 })),
    ).resolves.toMatchObject({ id: "abc" });
  });

  test("covers iat and nbf", async () => {
    await expect(
      provider().fetchAuthUser(idToken({ iat: nowSeconds + 299, nbf: nowSeconds + 299 })),
    ).resolves.toMatchObject({ id: "abc" });
    await expect(provider().fetchAuthUser(idToken({ iat: nowSeconds + 301 }))).rejects.toThrow(
      "used before issued",
    );
    await expect(provider().fetchAuthUser(idToken({ nbf: nowSeconds + 301 }))).rejects.toThrow(
      "not valid yet",
    );
  });
});

describe("the id_token claims", () => {
  test("the user fields, the raw user and the unverified email", async () => {
    const user = await provider().fetchAuthUser(
      idToken({ name: "n", preferred_username: "u", picture: "p", email: "e@example.com" }),
    );
    expect(user).toMatchObject({ id: "abc", name: "n", username: "u", avatarURL: "p", email: "" });
    expect(user.rawUser).toMatchObject({ email: "e@example.com" });
  });

  test("an aud of another type is no audience", async () => {
    await expect(provider().fetchAuthUser(idToken({ aud: 1 }))).rejects.toThrow("aud");
  });

  test("a list of audiences with a non-string member", async () => {
    await expect(provider().fetchAuthUser(idToken({ aud: ["client", 1] }))).rejects.toThrow(
      "aud is invalid",
    );
  });

  test("a non-string iss fails the issuers check", async () => {
    const p = provider();
    p.extra = { issuers: ["https://a.example"] };
    await expect(p.fetchAuthUser(idToken({ iss: 1 }))).rejects.toThrow("iss must be one of");
  });

  test("a query string token's numeric id_token is no id_token", async () => {
    const token = new Token({ accessToken: "abc", raw: new Map([["id_token", ["123"]]]) });
    await expect(provider().fetchAuthUser(token)).rejects.toThrow("empty or invalid id_token");
  });
});
