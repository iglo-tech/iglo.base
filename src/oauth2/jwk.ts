// Upstream: tools/auth/internal/jwk/jwk.go, with the signature checks of
// github.com/golang-jwt/jwt/v5 v5.3.1 (rsa.go, rsa_pss.go, ed25519.go) that
// Parser.Parse runs on its keys
//
// node:crypto verifies, not Web Crypto: the RSA-PSS salt length is
// PSSSaltLengthAuto in golang-jwt, which Web Crypto has no form of.

import {
  constants,
  createPublicKey,
  type KeyObject,
  verify,
  type VerifyKeyObjectInput,
} from "node:crypto";

import type { Clock } from "@/app/clock";
import { goQuote } from "@/fields/field";
import { fetchFollowingRedirects } from "@/oauth2/http-client";
import { RawURLEncoding } from "@/tools/security/base64";
import {
  JWTError,
  parseUnverifiedToken,
  type MapClaims,
  validateClaims,
} from "@/tools/security/jwt";
import { anyType, mapOf, unmarshal } from "@/tools/types/go-json";

const ed25519PublicKeySize = 32;

function trimPadding(value: string): string {
  return value.replace(/=+$/, "");
}

function decodeSegment(value: string): Uint8Array {
  return RawURLEncoding.decodeString(trimPadding(value));
}

// JWK.PublicKey: Go's *rsa.PublicKey or ed25519.PublicKey
export class JWK {
  kty = "";
  kid = "";
  use = "";
  alg = "";
  // RS256 (RSA)
  e = "";
  n = "";
  // Ed25519 (OKP)
  crv = "";
  x = "";

  constructor(init: Partial<JWK> = {}) {
    Object.assign(this, init);
  }

  // PublicKey reconstructs and returns the public key from the current JWK.
  publicKey(): KeyObject {
    switch (this.kty) {
      case "RSA": {
        // RFC 7518
        // https://datatracker.ietf.org/doc/html/rfc7518#section-6.3
        // https://datatracker.ietf.org/doc/html/rfc7517#appendix-A.1
        const e = RawURLEncoding.encodeToString(decodeSegment(this.e));
        const n = RawURLEncoding.encodeToString(decodeSegment(this.n));
        return createPublicKey({ key: { kty: "RSA", e, n }, format: "jwk" });
      }
      case "OKP": {
        // RFC 8037
        // https://datatracker.ietf.org/doc/html/rfc8037#section-2
        // https://datatracker.ietf.org/doc/html/rfc8037#appendix-A
        if (this.crv !== "Ed25519") {
          throw new Error(`unsupported OKP curve (must be Ed25519): ${goQuote(this.crv)}`);
        }

        const x = decodeSegment(this.x);
        if (x.length !== ed25519PublicKeySize) {
          throw new Error(`invalid Ed25519 key length: ${x.length}`);
        }

        return createPublicKey({
          key: { kty: "OKP", crv: "Ed25519", x: RawURLEncoding.encodeToString(x) },
          format: "jwk",
        });
      }
      default:
        throw new Error(`unsupported kty (must be RSA or OKP): ${goQuote(this.kty)}`);
    }
  }
}

const jwkFields = ["kty", "kid", "use", "alg", "e", "n", "crv", "x"] as const;

// a member of the "keys" array as Go's *JWK
function jwkOf(raw: unknown): JWK {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("json: cannot unmarshal into Go struct JWK");
  }
  const key = new JWK();
  for (const field of jwkFields) {
    const value = (raw as { [key: string]: unknown })[field];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new Error(`json: cannot unmarshal into Go string (JWK ${field})`);
    }
    key[field] = value ?? "";
  }
  return key;
}

// Fetch retrieves the JSON Web Key Set located at jwksURL and returns
// the first key that matches the specified kid.
export async function fetchJWK(
  signal: AbortSignal | undefined,
  jwksURL: string,
  kid: string,
): Promise<JWK> {
  const res = await fetchFollowingRedirects(jwksURL, { signal: signal ?? null });
  const rawBody = new Uint8Array(await res.arrayBuffer());

  // fetch doesn't treat non 2xx responses as error
  if (res.status >= 400) {
    throw new Error(
      `failed to fetch JSON Web Key Set from ${jwksURL} (${res.status}):\n${new TextDecoder().decode(rawBody)}`,
    );
  }

  const jwks = unmarshal(rawBody, mapOf(anyType)) as { [key: string]: unknown } | undefined;
  const rawKeys = jwks?.["keys"] ?? [];
  if (!Array.isArray(rawKeys)) {
    throw new Error("json: cannot unmarshal into Go slice of JWK");
  }

  const keys = rawKeys.map(jwkOf);
  const key = keys.find((k) => k.kid === kid && k.alg !== "");
  if (key === undefined) {
    throw new Error(`missing JWK with kid ${goQuote(kid)} and non-empty alg`);
  }

  return key;
}

const rsaHashes: { [alg: string]: string } = {
  RS256: "sha256",
  RS384: "sha384",
  RS512: "sha512",
  PS256: "sha256",
  PS384: "sha384",
  PS512: "sha512",
};

// SigningMethod.Verify with a key from JWK.PublicKey: HS*, ES* and none
// refuse both key types
function verifySignature(
  alg: string,
  signingString: string,
  signature: Uint8Array,
  key: KeyObject,
): boolean {
  const data = new TextEncoder().encode(signingString);

  if (alg === "EdDSA") {
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("key is invalid");
    }
    return verify(null, data, key, signature);
  }

  const hash = Object.hasOwn(rsaHashes, alg) ? rsaHashes[alg] : undefined;
  if (hash === undefined || key.asymmetricKeyType !== "rsa") {
    throw new Error("key is of invalid type");
  }

  const input: VerifyKeyObjectInput = alg.startsWith("PS")
    ? {
        key,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_AUTO,
      }
    : { key };
  return verify(hash, data, input, signature);
}

// ValidateTokenSignature validates the signature of a token with the
// public key retrieved from a remote JWKS.
export async function validateTokenSignature(
  signal: AbortSignal | undefined,
  token: string,
  jwksURL: string,
  clock: Clock,
): Promise<void> {
  // extract the kid token header
  // ---
  const claims: MapClaims = {};
  const { header, alg, parts, signature } = parseUnverifiedToken(token, claims);

  const kid = header?.["kid"];
  if (typeof kid !== "string" || kid === "") {
    throw new Error("missing kid header value");
  }

  // fetch the public key set
  // ---
  const key = await fetchJWK(signal, jwksURL, kid);

  // verify the signature
  // ---
  if (alg !== key.alg) {
    throw new JWTError(`token signature is invalid: signing method ${alg} is invalid`);
  }

  if (!verifySignature(alg, parts[0] + "." + parts[1], signature, key.publicKey())) {
    throw new JWTError("token signature is invalid: signature is invalid");
  }

  // the default validator of jwt.Parser: no leeway here
  validateClaims(claims, clock, { verifyIat: false });
}
