// Upstream: tools/security/crypto.go
//
// Strings are hashed as their UTF-8 bytes, as Go's []byte(string).

import { URLEncoding } from "@/tools/security/base64";

const encoder = new TextEncoder();

function hex(algorithm: "md5" | "sha256" | "sha512", text: string, secret?: string): string {
  const h =
    secret === undefined
      ? new Bun.CryptoHasher(algorithm)
      : new Bun.CryptoHasher(algorithm, encoder.encode(secret));
  h.update(encoder.encode(text));
  return h.digest("hex");
}

// S256Challenge creates the base64url encoded sha256 challenge string
// derived from code, with the padding stripped (RFC 7636).
export function s256Challenge(code: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(encoder.encode(code));
  return URLEncoding.encodeToString(h.digest()).replace(/=+$/, "");
}

// MD5 creates a hex md5 hash of text.
export function md5(text: string): string {
  return hex("md5", text);
}

// SHA256 creates a hex sha256 hash of text (FIPS 180-4).
export function sha256(text: string): string {
  return hex("sha256", text);
}

// SHA512 creates a hex sha512 hash of text (FIPS 180-4).
export function sha512(text: string): string {
  return hex("sha512", text);
}

// HS256 creates a hex HMAC-SHA256 of text.
export function hs256(text: string, secret: string): string {
  return hex("sha256", text, secret);
}

// HS512 creates a hex HMAC-SHA512 of text.
export function hs512(text: string, secret: string): string {
  return hex("sha512", text, secret);
}

// Equal compares two hash strings without leaking timing information
// about their content (subtle.ConstantTimeCompare: only the length can
// differ in time).
export function equal(hash1: string, hash2: string): boolean {
  return constantTimeCompare(encoder.encode(hash1), encoder.encode(hash2));
}

// subtle.ConstantTimeCompare
export function constantTimeCompare(x: Uint8Array, y: Uint8Array): boolean {
  if (x.length !== y.length) {
    return false;
  }
  let v = 0;
  for (let i = 0; i < x.length; i++) {
    v |= (x[i] as number) ^ (y[i] as number);
  }
  return v === 0;
}
