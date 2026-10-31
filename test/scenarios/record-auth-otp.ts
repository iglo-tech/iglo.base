// Upstream: apis/record_auth_otp_request_test.go,
// apis/record_auth_with_otp_test.go
//
// BeforeTestFunc steps become `prepare` steps on the fixture copy
// (test/scenarios/record-auth-prepare.ts), AfterTestFunc checks `after`
// checks of the pb_data and of the SMTP sink, which stands in for
// upstream's TestMailer. Not ported, because they only test upstream hooks:
// "existing auth record with intercepted email (with < 9 non-expired)"
// (OnMailerRecordOTPSend), "OnRecordRequestOTPRequest tx body write check"
// and "OnRecordAuthWithOTPRequest tx body write check", and the hook-only
// request context check of "valid otp with valid password and empty sentTo
// (disabled MFA)" (test/differential/auth/otp-cases.ts checks the context
// through an auth rule). TestRecordAuthWithOTPManualRateLimiterCheck is
// a sequence of requests to one server: test/apis/record-auth-otp.test.ts and
// test/differential/auth/otp-flows.test.ts.

import { rateLimitScenario } from "@test/scenarios/record-auth";
import {
  expiredDate,
  insertOTPs,
  otpRows,
  setAuthRecordField,
  setMFA,
  setOTP,
} from "@test/scenarios/record-auth-prepare";
import { queryRows } from "@test/scenarios/record-checks";
import type { AfterContext, PrepareContext, Suite } from "@test/scenarios/scenario";
import { mailSent, smtpToSink } from "@test/scenarios/settings-prepare";
import { sharedSmtpSink } from "@test/support/smtp-sink";

const userId = "4q1xlclmfloku33";
const email = "test@example.com";
const otpId = "a".repeat(15);

// several prepare steps in order
function all(...steps: ((ctx: PrepareContext) => void)[]): (ctx: PrepareContext) => void {
  return (ctx) => {
    for (const step of steps) {
      step(ctx);
    }
  };
}

// when the scenario's prepare step last ran
let preparedAt = 0;

function markPrepared(): void {
  preparedAt = Date.now();
}

// app.TestMailer.TotalSend() == 0, for the messages since prepare ran
function noMailSent(): void {
  const total = sharedSmtpSink().messages.filter((m) => m.received >= preparedAt).length;
  if (total !== 0) {
    throw new Error(`expected zero emails, got ${total}`);
  }
}

const unverified = setAuthRecordField("users", email, "verified", false);
const withoutMFA = setMFA("users", false, "");

function userVerified({ dataDir }: AfterContext): boolean {
  const [row] = queryRows(dataDir, "SELECT verified FROM users WHERE id = ?", userId) as {
    verified: number;
  }[];
  return Boolean(row?.verified);
}

function externalAuthsCount({ dataDir }: AfterContext): number {
  return queryRows(dataDir, "SELECT id FROM _externalAuths WHERE recordRef = ?", userId).length;
}

const authBody = (password: string, id = otpId): string => `{
				"otpId":"${id}",
				"password":"${password}"
			}`;

const authUrl = "/api/collections/users/auth-with-otp";
const requestUrl = "/api/collections/users/request-otp";

const successContent = [`"token":"`, `"record":{`, `"email":"test@example.com"`];
const successNotContent = [
  `"meta":`,
  // hidden fields
  `"tokenKey"`,
  `"password"`,
];

