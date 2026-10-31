// More OAuth2 cases (oauth2.test.ts), beyond upstream's
// apis/record_auth_with_oauth2_test.go scenarios. Each case is a scenario:
// both servers start on copies of the prepared fixture, sign in through the
// real OIDC provider against the local mock on 127.0.0.1
// (test/support/oauth2-mock.ts), upstream must meet the expectations and
// iglo.base must answer like upstream (test/differential/harness/compare.ts).

import { generateKeyPairSync, sign } from "node:crypto";
import { Database } from "bun:sqlite";
import { join } from "node:path";

import { OAuth2KnownFields } from "@/collections/collection-model-auth-options";

import { insertExternalAuth } from "@test/scenarios/record-auth-prepare";
import {
  all,
  authScenario,
  type PrepareStep,
  passwordChanged,
  type ProviderSpec,
  useProvider,
  user1Id,
  user2Id,
  usersId,
  verifiedEmail,
} from "@test/scenarios/record-auth-oauth2";
import {
  authOriginsCount,
  checks,
  externalAuthsCount,
  passwordIs,
  queryRows,
  rowHas,
} from "@test/scenarios/record-checks";
import { clientsToken, superuserToken, usersToken } from "@test/scenarios/record-crud";
import type { AfterContext, Scenario } from "@test/scenarios/scenario";
import type { MockProvider, MockRequest } from "@test/support/oauth2-mock";

const body = (extra: { [key: string]: unknown } = {}): string =>
  JSON.stringify({ provider: "oidc", code: "123", redirectURL: "https://example.com", ...extra });

const verified = (email: string, sub = "test_id"): { user: unknown } => ({
  user: { sub, ...verifiedEmail(email) },
});

const b64url = (value: string | Uint8Array): string => Buffer.from(value).toString("base64url");

// an unsigned-for-our-purposes id_token (the signature is checked only with a jwksURL)
function jwt(claims: { [key: string]: unknown }, header: { [key: string]: unknown } = {}): string {
  return [
    b64url(JSON.stringify({ alg: "HS256", ...header })),
    b64url(JSON.stringify(claims)),
    b64url("signature"),
  ].join(".");
}

const now = (): number => Math.floor(Date.now() / 1000);
const idTokenClaims = (): { [key: string]: unknown } => ({
  sub: "id_token_user",
  aud: "123",
  exp: now() + 3600,
  iat: now() - 10,
  name: "from id_token",
  ...verifiedEmail("id_token@example.com"),
});

// the provider reads the id_token: no userInfoURL
function idTokenProvider(
  idToken: () => unknown,
  extra?: { [key: string]: unknown },
  spec: (p: MockProvider) => ProviderSpec = () => ({}),
): PrepareStep {
  let current: MockProvider;
  return useProvider(
    (p) => {
      const base = spec(p as MockProvider);
      return {
        ...(base as object),
        token: { access_token: "abc", id_token: idToken() },
      };
    },
    (collection, provider) => {
      current = provider;
      const config = collection.oauth2.providers?.[0];
      if (config !== undefined) {
        config.userInfoURL = "";
        config.extra = extra === undefined ? null : extraOf(extra, current);
      }
    },
  );
}

function extraOf(extra: { [key: string]: unknown }, p: MockProvider): { [key: string]: unknown } {
  return { ...extra, ...(extra["jwksURL"] === "mock" ? { jwksURL: p.jwksURL } : {}) };
}

// the requests a provider got from the server, of one endpoint
const requestsTo = (provider: MockProvider, path: string): MockRequest[] =>
  provider.requests.filter((r) => r.path === path);

const newUserContent = [`"record":{`, `"token":"`, `"meta":{`, `"isNew":true`];
const linkedContent = [`"record":{`, `"token":"`, `"meta":{`, `"isNew":false`];

function linkRow(providerId: string) {
  return async ({ dataDir }: AfterContext): Promise<void> => {
    const rows = queryRows(
      dataDir,
      `SELECT r.id FROM _externalAuths e JOIN users r ON r.id = e.recordRef
       WHERE e.collectionRef = '${usersId}' AND e.provider = 'oidc' AND e.providerId = ?`,
      providerId,
    );
    if (rows.length !== 1) {
      throw new Error(`expected one link of ${providerId} to a user, got ${rows.length}`);
    }
  };
}

