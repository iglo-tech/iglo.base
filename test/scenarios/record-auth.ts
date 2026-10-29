// Upstream: apis/record_auth_with_password_test.go,
// apis/record_auth_refresh_test.go, apis/record_auth_methods_test.go,
// apis/record_auth_impersonate_test.go
//
// The tokens are upstream's fixture tokens (test data, expiring in 2050).
// BeforeTestFunc steps become `prepare` steps on the fixture copy
// (test/scenarios/record-auth-prepare.ts), AfterTestFunc checks `after`
// checks of the pb_data. Not ported: the "OnRecordAuthWithPasswordRequest
// tx body write check" and "OnRecordAuthRefreshRequest tx body write check"
// scenarios (they only test an upstream hook) and the hook-only
// BeforeTestFunc of "valid identity field (email) and valid password"
// (it asserts the request info context through OnRecordAuthRequest).
// The rate limit rules are M4.8. The auth alert emails upstream's test
// mailer receives (OnMailerRecordAuthAlertSend) are M4.4; the responses do
// not depend on them.

import {
  insertMFA,
  mfasCount,
  setAuthRecordField,
  setMFA,
  updateIdentityIndex,
} from "@test/scenarios/record-auth-prepare";
import { superuserToken, usersToken } from "@test/scenarios/record-crud";
import { setRateLimits } from "@test/scenarios/prepare";
import type { RateLimitRuleData } from "@test/scenarios/prepare";
import type { Scenario, Suite } from "@test/scenarios/scenario";

// users, test2@example.com
const usersTest2Token =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6Im9hcDY0MGNvdDR5cnUycyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.GfJo6EHIobgas_AXt-M-tj5IoQendPnrkMSe9ExuSEY";

// users, test@example.com, refreshable: false
const usersStaticToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6ZmFsc2V9.4IsO6YMsR19crhwl_YWzvRH8pfq2Ri4Gv2dzGyneLak";

// clients, test2@example.com (unverified)
const clientsUnverifiedToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6Im8xeTBkZDBzcGQ3ODZtZCIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoidjg1MXE0cjc5MHJoa25sIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.Zi0yXE-CNmnbTdVaQEzYZVuECqRdn3LgEM6pmB3XWBE";

// clients, test@example.com (verified)
const clientsVerifiedToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6ImdrMzkwcWVnczR5NDd3biIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoidjg1MXE0cjc5MHJoa25sIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.0ONnm_BsvPRZyDNT31GN1CKUB6uQRxvVvQ-Wc9AZfG0";

const rateLimitPending = {
  task: "M4.8",
  reason: "collectionPathRateLimit and the settings rate limit rules are not ported yet",
};

function rateLimitScenario(
  name: string,
  method: string,
  url: string,
  rules: RateLimitRuleData[],
  headers?: Record<string, string>,
): Scenario {
  return {
    name,
    method,
    url,
    ...(headers ? { headers } : {}),
    prepare: ({ dataDir }) => setRateLimits(dataDir, rules),
    pending: rateLimitPending,
    expectedStatus: 429,
    expectedContent: [`"data":{}`],
  };
}

// a successful auth response without the hidden fields
const authSuccessHidden = [
  // hidden fields
  `"tokenKey"`,
  `"password"`,
];

