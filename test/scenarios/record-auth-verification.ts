// Upstream: apis/record_auth_verification_request_test.go,
// apis/record_auth_verification_confirm_test.go
//
// BeforeTestFunc steps become `prepare` steps on the fixture copy
// (test/scenarios/prepare.ts, test/scenarios/record-auth-prepare.ts),
// AfterTestFunc checks become `after` checks of the pb_data and of the SMTP
// sink, which stands in for upstream's TestMailer. ExpectedEvents (hook
// counts) are dropped: iglo.base has no hooks.
//
// Not ported, because they only test upstream hooks or a store entry set
// from a test:
// - "existing auth record (after already sent)" (request-verification): it
//   sets the resend limit key in the app store directly. The request
//   sequence is covered by the differential auth flows.
// - "OnRecordRequestVerificationRequest tx body write check"
// - "OnRecordConfirmVerificationRequest tx body write check"
//
// The rate limit rules are M4.8.

import { updateCollection } from "@test/scenarios/prepare";
import { queryRows, checks, externalAuthsCount, rowHas } from "@test/scenarios/record-checks";
import { rateLimitScenario } from "@test/scenarios/record-auth";
import type { AfterContext, Suite } from "@test/scenarios/scenario";
import {
  mailSent,
  noMailSent,
  smtpToEmptySink,
  smtpToSink,
} from "@test/scenarios/settings-prepare";

const userId = "4q1xlclmfloku33";
const email = "test@example.com";

// the stored password hash of the user does not match the old password
// (user.ValidatePassword returns false)
function passwordWasReset(oldPassword: string): (ctx: AfterContext) => Promise<void> {
  return async ({ dataDir }) => {
    const rows = queryRows(dataDir, `SELECT password FROM "users" WHERE id = ?`, userId) as {
      password: string;
    }[];
    const hash = rows[0]?.password ?? "";
    if (hash !== "" && (await Bun.password.verify(oldPassword, hash))) {
      throw new Error("expected the user password to be reset");
    }
  };
}

const requestUrl = "/api/collections/users/request-verification";
const confirmUrl = "/api/collections/users/confirm-verification";

// users, test@example.com (unverified)
const verificationToken =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsImV4cCI6MjUyNDYwNDQ2MSwidHlwZSI6InZlcmlmaWNhdGlvbiIsImNvbGxlY3Rpb25JZCI6Il9wYl91c2Vyc19hdXRoXyIsImVtYWlsIjoidGVzdEBleGFtcGxlLmNvbSJ9.SetHpu2H-x-q4TIUz-xiQjwi7MNwLCLvSs4O0hUSp0E";

// users, test2@example.com (verified)
const verifiedUserToken =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6Im9hcDY0MGNvdDR5cnUycyIsImV4cCI6MjUyNDYwNDQ2MSwidHlwZSI6InZlcmlmaWNhdGlvbiIsImNvbGxlY3Rpb25JZCI6Il9wYl91c2Vyc19hdXRoXyIsImVtYWlsIjoidGVzdDJAZXhhbXBsZS5jb20ifQ.QQmM3odNFVk6u4J4-5H8IBM3dfk9YCD7mPW-8PhBAI8";

// users, expired
const expiredToken =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsImV4cCI6MTY0MDk5MTY2MSwidHlwZSI6InZlcmlmaWNhdGlvbiIsImNvbGxlY3Rpb25JZCI6Il9wYl91c2Vyc19hdXRoXyIsImVtYWlsIjoidGVzdEBleGFtcGxlLmNvbSJ9.qqelNNL2Udl6K_TJ282sNHYCpASgA6SIuSVKGfBHMZU";

// users, a password reset token
const passwordResetToken =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsImV4cCI6MjUyNDYwNDQ2MSwidHlwZSI6InBhc3N3b3JkUmVzZXQiLCJjb2xsZWN0aW9uSWQiOiJfcGJfdXNlcnNfYXV0aF8iLCJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20ifQ.xR-xq1oHDy0D8Q4NDOAEyYKGHWd_swzoiSoL8FLFBHY";

// nologin, test@example.com
const nologinToken =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImRjNDlrNmpnZWpuNDBoMyIsImV4cCI6MjUyNDYwNDQ2MSwidHlwZSI6InZlcmlmaWNhdGlvbiIsImNvbGxlY3Rpb25JZCI6ImtwdjcwOXNrMmxxYnFrOCIsImVtYWlsIjoidGVzdEBleGFtcGxlLmNvbSJ9.5GmuZr4vmwk3Cb_3ZZWNxwbE75KZC-j71xxIPR9AsVw";

