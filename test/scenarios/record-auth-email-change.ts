// Upstream: apis/record_auth_email_change_request_test.go,
// apis/record_auth_email_change_confirm_test.go
//
// AfterTestFunc checks become `after` checks of the pb_data and of the SMTP
// sink, which stands in for upstream's TestMailer. The change email goes to
// the new address. ExpectedEvents (hook counts) are dropped: iglo.base has
// no hooks.
//
// Not ported, because they only test upstream hooks:
// - "OnRecordRequestEmailChangeRequest tx body write check"
// - "OnRecordConfirmEmailChangeRequest tx body write check"

import { rateLimitScenario } from "@test/scenarios/record-auth";
import { checks, externalAuthsCount, rowHas } from "@test/scenarios/record-checks";
import type { Suite } from "@test/scenarios/scenario";
import { mailSent, smtpToSink } from "@test/scenarios/settings-prepare";

const userId = "4q1xlclmfloku33";

const requestUrl = "/api/collections/users/request-email-change";
const confirmUrl = "/api/collections/users/confirm-email-change";

// users, test@example.com, refreshable
const usersToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.ZT3F0Z3iM-xbGgSG3LEKiEzHrPHr8t8IuHLZGGNuxLo";

// superuser, sywbhecnh46rhm0
const superuserToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoicGJjXzMxNDI2MzU4MjMiLCJleHAiOjI1MjQ2MDQ0NjEsInJlZnJlc2hhYmxlIjp0cnVlfQ.UXgO3j-0BumcugrFjbd7j0M4MQvbrLggLlcu_YNGjoY";

// users, test@example.com, an email change token
const emailChangeToken =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsImNvbGxlY3Rpb25JZCI6Il9wYl91c2Vyc19hdXRoXyIsInR5cGUiOiJlbWFpbENoYW5nZSIsImVtYWlsIjoidGVzdEBleGFtcGxlLmNvbSIsIm5ld0VtYWlsIjoiY2hhbmdlQGV4YW1wbGUuY29tIiwiZXhwIjoyNTI0NjA0NDYxfQ.Y7mVlaEPhJiNPoIvIqbIosZU4c4lEhwysOrRR8c95iU";

// users, test@example.com, an expired email change token
const expiredEmailChangeToken =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsImNvbGxlY3Rpb25JZCI6Il9wYl91c2Vyc19hdXRoXyIsInR5cGUiOiJlbWFpbENoYW5nZSIsImVtYWlsIjoidGVzdEBleGFtcGxlLmNvbSIsIm5ld0VtYWlsIjoiY2hhbmdlQGV4YW1wbGUuY29tIiwiZXhwIjoxNjQwOTkxNjYxfQ.dff842MO0mgRTHY8dktp0dqG9-7LGQOgRuiAbQpYBls";