function noUser(email: string) {
  return async ({ dataDir }: AfterContext): Promise<void> => {
    if (queryRows(dataDir, "SELECT id FROM users WHERE email = ?", email).length !== 0) {
      throw new Error(`expected no user ${email}`);
    }
  };
}

function noLink(providerId: string) {
  return async ({ dataDir }: AfterContext): Promise<void> => {
    const rows = queryRows(
      dataDir,
      "SELECT id FROM _externalAuths WHERE provider = 'oidc' AND providerId = ?",
      providerId,
    );
    if (rows.length !== 0) {
      throw new Error(`expected no link of ${providerId}`);
    }
  };
}

function mfaRows(n: number) {
  return async ({ dataDir }: AfterContext): Promise<void> => {
    const rows = queryRows(dataDir, "SELECT id FROM _mfas WHERE method = 'oauth2'");
    if (rows.length !== n) {
      throw new Error(`expected ${n} oauth2 mfas, got ${rows.length}`);
    }
  };
}

function signingKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const signed = (claims: { [key: string]: unknown }): string => {
    const head = `${b64url(JSON.stringify({ alg: "RS256", kid: "key1" }))}.${b64url(JSON.stringify(claims))}`;
    return `${head}.${b64url(sign("sha256", Buffer.from(head), privateKey))}`;
  };
  return { jwks: { keys: [{ ...jwk, kid: "key1", alg: "RS256", use: "sig" }] }, signed };
}