export const recordRequestOTP: Suite = {
  file: "apis/record_auth_otp_request_test.go",
  func: "TestRecordRequestOTP",
  scenarios: [
    {
      name: "not an auth collection",
      method: "POST",
      url: "/api/collections/demo1/request-otp",
      body: `{"email":"test@example.com"}`,
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "auth collection with disabled otp",
      method: "POST",
      url: requestUrl,
      body: `{"email":"test@example.com"}`,
      prepare: setOTP("users", false),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "empty body",
      method: "POST",
      url: requestUrl,
      body: ``,
      expectedStatus: 400,
      expectedContent: [
        `"data":{"email":{"code":"validation_required","message":"Cannot be blank."}}`,
      ],
    },
    {
      name: "invalid body",
      method: "POST",
      url: requestUrl,
      body: `{"email`,
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "invalid request data",
      method: "POST",
      url: requestUrl,
      body: `{"email":"invalid"}`,
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"email":{"code":"validation_is_email`],
    },
    {
      name: "missing auth record",
      method: "POST",
      url: requestUrl,
      body: `{"email":"missing@example.com"}`,
      delayMs: 100,
      prepare: all(smtpToSink(), markPrepared),
      expectedStatus: 200,
      expectedContent: [
        `"otpId":"`, // some fake random generated string
      ],
      after: noMailSent,
    },
    {
      name: "existing auth record (with < 9 non-expired)",
      method: "POST",
      url: requestUrl,
      body: `{"email":"test@example.com"}`,
      delayMs: 300,
      prepare: all(
        smtpToSink(),
        // insert 8 non-expired and 2 expired
        insertOTPs(
          "users",
          email,
          ...Array.from({ length: 10 }, (_, i) => ({
            id: `otp_${i}`,
            ...(i >= 8 ? { date: expiredDate() } : {}),
          })),
        ),
      ),
      expectedStatus: 200,
      expectedContent: [`"otpId":"`],
      notExpectedContent: [`"otpId":"otp_`],
      after: (ctx) => {
        mailSent(email, "")(ctx);

        // ensure that sentTo is set
        const sent = otpRows(ctx.dataDir, userId).filter((otp) => otp.sentTo === email);
        if (sent.length !== 1) {
          throw new Error(`expected to find 1 OTP with sentTo ${email}, found ${sent.length}`);
        }
      },
    },
    {
      name: "existing auth record (with > 9 non-expired)",
      method: "POST",
      url: requestUrl,
      body: `{"email":"test@example.com"}`,
      delayMs: 100,
      prepare: all(
        smtpToSink(),
        // insert 10 non-expired
        insertOTPs("users", email, ...Array.from({ length: 10 }, (_, i) => ({ id: `otp_${i}` }))),
        markPrepared,
      ),
      expectedStatus: 200,
      expectedContent: [`"otpId":"otp_9"`],
      after: noMailSent,
    },

    // rate limit checks
    // -----------------------------------------------------------
    rateLimitScenario(
      "RateLimit rule - users:requestOTP",
      "POST",
      requestUrl,
      [
        { maxRequests: 100, label: "abc" },
        { maxRequests: 100, label: "*:requestOTP" },
        { maxRequests: 0, label: "users:requestOTP" },
      ],
      undefined,
      `{"email":"test@example.com"}`,
    ),
    rateLimitScenario(
      "RateLimit rule - *:requestOTP",
      "POST",
      requestUrl,
      [
        { maxRequests: 100, label: "abc" },
        { maxRequests: 0, label: "*:requestOTP" },
      ],
      undefined,
      `{"email":"test@example.com"}`,
    ),
  ],
};

export const recordAuthWithOTP: Suite = {
  file: "apis/record_auth_with_otp_test.go",
  func: "TestRecordAuthWithOTP",
  scenarios: [
    {
      name: "not an auth collection",
      method: "POST",
      url: "/api/collections/demo1/auth-with-otp",
      body: `{"otpId":"test","password":"123456"}`,
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "auth collection with disabled otp",
      method: "POST",
      url: authUrl,
      body: `{"otpId":"test","password":"123456"}`,
      prepare: setOTP("users", false),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "invalid body",
      method: "POST",
      url: authUrl,
      body: `{"email`,
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "empty body",
      method: "POST",
      url: authUrl,
      body: ``,
      expectedStatus: 400,
      expectedContent: [
        `"data":{`,
        `"otpId":{"code":"validation_required"`,
        `"password":{"code":"validation_required"`,
      ],
    },
    {
      name: "invalid request data",
      method: "POST",
      url: authUrl,
      body: authBody("a".repeat(72), "a".repeat(256)),
      expectedStatus: 400,
      expectedContent: [
        `"data":{`,
        `"otpId":{"code":"validation_length_out_of_range"`,
        `"password":{"code":"validation_length_out_of_range"`,
      ],
    },
    {
      name: "missing otp",
      method: "POST",
      url: authUrl,
      body: authBody("123456", "missing"),
      prepare: insertOTPs("users", email, { id: otpId }),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "otp for different collection",
      method: "POST",
      url: authUrl,
      body: authBody("123456"),
      prepare: insertOTPs("clients", email, { id: otpId }),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "otp with wrong password",
      method: "POST",
      url: authUrl,
      body: authBody("123456"),
      prepare: insertOTPs("users", email, { id: otpId, password: "1234567890" }),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "expired otp with valid password",
      method: "POST",
      url: authUrl,
      body: authBody("123456"),
      prepare: insertOTPs("users", email, { id: otpId, date: expiredDate() }),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "valid otp with valid password (enabled MFA)",
      method: "POST",
      url: authUrl,
      body: authBody("123456"),
      prepare: insertOTPs("users", email, { id: otpId }),
      expectedStatus: 401,
      expectedContent: [`"mfaId":"`],
    },
    {
      name: "valid otp with valid password and empty sentTo (disabled MFA)",
      method: "POST",
      url: authUrl,
      body: authBody("123456"),
      prepare: all(unverified, withoutMFA, insertOTPs("users", email, { id: otpId })),
      expectedStatus: 200,
      expectedContent: successContent,
      notExpectedContent: successNotContent,
      after: (ctx) => {
        if (userVerified(ctx)) {
          throw new Error("expected the user to remain unverified because sentTo != email");
        }

        // ensure that all pre-existing OAuth2 were NOT deleted
        const total = externalAuthsCount(ctx);
        if (total !== 2) {
          throw new Error(`expected 2 external auths, found ${total}`);
        }
      },
    },
    {
      name: "valid otp with valid password and nonempty sentTo=email (disabled MFA)",
      method: "POST",
      url: authUrl,
      body: authBody("123456"),
      prepare: all(
        unverified,
        withoutMFA,
        insertOTPs("users", email, { id: otpId, sentTo: email }),
      ),
      expectedStatus: 200,
      expectedContent: successContent,
      notExpectedContent: successNotContent,
      after: (ctx) => {
        if (!userVerified(ctx)) {
          throw new Error("expected the user to be marked as verified");
        }

        // ensure that all pre-existing OTPs are cleared
        const otps = otpRows(ctx.dataDir, userId).length;
        if (otps > 0) {
          throw new Error(`expected all OTPs to be cleared, found ${otps}`);
        }

        // ensure that all pre-existing OAuth2 links are cleared
        const total = externalAuthsCount(ctx);
        if (total > 0) {
          throw new Error(`expected all external auths to be cleared, found ${total}`);
        }
      },
    },

    // rate limit checks
    // -----------------------------------------------------------
    rateLimitScenario("RateLimit rule - users:authWithOTP", "POST", authUrl, [
      { maxRequests: 100, label: "abc" },
      { maxRequests: 100, label: "*:authWithOTP" },
      { maxRequests: 100, label: "users:auth" },
      { maxRequests: 0, label: "users:authWithOTP" },
    ]),
    rateLimitScenario("RateLimit rule - *:authWithOTP", "POST", authUrl, [
      { maxRequests: 100, label: "abc" },
      { maxRequests: 100, label: "*:auth" },
      { maxRequests: 0, label: "*:authWithOTP" },
    ]),
    rateLimitScenario("RateLimit rule - users:auth", "POST", authUrl, [
      { maxRequests: 100, label: "abc" },
      { maxRequests: 100, label: "*:authWithOTP" },
      { maxRequests: 0, label: "users:auth" },
    ]),
    rateLimitScenario("RateLimit rule - *:auth", "POST", authUrl, [
      { maxRequests: 100, label: "abc" },
      { maxRequests: 0, label: "*:auth" },
    ]),
  ],
};