export const recordAuthWithPassword: Suite = {
  file: "apis/record_auth_with_password_test.go",
  func: "TestRecordAuthWithPassword",
  scenarios: [
    {
      name: "disabled password auth",
      method: "POST",
      url: "/api/collections/nologin/auth-with-password",
      body: `{"identity":"test@example.com","password":"1234567890"}`,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "non-auth collection",
      method: "POST",
      url: "/api/collections/demo1/auth-with-password",
      body: `{"identity":"test@example.com","password":"1234567890"}`,
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "invalid body format",
      method: "POST",
      url: "/api/collections/clients/auth-with-password",
      body: `{"identity`,
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "empty body params",
      method: "POST",
      url: "/api/collections/clients/auth-with-password",
      body: `{"identity":"","password":""}`,
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"identity":{`, `"password":{`],
    },
    {
      name: "valid identity field and invalid password",
      method: "POST",
      url: "/api/collections/clients/auth-with-password",
      body: `{
				"identity":"test@example.com",
				"password":"invalid"
			}`,
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "valid identity field (email) and valid password",
      method: "POST",
      url: "/api/collections/clients/auth-with-password",
      body: `{
				"identity":"test@example.com",
				"password":"1234567890"
			}`,
      expectedStatus: 200,
      expectedContent: [`"email":"test@example.com"`, `"token":`],
      notExpectedContent: authSuccessHidden,
    },
    {
      name: "valid identity field (username) and valid password",
      method: "POST",
      url: "/api/collections/clients/auth-with-password",
      body: `{
				"identity":"clients57772",
				"password":"1234567890"
			}`,
      expectedStatus: 200,
      expectedContent: [`"email":"test@example.com"`, `"username":"clients57772"`, `"token":`],
      notExpectedContent: authSuccessHidden,
    },
    {
      // https://ganigeorgiev.com/pocketbase/discussions/7256
      name: "valid non-email identity field with a value that is a properly formatted email",
      method: "POST",
      url: "/api/collections/clients/auth-with-password",
      body: `{
				"identity":"username_as_email@example.com",
				"password":"1234567890"
			}`,
      prepare: setAuthRecordField(
        "clients",
        "test@example.com",
        "username",
        "username_as_email@example.com",
      ),
      expectedStatus: 200,
      expectedContent: [
        `"email":"test@example.com"`,
        `"username":"username_as_email@example.com"`,
        `"token":`,
      ],
      notExpectedContent: authSuccessHidden,
    },
    {
      name: "unknown explicit identityField",
      method: "POST",
      url: "/api/collections/clients/auth-with-password",
      body: `{
				"identityField": "created",
				"identity":"test@example.com",
				"password":"1234567890"
			}`,
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"identityField":{"code":"validation_in_invalid"`],
    },
    {
      name: "valid identity field and valid password with mismatched explicit identityField",
      method: "POST",
      url: "/api/collections/clients/auth-with-password",
      body: `{
				"identityField": "username",
				"identity":"test@example.com",
				"password":"1234567890"
			}`,
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "valid identity field and valid password with matched explicit identityField",
      method: "POST",
      url: "/api/collections/clients/auth-with-password",
      body: `{
				"identityField": "username",
				"identity":"clients57772",
				"password":"1234567890"
			}`,
      expectedStatus: 200,
      expectedContent: [`"email":"test@example.com"`, `"username":"clients57772"`, `"token":`],
      notExpectedContent: authSuccessHidden,
    },
    {
      name: "valid identity (unverified) and valid password in onlyVerified collection",
      method: "POST",
      url: "/api/collections/clients/auth-with-password",
      body: `{
				"identity":"test2@example.com",
				"password":"1234567890"
			}`,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "already authenticated record",
      method: "POST",
      url: "/api/collections/clients/auth-with-password",
      body: `{
				"identity":"test@example.com",
				"password":"1234567890"
			}`,
      headers: { Authorization: usersToken },
      expectedStatus: 200,
      expectedContent: [`"id":"gk390qegs4y47wn"`, `"email":"test@example.com"`, `"token":`],
      notExpectedContent: authSuccessHidden,
    },
    {
      name: "with mfa first auth check",
      method: "POST",
      url: "/api/collections/users/auth-with-password",
      body: `{
				"identity":"test@example.com",
				"password":"1234567890"
			}`,
      expectedStatus: 401,
      expectedContent: [`"mfaId":"`],
      after: mfasCount("_pb_users_auth_", "4q1xlclmfloku33", 1),
    },
    {
      name: "with mfa second auth check",
      method: "POST",
      url: "/api/collections/users/auth-with-password",
      body: `{
				"mfaId": "${"a".repeat(15)}",
				"identity":"test@example.com",
				"password":"1234567890"
			}`,
      prepare: insertMFA("users", "test@example.com", "a".repeat(15), "test"),
      expectedStatus: 200,
      expectedContent: [`"email":"test@example.com"`, `"token":`],
      notExpectedContent: authSuccessHidden,
      // the mfa is deleted
      after: mfasCount("_pb_users_auth_", "4q1xlclmfloku33", 0),
    },
    {
      name: "with enabled mfa but unsatisfied mfa rule (aka. skip the mfa check)",
      method: "POST",
      url: "/api/collections/users/auth-with-password",
      body: `{
				"identity":"test@example.com",
				"password":"1234567890"
			}`,
      prepare: setMFA("users", true, "1=2"),
      expectedStatus: 200,
      expectedContent: [`"email":"test@example.com"`, `"token":`],
      notExpectedContent: authSuccessHidden,
      after: mfasCount("_pb_users_auth_", "4q1xlclmfloku33", 0),
    },

    // case sensitivity checks
    // -----------------------------------------------------------
    {
      name: "with explicit identityField (case-sensitive)",
      method: "POST",
      url: "/api/collections/clients/auth-with-password",
      body: `{
				"identityField": "username",
				"identity":"Clients57772",
				"password":"1234567890"
			}`,
      prepare: updateIdentityIndex({ username: "" }),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "with explicit identityField (case-insensitive)",
      method: "POST",
      url: "/api/collections/clients/auth-with-password",
      body: `{
				"identityField": "username",
				"identity":"Clients57772",
				"password":"1234567890"
			}`,
      prepare: updateIdentityIndex({ username: "nocase" }),
      expectedStatus: 200,
      expectedContent: [`"email":"test@example.com"`, `"username":"clients57772"`, `"token":`],
      notExpectedContent: authSuccessHidden,
    },
    {
      name: "without explicit identityField and non-email field (case-insensitive)",
      method: "POST",
      url: "/api/collections/clients/auth-with-password",
      body: `{
				"identity":"Clients57772",
				"password":"1234567890"
			}`,
      prepare: updateIdentityIndex({ username: "nocase" }),
      expectedStatus: 200,
      expectedContent: [`"email":"test@example.com"`, `"username":"clients57772"`, `"token":`],
      notExpectedContent: authSuccessHidden,
    },
    {
      name: "without explicit identityField and email field (case-insensitive)",
      method: "POST",
      url: "/api/collections/clients/auth-with-password",
      body: `{
				"identity":"tESt@example.com",
				"password":"1234567890"
			}`,
      prepare: updateIdentityIndex({ email: "nocase" }),
      expectedStatus: 200,
      expectedContent: [`"email":"test@example.com"`, `"username":"clients57772"`, `"token":`],
      notExpectedContent: authSuccessHidden,
    },

    // rate limit checks
    // -----------------------------------------------------------
    rateLimitScenario(
      "RateLimit rule - users:authWithPassword",
      "POST",
      "/api/collections/users/auth-with-password",
      [
        { maxRequests: 100, label: "abc" },
        { maxRequests: 100, label: "*:authWithPassword" },
        { maxRequests: 100, label: "users:auth" },
        { maxRequests: 0, label: "users:authWithPassword" },
      ],
    ),
    rateLimitScenario(
      "RateLimit rule - *:authWithPassword",
      "POST",
      "/api/collections/users/auth-with-password",
      [
        { maxRequests: 100, label: "abc" },
        { maxRequests: 100, label: "*:auth" },
        { maxRequests: 0, label: "*:authWithPassword" },
      ],
    ),
    rateLimitScenario(
      "RateLimit rule - users:auth",
      "POST",
      "/api/collections/users/auth-with-password",
      [
        { maxRequests: 100, label: "abc" },
        { maxRequests: 100, label: "*:authWithPassword" },
        { maxRequests: 0, label: "users:auth" },
      ],
    ),
    rateLimitScenario(
      "RateLimit rule - *:auth",
      "POST",
      "/api/collections/users/auth-with-password",
      [
        { maxRequests: 100, label: "abc" },
        { maxRequests: 0, label: "*:auth" },
      ],
    ),
  ],
};

export const recordAuthRefresh: Suite = {
  file: "apis/record_auth_refresh_test.go",
  func: "TestRecordAuthRefresh",
  scenarios: [
    {
      name: "unauthorized",
      method: "POST",
      url: "/api/collections/users/auth-refresh",
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "superuser trying to refresh the auth of another auth collection",
      method: "POST",
      url: "/api/collections/users/auth-refresh",
      headers: { Authorization: superuserToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "auth record + not an auth collection",
      method: "POST",
      url: "/api/collections/demo1/auth-refresh",
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "auth record + different auth collection",
      method: "POST",
      url: "/api/collections/clients/auth-refresh?expand=rel,missing",
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "auth record + same auth collection as the token",
      method: "POST",
      url: "/api/collections/users/auth-refresh?expand=rel,missing",
      headers: { Authorization: usersToken },
      expectedStatus: 200,
      expectedContent: [
        `"token":`,
        `"record":`,
        `"id":"4q1xlclmfloku33"`,
        `"emailVisibility":false`,
        `"email":"test@example.com"`, // the owner can always view their email address
        `"expand":`,
        `"rel":`,
        `"id":"llvuca81nly1qls"`,
      ],
      notExpectedContent: [
        `"missing":`,
        // should return a different token
        usersToken,
      ],
    },
    {
      name: "auth record + same auth collection as the token but static/unrefreshable",
      method: "POST",
      url: "/api/collections/users/auth-refresh",
      headers: { Authorization: usersStaticToken },
      expectedStatus: 200,
      expectedContent: [
        // should return the same token
        `"token":"${usersStaticToken}"`,
        `"record":`,
        `"id":"4q1xlclmfloku33"`,
        `"emailVisibility":false`,
        `"email":"test@example.com"`, // the owner can always view their email address
      ],
    },
    {
      name: "unverified auth record in onlyVerified collection",
      method: "POST",
      url: "/api/collections/clients/auth-refresh",
      headers: { Authorization: clientsUnverifiedToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "verified auth record in onlyVerified collection",
      method: "POST",
      url: "/api/collections/clients/auth-refresh",
      headers: { Authorization: clientsVerifiedToken },
      expectedStatus: 200,
      expectedContent: [
        `"token":`,
        `"record":`,
        `"id":"gk390qegs4y47wn"`,
        `"verified":true`,
        `"email":"test@example.com"`,
      ],
    },

    // rate limit checks
    // -----------------------------------------------------------
    rateLimitScenario(
      "RateLimit rule - users:authRefresh",
      "POST",
      "/api/collections/users/auth-refresh",
      [
        { maxRequests: 100, label: "abc" },
        { maxRequests: 100, label: "*:authRefresh" },
        { maxRequests: 0, label: "users:authRefresh" },
      ],
      { Authorization: usersToken },
    ),
    rateLimitScenario(
      "RateLimit rule - *:authRefresh",
      "POST",
      "/api/collections/users/auth-refresh",
      [
        { maxRequests: 100, label: "abc" },
        { maxRequests: 0, label: "*:authRefresh" },
      ],
      { Authorization: usersToken },
    ),
  ],
};

export const recordAuthMethodsList: Suite = {
  file: "apis/record_auth_methods_test.go",
  func: "TestRecordAuthMethodsList",
  scenarios: [
    {
      name: "missing collection",
      method: "GET",
      url: "/api/collections/missing/auth-methods",
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "non auth collection",
      method: "GET",
      url: "/api/collections/demo1/auth-methods",
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "auth collection with none auth methods allowed",
      method: "GET",
      url: "/api/collections/nologin/auth-methods",
      expectedStatus: 200,
      expectedContent: [
        `"password":{"identityFields":[],"enabled":false}`,
        `"oauth2":{"providers":[],"enabled":false}`,
        `"mfa":{"enabled":false,"duration":0}`,
        `"otp":{"enabled":false,"duration":0}`,
      ],
    },
    {
      name: "auth collection with all auth methods allowed",
      method: "GET",
      url: "/api/collections/users/auth-methods",
      expectedStatus: 200,
      expectedContent: [
        `"password":{"identityFields":["email","username"],"enabled":true}`,
        `"mfa":{"enabled":true,"duration":1800}`,
        `"otp":{"enabled":true,"duration":300}`,
        `"oauth2":{`,
        `"providers":[{`,
        `"name":"google"`,
        `"name":"gitlab"`,
        `"logo":"<svg`,
        `"logo":""`, // for the legacy fields
        `"state":`,
        `"displayName":`,
        `"codeVerifier":`,
        `"codeChallenge":`,
        `"codeChallengeMethod":`,
        `"authURL":`,
        `redirect_uri="`, // ensures that the redirect_uri is the last url param
      ],
    },

    // rate limit checks
    // -----------------------------------------------------------
    rateLimitScenario(
      "RateLimit rule - nologin:listAuthMethods",
      "GET",
      "/api/collections/nologin/auth-methods",
      [
        { maxRequests: 100, label: "abc" },
        { maxRequests: 100, label: "*:listAuthMethods" },
        { maxRequests: 0, label: "nologin:listAuthMethods" },
      ],
    ),
    rateLimitScenario(
      "RateLimit rule - *:listAuthMethods",
      "GET",
      "/api/collections/nologin/auth-methods",
      [
        { maxRequests: 100, label: "abc" },
        { maxRequests: 0, label: "*:listAuthMethods" },
      ],
    ),
  ],
};

export const recordAuthImpersonate: Suite = {
  file: "apis/record_auth_impersonate_test.go",
  func: "TestRecordAuthImpersonate",
  scenarios: [
    {
      name: "unauthorized",
      method: "POST",
      url: "/api/collections/users/impersonate/4q1xlclmfloku33",
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as different user",
      method: "POST",
      url: "/api/collections/users/impersonate/4q1xlclmfloku33",
      headers: { Authorization: usersTest2Token },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as the same user",
      method: "POST",
      url: "/api/collections/users/impersonate/4q1xlclmfloku33",
      headers: { Authorization: usersToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "authorized as superuser",
      method: "POST",
      url: "/api/collections/users/impersonate/4q1xlclmfloku33",
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [`"token":"`, `"id":"4q1xlclmfloku33"`, `"record":{`],
      notExpectedContent: [
        // hidden fields should remain hidden even though we are authenticated as superuser
        `"tokenKey"`,
        `"password"`,
      ],
    },
    {
      name: "authorized as superuser with custom invalid duration",
      method: "POST",
      url: "/api/collections/users/impersonate/4q1xlclmfloku33",
      headers: { Authorization: superuserToken },
      body: `{"duration":-1}`,
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"duration":{`],
    },
    {
      name: "authorized as superuser with custom valid duration",
      method: "POST",
      url: "/api/collections/users/impersonate/4q1xlclmfloku33",
      headers: { Authorization: superuserToken },
      body: `{"duration":100}`,
      expectedStatus: 200,
      expectedContent: [`"token":"`, `"id":"4q1xlclmfloku33"`, `"record":{`],
    },
  ],
};
