// Upstream: apis/record_auth_with_oauth2_test.go
//
// Upstream's tests register a Go mock provider named "test" that returns
// a fixed AuthUser and Token. Here the provider is the real OIDC provider
// ("oidc") pointed at a local mock (test/support/oauth2-mock.ts): the AuthUser
// fields become userinfo claims (sub, preferred_username, picture, and
// email with email_verified), the token the mock's default answer. BeforeTestFunc
// steps become `prepare` steps, AfterTestFunc checks `after` checks of
// the pb_data; ExpectedEvents are dropped (D5).
//
// Not ported here, with the reason:
//   - "creating user (with mapped OAuth2 fields and avatarURL->file field)":
//     its avatar is on the public internet; both servers refuse the mock on
//     loopback. test/apis/record-auth-with-oauth2.test.ts covers the path
//     in-process, with the address check replaced.
//   - "store name with Apple provider": needs a provider named apple with a
//     Go-injected user. In-process in test/apis/record-auth-with-oauth2.test.ts,
//     with the real Apple provider too (its JWKS is fixed, so a test-only fetch
//     answers it).
//   - "store name with non-Apple provider": its store key is set from Go.
//     test/differential/auth/oauth2-flows.test.ts sets it through the redirect
//     endpoint.
//   - "OnRecordAuthWithOAuth2Request tx body write check": only tests a hook.
//   - the OnRecordAuthRequest request context check of "existing linked
//     OAuth2 (unverified user)": a hook; test/differential/auth/oauth2-cases.ts
//     checks the context through an auth rule.
// The rate limit scenarios are pending on M4.8.

import type { Collection } from "@/collections/collection-model";
import {
  OAuth2KnownFields,
  OAuth2ProviderConfig,
} from "@/collections/collection-model-auth-options";
import { findSingleColumnUniqueIndex } from "@/tools/dbutils/index";

import { updateCollection } from "@test/scenarios/prepare";
import { rateLimitScenario } from "@test/scenarios/record-auth";
import { insertExternalAuth, updateKeepingTokenKey } from "@test/scenarios/record-auth-prepare";
import {
  authOriginsCount,
  checks,
  externalAuthsCount,
  passwordIs,
  queryRows,
  rowHas,
} from "@test/scenarios/record-checks";
import { usersToken } from "@test/scenarios/record-crud";
import type { AfterContext, PrepareContext, Scenario, Suite } from "@test/scenarios/scenario";
import {
  type MockEndpoints,
  type MockProvider,
  type MockProviderSpec,
  sharedOAuth2Mock,
} from "@test/support/oauth2-mock";

export const usersId = "_pb_users_auth_";
export const user1Id = "4q1xlclmfloku33"; // test@example.com, unverified
export const user2Id = "oap640cot4yru2s"; // test2@example.com, verified
export const user3Id = "bgs820n361vj1qd"; // test3@example.com, verified
const pw = "1234567890";

// users, test2@example.com
const user2Token =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6Im9hcDY0MGNvdDR5cnUycyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.GfJo6EHIobgas_AXt-M-tj5IoQendPnrkMSe9ExuSEY";

export const authURL = "/api/collections/users/auth-with-oauth2";

export type PrepareStep = (ctx: PrepareContext) => void;

// several prepare steps in order
export function all(...steps: PrepareStep[]): PrepareStep {
  return (ctx) => {
    for (const step of steps) {
      step(ctx);
    }
  };
}

// a registered mock provider, as a prepare step sees it
export type ProviderSpec = MockProviderSpec | ((p: MockEndpoints) => MockProviderSpec);

// Enables OAuth2 on the collection with the "oidc" provider pointed at a new
// mock provider, and disables MFA (auth.Providers["test"] + the collection
// changes of upstream's BeforeTestFunc). `onProvider` gets the provider, for
// checks of what the server sent to it.
export function useProvider(
  spec: ProviderSpec = {},
  change?: (collection: Collection, provider: MockProvider) => void,
  collectionName = "users",
  onProvider?: (provider: MockProvider) => void,
): PrepareStep {
  return ({ dataDir }) => {
    const provider = sharedOAuth2Mock().register(spec);
    onProvider?.(provider);
    updateCollection(dataDir, collectionName, (collection) => {
      collection.mfa.enabled = false;
      collection.oauth2.enabled = true;
      collection.oauth2.providers = [
        new OAuth2ProviderConfig({
          name: "oidc",
          clientId: "123",
          clientSecret: "456",
          tokenURL: provider.tokenURL,
          userInfoURL: provider.userInfoURL,
        }),
      ];
      change?.(collection, provider);
    });
  };
}

