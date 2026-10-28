// Upstream: core/record_tokens_test.go
//
// Each Go test function runs on its own copy of the vendored fixture
// (openTestApp, as tests.NewTestApp). The app clock is fixed, so the
// tolerance upstream allows for time.Now() moving between the token and
// the check is not needed: exp is exactly now + duration. Added (not
// upstream's): the claims of every token type with their values, the claim
// order of the signed JSON, the thrown errors, and the clock moved past exp.

import { describe, expect, test } from "bun:test";

import type { Clock } from "@/app/clock";
import { Collection, CollectionTypeAuth, newAuthCollection } from "@/collections/collection-model";
import type { Record } from "@/records/record-model";
import {
  findAuthRecordByEmail,
  findAuthRecordByToken,
  findRecordById,
} from "@/records/record-query";
import { newRecord } from "@/records/record-model";
import {
  ErrMissingSigningKey,
  ErrNotAuthRecord,
  TokenClaimRefreshable,
  TokenTypeAuth,
  TokenTypeEmailChange,
  TokenTypeFile,
  TokenTypePasswordReset,
  TokenTypeVerification,
  newAuthToken,
  newEmailChangeToken,
  newFileToken,
  newPasswordResetToken,
  newStaticAuthToken,
  newVerificationToken,
} from "@/records/record-tokens";
import { RawURLEncoding } from "@/tools/security/base64";
import { parseUnverifiedJWT } from "@/tools/security/jwt";

import { openTestApp } from "@test/collections/app";

const Second = 1_000_000_000n;

// 2026-10-29T10:11:12.345Z
const nowMs = Date.UTC(2026, 9, 29, 10, 11, 12, 345);
const nowUnix = Math.floor(nowMs / 1000);
const clock: Clock = { now: () => new Date(nowMs) };

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

// the raw JSON of a token's claims segment
function claimsJSON(token: string): string {
  return new TextDecoder().decode(RawURLEncoding.decodeString(token.split(".")[1] as string));
}

test("TestNewStaticAuthToken", () => {
  testRecordToken(TokenTypeAuth, (record) => newStaticAuthToken(record, 0n, clock), {
    [TokenClaimRefreshable]: false,
  });
});

describe("TestNewStaticAuthTokenWithCustomDuration", () => {
  const durations = [-100n, 0n, 100n];

  for (const [i, d] of durations.entries()) {
    test(`${i}_${d}`, () => {
      const app = openTestApp(clock);
      try {
        const user = findAuthRecordByEmail(app, "users", "test@example.com");

        const duration = d * Second;

        const token = newStaticAuthToken(user, duration, clock);

        const claims = parseUnverifiedJWT(token, clock);

        const exp = claims["exp"];

        let expectedDuration = duration;
        // should fallback to the collection setting
        if (expectedDuration <= 0n) {
          expectedDuration = user.collection().authToken.durationTime();
        }

        expect(exp).toBe(nowUnix + Number(expectedDuration / Second));
      } finally {
        app.cleanup();
      }
    });
  }
});

test("TestNewAuthToken", () => {
  testRecordToken(TokenTypeAuth, (record) => newAuthToken(record, clock), {
    [TokenClaimRefreshable]: true,
  });
});

test("TestNewVerificationToken", () => {
  testRecordToken(TokenTypeVerification, (record) => newVerificationToken(record, clock), null);
});

test("TestNewPasswordResetToken", () => {
  testRecordToken(TokenTypePasswordReset, (record) => newPasswordResetToken(record, clock), null);
});

test("TestNewEmailChangeToken", () => {
  testRecordToken(
    TokenTypeEmailChange,
    (record) => newEmailChangeToken(record, "new@example.com", clock),
    null,
  );
});

test("TestNewFileToken", () => {
  testRecordToken(TokenTypeFile, (record) => newFileToken(record, clock), null);
});

