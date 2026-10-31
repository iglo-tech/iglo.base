// Upstream: forms/apple_client_secret_create.go (Submit) and its claims and
// header, checked in-process: the secret is verified with the public key of a
// key generated here.

import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";

import type { Clock } from "@/app/clock";
import { signAppleClientSecret } from "@/oauth2/apple-client-secret";

const pemKey = (): string =>
  generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();

const fixedClock = (ms: number): Clock => ({ now: () => new Date(ms) });

const form = (privateKey: string, duration: number) => ({
  clientId: "com.example.app",
  teamId: "ABCDE12345",
  keyId: "KEYID12345",
  privateKey,
  duration,
});

function parts(secret: string): {
  header: { [key: string]: unknown };
  claims: { [key: string]: unknown };
  raw: string[];
  signature: Buffer;
} {
  const [h = "", c = "", s = ""] = secret.split(".");
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString()),
    claims: JSON.parse(Buffer.from(c, "base64url").toString()),
    raw: [Buffer.from(h, "base64url").toString(), Buffer.from(c, "base64url").toString()],
    signature: Buffer.from(s, "base64url"),
  };
}

describe("Apple client secret", () => {
  test("an ES256 JWT with upstream's header and registered claims", () => {
    const privateKey = pemKey();
    const secret = signAppleClientSecret(form(privateKey, 3600), fixedClock(1_700_000_123_456));
    const { header, claims, raw, signature } = parts(secret);

    expect(header).toEqual({ alg: "ES256", kid: "KEYID12345", typ: "JWT" });
    expect(raw[0]).toBe('{"alg":"ES256","kid":"KEYID12345","typ":"JWT"}');
    expect(raw[1]).toBe(
      '{"iss":"ABCDE12345","sub":"com.example.app","aud":["https://appleid.apple.com"],"exp":1700003723,"iat":1700000123}',
    );
    expect(claims).toEqual({
      iss: "ABCDE12345",
      sub: "com.example.app",
      aud: ["https://appleid.apple.com"],
      exp: 1700003723,
      iat: 1700000123,
    });
    // raw r||s, 32 bytes each
    expect(signature.length).toBe(64);
  });

  test("the signature verifies with the public key", () => {
    const privateKey = pemKey();
    const secret = signAppleClientSecret(form(privateKey, 60), fixedClock(Date.now()));
    const { raw, signature } = parts(secret);
    const signingInput = secret.slice(0, secret.lastIndexOf("."));

    expect(
      verify(
        "sha256",
        Buffer.from(signingInput),
        { key: createPublicKey(privateKey), dsaEncoding: "ieee-p1363" },
        signature,
      ),
    ).toBe(true);
    expect(raw.length).toBe(2);
  });

  test("the expiry is the duration after issue, in whole seconds", () => {
    const secret = signAppleClientSecret(form(pemKey(), 15_777_000), fixedClock(2_000_000_999));
    const { claims } = parts(secret);
    expect(claims["iat"]).toBe(2_000_000);
    expect(claims["exp"]).toBe(2_000_000 + 15_777_000);
  });

  test("a PEM block with a header line before the blank line", () => {
    const pem = pemKey();
    const body = pem.split("\n").filter((line) => !line.startsWith("-----"));
    const withHeaders = [
      "-----BEGIN PRIVATE KEY-----",
      "Proc-Type: 4,TEST",
      "",
      ...body.filter((l) => l !== ""),
      "-----END PRIVATE KEY-----",
      "",
    ].join("\n");
    const secret = signAppleClientSecret(form(withHeaders, 60), fixedClock(Date.now()));
    expect(parts(secret).claims["sub"]).toBe("com.example.app");
  });

  test("a damaged key is an error", () => {
    expect(() =>
      signAppleClientSecret(
        form("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----", 60),
        fixedClock(0),
      ),
    ).toThrow();
  });

  test("a SEC1 key under a PRIVATE KEY label signs, as ParseECPrivateKeyFromPEM reads it", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const der = privateKey.export({ type: "sec1", format: "der" }).toString("base64");
    const secret = signAppleClientSecret(
      form(`-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----`, 60),
      fixedClock(0),
    );
    const [header, claims, signature] = secret.split(".") as [string, string, string];
    const valid = verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    );
    expect(valid).toBe(true);
  });

  test("a P-384 key is not an ES256 key", () => {
    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    expect(() => signAppleClientSecret(form(p384, 60), fixedClock(0))).toThrow("key is invalid");
  });

  test("an RSA key is not an ES256 key", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    expect(() => signAppleClientSecret(form(rsa, 60), fixedClock(0))).toThrow(
      "key is not a valid ECDSA private key",
    );
  });
});
