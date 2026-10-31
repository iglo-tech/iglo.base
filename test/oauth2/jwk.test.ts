// Upstream: tools/auth/internal/jwk/jwk_test.go

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type KeyObject, generateKeyPairSync, sign } from "node:crypto";

import { JWK, fetchJWK, validateTokenSignature } from "@/oauth2/jwk";

// a clock the test moves by hand (tests never sleep)
const clock = { now: () => new Date("2026-10-29T12:00:00.000Z") };

const b64url = (value: string | Buffer): string => Buffer.from(value).toString("base64url");

// the keys of the tests: the public parts are exported as JWK members
const rsaPair = generateKeyPairSync("rsa", { modulusLength: 1024 });
const rsaJWK = rsaPair.publicKey.export({ format: "jwk" });

const edPair = generateKeyPairSync("ed25519");
const edJWK = edPair.publicKey.export({ format: "jwk" });

// a compact JWT: header and payload are signed as base64url text
function signJWT(header: object, key: KeyObject, alg: "EdDSA" | "RS256"): string {
  const signingInput = b64url(JSON.stringify(header)) + "." + b64url("{}");
  const data = Buffer.from(signingInput);
  const signature = alg === "EdDSA" ? sign(null, data, key) : sign("sha256", data, key);
  return signingInput + "." + signature.toString("base64url");
}

// -------------------------------------------------------------------
// TestJWK_PublicKey

describe("TestJWK_PublicKey", () => {
  test("empty", () => {
    expect(() => new JWK().publicKey()).toThrow();
  });

  test("invalid kty", () => {
    const key = new JWK({ kty: "invalid", alg: "RS256", e: rsaJWK.e, n: rsaJWK.n });

    expect(() => key.publicKey()).toThrow();
  });

  test("RSA", () => {
    const key = new JWK({ kty: "RSA", alg: "RS256", e: rsaJWK.e, n: rsaJWK.n });

    expect(key.publicKey().export({ format: "jwk" })).toMatchObject({
      kty: "RSA",
      n: rsaJWK.n,
      e: rsaJWK.e,
    });
  });

  test("OKP with unsupported curve", () => {
    const key = new JWK({ kty: "OKP", crv: "invalid", x: b64url("a".repeat(32)) });

    expect(() => key.publicKey()).toThrow();
  });

  test("OKP with invalid public key length", () => {
    const key = new JWK({ kty: "OKP", crv: "Ed25519", x: b64url("a".repeat(31)) });

    expect(() => key.publicKey()).toThrow();
  });

  test("valid OKP", () => {
    const key = new JWK({ kty: "OKP", crv: "Ed25519", x: b64url("a".repeat(32)) });

    expect(key.publicKey().export({ format: "jwk" })).toMatchObject({
      kty: "OKP",
      crv: "Ed25519",
      x: b64url("a".repeat(32)),
    });
  });
});

// -------------------------------------------------------------------
// TestFetch: a JWKS endpoint that fails with ?error

describe("TestFetch", () => {
  let server: ReturnType<typeof Bun.serve>;
  let keysURL = "";

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.searchParams.has("error")) {
          return new Response("error", { status: 400 });
        }

        return Response.json({
          keys: [
            { kid: "abc", kty: "OKP", crv: "Ed25519", x: "test_x" },
            { kid: "def", kty: "RSA", alg: "RS256", n: "test_n", e: "test_e" },
          ],
        });
      },
    });
    keysURL = `http://127.0.0.1:${server.port}/keys`;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("error response", async () => {
    await expect(fetchJWK(undefined, keysURL + "?error", "def")).rejects.toThrow();
  });

  test("non-matching kid", async () => {
    await expect(fetchJWK(undefined, keysURL, "missing")).rejects.toThrow();
  });

  test("matching kid (no alg)", async () => {
    await expect(fetchJWK(undefined, keysURL, "abc")).rejects.toThrow();
  });

  test("matching kid", async () => {
    const key = await fetchJWK(undefined, keysURL, "def");

    expect({ kid: key.kid, kty: key.kty, alg: key.alg, n: key.n, e: key.e }).toEqual({
      kid: "def",
      kty: "RSA",
      alg: "RS256",
      n: "test_n",
      e: "test_e",
    });
  });
});

// -------------------------------------------------------------------
// TestValidateTokenSignature: a JWKS with one Ed25519 and one RSA key

describe("TestValidateTokenSignature", () => {
  let server: ReturnType<typeof Bun.serve>;
  let jwksURL = "";

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({
          keys: [
            { kid: "key1", kty: "OKP", alg: "EdDSA", crv: "Ed25519", x: edJWK.x },
            { kid: "key2", kty: "RSA", alg: "RS256", e: rsaJWK.e, n: rsaJWK.n },
          ],
        });
      },
    });
    jwksURL = `http://127.0.0.1:${server.port}/jwks`;
  });

  afterAll(() => {
    server.stop(true);
  });

  const nonmatchingKidToken = signJWT(
    { alg: "EdDSA", typ: "JWT", kid: "missing" },
    edPair.privateKey,
    "EdDSA",
  );
  const key1Token = signJWT({ alg: "EdDSA", typ: "JWT", kid: "key1" }, edPair.privateKey, "EdDSA");
  const key2Token = signJWT({ alg: "RS256", typ: "JWT", kid: "key2" }, rsaPair.privateKey, "RS256");

  test("empty token", async () => {
    await expect(validateTokenSignature(undefined, "", jwksURL, clock)).rejects.toThrow();
  });

  test("invalid token", async () => {
    await expect(validateTokenSignature(undefined, "abc", jwksURL, clock)).rejects.toThrow();
  });

  test("no matching kid", async () => {
    await expect(
      validateTokenSignature(undefined, nonmatchingKidToken, jwksURL, clock),
    ).rejects.toThrow();
  });

  test("valid Ed25519 token", async () => {
    await expect(validateTokenSignature(undefined, key1Token, jwksURL, clock)).resolves.toBe(
      undefined,
    );
  });

  test("valid RSA token", async () => {
    await expect(validateTokenSignature(undefined, key2Token, jwksURL, clock)).resolves.toBe(
      undefined,
    );
  });
});