function testRecordToken(
  tokenType: string,
  tokenFunc: (record: Record) => string,
  expectedClaims: { [key: string]: unknown } | null,
): void {
  const app = openTestApp(clock);
  try {
    const demo1 = findRecordById(app, "demo1", "84nmscqy84lsi1t");

    const user = findAuthRecordByEmail(app, "users", "test@example.com");

    // non-auth record
    expect(errorOf(() => tokenFunc(demo1))).toBe(ErrNotAuthRecord);

    // auth record
    const token = tokenFunc(user);

    const tokenRecord = findAuthRecordByToken(app, token, tokenType);
    expect(tokenRecord.id).toBe(user.id);

    if (expectedClaims !== null) {
      const claims = parseUnverifiedJWT(token, clock);
      for (const [k, v] of Object.entries(expectedClaims)) {
        expect(claims[k]).toBe(v);
      }
    }

    // empty signing key: upstream replaces the record's collection with a
    // zero auth Collection (no secrets); here a record of such a collection
    const collection = new Collection();
    collection.type = CollectionTypeAuth;
    const emptyKeyUser = newRecord(collection);
    emptyKeyUser.id = user.id;
    emptyKeyUser.setTokenKey("");

    expect(errorOf(() => tokenFunc(emptyKeyUser))).toBe(ErrMissingSigningKey);
  } finally {
    app.cleanup();
  }
}

describe("record tokens: claims and signed JSON (not upstream's)", () => {
  const app = openTestApp(clock);
  const user = findAuthRecordByEmail(app, "users", "test@example.com");
  const c = user.collection();
  app.cleanup();

  // Go's MapClaims marshal with sorted keys
  const cases: [string, () => string, string, bigint][] = [
    [
      "auth",
      () => newAuthToken(user, clock),
      `{"collectionId":"${c.id}","exp":%EXP%,"id":"${user.id}","refreshable":true,"type":"auth"}`,
      c.authToken.durationTime(),
    ],
    [
      "static auth with a duration",
      () => newStaticAuthToken(user, 3600n * Second, clock),
      `{"collectionId":"${c.id}","exp":%EXP%,"id":"${user.id}","refreshable":false,"type":"auth"}`,
      3600n * Second,
    ],
    [
      "verification",
      () => newVerificationToken(user, clock),
      `{"collectionId":"${c.id}","email":"test@example.com","exp":%EXP%,"id":"${user.id}","type":"verification"}`,
      c.verificationToken.durationTime(),
    ],
    [
      "password reset",
      () => newPasswordResetToken(user, clock),
      `{"collectionId":"${c.id}","email":"test@example.com","exp":%EXP%,"id":"${user.id}","type":"passwordReset"}`,
      c.passwordResetToken.durationTime(),
    ],
    [
      "email change",
      () => newEmailChangeToken(user, "new<&>@example.com", clock),
      `{"collectionId":"${c.id}","email":"test@example.com","exp":%EXP%,"id":"${user.id}","newEmail":"new\\u003c\\u0026\\u003e@example.com","type":"emailChange"}`,
      c.emailChangeToken.durationTime(),
    ],
    [
      "file",
      () => newFileToken(user, clock),
      `{"collectionId":"${c.id}","exp":%EXP%,"id":"${user.id}","type":"file"}`,
      c.fileToken.durationTime(),
    ],
  ];

  for (const [name, make, expected, duration] of cases) {
    test(name, () => {
      const token = make();
      expect(token.split(".")[0]).toBe(
        RawURLEncoding.encodeToString(new TextEncoder().encode(`{"alg":"HS256","typ":"JWT"}`)),
      );
      const exp = nowUnix + Number(duration / Second);
      expect(claimsJSON(token)).toBe(expected.replace("%EXP%", String(exp)));
    });
  }

  test("a token from a new auth collection record without a token key", () => {
    const record = newRecord(newAuthCollection("test"));
    record.id = "r1";
    // the collection secret alone signs it
    expect(errorOf(() => newAuthToken(record, clock))).toBeNull();
  });
});