// the claims of a provider-verified email
export const verifiedEmail = (email: string): { email: string; email_verified: boolean } => ({
  email,
  email_verified: true,
});

const body = (createData?: unknown): string =>
  JSON.stringify({
    provider: "oidc",
    code: "123",
    redirectURL: "https://example.com",
    ...(createData === undefined ? {} : { createData }),
  });

export function authScenario(
  scenario: Omit<Scenario, "method" | "url" | "body"> & { body?: string },
): Scenario {
  return { method: "POST", url: authURL, body: body(), ...scenario };
}

const hiddenFields = [`"tokenKey"`, `"password"`];

// the only external auth left is the oidc link
function onlyLink(recordId: string, providerId: string) {
  return async ({ dataDir }: AfterContext): Promise<void> => {
    const rows = queryRows(
      dataDir,
      "SELECT provider, providerId, collectionRef FROM _externalAuths WHERE recordRef = ?",
      recordId,
    );
    const expected = [{ provider: "oidc", providerId, collectionRef: usersId }];
    if (JSON.stringify(rows) !== JSON.stringify(expected)) {
      throw new Error(`expected only the oidc link, got ${JSON.stringify(rows)}`);
    }
  };
}

const linkedRows = (recordId: string, n: number) => externalAuthsCount(usersId, recordId, n);

const mapAvatarAndUsername = (collection: Collection): void => {
  collection.oauth2.mappedFields = new OAuth2KnownFields({
    username: "name", // should be ignored because of the explicit submitted value
    id: "username",
    avatarURL: "avatar",
  });
};

const createData = {
  emailVisibility: true,
  password: pw,
  passwordConfirm: pw,
  name: "test_name",
  username: "test_username",
  rel: "0yxhwia2amd8gec",
};

const rateLimits = (name: string, rules: { maxRequests: number; label: string }[]): Scenario => ({
  ...rateLimitScenario(name, "POST", authURL, rules),
  pending: { task: "M4.8", reason: "the settings rate limit rules" },
});

