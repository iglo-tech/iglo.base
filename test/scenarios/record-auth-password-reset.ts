// Upstream: apis/record_auth_password_reset_request_test.go,
// apis/record_auth_password_reset_confirm_test.go
//
// BeforeTestFunc steps become `prepare` steps on the fixture copy
// (test/scenarios/record-auth-prepare.ts), AfterTestFunc checks become
// `after` checks of the pb_data and of the SMTP sink, which stands in for
// upstream's TestMailer. ExpectedEvents (hook counts) are dropped: iglo.base
// has no hooks.
//
// Not ported, because they only test upstream hooks or a store entry set
// from a test:
// - "existing auth record (after already sent)" (request-password-reset): it
//   sets the resend limit key in the app store directly. The request
//   sequence is covered by the differential auth flows.
// - "OnRecordRequestPasswordResetRequest tx body write check"
// - "OnRecordConfirmPasswordResetRequest tx body write check"
//
// The rate limit rules are M4.8.

import { updateKeepingTokenKey } from "@test/scenarios/record-auth-prepare";
import { rateLimitScenario } from "@test/scenarios/record-auth";
import { checks, externalAuthsCount, passwordIs, rowHas } from "@test/scenarios/record-checks";
import type { AfterContext, Suite } from "@test/scenarios/scenario";
import {
  mailSent,
  noMailSent,
  smtpToEmptySink,
  smtpToSink,
} from "@test/scenarios/settings-prepare";

const userId = "4q1xlclmfloku33";
const email = "test@example.com";
const confirmUrl = "/api/collections/users/confirm-password-reset";

// the password reset token is no longer accepted by the confirm endpoint
// (app.FindAuthRecordByToken fails): the same token, with a valid password,
// is answered with an invalid token error
function tokenInvalidated(token: string): (ctx: AfterContext) => Promise<void> {
  return async ({ url }) => {
    const res = await fetch(url + confirmUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: "1234567!", passwordConfirm: "1234567!" }),
    });
    const text = await res.text();
    if (res.status !== 400 || !text.includes(`"token":{"code":"validation_invalid_token"`)) {
      throw new Error(
        `expected the password reset token to be invalidated, got ${res.status}: ${text}`,
      );
    }
  };
}

const requestUrl = "/api/collections/users/request-password-reset";

// users, test@example.com, expired
const expiredToken =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsImV4cCI6MTY0MDk5MTY2MSwidHlwZSI6InBhc3N3b3JkUmVzZXQiLCJjb2xsZWN0aW9uSWQiOiJfcGJfdXNlcnNfYXV0aF8iLCJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20ifQ.5Tm6_6amQqOlX3urAnXlEdmxwG5qQJfiTg6U0hHR1hk";

// users, test@example.com
const passwordResetToken =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsImV4cCI6MjUyNDYwNDQ2MSwidHlwZSI6InBhc3N3b3JkUmVzZXQiLCJjb2xsZWN0aW9uSWQiOiJfcGJfdXNlcnNfYXV0aF8iLCJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20ifQ.xR-xq1oHDy0D8Q4NDOAEyYKGHWd_swzoiSoL8FLFBHY";

// users, test@example.com, a verification token
const verificationToken =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsImV4cCI6MjUyNDYwNDQ2MSwidHlwZSI6InZlcmlmaWNhdGlvbiIsImNvbGxlY3Rpb25JZCI6Il9wYl91c2Vyc19hdXRoXyIsImVtYWlsIjoidGVzdEBleGFtcGxlLmNvbSJ9.SetHpu2H-x-q4TIUz-xiQjwi7MNwLCLvSs4O0hUSp0E";

export const recordRequestPasswordReset: Suite = {
  file: "apis/record_auth_password_reset_request_test.go",
  func: "TestRecordRequestPasswordReset",
  scenarios: [
    {
      name: "not an auth collection",
      method: "POST",
      url: "/api/collections/demo1/request-password-reset",
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
      name: "existing auth record in a collection with disabled password login",
      method: "POST",
      url: "/api/collections/nologin/request-password-reset",
      body: `{"email":"test@example.com"}`,
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
      name: "existing auth record",
      method: "POST",
      url: requestUrl,
      body: `{"email":"test@example.com"}`,
      delayMs: 100,
      prepare: smtpToSink(),
      expectedStatus: 204,
      after: mailSent(email, "/auth/confirm-password-reset"),
    },

    // rate limit checks
    // -----------------------------------------------------------
    rateLimitScenario(
      "RateLimit rule - users:requestPasswordReset",
      "POST",
      requestUrl,
      [
        { maxRequests: 100, label: "abc" },
        { maxRequests: 100, label: "*:requestPasswordReset" },
        { maxRequests: 0, label: "users:requestPasswordReset" },
      ],
      undefined,
      `{"email":"missing@example.com"}`,
    ),
    rateLimitScenario(
      "RateLimit rule - *:requestPasswordReset",
      "POST",
      requestUrl,
      [
        { maxRequests: 100, label: "abc" },
        { maxRequests: 0, label: "*:requestPasswordReset" },
      ],
      undefined,
      `{"email":"missing@example.com"}`,
    ),
  ],
};

