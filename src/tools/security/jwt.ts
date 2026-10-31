// Upstream: tools/security/jwt.go, and the parts of
// github.com/golang-jwt/jwt/v5 v5.3.1 it and tools/auth use: parser.go (Parser.ParseUnverified,
// ParseWithClaims, splitToken, DecodeSegment with RawURLEncoding),
// validator.go (Validator.Validate with no leeway), map_claims.go
// (parseNumericDate), types.go (newNumericDateFromSeconds with
// TimePrecision = time.Second), token.go (NewWithClaims, SigningString,
// SignedString), hmac.go and the signing method registry.
//
// Header and claims are Go JSON: encoding/json (v1) on top of json/v2, so
// claims are marshaled with sorted keys and HTML/JS escaping and decoded
// with duplicate names allowed (last wins) and numbers as float64. HMAC
// uses Bun.CryptoHasher, which accepts the empty key that Web Crypto
// rejects (golang-jwt signs with it).
//
// The time comes from the caller (a Clock), never from Date.now().

import type { Clock } from "@/app/clock";
import { RawURLEncoding } from "@/tools/security/base64";
import { constantTimeCompare } from "@/tools/security/crypto";
import { anyType, mapOf, marshal, setOwn, unmarshal } from "@/tools/types/go-json";

export type MapClaims = Record<string, unknown>;

// golang-jwt's error kinds (ErrTokenMalformed, ErrTokenUnverifiable,
// ErrTokenSignatureInvalid, ErrTokenInvalidClaims ...)
export class JWTError extends Error {
  constructor(
    message: string,
    // the claims parsed so far (ParseUnverifiedJWT returns them with the
    // error, as upstream)
    readonly claims: MapClaims = {},
  ) {
    super(message);
    this.name = "JWTError";
  }
}

// the algorithms golang-jwt registers (GetSigningMethod); any other alg is
// "unavailable"
const signingMethods = new Set([
  "HS256",
  "HS384",
  "HS512",
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
  "PS256",
  "PS384",
  "PS512",
  "EdDSA",
  "none",
]);

const encoder = new TextEncoder();

function hmacSHA256(text: string, key: string): Uint8Array {
  const h = new Bun.CryptoHasher("sha256", encoder.encode(key));
  h.update(encoder.encode(text));
  return h.digest();
}

export interface Unverified {
  header: Record<string, unknown> | undefined;
  // the header's alg (Token.Method.Alg())
  alg: string;
  claims: MapClaims;
  parts: [string, string, string];
  signature: Uint8Array;
}

// Parser.ParseUnverified with MapClaims and the default parser options
// (RawURLEncoding segments, no json.Number)
export function parseUnverifiedToken(token: string, claims: MapClaims): Unverified {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new JWTError("token is malformed: token contains an invalid number of segments");
  }
  const [h, c, s] = parts as [string, string, string];

  let headerBytes: Uint8Array;
  try {
    headerBytes = RawURLEncoding.decodeString(h);
  } catch {
    throw new JWTError("token is malformed: could not base64 decode header");
  }
  let header: Record<string, unknown> | undefined;
  try {
    header = unmarshal(headerBytes, mapOf(anyType), { legacy: true }) as
      | Record<string, unknown>
      | undefined;
  } catch {
    throw new JWTError("token is malformed: could not JSON decode header");
  }

  let claimBytes: Uint8Array;
  try {
    claimBytes = RawURLEncoding.decodeString(c);
  } catch {
    throw new JWTError("token is malformed: could not base64 decode claim");
  }
  try {
    // decoded into the caller's (empty) map; a JSON null leaves it empty
    const decoded = unmarshal(claimBytes, mapOf(anyType), { legacy: true }) as
      | MapClaims
      | undefined;
    for (const [k, v] of Object.entries(decoded ?? {})) {
      setOwn(claims, k, v);
    }
  } catch {
    throw new JWTError("token is malformed: could not JSON decode claim", claims);
  }

  const alg = header?.["alg"];
  if (typeof alg !== "string") {
    throw new JWTError("token is unverifiable: signing method (alg) is unspecified", claims);
  }
  if (!signingMethods.has(alg)) {
    throw new JWTError("token is unverifiable: signing method (alg) is unavailable", claims);
  }

  let signature: Uint8Array;
  try {
    signature = RawURLEncoding.decodeString(s);
  } catch {
    throw new JWTError("token is malformed: could not base64 decode signature", claims);
  }
  return { header, alg, claims, parts: [h, c, s], signature };
}

// Unix seconds as Go's internal time seconds (since year 1), wrapped to
// int64 like time.Unix's addition
const unixToInternal = 62135596800n;

function internalSeconds(unixSec: bigint): bigint {
  return BigInt.asIntN(64, unixSec + unixToInternal);
}

// newNumericDateFromSeconds(f) truncated to seconds: math.Modf, then
// int64(round) (out of range values convert to math.MinInt64 on amd64, the
// platform of the reference binary), then time.Unix normalization of a
// negative fraction
function numericDateSeconds(f: number): bigint {
  const round = Math.trunc(f);
  const frac = f - round;
  let sec = round >= 2 ** 63 || round < -(2 ** 63) ? -(1n << 63n) : BigInt(round);
  if (Math.trunc(frac * 1e9) < 0) {
    sec = BigInt.asIntN(64, sec - 1n);
  }
  return sec;
}