export const recordAuthWithOAuth2: Suite = {
  file: "apis/record_auth_with_oauth2_test.go",
  func: "TestRecordAuthWithOAuth2",
  scenarios: [
    {
      name: "disabled OAuth2 auth",
      method: "POST",
      url: "/api/collections/nologin/auth-with-oauth2",
      body: `{
				"provider":     "test",
				"code":         "123",
				"codeVerifier": "456",
				"redirectURL":  "https://example.com"
			}`,
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "invalid body",
      method: "POST",
      url: authURL,
      body: `{"provider"`,
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "trigger form validations (missing provider)",
      method: "POST",
      url: authURL,
      body: `{
				"provider": "missing"
			}`,
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"provider":`, `"code":`],
      notExpectedContent: [
        // should be optional
        `"codeVerifier":`,
        `"redirectURL":`,
      ],
    },
    {
      name: "trigger form validations (existing but disabled provider)",
      method: "POST",
      url: authURL,
      body: `{
				"provider": "apple"
			}`,
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"provider":`, `"code":`],
      notExpectedContent: [
        // should be optional
        `"codeVerifier":`,
        `"redirectURL":`,
      ],
    },
    authScenario({
      name: "existing linked OAuth2 (unverified user)",
      body: body({ name: "test_new" }),
      // auth with some other user from the same collection to ensure that it is ignored
      headers: { Authorization: user2Token },
      prepare: all(
        useProvider(),
        insertExternalAuth("users", "test@example.com", "oidc", "test_id"),
      ),
      expectedStatus: 200,
      expectedContent: [
        `"record":{`,
        `"token":"`,
        `"meta":{`,
        `"email":"test@example.com"`,
        `"id":"4q1xlclmfloku33"`,
        `"id":"test_id"`,
        `"verified":false`, // shouldn't change
      ],
      notExpectedContent: hiddenFields,
      after: checks(
        rowHas("users", user1Id, { name: "test1" }),
        passwordChanged(user1Id),
        authOriginsCount(usersId, user1Id, 1),
        // ensure that other linked external auths have been deleted
        onlyLink(user1Id, "test_id"),
      ),
    }),
    authScenario({
      name: "existing linked OAuth2 (verified user)",
      prepare: all(
        useProvider(),
        insertExternalAuth("users", "test2@example.com", "oidc", "test_id"),
      ),
      expectedStatus: 200,
      expectedContent: [
        `"record":{`,
        `"token":"`,
        `"meta":{`,
        `"isNew":false`,
        `"email":"test2@example.com"`,
        `"id":"oap640cot4yru2s"`,
        `"id":"test_id"`,
        `"verified":true`,
      ],
      notExpectedContent: hiddenFields,
      after: checks(passwordIs("users", user2Id, pw), authOriginsCount(usersId, user2Id, 1)),
    }),
    authScenario({
      name: "link by email (unverified user)",
      prepare: useProvider({ user: { sub: "test_id", ...verifiedEmail("test@example.com") } }),
      expectedStatus: 200,
      expectedContent: [
        `"record":{`,
        `"token":"`,
        `"meta":{`,
        `"isNew":false`,
        `"email":"test@example.com"`,
        `"id":"4q1xlclmfloku33"`,
        `"id":"test_id"`,
        `"verified":true`, // should be updated
      ],
      notExpectedContent: hiddenFields,
      after: checks(
        passwordChanged(user1Id),
        authOriginsCount(usersId, user1Id, 1),
        onlyLink(user1Id, "test_id"),
      ),
    }),
    authScenario({
      name: "link by email (verified user)",
      prepare: useProvider({ user: { sub: "test_id", ...verifiedEmail("test3@example.com") } }),
      expectedStatus: 200,
      expectedContent: [
        `"record":{`,
        `"token":"`,
        `"meta":{`,
        `"isNew":false`,
        `"email":"test3@example.com"`,
        `"id":"bgs820n361vj1qd"`,
        `"id":"test_id"`,
        `"verified":true`,
      ],
      notExpectedContent: hiddenFields,
      after: checks(
        passwordIs("users", user3Id, pw),
        authOriginsCount(usersId, user3Id, 1),
        linkedRows(user3Id, 2),
      ),
    }),
    authScenario({
      name: "link by fallback user (OAuth2 user with different email)",
      headers: { Authorization: usersToken },
      prepare: useProvider({
        // different email -> should be ignored
        user: { sub: "test_id", ...verifiedEmail("test2@example.com") },
      }),
      expectedStatus: 200,
      expectedContent: [
        `"record":{`,
        `"token":"`,
        `"meta":{`,
        `"isNew":false`,
        `"email":"test@example.com"`,
        `"id":"4q1xlclmfloku33"`,
        `"id":"test_id"`,
        `"verified":false`, // shouldn't change because the OAuth2 user email is different
      ],
      notExpectedContent: hiddenFields,
      after: checks(passwordIs("users", user1Id, pw), authOriginsCount(usersId, user1Id, 1)),
    }),
    authScenario({
      name: "link by fallback user (user without email)",
      headers: { Authorization: usersToken },
      prepare: all(
        // manually unset the user email; the old token key keeps the token valid
        updateKeepingTokenKey("users", "test@example.com", (user) => user.setEmail("")),
        useProvider({
          user: { sub: "test_id", ...verifiedEmail("test_oauth2@example.com") },
        }),
      ),
      expectedStatus: 200,
      expectedContent: [
        `"record":{`,
        `"token":"`,
        `"meta":{`,
        `"isNew":false`,
        `"email":"test_oauth2@example.com"`,
        `"id":"4q1xlclmfloku33"`,
        `"id":"test_id"`,
        `"verified":true`,
      ],
      notExpectedContent: hiddenFields,
      after: checks(passwordIs("users", user1Id, pw), authOriginsCount(usersId, user1Id, 1)),
    }),
    authScenario({
      name: "link by fallback user (unverified user with matching email)",
      headers: { Authorization: usersToken },
      prepare: useProvider({
        // matching email -> should be marked as verified
        user: { sub: "test_id", ...verifiedEmail("test@example.com") },
      }),
      expectedStatus: 200,
      expectedContent: [
        `"record":{`,
        `"token":"`,
        `"meta":{`,
        `"isNew":false`,
        `"email":"test@example.com"`,
        `"id":"4q1xlclmfloku33"`,
        `"id":"test_id"`,
        `"verified":true`,
      ],
      notExpectedContent: hiddenFields,
      after: checks(passwordIs("users", user1Id, pw), authOriginsCount(usersId, user1Id, 1)),
    }),
    authScenario({
      name: "creating user (no extra create data or custom fields mapping)",
      prepare: useProvider(),
      expectedStatus: 200,
      expectedContent: [
        `"record":{`,
        `"token":"`,
        `"meta":{`,
        `"isNew":true`,
        `"email":""`,
        `"id":"test_id"`,
        `"verified":true`,
      ],
      notExpectedContent: hiddenFields,
    }),
    authScenario({
      name: "creating user (submit failure - form auth fields validator)",
      body: body({ verified: true, email: "invalid", rel: "invalid", file: "invalid" }),
      prepare: useProvider(),
      expectedStatus: 400,
      expectedContent: [`"data":{`, `"verified":{"code":"validation_values_mismatch"`],
      notExpectedContent: [
        `"email":`, // ignored because the record validator never ran
        `"rel":`, // ignored because the record validator never ran
        `"file":`, // ignored because the record validator never ran
      ],
    }),
    authScenario({
      name: "creating user (submit failure - record fields validator)",
      body: body({ email: "invalid", rel: "invalid", file: "invalid" }),
      prepare: useProvider(),
      expectedStatus: 400,
      expectedContent: [
        `"data":{`,
        `"email":{"code":"validation_is_email"`,
        `"rel":{"code":"validation_missing_rel_records"`,
        `"file":{"code":"validation_invalid_file"`,
      ],
    }),
    authScenario({
      name: "creating user (valid create data with empty submitted email)",
      body: body({ email: "", ...createData }),
      prepare: useProvider(),
      expectedStatus: 200,
      expectedContent: [
        `"isNew":true`,
        `"email":""`,
        `"emailVisibility":true`,
        `"name":"test_name"`,
        `"username":"test_username"`,
        `"verified":true`,
        `"rel":"0yxhwia2amd8gec"`,
      ],
      notExpectedContent: hiddenFields,
      after: passwordByUsername("test_username", pw),
    }),
    authScenario({
      name: "creating user (valid create data with non-empty valid submitted email)",
      body: body({ email: "test_create@example.com", ...createData }),
      prepare: useProvider({
        // should be ignored because of the explicit submitted email
        user: { sub: "test_id", ...verifiedEmail("oauth2@example.com") },
      }),
      expectedStatus: 200,
      expectedContent: [
        `"email":"test_create@example.com"`,
        `"emailVisibility":true`,
        `"name":"test_name"`,
        `"username":"test_username"`,
        `"verified":false`,
        `"rel":"0yxhwia2amd8gec"`,
      ],
      notExpectedContent: hiddenFields,
      after: passwordByUsername("test_username", pw),
    }),
    authScenario({
      name: "creating user (with mapped OAuth2 fields and local avatarURL->file field; ensures that safeHTTPClient is being used)",
      body: body({ name: "test_name", emailVisibility: true, rel: "0yxhwia2amd8gec" }),
      prepare: useProvider(
        (p) => ({
          user: {
            sub: "oauth2_id",
            ...verifiedEmail("oauth2@example.com"),
            preferred_username: "oauth2_username",
            picture: p.avatarURL, // local/private file download is not allowed
          },
        }),
        mapAvatarAndUsername,
      ),
      expectedStatus: 200,
      expectedContent: [
        `"isNew":true`,
        `"email":"oauth2@example.com"`,
        `"emailVisibility":true`,
        `"name":"test_name"`,
        `"username":"oauth2_id"`,
        `"verified":true`,
        `"rel":"0yxhwia2amd8gec"`,
        `"avatar":""`,
      ],
      notExpectedContent: hiddenFields,
    }),
    authScenario({
      name: "creating user (with mapped OAuth2 avatarURL field but empty OAuth2User.avatarURL value)",
      prepare: useProvider(
        { user: { sub: "oauth2_id", ...verifiedEmail("oauth2@example.com"), picture: "" } },
        (collection) => {
          collection.oauth2.mappedFields = new OAuth2KnownFields({ avatarURL: "avatar" });
        },
      ),
      expectedStatus: 200,
      expectedContent: [
        `"isNew":true`,
        `"email":"oauth2@example.com"`,
        `"emailVisibility":false`,
        `"verified":true`,
        `"avatar":""`,
      ],
      notExpectedContent: hiddenFields,
    }),
    authScenario({
      name: "creating user (with mapped OAuth2 fields, case-sensitive username and avatarURL->non-file field)",
      prepare: useProvider(
        (p) => ({
          user: {
            sub: "oauth2_id",
            ...verifiedEmail("oauth2@example.com"),
            preferred_username: "tESt2_username", // wouldn't match with existing because the related field index is case-sensitive
            name: "oauth2_name",
            picture: p.avatarURL, // allowed because it is not being downloaded
          },
        }),
        (collection) => {
          collection.oauth2.mappedFields = new OAuth2KnownFields({
            username: "username",
            avatarURL: "name",
          });
        },
      ),
      expectedStatus: 200,
      expectedContent: [
        `"isNew":true`,
        `"email":"oauth2@example.com"`,
        `"emailVisibility":false`,
        `"username":"tESt2_username"`,
        `"name":"http://127.`,
        `"verified":true`,
        `"avatar":""`,
      ],
      notExpectedContent: hiddenFields,
    }),
    authScenario({
      name: "creating user (with mapped OAuth2 fields and duplicated case-insensitive username)",
      prepare: useProvider(
        {
          user: {
            sub: "oauth2_id",
            ...verifiedEmail("oauth2@example.com"),
            preferred_username: "tESt2_username",
            name: "oauth2_name",
          },
        },
        (collection) => {
          // make the username index case-insensitive to ensure that case-insensitive match is used
          const [index, ok] = findSingleColumnUniqueIndex(collection.indexes, "username");
          if (ok) {
            (index.columns[0] as { collate: string }).collate = "nocase";
            collection.removeIndex(index.indexName);
            collection.indexes.push(index.build());
          }
          collection.oauth2.mappedFields = new OAuth2KnownFields({ username: "username" });
        },
      ),
      expectedStatus: 200,
      expectedContent: [
        `"isNew":true`,
        `"email":"oauth2@example.com"`,
        `"emailVisibility":false`,
        `"verified":true`,
        `"avatar":""`,
        `"username":"users`,
      ],
      notExpectedContent: hiddenFields,
    }),
    authScenario({
      name: "creating user (with mapped OAuth2 fields and username that doesn't match the field validations)",
      prepare: useProvider(
        {
          user: {
            sub: "oauth2_id",
            ...verifiedEmail("oauth2@example.com"),
            preferred_username: "!@invalid",
            name: "oauth2_name",
          },
        },
        (collection) => {
          collection.oauth2.mappedFields = new OAuth2KnownFields({ username: "username" });
        },
      ),
      expectedStatus: 200,
      expectedContent: [
        `"isNew":true`,
        `"email":"oauth2@example.com"`,
        `"emailVisibility":false`,
        `"verified":true`,
        `"avatar":""`,
        `"username":"users`,
      ],
      notExpectedContent: hiddenFields,
    }),

    // rate limit checks
    // -----------------------------------------------------------
    rateLimits("RateLimit rule - users:authWithOAuth2", [
      { maxRequests: 100, label: "abc" },
      { maxRequests: 100, label: "*:authWithOAuth2" },
      { maxRequests: 100, label: "users:auth" },
      { maxRequests: 0, label: "users:authWithOAuth2" },
    ]),
    rateLimits("RateLimit rule - *:authWithOAuth2", [
      { maxRequests: 100, label: "abc" },
      { maxRequests: 100, label: "*:auth" },
      { maxRequests: 0, label: "*:authWithOAuth2" },
    ]),
    rateLimits("RateLimit tag - users:auth", [
      { maxRequests: 100, label: "abc" },
      { maxRequests: 100, label: "*:authWithOAuth2" },
      { maxRequests: 0, label: "users:auth" },
    ]),
    rateLimits("RateLimit tag - *:auth", [
      { maxRequests: 100, label: "abc" },
      { maxRequests: 0, label: "*:auth" },
    ]),
  ],
};

// the fixture's password no longer works
export function passwordChanged(recordId: string) {
  return async (ctx: AfterContext): Promise<void> => {
    try {
      await passwordIs("users", recordId, pw)(ctx);
    } catch {
      return;
    }
    throw new Error(`expected password ${pw} to be changed`);
  };
}

// passwordIs for the record found by its username
function passwordByUsername(username: string, password: string) {
  return async (ctx: AfterContext): Promise<void> => {
    const [row] = queryRows(ctx.dataDir, "SELECT id FROM users WHERE username = ?", username) as {
      id: string;
    }[];
    if (row === undefined) {
      throw new Error(`missing user ${username}`);
    }
    await passwordIs("users", row.id, password)(ctx);
  };
}
