// Upstream: apis/settings_test.go (TestSettingsList, TestSettingsSet,
// TestSettingsTestS3, TestSettingsTestEmail, TestGenerateAppleClientSecret)
// and forms/test_email_send_test.go (TestEmailSendValidateAndSubmit, whose
// form submits become requests to the test email endpoint)
//
// The tokens are upstream's fixture tokens (test data, expiring in 2050).
// Not ported: the two "tx body write check" scenarios, which only test an
// upstream hook (OnSettingsListRequest, OnSettingsUpdateRequest). The
// TestMailer of upstream's test app is an in-process SMTP sink here
// (test/scenarios/settings-prepare.ts), so that upstream meets the
// scenarios in differential mode. The
// Apple client secret is signed with an ES256 key generated in the test.

import { generateKeyPairSync } from "node:crypto";

import { superuserToken, usersToken } from "@test/scenarios/record-crud";
import type { Suite } from "@test/scenarios/scenario";
import { mailSent, secretsPersisted, smtpToSink } from "@test/scenarios/settings-prepare";

const validData = `{
		"meta":{"appName":"update_test"},
		"smtp":{"password": "new_smtp_password"},
		"s3":{"secret": "new_s3_secret"},
		"backups":{"s3":{"secret":"new_backups_s3_secret"}}
	}`;

// a P-256 private key in PKCS #8 PEM (x509.MarshalPKCS8PrivateKey + pem.EncodeToMemory)
const privatePem = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

export const settingsList: Suite = {
  file: "apis/settings_test.go",
  func: "TestSettingsList",
  scenarios: [
    {
      name: "unauthorized",
      method: "GET",
      url: "/api/settings",
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method: "GET",
      url: "/api/settings",
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser",
      method: "GET",
      url: "/api/settings",
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [`"meta":{`, `"logs":{`, `"smtp":{`, `"s3":{`, `"backups":{`, `"batch":{`],
    },
  ],
};

export const settingsSet: Suite = {
  file: "apis/settings_test.go",
  func: "TestSettingsSet",
  scenarios: [
    {
      name: "unauthorized",
      method: "PATCH",
      url: "/api/settings",
      body: validData,
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method: "PATCH",
      url: "/api/settings",
      body: validData,
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser submitting empty data",
      method: "PATCH",
      url: "/api/settings",
      body: ``,
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [`"meta":{`, `"logs":{`, `"smtp":{`, `"s3":{`, `"backups":{`, `"batch":{`],
    },
    {
      name: "authorized as superuser submitting invalid data",
      method: "PATCH",
      url: "/api/settings",
      body: `{"meta":{"appName":""}}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"meta":{"appName":{"code":"validation_required"`],
    },
    {
      name: "authorized as superuser submitting valid data",
      method: "PATCH",
      url: "/api/settings",
      body: validData,
      headers: { Authorization: superuserToken },
      after: secretsPersisted,
      expectedStatus: 200,
      expectedContent: [
        `"meta":{`,
        `"logs":{`,
        `"smtp":{`,
        `"s3":{`,
        `"backups":{`,
        `"batch":{`,
        `"appName":"update_test"`,
      ],
      notExpectedContent: ["secret", "password"],
    },
  ],
};

