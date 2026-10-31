// Upstream: core/record_tokens.go
//
// Go's Record methods are functions of the record here. The current time
// comes from the clock passed in (upstream's security.NewJWT reads
// time.Now()). Durations are Go's time.Duration: nanoseconds as a bigint.
// Go's (token, error) results are the token, and the error is thrown.

import type { Clock } from "@/app/clock";
import type { Record } from "@/records/record-model";
import { JWTError, type MapClaims, newJWT, parseUnverifiedJWT } from "@/tools/security/jwt";

// Supported record token types
export const TokenTypeAuth = "auth";
export const TokenTypeFile = "file";
export const TokenTypeVerification = "verification";
export const TokenTypePasswordReset = "passwordReset";
export const TokenTypeEmailChange = "emailChange";

// List with commonly used record token claims
export const TokenClaimId = "id";
export const TokenClaimType = "type";
export const TokenClaimCollectionId = "collectionId";
export const TokenClaimEmail = "email";
export const TokenClaimNewEmail = "newEmail";
export const TokenClaimRefreshable = "refreshable";

// Common token related errors
export const ErrNotAuthRecord = new Error("not an auth collection record");
export const ErrMissingSigningKey = new Error("missing or invalid signing key");

// `claims, _ := security.ParseUnverifiedJWT(token)`: the claims parsed before
// any failure (an expired token still gives all of them, a malformed one
// none), for the callers that ignore the error.
export function parseUnverifiedClaims(token: string, clock: Clock): MapClaims {
  try {
    return parseUnverifiedJWT(token, clock);
  } catch (err) {
    if (err instanceof JWTError) {
      return err.claims;
    }
    throw err;
  }
}

// NewStaticAuthToken generates and returns a new static record authentication token.
//
// Static auth tokens are similar to the regular auth tokens, but are
// non-refreshable and support custom duration.
//
// Zero or negative duration will fallback to the duration from the auth collection settings.
export function newStaticAuthToken(m: Record, duration: bigint, clock: Clock): string {
  return newAuthTokenWith(m, duration, false, clock);
}

// NewAuthToken generates and returns a new record authentication token.
export function newAuthToken(m: Record, clock: Clock): string {
  return newAuthTokenWith(m, 0n, true, clock);
}

function newAuthTokenWith(m: Record, duration: bigint, refreshable: boolean, clock: Clock): string {
  if (!m.collection().isAuth()) {
    throw ErrNotAuthRecord;
  }

  const key = m.tokenKey() + m.collection().authToken.secret;
  if (key === "") {
    throw ErrMissingSigningKey;
  }

  const claims: MapClaims = {
    [TokenClaimType]: TokenTypeAuth,
    [TokenClaimId]: m.id,
    [TokenClaimCollectionId]: m.collection().id,
    [TokenClaimRefreshable]: refreshable,
  };

  if (duration <= 0n) {
    duration = m.collection().authToken.durationTime();
  }

  return newJWT(claims, key, duration, clock);
}

// NewVerificationToken generates and returns a new record verification token.
export function newVerificationToken(m: Record, clock: Clock): string {
  if (!m.collection().isAuth()) {
    throw ErrNotAuthRecord;
  }

  const key = m.tokenKey() + m.collection().verificationToken.secret;
  if (key === "") {
    throw ErrMissingSigningKey;
  }

  return newJWT(
    {
      [TokenClaimType]: TokenTypeVerification,
      [TokenClaimId]: m.id,
      [TokenClaimCollectionId]: m.collection().id,
      [TokenClaimEmail]: m.email(),
    },
    key,
    m.collection().verificationToken.durationTime(),
    clock,
  );
}

// NewPasswordResetToken generates and returns a new auth record password reset request token.
export function newPasswordResetToken(m: Record, clock: Clock): string {
  if (!m.collection().isAuth()) {
    throw ErrNotAuthRecord;
  }

  const key = m.tokenKey() + m.collection().passwordResetToken.secret;
  if (key === "") {
    throw ErrMissingSigningKey;
  }

  return newJWT(
    {
      [TokenClaimType]: TokenTypePasswordReset,
      [TokenClaimId]: m.id,
      [TokenClaimCollectionId]: m.collection().id,
      [TokenClaimEmail]: m.email(),
    },
    key,
    m.collection().passwordResetToken.durationTime(),
    clock,
  );
}

// NewEmailChangeToken generates and returns a new auth record change email request token.
export function newEmailChangeToken(m: Record, newEmail: string, clock: Clock): string {
  if (!m.collection().isAuth()) {
    throw ErrNotAuthRecord;
  }

  const key = m.tokenKey() + m.collection().emailChangeToken.secret;
  if (key === "") {
    throw ErrMissingSigningKey;
  }

  return newJWT(
    {
      [TokenClaimType]: TokenTypeEmailChange,
      [TokenClaimId]: m.id,
      [TokenClaimCollectionId]: m.collection().id,
      [TokenClaimEmail]: m.email(),
      [TokenClaimNewEmail]: newEmail,
    },
    key,
    m.collection().emailChangeToken.durationTime(),
    clock,
  );
}

// NewFileToken generates and returns a new record private file access token.
export function newFileToken(m: Record, clock: Clock): string {
  if (!m.collection().isAuth()) {
    throw ErrNotAuthRecord;
  }

  const key = m.tokenKey() + m.collection().fileToken.secret;
  if (key === "") {
    throw ErrMissingSigningKey;
  }

  return newJWT(
    {
      [TokenClaimType]: TokenTypeFile,
      [TokenClaimId]: m.id,
      [TokenClaimCollectionId]: m.collection().id,
    },
    key,
    m.collection().fileToken.durationTime(),
    clock,
  );
}