export const recordConfirmPasswordReset: Suite = {
  file: "apis/record_auth_password_reset_confirm_test.go",
  func: "TestRecordConfirmPasswordReset",
  scenarios: [
    {
      name: "empty data",
      method: "POST",
      url: confirmUrl,
      body: "",
      expectedStatus: 400,
      expectedContent: [
        `"data":{`,
        `"password":{"code":"validation_required"`,
        `"passwordConfirm":{"code":"validation_required"`,
        `"token":{"code":"validation_required"`,
      ],
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
      name: "expired token and invalid password",
      method: "POST",
      url: confirmUrl,
      body: `{"token":"${expiredToken}","password":"1234567","passwordConfirm":"7654321"}`,
      expectedStatus: 400,
      expectedContent: [
        `"data":{`,
        `"token":{"code":"validation_invalid_token"`,
        `"password":{"code":"validation_length_out_of_range"`,
        `"passwordConfirm":{"code":"validation_values_mismatch"`,
      ],
    },
    {
      name: "non-password reset token",
      method: "POST",
      url: confirmUrl,
      body: `{"token":"${verificationToken}","password":"1234567!","passwordConfirm":"1234567!"}`,
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"token":{"code":"validation_invalid_token"`],
    },
    {
      name: "non auth collection",
      method: "POST",
      url: "/api/collections/demo1/confirm-password-reset?expand=rel,missing",
      body: `{"token":"${passwordResetToken}","password":"1234567!","passwordConfirm":"1234567!"}`,
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "different auth collection",
      method: "POST",
      url: "/api/collections/clients/confirm-password-reset?expand=rel,missing",
      body: `{"token":"${passwordResetToken}","password":"1234567!","passwordConfirm":"1234567!"}`,
      expectedStatus: 400,
      expectedContent: [`"data":{"token":{"code":"validation_token_collection_mismatch"`],
    },
    {
      name: "valid token and data (unverified user)",
      method: "POST",
      url: confirmUrl,
      body: `{"token":"${passwordResetToken}","password":"1234567!","passwordConfirm":"1234567!"}`,
      expectedStatus: 204,
      after: checks(
        tokenInvalidated(passwordResetToken),
        rowHas("users", userId, { verified: 1, email }),
        passwordIs("users", userId, "1234567!"),
        // ensure that all pre-existing OAuth2 links are cleared
        externalAuthsCount("_pb_users_auth_", userId, 0),
      ),
    },
    {
      name: "valid token and data (unverified user with different email from the one in the token)",
      method: "POST",
      url: confirmUrl,
      body: `{"token":"${passwordResetToken}","password":"1234567!","passwordConfirm":"1234567!"}`,
      // manually change the email to check whether the verified state will be updated
      prepare: updateKeepingTokenKey("users", email, (record) => {
        record.set("email", "test_update@example.com");
      }),
      expectedStatus: 204,
      after: checks(
        tokenInvalidated(passwordResetToken),
        rowHas("users", userId, { verified: 0, email: "test_update@example.com" }),
        passwordIs("users", userId, "1234567!"),
        // ensure that all pre-existing OAuth2 were NOT deleted
        externalAuthsCount("_pb_users_auth_", userId, 2),
      ),
    },
    {
      name: "valid token and data (verified user)",
      method: "POST",
      url: confirmUrl,
      body: `{"token":"${passwordResetToken}","password":"1234567!","passwordConfirm":"1234567!"}`,
      // ensure that the user is already verified
      prepare: updateKeepingTokenKey("users", email, (record) => {
        record.set("verified", true);
      }),
      expectedStatus: 204,
      after: checks(
        tokenInvalidated(passwordResetToken),
        rowHas("users", userId, { verified: 1, email }),
        passwordIs("users", userId, "1234567!"),
      ),
    },

    // rate limit checks
    // -----------------------------------------------------------
    rateLimitScenario(
      "RateLimit rule - users:confirmPasswordReset",
      "POST",
      confirmUrl,
      [
        { maxRequests: 100, label: "abc" },
        { maxRequests: 100, label: "*:confirmPasswordReset" },
        { maxRequests: 0, label: "users:confirmPasswordReset" },
      ],
      undefined,
      `{"token":"${passwordResetToken}","password":"1234567!","passwordConfirm":"1234567!"}`,
    ),
    rateLimitScenario(
      "RateLimit rule - *:confirmPasswordReset",
      "POST",
      confirmUrl,
      [
        { maxRequests: 100, label: "abc" },
        { maxRequests: 0, label: "*:confirmPasswordReset" },
      ],
      undefined,
      `{"token":"${passwordResetToken}","password":"1234567!","passwordConfirm":"1234567!"}`,
    ),
  ],
};
