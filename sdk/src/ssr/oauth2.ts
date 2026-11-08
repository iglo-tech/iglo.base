// docs/design/13-ssr.md ("OAuth2"). Upstream: apis/record_auth_methods.go (state, PKCE verifier,
// authURL ending in `&redirect_uri=`) and apis/record_auth_with_oauth2.go (the code exchange).
import { safeDecode } from "@sdk/ssr/cookies";

/** The temporary cookie's lifetime, as its `Max-Age` (see `buildOAuth2CookieToSet`). */
export const OAUTH2_STATE_TTL_MS = 600 * 1000;
export const DEFAULT_OAUTH2_COLLECTION = "users";

export type OAuth2ErrorKind =
  | "invalid-callback"
  | "unknown-provider"
  | "no-cookie-writer"
  | "missing-cookie"
  | "expired"
  | "state-mismatch"
  | "provider-error"
  | "missing-code";

/**
 * A failure of the OAuth2 redirect flow that the SDK detects itself. A failure the server
 * reports is its `ClientResponseError`, unchanged.
 */
export class OAuth2Error extends Error {
  readonly kind: OAuth2ErrorKind;
  /** The provider's `error` parameter (`provider-error` only). */
  readonly providerError?: string;

  constructor(kind: OAuth2ErrorKind, message: string, providerError?: string) {
    super(message);
    this.name = "OAuth2Error";
    this.kind = kind;
    this.providerError = providerError;
  }
}

/** What the temporary cookie carries from `startOAuth2` to `completeOAuth2`. */
export interface OAuth2Pending {
  state: string;
  codeVerifier: string;
  provider: string;
  collection: string;
  /** The callback URL sent to the provider; the server must get the same one. */
  redirectURL: string;
  redirectTo: string;
  /** Expiry, in epoch milliseconds. */
  exp: number;
}

const FALLBACK_REDIRECT = "/";
const PROBE_ORIGIN = "http://app.invalid";

/** Backslashes and control characters (URL parsers strip some of them, browsers read others). */
function hasBackslashOrControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x5c || code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * A same-origin path for `redirectTo`, or `/`. Only a path that starts with one slash is kept:
 * no `//host`, no backslash (browsers read `/\host` as `//host`), no control characters, no
 * scheme, and nothing that resolves to another origin.
 */
export function safeRedirectPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value[0] !== "/") {
    return FALLBACK_REDIRECT;
  }
  if (value.startsWith("//") || hasBackslashOrControl(value)) {
    return FALLBACK_REDIRECT;
  }
  try {
    if (new URL(value, PROBE_ORIGIN).origin !== PROBE_ORIGIN) {
      return FALLBACK_REDIRECT;
    }
  } catch {
    return FALLBACK_REDIRECT;
  }
  return value;
}

/** Equal strings compare in time that depends only on their length (the state is public). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * The callback URL the provider redirects to. It is registered with the provider, so it must
 * be an absolute http(s) URL; a query or fragment would not match the registration.
 */
export function validateCallbackUrl(callbackUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    throw new OAuth2Error("invalid-callback", "callbackUrl must be an absolute URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new OAuth2Error("invalid-callback", "callbackUrl must be an http or https URL.");
  }
  return parsed.href;
}

const SAFE_COLLECTION = /^[A-Za-z0-9_-]{1,100}$/;

function isString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

/**
 * Reads the temporary cookie's value. Adapters may hand it over decoded or as the browser sent
 * it, so the raw text is tried first and the percent-decoded text second (as the session cookie).
 * Anything malformed is `undefined`, which the caller treats as a missing cookie.
 */
export function parseOAuth2Cookie(raw: string): OAuth2Pending | undefined {
  const candidates = raw === safeDecode(raw) ? [raw] : [raw, safeDecode(raw)];
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const obj = parsed as Record<string, unknown>;
    if (
      !isString(obj["state"], 256) ||
      obj["state"] === "" ||
      !isString(obj["codeVerifier"], 256) ||
      !isString(obj["provider"], 100) ||
      obj["provider"] === "" ||
      !isString(obj["collection"], 100) ||
      !SAFE_COLLECTION.test(obj["collection"]) ||
      !isString(obj["redirectURL"], 2048) ||
      obj["redirectURL"] === "" ||
      !isString(obj["redirectTo"], 2048) ||
      typeof obj["exp"] !== "number" ||
      !Number.isFinite(obj["exp"])
    ) {
      return undefined;
    }
    return {
      state: obj["state"],
      codeVerifier: obj["codeVerifier"],
      provider: obj["provider"],
      collection: obj["collection"],
      redirectURL: obj["redirectURL"],
      redirectTo: obj["redirectTo"],
      exp: obj["exp"],
    };
  }
  return undefined;
}

/** The provider's authorization URL with the callback as its `redirect_uri`. */
export function withRedirectUri(authURL: string, callbackUrl: string): string {
  return authURL + encodeURIComponent(callbackUrl);
}
