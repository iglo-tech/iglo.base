// Upstream: tools/auth/apple.go (FetchAuthUser, FetchRawUserInfo,
// parseAndVerifyIdToken), checked in-process: Apple's JWKS URL is fixed (no
// configuration reaches it), so the signature is checked against a key
// generated here, served by a test-only fetch (test/support/fetch-stub.ts).
// The differential cases (test/differential/auth/oauth2-provider-cases.ts)
// cover the claim checks that run before the signature.

import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";

import { Apple } from "@/oauth2/apple";
import { Token } from "@/oauth2/token";
import { json, type StubbedFetch, stubFetch } from "@test/support/fetch-stub";

const jwksURL = "https://appleid.apple.com/auth/keys";
const clientId = "com.example.app";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "apple-key-1",
  alg: "RS256",
  use: "sig",
};

const b64url = (value: string | Uint8Array): string => Buffer.from(value).toString("base64url");
const now = (): number => Math.floor(Date.now() / 1000);

// an id_token signed with key, with the header and claims given
function idToken(
  claims: { [key: string]: unknown },
  opts: { key?: typeof privateKey; header?: { [key: string]: unknown } } = {},
): string {
  const head = `${b64url(JSON.stringify({ alg: "RS256", kid: "apple-key-1", ...opts.header }))}.${b64url(JSON.stringify(claims))}`;
  return `${head}.${b64url(sign("sha256", Buffer.from(head), opts.key ?? privateKey))}`;
}

const validClaims = (overrides: { [key: string]: unknown } = {}): { [key: string]: unknown } => ({
  iss: "https://appleid.apple.com",
  aud: clientId,
  sub: "001234.abcdef.0123",
  iat: now() - 10,
  exp: now() + 3600,
  email: "apple@example.com",
  email_verified: "true",
  ...overrides,
});

let stub: StubbedFetch | undefined;

afterEach(() => {
  stub?.restore();
  stub = undefined;
});

function serveJWKS(): void {
  stub = stubFetch({ [jwksURL]: () => json({ keys: [jwk] }) });
}

function provider(): Apple {
  const p = new Apple();
  p.clientId = clientId;
  return p;
}

const tokenWith = (id: string): Token =>
  new Token({ accessToken: "access", refreshToken: "refresh", raw: { id_token: id } });

describe("Apple id_token", () => {
  test("a valid id_token gives the user, with the email only when Apple verified it", async () => {
    serveJWKS();
    const user = await provider().fetchAuthUser(
      tokenWith(idToken(validClaims({ name: "From Claims" }))),
    );

    expect(user.id).toBe("001234.abcdef.0123");
    expect(user.email).toBe("apple@example.com");
    expect(user.name).toBe("From Claims");
    expect(user.accessToken).toBe("access");
    expect(user.refreshToken).toBe("refresh");
    expect(user.rawUser).toMatchObject({ sub: "001234.abcdef.0123", email_verified: "true" });
    expect(stub?.calls).toEqual([jwksURL]);
  });

  test("email_verified as a bool, and as a string that is not true", async () => {
    serveJWKS();
    const verified = await provider().fetchAuthUser(
      tokenWith(idToken(validClaims({ email_verified: true }))),
    );
    expect(verified.email).toBe("apple@example.com");

    const unverified = await provider().fetchAuthUser(
      tokenWith(idToken(validClaims({ email_verified: "false" }))),
    );
    expect(unverified.email).toBe("");
  });

  test("the name is empty without a name claim (the redirect provides it)", async () => {
    serveJWKS();
    const user = await provider().fetchAuthUser(tokenWith(idToken(validClaims())));
    expect(user.name).toBe("");
  });

  test("the user's expiry is the token's expiry", async () => {
    serveJWKS();
    const p = provider();
    const token = tokenWith(idToken(validClaims()));
    token.expiry = new Date(Date.now() + 60_000);
    const user = await p.fetchAuthUser(token);
    expect(user.expiry.toString()).toBe(token.expiry.toISOString().replace("T", " "));
  });

  test("a missing id_token", async () => {
    await expect(provider().fetchAuthUser(new Token({ accessToken: "access" }))).rejects.toThrow(
      "empty id_token",
    );
  });

  test("an id_token from another issuer is rejected before any request", async () => {
    stub = stubFetch({});
    await expect(
      provider().fetchAuthUser(tokenWith(idToken(validClaims({ iss: "https://evil.example" })))),
    ).rejects.toThrow("invalid issuer");
    expect(stub.calls).toEqual([]);
  });

  test("an id_token for another audience is rejected", async () => {
    stub = stubFetch({});
    await expect(
      provider().fetchAuthUser(tokenWith(idToken(validClaims({ aud: "another.client" })))),
    ).rejects.toThrow("audience");
    expect(stub.calls).toEqual([]);
  });

  test("an expired id_token is rejected", async () => {
    stub = stubFetch({});
    await expect(
      provider().fetchAuthUser(
        tokenWith(idToken(validClaims({ exp: now() - 3600, iat: now() - 7200 }))),
      ),
    ).rejects.toThrow("expired");
    expect(stub.calls).toEqual([]);
  });

  test("an id_token without an expiration is rejected", async () => {
    stub = stubFetch({});
    const claims = validClaims();
    delete claims["exp"];
    await expect(provider().fetchAuthUser(tokenWith(idToken(claims)))).rejects.toThrow(
      "exp claim is required",
    );
  });

  test("an id_token signed with another key is rejected", async () => {
    serveJWKS();
    await expect(
      provider().fetchAuthUser(tokenWith(idToken(validClaims(), { key: otherKey }))),
    ).rejects.toThrow("id_token validation failed");
    expect(stub?.calls).toEqual([jwksURL]);
  });

  test("an id_token whose key id is not in the key set is rejected", async () => {
    serveJWKS();
    await expect(
      provider().fetchAuthUser(tokenWith(idToken(validClaims(), { header: { kid: "unknown" } }))),
    ).rejects.toThrow("id_token validation failed");
  });

  test("an id_token without a key id is rejected", async () => {
    serveJWKS();
    // the header without kid: the signature is over this header
    const head = `${b64url(JSON.stringify({ alg: "RS256" }))}.${b64url(JSON.stringify(validClaims()))}`;
    const signed = `${head}.${b64url(sign("sha256", Buffer.from(head), privateKey))}`;
    await expect(provider().fetchAuthUser(tokenWith(signed))).rejects.toThrow(
      "missing kid header value",
    );
  });
});

describe("Apple provider", () => {
  test("uses Apple's endpoints and scopes", () => {
    const p = new Apple();
    expect(p.authURL).toBe("https://appleid.apple.com/auth/authorize");
    expect(p.tokenURL).toBe("https://appleid.apple.com/auth/token");
    expect(p.scopes).toEqual(["name", "email"]);
    expect(p.pkce).toBe(true);
    expect(p.jwksURL).toBe(jwksURL);
  });
});