// MapClaims.parseNumericDate: a missing claim or 0 is no date; anything but
// a float64 (number) is an invalid type
function parseNumericDate(claims: MapClaims, key: string): bigint | undefined {
  if (!Object.hasOwn(claims, key)) {
    return undefined;
  }
  const v = claims[key];
  if (typeof v !== "number") {
    throw new JWTError(`token has invalid claims: ${key} is invalid`);
  }
  if (v === 0) {
    return undefined;
  }
  return internalSeconds(numericDateSeconds(v));
}

export interface ValidateOptions {
  verifyIat: boolean; // jwt.WithIssuedAt()
  leewaySeconds?: number; // jwt.WithLeeway
  audience?: string; // jwt.WithAudience, one expected value
}

// MapClaims.parseClaimsString: a string or a list of them; any other type
// is no value at all
function parseClaimStrings(claims: MapClaims, key: string): string[] {
  const v = Object.hasOwn(claims, key) ? claims[key] : undefined;
  if (typeof v === "string") {
    return [v];
  }
  if (!Array.isArray(v)) {
    return [];
  }
  return v.map((item: unknown) => {
    if (typeof item !== "string") {
      throw new JWTError(`token has invalid claims: ${key} is invalid`);
    }
    return item;
  });
}

// Validator.verifyAudience with one expected value, which makes aud required
function verifyAudience(claims: MapClaims, expected: string): string | undefined {
  let aud: string[];
  try {
    aud = parseClaimStrings(claims, "aud");
  } catch (err) {
    return (err as Error).message;
  }
  if (aud.length === 0 || (aud.length === 1 && aud[0] === "")) {
    return "token is missing required claim: aud claim is required";
  }
  return aud.includes(expected) ? undefined : "token has invalid audience";
}

// Validator.Validate: exp must be after now, nbf (and iat with verifyIat)
// not after now, each within the leeway. Every check runs and the errors
// are joined.
export function validateClaims(claims: MapClaims, clock: Clock, opts: ValidateOptions): void {
  const leeway = BigInt(opts.leewaySeconds ?? 0);
  const ms = clock.now().getTime();
  const now = internalSeconds(BigInt(Math.floor(ms / 1000)));
  const errors: string[] = [];
  const check = (key: string, ok: (t: bigint) => boolean, message: string) => {
    let t: bigint | undefined;
    try {
      t = parseNumericDate(claims, key);
    } catch (err) {
      errors.push((err as Error).message);
      return;
    }
    // a time with whole seconds compared with now (which may have a
    // sub-second part): now.Before(t) is now's seconds < t
    if (t !== undefined && !ok(t)) {
      errors.push(message);
    }
  };
  check("exp", (exp) => now < exp + leeway, "token has invalid claims: token is expired");
  check("nbf", (nbf) => !(now < nbf - leeway), "token has invalid claims: token is not valid yet");
  if (opts.verifyIat) {
    check(
      "iat",
      (iat) => !(now < iat - leeway),
      "token has invalid claims: token used before issued",
    );
  }
  if (opts.audience !== undefined) {
    const audienceErr = verifyAudience(claims, opts.audience);
    if (audienceErr !== undefined) {
      errors.push(audienceErr);
    }
  }
  if (errors.length > 0) {
    throw new JWTError(errors.join("\n"), claims);
  }
}

// ParseUnverifiedJWT parses a JWT and returns its claims but DOES NOT
// verify the signature. It verifies only the exp, iat and nbf claims. On a
// failure the JWTError carries the claims parsed so far.
export function parseUnverifiedJWT(token: string, clock: Clock): MapClaims {
  const claims: MapClaims = {};
  parseUnverifiedToken(token, claims);
  validateClaims(claims, clock, { verifyIat: true });
  return claims;
}

// ParseJWT verifies (HS256 only) and parses a JWT and returns its claims.
// exp and nbf are validated; iat is not (upstream's parser does not enable
// WithIssuedAt).
export function parseJWT(token: string, verificationKey: string, clock: Clock): MapClaims {
  const claims: MapClaims = {};
  const u = parseUnverifiedToken(token, claims);
  if (u.header?.["alg"] !== "HS256") {
    throw new JWTError(
      `token signature is invalid: signing method ${String(u.header?.["alg"])} is invalid`,
    );
  }
  const expected = hmacSHA256(u.parts[0] + "." + u.parts[1], verificationKey);
  if (!constantTimeCompare(u.signature, expected)) {
    throw new JWTError("token signature is invalid: signature is invalid");
  }
  validateClaims(claims, clock, { verifyIat: false });
  return claims;
}

// NewJWT generates a new HS256 signed JWT. exp is now + duration
// (nanoseconds, a number or Go's int64 time.Duration as a bigint) in Unix
// seconds, unless payload sets its own exp.
export function newJWT(
  payload: MapClaims,
  signingKey: string,
  duration: number | bigint,
  clock: Clock,
): string {
  const nowNs = BigInt(clock.now().getTime()) * 1_000_000n;
  const expNs = nowNs + (typeof duration === "bigint" ? duration : BigInt(Math.trunc(duration)));
  // time.Time.Unix: floor division
  let exp = expNs / 1_000_000_000n;
  if (expNs % 1_000_000_000n < 0n) {
    exp -= 1n;
  }
  const claims: MapClaims = { exp };
  for (const [k, v] of Object.entries(payload)) {
    setOwn(claims, k, v);
  }

  const header = marshal({ typ: "JWT", alg: "HS256" }, { legacy: true });
  const body = marshal(claims, { legacy: true });
  const signingString =
    RawURLEncoding.encodeToString(encoder.encode(header)) +
    "." +
    RawURLEncoding.encodeToString(encoder.encode(body));
  return signingString + "." + RawURLEncoding.encodeToString(hmacSHA256(signingString, signingKey));
}