export const recordRequestVerification: Suite = {
  file: "apis/record_auth_verification_request_test.go",
  func: "TestRecordRequestVerification",
  scenarios: [
    {
      name: "not an auth collection",
      method: "POST",
      url: "/api/collections/demo1/request-verification",
      body: "",
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "empty data",
      method: "POST",
      url: requestUrl,
      body: "",
      expectedStatus: 400,
      expectedContent: [
        `"data":{"email":{"code":"validation_required","message":"Cannot be blank."}}`,
      ],
    },
    {
      name: "invalid data",
      method: "POST",
      url: requestUrl,
      body: `{"email`,
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "missing auth record",
      method: "POST",
      url: requestUrl,
      body: `{"email":"missing@example.com"}`,
      delayMs: 100,
      prepare: smtpToEmptySink(),
      expectedStatus: 204,
      after: noMailSent,
    },
    {
      name: "already verified auth record",
      method: "POST",
      url: requestUrl,
      body: `{"email":"test2@example.com"}`,
      delayMs: 100,
      prepare: smtpToEmptySink(),
      expectedStatus: 204,
      after: noMailSent,
    },
    {
      name: "existing auth record",
      method: "POST",
      url: requestUrl,
      body: `{"email":"test@example.com"}`,
      delayMs: 100,
      prepare: smtpToSink(),
      expectedStatus: 204,
      after: mailSent(email, "/auth/confirm-verification"),
    },

    // rate limit checks
    // -----------------------------------------------------------
    rateLimitScenario(
      "RateLimit rule - users:requestVerification",
      "POST",
      requestUrl,
      [
        { maxRequests: 100, label: "abc" },
        { maxRequests: 100, label: "*:requestVerification" },
        { maxRequests: 0, label: "users:requestVerification" },
      ],
      undefined,
      `{"email":"test@example.com"}`,
    ),
    rateLimitScenario(
      "RateLimit rule - *:requestVerification",
      "POST",
      requestUrl,
      [
        { maxRequests: 100, label: "abc" },
        { maxRequests: 0, label: "*:requestVerification" },
      ],
      undefined,
      `{"email":"test@example.com"}`,
    ),
  ],
};

export const recordConfirmVerification: Suite = {
  file: "apis/record_auth_verification_confirm_test.go",
  func: "TestRecordConfirmVerification",
  scenarios: [
    {
      name: "empty data",
      method: "POST",
      url: confirmUrl,
      body: "",
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"token":{"code":"validation_required"`],
    },
    {
      name: "invalid data format",
      method: "POST",
      url: confirmUrl,
      body: `{"password`,
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "expired token",
      method: "POST",
      url: confirmUrl,
      body: `{"token":"${expiredToken}"}`,
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"token":{"code":"validation_invalid_token"`],
    },
    {
      name: "non-verification token",
      method: "POST",
      url: confirmUrl,
      body: `{"token":"${passwordResetToken}"}`,
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"token":{"code":"validation_invalid_token"`],
    },
    {
      name: "non auth collection",
      method: "POST",
      url: "/api/collections/demo1/confirm-verification?expand=rel,missing",
      body: `{"token":"${verificationToken}"}`,
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "different auth collection",
      method: "POST",
      url: "/api/collections/clients/confirm-verification?expand=rel,missing",
      body: `{"token":"${verificationToken}"}`,
      expectedStatus: 400,
      expectedContent: [`"data":{"token":{"code":"validation_token_collection_mismatch"`],
    },
    {
      name: "valid token",
      method: "POST",
      url: confirmUrl,
      body: `{"token":"${verificationToken}"}`,
      expectedStatus: 204,
      after: checks(
        rowHas("users", userId, { verified: 1, email }),
        // ensure that all pre-existing OAuth2 links are cleared
        externalAuthsCount("_pb_users_auth_", userId, 0),
      ),
    },
    {
      name: "valid token (disabled password auth)",
      method: "POST",
      url: confirmUrl,
      body: `{"token":"${verificationToken}"}`,
      prepare: ({ dataDir }) =>
        updateCollection(dataDir, "users", (c) => {
          c.passwordAuth.enabled = false;
        }),
      expectedStatus: 204,
      after: checks(
        rowHas("users", userId, { verified: 1, email }),
        passwordWasReset("1234567890"),
        // ensure that all pre-existing OAuth2 links are cleared
        externalAuthsCount("_pb_users_auth_", userId, 0),
      ),
    },
    {
      name: "valid token (already verified)",
      method: "POST",
      url: confirmUrl,
      body: `{"token":"${verifiedUserToken}"}`,
      expectedStatus: 204,
    },
    {
      name: "valid verification token from a collection without allowed login",
      method: "POST",
      url: "/api/collections/nologin/confirm-verification",
      body: `{"token":"${nologinToken}"}`,
      expectedStatus: 204,
    },

    // rate limit checks
    // -----------------------------------------------------------
    rateLimitScenario(
      "RateLimit rule - nologin:confirmVerification",
      "POST",
      "/api/collections/nologin/confirm-verification",
      [
        { maxRequests: 100, label: "abc" },
        { maxRequests: 100, label: "*:confirmVerification" },
        { maxRequests: 0, label: "nologin:confirmVerification" },
      ],
      undefined,
      `{"token":"${nologinToken}"}`,
    ),
    rateLimitScenario(
      "RateLimit rule - *:confirmVerification",
      "POST",
      "/api/collections/nologin/confirm-verification",
      [
        { maxRequests: 100, label: "abc" },
        { maxRequests: 0, label: "*:confirmVerification" },
      ],
      undefined,
      `{"token":"${nologinToken}"}`,
    ),
  ],
};
