// Upstream: forms/apple_client_secret_create.go (Submit, after its validation,
// which settings.ts runs)
//
// The client secret is an ES256 JWT (golang-jwt v5's SigningMethodES256): the
// header has alg, kid and typ, and the claims are jwt.RegisteredClaims, in
// the struct's order. The signature is raw r||s (RFC 7518 section 3.4), not
// DER. The private key is PKCS #8 PEM, the form of Apple's key files.

import type { Clock } from "@/app/clock";
import { StdEncoding, RawURLEncoding } from "@/tools/security/base64";
import { marshal } from "@/tools/types/go-json";

// the audience of the Apple client secret
const audience = "https://appleid.apple.com";

const encoder = new TextEncoder();

export interface AppleClientSecretOptions {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
  // seconds
  duration: number | bigint;
}

// the DER bytes of the first PEM block of text, as pem.Decode reads it: the
// body's base64, with any header lines before the blank line dropped
function pemDER(text: string): Uint8Array<ArrayBuffer> {
  const block = /(?:^|\n)-----BEGIN ([^-\n]+)-----\r?\n([\s\S]*?)\r?\n?-----END \1-----/.exec(text);
  if (block === null) {
    throw new Error("Invalid Key: Key must be PEM encoded PKCS1 or PKCS8 private key");
  }

  const lines = (block[2] ?? "").split(/\r?\n/);
  let start = 0;
  if (lines[0]?.includes(":") === true) {
    const blank = lines.indexOf("");
    start = blank === -1 ? lines.length : blank + 1;
  }
  return StdEncoding.decodeString(lines.slice(start).join("").replace(/\s+/g, ""));
}

// Submit: a new client secret signed with the form's private key, valid for
// duration seconds from the clock's time.
export async function signAppleClientSecret(
  opts: AppleClientSecretOptions,
  clock: Clock,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemDER(opts.privateKey.trim()),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  // jwt.NumericDate: whole seconds
  const iat = Math.floor(clock.now().getTime() / 1000);
  const exp = iat + Number(opts.duration);

  // golang-jwt marshals with encoding/json (v1): HTML characters are escaped
  // the header's members in sorted order, as jwt's map is marshaled
  const header = marshal({ alg: "ES256", kid: opts.keyId, typ: "JWT" }, { legacy: true });
  // jwt.RegisteredClaims: iss, sub, aud, exp, iat
  const claims =
    `{"iss":${marshal(opts.teamId, { legacy: true })},` +
    `"sub":${marshal(opts.clientId, { legacy: true })},` +
    `"aud":[${marshal(audience, { legacy: true })}],"exp":${exp},"iat":${iat}}`;

  const signingInput = `${RawURLEncoding.encodeToString(encoder.encode(header))}.${RawURLEncoding.encodeToString(encoder.encode(claims))}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(signingInput),
  );

  return `${signingInput}.${RawURLEncoding.encodeToString(new Uint8Array(signature))}`;
}