export const recordRequestEmailChange: Suite = {
  file: "apis/record_auth_email_change_request_test.go",
  func: "TestRecordRequestEmailChange",
  scenarios: [
    {
      name: "unauthorized",
      method: "POST",
      url: requestUrl,
      body: `{"newEmail":"change@example.com"}`,
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "not an auth collection",
      method: "POST",
      url: "/api/collections/demo1/request-email-change",
      body: `{"newEmail":"change@example.com"}`,
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "record authentication but from different auth collection",
      method: "POST",
      url: "/api/collections/clients/request-email-change",
      body: `{"newEmail":"change@example.com"}`,
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "superuser authentication",
      method: "POST",
      url: requestUrl,
      body: `{"newEmail":"change@example.com"}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "invalid data",
      method: "POST",
      url: requestUrl,
      body: `{"newEmail`,
      headers: { Authorization: usersToken },
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "empty data",
      method: "POST",
      url: requestUrl,
      body: `{}`,
      headers: { Authorization: usersToken },
      expectedStatus: 400,
      expectedContent: [`"data":`, `"newEmail":{"code":"validation_required"`],
    },
    {
      name: "valid data (existing email)",
      method: "POST",
      url: requestUrl,
      body: `{"newEmail":"test2@example.com"}`,
      headers: { Authorization: usersToken },
      expectedStatus: 400,
      expectedContent: [`"data":`, `"newEmail":{"code":"validation_invalid_new_email"`],
    },
    {
      name: "valid data (new email)",
      method: "POST",
      url: requestUrl,
      body: `{"newEmail":"change@example.com"}`,
      headers: { Authorization: usersToken },
      // the change email is sent synchronously: the sink must answer
      prepare: smtpToSink(),
      expectedStatus: 204,
      after: mailSent("change@example.com", "/auth/confirm-email-change"),
    },

    // rate limit checks
    // -----------------------------------------------------------
    rateLimitScenario(
      "RateLimit rule - users:requestEmailChange",
      "POST",
      requestUrl,
      [
        { maxRequests: 100, label: "abc" },
        { maxRequests: 100, label: "*:requestEmailChange" },
        { maxRequests: 0, label: "users:requestEmailChange" },
      ],
      { Authorization: usersToken },
      `{"newEmail":"change@example.com"}`,
    ),
    rateLimitScenario(
      "RateLimit rule - *:requestEmailChange",
      "POST",
      requestUrl,
      [
        { maxRequests: 100, label: "abc" },
        { maxRequests: 0, label: "*:requestEmailChange" },
      ],
      { Authorization: usersToken },
      `{"newEmail":"change@example.com"}`,
    ),
  ],
};

export const recordConfirmEmailChange: Suite = {
  file: "apis/record_auth_email_change_confirm_test.go",
  func: "TestRecordConfirmEmailChange",
  scenarios: [
    {
      name: "not an auth collection",
      method: "POST",
      url: "/api/collections/demo1/confirm-email-change",
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "empty data",
      method: "POST",
      url: confirmUrl,
      body: "",
      expectedStatus: 400,
      expectedContent: [
        `"data":`,
        `"token":{"code":"validation_required"`,
        `"password":{"code":"validation_required"`,
      ],
    },
    {
      name: "invalid data",
      method: "POST",
      url: confirmUrl,
      body: `{"token`,
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "expired token and correct password",
      method: "POST",
      url: confirmUrl,
      body: `{"token":"${expiredEmailChangeToken}","password":"1234567890"}`,
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"token":{`, `"code":"validation_invalid_token"`],
    },
    {
      name: "non-email change token",
      method: "POST",
      url: confirmUrl,
      body: `{"token":"${usersToken}","password":"1234567890"}`,
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"token":{`, `"code":"validation_invalid_token_payload"`],
    },
    {
      name: "valid token and incorrect password",
      method: "POST",
      url: confirmUrl,
      body: `{"token":"${emailChangeToken}","password":"1234567891"}`,
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"password":{`, `"code":"validation_invalid_password"`],
    },
    {
      name: "valid token and correct password",
      method: "POST",
      url: confirmUrl,
      body: `{"token":"${emailChangeToken}","password":"1234567890"}`,
      expectedStatus: 204,
      after: checks(
        rowHas("users", userId, { verified: 1, email: "change@example.com" }),
        // ensure that all pre-existing OAuth2 links are cleared
        externalAuthsCount("_pb_users_auth_", userId, 0),
      ),
    },
    {
      name: "valid token in different auth collection",
      method: "POST",
      url: "/api/collections/clients/confirm-email-change",
      body: `{"token":"${emailChangeToken}","password":"1234567890"}`,
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"token":{"code":"validation_token_collection_mismatch"`],
    },

    // rate limit checks
    // -----------------------------------------------------------
    rateLimitScenario(
      "RateLimit rule - users:confirmEmailChange",
      "POST",
      confirmUrl,
      [
        { maxRequests: 100, label: "abc" },
        { maxRequests: 100, label: "*:confirmEmailChange" },
        { maxRequests: 0, label: "users:confirmEmailChange" },
      ],
      undefined,
      `{"token":"${emailChangeToken}","password":"1234567890"}`,
    ),
    rateLimitScenario(
      "RateLimit rule - *:confirmEmailChange",
      "POST",
      confirmUrl,
      [
        { maxRequests: 100, label: "abc" },
        { maxRequests: 0, label: "*:confirmEmailChange" },
      ],
      undefined,
      `{"token":"${emailChangeToken}","password":"1234567890"}`,
    ),
  ],
};