export const settingsTestS3: Suite = {
  file: "apis/settings_test.go",
  func: "TestSettingsTestS3",
  scenarios: [
    {
      name: "unauthorized",
      method: "POST",
      url: "/api/settings/test/s3",
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method: "POST",
      url: "/api/settings/test/s3",
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser (missing body + no s3)",
      method: "POST",
      url: "/api/settings/test/s3",
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"filesystem":{`],
    },
    {
      name: "authorized as superuser (invalid filesystem)",
      method: "POST",
      url: "/api/settings/test/s3",
      body: `{"filesystem":"invalid"}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"filesystem":{`],
    },
    {
      name: "authorized as superuser (valid filesystem and no s3)",
      method: "POST",
      url: "/api/settings/test/s3",
      body: `{"filesystem":"storage"}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
  ],
};

export const settingsTestEmail: Suite = {
  file: "apis/settings_test.go",
  func: "TestSettingsTestEmail",
  scenarios: [
    {
      name: "unauthorized",
      method: "POST",
      url: "/api/settings/test/email",
      body: `{
				"template": "verification",
				"email": "test@example.com"
			}`,
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method: "POST",
      url: "/api/settings/test/email",
      body: `{
				"template": "verification",
				"email": "test@example.com"
			}`,
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser (invalid body)",
      method: "POST",
      url: "/api/settings/test/email",
      body: `{`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser (empty json)",
      method: "POST",
      url: "/api/settings/test/email",
      body: `{}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [
        `"email":{"code":"validation_required"`,
        `"template":{"code":"validation_required"`,
      ],
    },
    {
      name: "authorized as superuser (verifiation template)",
      method: "POST",
      url: "/api/settings/test/email",
      body: `{
				"template": "verification",
				"email": "test@example.com"
			}`,
      headers: { Authorization: superuserToken },
      prepare: smtpToSink(),
      after: mailSent("test@example.com", "Verify"),
      expectedStatus: 204,
    },
    {
      name: "authorized as superuser (password reset template)",
      method: "POST",
      url: "/api/settings/test/email",
      body: `{
				"template": "password-reset",
				"email": "test@example.com"
			}`,
      headers: { Authorization: superuserToken },
      prepare: smtpToSink(),
      after: mailSent("test@example.com", "Reset password"),
      expectedStatus: 204,
    },
    {
      name: "authorized as superuser (email change)",
      method: "POST",
      url: "/api/settings/test/email",
      body: `{
				"template": "email-change",
				"email": "test@example.com"
			}`,
      headers: { Authorization: superuserToken },
      prepare: smtpToSink(),
      after: mailSent("test@example.com", "Confirm new email"),
      expectedStatus: 204,
    },
    {
      name: "authorized as superuser (otp)",
      method: "POST",
      url: "/api/settings/test/email",
      body: `{
				"template": "otp",
				"email": "test@example.com"
			}`,
      headers: { Authorization: superuserToken },
      prepare: smtpToSink(),
      after: mailSent("test@example.com", "one-time password"),
      expectedStatus: 204,
    },
  ],
};

// the TestEmailSendValidateAndSubmit table: [template, email, collection,
// expected error keys (none: one email sent with the template's text)]
const testEmailSendCases: [string, string, string, string[] | null][] = [
  ["", "", "", ["template", "email"]],
  ["invalid", "test@example.com", "", ["template"]],
  ["verification", "invalid", "", ["email"]],
  ["verification", "test@example.com", "invalid", ["collection"]],
  ["verification", "test@example.com", "demo1", ["collection"]],
  ["verification", "test@example.com", "users", null],
  ["password-reset", "test@example.com", "", null],
  ["email-change", "test@example.com", "", null],
  ["otp", "test@example.com", "", null],
  ["login-alert", "test@example.com", "", null],
];

const testEmailSendContent: Record<string, string> = {
  "password-reset": "Reset password",
  "email-change": "Confirm new email",
  verification: "Verify",
  otp: "one-time password",
  "login-alert": "from a new location",
};

export const testEmailSendValidateAndSubmit: Suite = {
  file: "forms/test_email_send_test.go",
  func: "TestEmailSendValidateAndSubmit",
  scenarios: testEmailSendCases.map(([template, email, collection, expectedErrors], i) =>
    expectedErrors === null
      ? {
          name: `${i}_${template}`,
          method: "POST",
          url: "/api/settings/test/email",
          body: JSON.stringify({ template, email, collection }),
          headers: { Authorization: superuserToken },
          prepare: smtpToSink(),
          after: mailSent(email, testEmailSendContent[template] as string),
          expectedStatus: 204,
        }
      : {
          name: `${i}_${template}`,
          method: "POST",
          url: "/api/settings/test/email",
          body: JSON.stringify({ template, email, collection }),
          headers: { Authorization: superuserToken },
          expectedStatus: 400,
          expectedContent: expectedErrors.map((key) => `"${key}":{"code":`),
        },
  ),
};

export const generateAppleClientSecret: Suite = {
  file: "apis/settings_test.go",
  func: "TestGenerateAppleClientSecret",
  scenarios: [
    {
      name: "unauthorized",
      method: "POST",
      url: "/api/settings/apple/generate-client-secret",
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as regular user",
      method: "POST",
      url: "/api/settings/apple/generate-client-secret",
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser (invalid body)",
      method: "POST",
      url: "/api/settings/apple/generate-client-secret",
      body: `{`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser (empty json)",
      method: "POST",
      url: "/api/settings/apple/generate-client-secret",
      body: `{}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [
        `"clientId":{"code":"validation_required"`,
        `"teamId":{"code":"validation_required"`,
        `"keyId":{"code":"validation_required"`,
        `"privateKey":{"code":"validation_required"`,
        `"duration":{"code":"validation_required"`,
      ],
    },
    {
      name: "authorized as superuser (invalid data)",
      method: "POST",
      url: "/api/settings/apple/generate-client-secret",
      body: `{
				"clientId": "",
				"teamId": "123456789",
				"keyId": "123456789",
				"privateKey": "invalid",
				"duration": -1
			}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 400,
      expectedContent: [
        `"clientId":{"code":"validation_required"`,
        `"teamId":{"code":"validation_length_invalid"`,
        `"keyId":{"code":"validation_length_invalid"`,
        `"privateKey":{"code":"validation_match_invalid"`,
        `"duration":{"code":"validation_min_greater_equal_than_required"`,
      ],
    },
    {
      name: "authorized as superuser (valid data)",
      method: "POST",
      url: "/api/settings/apple/generate-client-secret",
      body: `{
				"clientId": "123",
				"teamId": "1234567890",
				"keyId": "1234567891",
				"privateKey": ${JSON.stringify(privatePem)},
				"duration": 1
			}`,
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [`"secret":"`],
    },
  ],
};