export function oauth2Cases(): Scenario[] {
  let provider: MockProvider;
  const capture = (p: MockProvider): void => {
    provider = p;
  };
  const keys = signingKeys();

  return [
    // new users
    // -----------------------------------------------------------
    authScenario({
      name: "new user with a verified provider email",
      prepare: useProvider(verified("new@example.com", "new_id")),
      expectedStatus: 200,
      expectedContent: [...newUserContent, `"email":"new@example.com"`, `"verified":true`],
      after: checks(linkRow("new_id"), async ({ dataDir }) => {
        const [row] = queryRows(
          dataDir,
          "SELECT verified, tokenKey FROM users WHERE email = ?",
          "new@example.com",
        ) as { verified: number; tokenKey: string }[];
        if (row?.verified !== 1 || row.tokenKey === "") {
          throw new Error(`unexpected row ${JSON.stringify(row)}`);
        }
      }),
    }),
    authScenario({
      name: "a provider without a verified email creates a user without email",
      prepare: useProvider({
        user: { sub: "no_email", email: "unverified@example.com", email_verified: false },
      }),
      expectedStatus: 200,
      expectedContent: [...newUserContent, `"email":""`, `"verified":true`],
      after: checks(noUser("unverified@example.com"), linkRow("no_email")),
    }),
    authScenario({
      name: `email_verified as the string "true"`,
      prepare: useProvider({
        user: { sub: "s1", email: "string@example.com", email_verified: "true" },
      }),
      expectedStatus: 200,
      expectedContent: [...newUserContent, `"email":"string@example.com"`],
    }),
    authScenario({
      name: `email_verified as the string "no" counts as false`,
      prepare: useProvider({
        user: { sub: "s2", email: "string@example.com", email_verified: "no" },
      }),
      expectedStatus: 200,
      expectedContent: [...newUserContent, `"email":""`],
    }),
    authScenario({
      name: "email_verified as a number",
      prepare: useProvider({ user: { sub: "s3", email: "num@example.com", email_verified: 1 } }),
      expectedStatus: 200,
      expectedContent: [...newUserContent, `"email":"num@example.com"`],
    }),
    authScenario({
      name: "mapped id, name and username fields",
      prepare: useProvider(
        {
          user: {
            sub: "mapped_sub",
            name: "Mapped Name",
            preferred_username: "mapped_username",
            ...verifiedEmail("mapped@example.com"),
          },
        },
        (collection) => {
          collection.oauth2.mappedFields = new OAuth2KnownFields({
            name: "name",
            username: "username",
          });
        },
      ),
      expectedStatus: 200,
      expectedContent: [...newUserContent, `"name":"Mapped Name"`, `"username":"mapped_username"`],
    }),
    authScenario({
      name: "a mapped username that is taken gets an autogenerated one",
      prepare: useProvider(
        {
          user: {
            sub: "taken",
            preferred_username: "users75657",
            ...verifiedEmail("taken@example.com"),
          },
        },
        (collection) => {
          collection.oauth2.mappedFields = new OAuth2KnownFields({ username: "username" });
        },
      ),
      expectedStatus: 200,
      expectedContent: [...newUserContent, `"username":"users`],
    }),
    authScenario({
      name: "a taken username in createData is a validation error and nothing is stored",
      body: body({ createData: { username: "users75657" } }),
      prepare: useProvider(verified("creator@example.com", "creator")),
      expectedStatus: 400,
      expectedContent: [`"username":{"code":"validation_not_unique"`],
      after: checks(noUser("creator@example.com"), noLink("creator")),
    }),
    authScenario({
      name: "createData with a taken email is a validation error",
      body: body({ createData: { email: "test2@example.com" } }),
      prepare: useProvider({ user: { sub: "dup_email" } }),
      expectedStatus: 400,
      expectedContent: [`"email":{"code":"validation_not_unique"`],
      after: noLink("dup_email"),
    }),
    authScenario({
      name: "createData that is not an object",
      body: body({ createData: "text" }),
      prepare: useProvider(),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    }),
    authScenario({
      name: "createData null",
      body: body({ createData: null }),
      prepare: useProvider({ user: { sub: "null_data" } }),
      expectedStatus: 200,
      expectedContent: newUserContent,
    }),
    authScenario({
      name: "a non-string createData email takes the provider's",
      body: body({ createData: { email: 123 } }),
      prepare: useProvider(verified("provider@example.com", "email_type")),
      expectedStatus: 200,
      expectedContent: [...newUserContent, `"email":"provider@example.com"`, `"verified":true`],
    }),
    authScenario({
      name: "a rejected password in createData",
      body: body({ createData: { password: "1", passwordConfirm: "2" } }),
      prepare: useProvider({ user: { sub: "weak" } }),
      expectedStatus: 400,
      expectedContent: [`"passwordConfirm":{"code":"validation_values_mismatch"`],
      after: noLink("weak"),
    }),

    // create rule
    // -----------------------------------------------------------
    authScenario({
      name: "signup disabled by the create rule",
      prepare: useProvider(verified("norule@example.com", "norule"), (collection) => {
        collection.createRule = null;
      }),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
      after: checks(noUser("norule@example.com"), noLink("norule")),
    }),
    authScenario({
      name: "a create rule that fails",
      prepare: useProvider(verified("rule@example.com", "rule"), (collection) => {
        collection.createRule = `@request.body.name = "never"`;
      }),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
      after: noLink("rule"),
    }),
    authScenario({
      name: "a create rule on the request context and the provider's email",
      prepare: useProvider(verified("ctx@example.com", "ctx"), (collection) => {
        collection.createRule = `@request.context = "oauth2" && @request.body.email:isset = true`;
      }),
      expectedStatus: 200,
      expectedContent: [...newUserContent, `"email":"ctx@example.com"`],
    }),
    authScenario({
      name: "signup disabled does not stop an existing user",
      prepare: useProvider(verified("test2@example.com"), (collection) => {
        collection.createRule = null;
      }),
      expectedStatus: 200,
      expectedContent: [...linkedContent, `"id":"${user2Id}"`],
    }),

    // existing users
    // -----------------------------------------------------------
    authScenario({
      name: "a verified user's existing link keeps the other links and the password",
      prepare: all(
        useProvider(verified("other@example.com", "linked_id")),
        insertExternalAuth("users", "test2@example.com", "oidc", "linked_id"),
      ),
      expectedStatus: 200,
      expectedContent: [...linkedContent, `"id":"${user2Id}"`, `"email":"test2@example.com"`],
      after: checks(
        passwordIs("users", user2Id, "1234567890"),
        externalAuthsCount(usersId, user2Id, 1),
      ),
    }),
    authScenario({
      name: "an email match of an unverified user resets its password and links",
      prepare: useProvider(verified("test@example.com", "guard")),
      expectedStatus: 200,
      expectedContent: [...linkedContent, `"verified":true`],
      after: checks(
        passwordChanged(user1Id),
        externalAuthsCount(usersId, user1Id, 1),
        linkRow("guard"),
        rowHas("users", user1Id, { verified: 1 }),
      ),
    }),
    authScenario({
      name: "a logged in unverified user keeps its password on a matching link",
      headers: { Authorization: usersToken },
      prepare: useProvider(verified("test@example.com", "own")),
      expectedStatus: 200,
      expectedContent: [...linkedContent, `"verified":true`],
      after: passwordIs("users", user1Id, "1234567890"),
    }),
    authScenario({
      name: "an auth token of another collection is no fallback",
      headers: { Authorization: clientsToken },
      prepare: useProvider({ user: { sub: "fresh" } }),
      expectedStatus: 200,
      expectedContent: newUserContent,
    }),
    authScenario({
      name: "a superuser token is no fallback, and sees the new record's fields",
      headers: { Authorization: superuserToken },
      prepare: useProvider({ user: { sub: "by_superuser" } }),
      expectedStatus: 200,
      expectedContent: newUserContent,
    }),
    authScenario({
      name: "a link to a missing record",
      prepare: all(useProvider({ user: { sub: "dangling" } }), ({ dataDir }) => {
        const db = new Database(join(dataDir, "data.db"));
        try {
          db.run("PRAGMA foreign_keys = OFF");
          db.run(
            `INSERT INTO _externalAuths (id, collectionRef, recordRef, provider, providerId, created, updated)
             VALUES ('danglinglink123', '${usersId}', 'missing12345678', 'oidc', 'dangling',
                     '2024-01-01 00:00:00.000Z', '2024-01-01 00:00:00.000Z')`,
          );
        } finally {
          db.close();
        }
      }),
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    }),
    authScenario({
      name: "an empty provider id never matches a stored link and is refused",
      prepare: all(useProvider(verified("atomic@example.com", "")), ({ dataDir }) => {
        const db = new Database(join(dataDir, "data.db"));
        try {
          db.run(
            `UPDATE _externalAuths SET provider = 'oidc', providerId = '' WHERE id = 'clmflokuq1xl341'`,
          );
        } finally {
          db.close();
        }
      }),
      expectedStatus: 400,
      expectedContent: [`"providerId":{"code":"validation_required"`],
      // the record create and the link are all or nothing
      after: noUser("atomic@example.com"),
    }),

    // auth rule, MFA, superusers
    // -----------------------------------------------------------
    authScenario({
      name: "the request context in the auth rule",
      prepare: useProvider(verified("test2@example.com"), (collection) => {
        collection.authRule = `@request.context = "oauth2"`;
      }),
      expectedStatus: 200,
      expectedContent: linkedContent,
    }),
    authScenario({
      name: "an auth rule that refuses, after the record and the link were saved",
      prepare: useProvider(verified("refused@example.com", "refused"), (collection) => {
        collection.authRule = `verified = false`;
      }),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
      after: linkRow("refused"),
    }),
    authScenario({
      name: "MFA on an existing user answers with an mfaId and stores the link",
      prepare: useProvider(verified("test2@example.com", "mfa_link"), (collection) => {
        collection.mfa.enabled = true;
        collection.mfa.rule = "";
      }),
      expectedStatus: 401,
      expectedContent: [`"mfaId":"`],
      after: checks(linkRow("mfa_link"), mfaRows(1)),
    }),
    authScenario({
      name: "MFA on a new user",
      prepare: useProvider(verified("mfa@example.com", "mfa_new"), (collection) => {
        collection.mfa.enabled = true;
        collection.mfa.rule = "";
      }),
      expectedStatus: 401,
      expectedContent: [`"mfaId":"`],
      after: checks(linkRow("mfa_new"), mfaRows(1)),
    }),
    authScenario({
      name: "an MFA rule that does not match",
      prepare: useProvider(verified("test2@example.com"), (collection) => {
        collection.mfa.enabled = true;
        collection.mfa.rule = `email = "nobody@example.com"`;
      }),
      expectedStatus: 200,
      expectedContent: linkedContent,
    }),
    {
      name: "superusers are refused",
      method: "POST",
      url: "/api/collections/_superusers/auth-with-oauth2",
      body: body(),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },

    // providers
    // -----------------------------------------------------------
    authScenario({
      name: "a disabled provider",
      body: body({ provider: "github" }),
      prepare: useProvider(),
      expectedStatus: 400,
      expectedContent: [`"provider":{"code":"validation_invalid_provider"`, "github"],
    }),
    authScenario({
      name: "an unknown provider",
      body: body({ provider: "nope" }),
      prepare: useProvider(),
      expectedStatus: 400,
      expectedContent: [`"provider":{"code":"validation_invalid_provider"`, "nope"],
    }),
    authScenario({
      name: "a provider name over 100 characters",
      body: body({ provider: "a".repeat(101) }),
      prepare: useProvider(),
      expectedStatus: 400,
      expectedContent: [`"provider":{"code":"validation_length_too_long"`],
    }),
    authScenario({
      name: "a missing code",
      body: JSON.stringify({ provider: "oidc" }),
      prepare: useProvider(),
      expectedStatus: 400,
      expectedContent: [`"code":{"code":"validation_required"`],
    }),
    authScenario({
      name: "OAuth2 enabled without the provider's token url",
      prepare: useProvider({}, (collection) => {
        const config = collection.oauth2.providers?.[0];
        if (config !== undefined) {
          config.tokenURL = "";
        }
      }),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    }),

    // the token endpoint
    // -----------------------------------------------------------
    authScenario({
      name: "a failing token endpoint",
      prepare: useProvider({ tokenStatus: 500, token: "oops" }),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to fetch OAuth2 token."`, `"data":{}`],
    }),
    authScenario({
      name: "a token error with status 200",
      prepare: useProvider({ token: { error: "invalid_grant" } }),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to fetch OAuth2 token."`],
    }),
    authScenario({
      name: "a token response without access_token",
      prepare: useProvider({ token: { token_type: "bearer" } }),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to fetch OAuth2 token."`],
    }),
    authScenario({
      name: "a token response that is not JSON",
      prepare: useProvider({ token: "<html>" }),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to fetch OAuth2 token."`],
    }),
    authScenario({
      name: "a form-encoded token response",
      prepare: useProvider({
        token: "access_token=abc&token_type=bearer&refresh_token=def",
        tokenContentType: "application/x-www-form-urlencoded",
        user: { sub: "form_token" },
      }),
      expectedStatus: 200,
      expectedContent: [...newUserContent, `"accessToken":"abc"`, `"refreshToken":"def"`],
    }),
    authScenario({
      name: "a text/plain token response with parameters in its type",
      prepare: useProvider({
        token: "access_token=abc",
        tokenContentType: "text/plain; charset=utf-8",
        user: { sub: "text_token" },
      }),
      expectedStatus: 200,
      expectedContent: [...newUserContent, `"accessToken":"abc"`],
    }),
    authScenario({
      name: "the expiry in meta from a numeric expires_in",
      prepare: useProvider({
        token: { access_token: "abc", expires_in: 3600 },
        user: { sub: "expiring" },
      }),
      expectedStatus: 200,
      expectedContent: [...newUserContent, `"expiry":"20`],
    }),
    authScenario({
      name: "the expiry in meta from a string expires_in",
      prepare: useProvider({
        token: { access_token: "abc", expires_in: "3600" },
        user: { sub: "expiring2" },
      }),
      expectedStatus: 200,
      expectedContent: [...newUserContent, `"expiry":"20`],
    }),
    authScenario({
      name: "an expires_in that is no number",
      prepare: useProvider({ token: { access_token: "abc", expires_in: "soon" } }),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to fetch OAuth2 token."`],
    }),
    authScenario({
      name: "an expired access token is refreshed for the user info",
      prepare: useProvider(
        {
          token: { access_token: "old", refresh_token: "ref", expires_in: 5 },
          refreshedToken: { access_token: "new", expires_in: 3600 },
          user: { sub: "refreshed" },
        },
        undefined,
        "users",
        capture,
      ),
      expectedStatus: 200,
      expectedContent: [...newUserContent, `"accessToken":"old"`, `"refreshToken":"ref"`],
      after: async () => {
        const auth = requestsTo(provider, "/userinfo").map((r) => r.authorization);
        if (auth.length === 0 || !auth.every((v) => v === "Bearer new")) {
          throw new Error(`unexpected userinfo auth ${JSON.stringify(auth)}`);
        }
      },
    }),
    authScenario({
      name: "an expired access token without a refresh token",
      prepare: useProvider({ token: { access_token: "old", expires_in: 5 } }),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to fetch OAuth2 user."`],
    }),
    authScenario({
      name: "the token request: credentials, code, verifier and redirect url",
      body: body({ codeVerifier: "verifier", redirectURL: "https://example.com/cb?a=b c" }),
      prepare: useProvider({ user: { sub: "shape" } }, undefined, "users", capture),
      expectedStatus: 200,
      expectedContent: newUserContent,
      after: async () => {
        const first = requestsTo(provider, "/token")[0];
        if (
          first?.authorization !== `Basic ${btoa("123:456")}` ||
          first.contentType !== "application/x-www-form-urlencoded" ||
          first.body !==
            "code=123&code_verifier=verifier&grant_type=authorization_code&redirect_uri=https%3A%2F%2Fexample.com%2Fcb%3Fa%3Db+c"
        ) {
          throw new Error(`unexpected token request ${JSON.stringify(first)}`);
        }
      },
    }),
    authScenario({
      name: "the credentials in the form body after the header failed",
      prepare: useProvider(
        { rejectBasicAuth: true, user: { sub: "params" } },
        undefined,
        "users",
        capture,
      ),
      expectedStatus: 200,
      expectedContent: newUserContent,
      after: async () => {
        const bodies = requestsTo(provider, "/token")
          .filter((r) => r.authorization === "")
          .map((r) => r.body);
        const expected =
          "client_id=123&client_secret=456&code=123&code_verifier=&grant_type=authorization_code&redirect_uri=https%3A%2F%2Fexample.com";
        if (bodies.length === 0 || !bodies.every((v) => v === expected)) {
          throw new Error(`unexpected form bodies ${JSON.stringify(bodies)}`);
        }
      },
    }),
    authScenario({
      name: "a wrong codeVerifier",
      body: body({ codeVerifier: "wrong" }),
      prepare: useProvider({ codeVerifier: "right" }),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to fetch OAuth2 token."`],
    }),
    authScenario({
      name: "the right codeVerifier",
      body: body({ codeVerifier: "right" }),
      prepare: useProvider({ codeVerifier: "right", user: { sub: "pkce" } }),
      expectedStatus: 200,
      expectedContent: newUserContent,
    }),
    authScenario({
      name: "PKCE turned off sends no code_verifier",
      body: body({ codeVerifier: "unused" }),
      prepare: useProvider(
        { user: { sub: "no_pkce" } },
        (collection) => {
          const config = collection.oauth2.providers?.[0];
          if (config !== undefined) {
            config.pkce = false;
          }
        },
        "users",
        capture,
      ),
      expectedStatus: 200,
      expectedContent: newUserContent,
      after: async () => {
        if (requestsTo(provider, "/token").some((r) => r.body.includes("code_verifier"))) {
          throw new Error("expected no code_verifier");
        }
      },
    }),
    authScenario({
      name: "the deprecated redirectUrl field",
      body: JSON.stringify({ provider: "oidc", code: "123", redirectUrl: "https://old.example" }),
      prepare: useProvider({ user: { sub: "old_field" } }, undefined, "users", capture),
      expectedStatus: 200,
      expectedContent: newUserContent,
      after: async () => {
        if (!requestsTo(provider, "/token")[0]?.body.includes("redirect_uri=https%3A%2F%2Fold")) {
          throw new Error("expected the redirect_uri");
        }
      },
    }),
    authScenario({
      name: "a token type other than bearer",
      prepare: useProvider(
        { token: { access_token: "abc", token_type: "MAC" }, user: { sub: "mac" } },
        undefined,
        "users",
        capture,
      ),
      expectedStatus: 200,
      expectedContent: newUserContent,
      after: async () => {
        if (requestsTo(provider, "/userinfo")[0]?.authorization !== "MAC abc") {
          throw new Error("expected the MAC scheme");
        }
      },
    }),

    // the user info endpoint
    // -----------------------------------------------------------
    authScenario({
      name: "a failing userinfo endpoint",
      prepare: useProvider({ userStatus: 500, user: "oops" }),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to fetch OAuth2 user."`, `"data":{}`],
    }),
    authScenario({
      name: "userinfo that is not JSON",
      prepare: useProvider({ user: "<html>" }),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to fetch OAuth2 user."`],
    }),
    authScenario({
      name: "userinfo with a numeric sub",
      prepare: useProvider({ user: { sub: 123 } }),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to fetch OAuth2 user."`],
    }),
    authScenario({
      name: "userinfo with duplicate names",
      prepare: useProvider({ user: `{"sub":"a","sub":"b"}` }),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to fetch OAuth2 user."`],
    }),
    authScenario({
      name: "userinfo that is an array",
      prepare: useProvider({ user: `[]` }),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to fetch OAuth2 user."`],
    }),
    authScenario({
      name: "the raw user in meta",
      prepare: useProvider({
        user: `{"sub":"raw","big":12345678901234567890,"nested":{"b":[1,null,"x"],"a":true},"é":"ü<>&"}`,
      }),
      expectedStatus: 200,
      expectedContent: [...newUserContent, `"rawUser":{`, `"nested":{`, `"avatarUrl":""`],
    }),

    // the id_token
    // -----------------------------------------------------------
    authScenario({
      name: "the user from the id_token",
      prepare: idTokenProvider(() => jwt(idTokenClaims())),
      expectedStatus: 200,
      expectedContent: [...newUserContent, `"name":"from id_token"`, `"id":"id_token_user"`],
    }),
    authScenario({
      name: "no id_token and no userInfoURL",
      prepare: idTokenProvider(() => ""),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to fetch OAuth2 user."`],
    }),
    authScenario({
      name: "an id_token for another audience",
      prepare: idTokenProvider(() => jwt({ ...idTokenClaims(), aud: "other" })),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to fetch OAuth2 user."`],
    }),
    authScenario({
      name: "an id_token with a list of audiences",
      prepare: idTokenProvider(() => jwt({ ...idTokenClaims(), aud: ["other", "123"] })),
      expectedStatus: 200,
      expectedContent: newUserContent,
    }),
    authScenario({
      name: "an id_token without an audience",
      prepare: idTokenProvider(() => {
        const { aud: _, ...claims } = idTokenClaims();
        return jwt(claims);
      }),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to fetch OAuth2 user."`],
    }),
    authScenario({
      name: "an id_token expired within the leeway",
      prepare: idTokenProvider(() => jwt({ ...idTokenClaims(), exp: now() - 60 })),
      expectedStatus: 200,
      expectedContent: newUserContent,
    }),
    authScenario({
      name: "an id_token expired past the leeway",
      prepare: idTokenProvider(() => jwt({ ...idTokenClaims(), exp: now() - 3600 })),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to fetch OAuth2 user."`],
    }),
    authScenario({
      name: "an id_token issued in the future, past the leeway",
      prepare: idTokenProvider(() => jwt({ ...idTokenClaims(), iat: now() + 3600 })),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to fetch OAuth2 user."`],
    }),
    authScenario({
      name: "an id_token with an unknown alg",
      prepare: idTokenProvider(() => jwt(idTokenClaims(), { alg: "XX1" })),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to fetch OAuth2 user."`],
    }),
    authScenario({
      name: "an id_token from an allowed issuer",
      prepare: idTokenProvider(() => jwt({ ...idTokenClaims(), iss: "https://b.example" }), {
        issuers: ["https://a.example", "https://b.example"],
      }),
      expectedStatus: 200,
      expectedContent: newUserContent,
    }),
    authScenario({
      name: "an id_token from another issuer",
      prepare: idTokenProvider(() => jwt({ ...idTokenClaims(), iss: "https://c.example" }), {
        issuers: ["https://a.example"],
      }),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to fetch OAuth2 user."`],
    }),
    authScenario({
      name: "an id_token signed with a key of the JWKS",
      prepare: idTokenProvider(
        () => keys.signed(idTokenClaims()),
        { jwksURL: "mock" },
        () => ({ jwks: keys.jwks }),
      ),
      expectedStatus: 200,
      expectedContent: newUserContent,
    }),
    authScenario({
      name: "an id_token with a bad signature",
      prepare: idTokenProvider(
        () => `${keys.signed(idTokenClaims()).slice(0, -8)}AAAAAAAA`,
        { jwksURL: "mock" },
        () => ({ jwks: keys.jwks }),
      ),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to fetch OAuth2 user."`],
    }),
    authScenario({
      name: "an id_token signed with a key outside the JWKS",
      prepare: idTokenProvider(
        () => signingKeys().signed(idTokenClaims()),
        { jwksURL: "mock" },
        () => ({ jwks: keys.jwks }),
      ),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to fetch OAuth2 user."`],
    }),
    authScenario({
      name: "an id_token within the leeway fails the signature's own expiry check",
      prepare: idTokenProvider(
        () => keys.signed({ ...idTokenClaims(), exp: now() - 60 }),
        { jwksURL: "mock" },
        () => ({ jwks: keys.jwks }),
      ),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to fetch OAuth2 user."`],
    }),

    // the auth methods of the ported provider
    // -----------------------------------------------------------
    {
      name: "auth methods with the oidc provider",
      method: "GET",
      url: "/api/collections/users/auth-methods",
      prepare: useProvider({}, (collection, p) => {
        const config = collection.oauth2.providers?.[0];
        if (config !== undefined) {
          config.authURL = p.authURL;
          config.displayName = "My OIDC";
        }
      }),
      expectedStatus: 200,
      expectedContent: [`"name":"oidc"`, `"displayName":"My OIDC"`, `"codeChallengeMethod":"S256"`],
    },
    {
      name: "auth methods with PKCE turned off",
      method: "GET",
      url: "/api/collections/users/auth-methods",
      prepare: useProvider({}, (collection, p) => {
        const config = collection.oauth2.providers?.[0];
        if (config !== undefined) {
          config.authURL = p.authURL;
          config.pkce = false;
        }
      }),
      expectedStatus: 200,
      expectedContent: [`"name":"oidc"`, `"codeVerifier":""`],
    },

    // the request
    // -----------------------------------------------------------
    {
      name: "form-encoded request",
      method: "POST",
      url: "/api/collections/users/auth-with-oauth2",
      body: "provider=oidc&code=123&redirectURL=https%3A%2F%2Fexample.com",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      prepare: useProvider({ user: { sub: "form" } }),
      expectedStatus: 200,
      expectedContent: newUserContent,
    },
    authScenario({
      name: "expand and fields on the response",
      prepare: useProvider({ user: { sub: "fields" } }),
      url: "/api/collections/users/auth-with-oauth2?fields=meta.isNew,record.verified",
      expectedStatus: 200,
      expectedContent: [`"isNew":true`, `"verified":true`],
      notExpectedContent: [`"accessToken"`, `"token"`],
    } as Omit<Scenario, "method" | "body">),
    authScenario({
      name: "another collection, where only superusers can create",
      prepare: useProvider({ user: { sub: "client" } }, undefined, "clients"),
      url: "/api/collections/clients/auth-with-oauth2",
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    } as Omit<Scenario, "method" | "body">),
    authScenario({
      name: "the auth origin of a new user",
      prepare: useProvider(verified("origin@example.com", "origin")),
      expectedStatus: 200,
      expectedContent: newUserContent,
      after: async (ctx) => {
        const [row] = queryRows(
          ctx.dataDir,
          "SELECT id FROM users WHERE email = ?",
          "origin@example.com",
        ) as { id: string }[];
        await authOriginsCount(usersId, row?.id ?? "", 1)(ctx);
      },
    }),
  ];
}
