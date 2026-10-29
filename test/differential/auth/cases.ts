// More password auth, refresh, auth methods, impersonate and MFA cases
// (auth.test.ts), beyond upstream's apis/record_auth_*_test.go scenarios.
// Each case is a scenario: both servers start on copies of the prepared
// fixture, upstream must meet the expectations and iglo.base must answer
// like upstream (test/differential/harness/compare.ts).

import { Database } from "bun:sqlite";
import { join } from "node:path";

import { OAuth2ProviderConfig } from "@/collections/collection-model-auth-options";

import { multipart } from "@test/scenarios/multipart";
import { updateCollection } from "@test/scenarios/prepare";
import { insertMFA, mfasCount, setMFA } from "@test/scenarios/record-auth-prepare";
import { queryRows } from "@test/scenarios/record-checks";
import {
  clientsToken,
  nologinToken,
  superuserToken,
  usersToken,
} from "@test/scenarios/record-crud";
import type { PrepareContext, Scenario } from "@test/scenarios/scenario";
import { changeSettings } from "@test/scenarios/settings-prepare";

// tokens made for the cases from the fixture's keys (auth.test.ts)
export interface CaseTokens {
  // users, test@example.com: an auth token that expired
  usersExpired: string;
  // users, test@example.com: a file token
  usersFile: string;
}

const login = (
  collection: string,
  body: unknown,
  query = "",
): Pick<Scenario, "method" | "url" | "body"> => ({
  method: "POST",
  url: `/api/collections/${collection}/auth-with-password${query}`,
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const pw = "1234567890";

// several prepare steps in order
function all(...steps: ((ctx: PrepareContext) => void)[]): (ctx: PrepareContext) => void {
  return (ctx) => {
    for (const step of steps) {
      step(ctx);
    }
  };
}

const usersWithoutMFA = setMFA("users", false, "");

function setAuthRule(collection: string, rule: string | null): (ctx: PrepareContext) => void {
  return ({ dataDir }) =>
    updateCollection(dataDir, collection, (c) => {
      c.authRule = rule;
    });
}

function setIdentityFields(collection: string, ...fields: string[]): (ctx: PrepareContext) => void {
  return ({ dataDir }) =>
    updateCollection(dataDir, collection, (c) => {
      c.passwordAuth.identityFields = fields;
    });
}

// the MFA's created date moved to the past (an expired MFA)
function ageMFA(id: string): (ctx: PrepareContext) => void {
  return ({ dataDir }) => {
    const db = new Database(join(dataDir, "data.db"));
    try {
      db.query(`UPDATE _mfas SET created = '2020-01-01 00:00:00.000Z' WHERE id = ?`).run(id);
    } finally {
      db.close();
    }
  };
}

function mfaRow(id: string, n: number): Scenario["after"] {
  return ({ dataDir }) => {
    const rows = queryRows(dataDir, `SELECT id FROM _mfas WHERE id = ?`, id);
    if (rows.length !== n) {
      return Promise.reject(new Error(`expected ${n} mfa ${id}, got ${rows.length}`));
    }
    return Promise.resolve();
  };
}

const mfaId = "m".repeat(15);

export function authCases(tokens: CaseTokens): Scenario[] {
  const form = multipart({ identity: "test@example.com", password: pw });
  return [
    // identity fields
    // -----------------------------------------------------------
    {
      name: "users: email identity (MFA off)",
      ...login("users", { identity: "test@example.com", password: pw }),
      prepare: usersWithoutMFA,
      expectedStatus: 200,
      expectedContent: [`"email":"test@example.com"`, `"token":`],
    },
    {
      name: "users: username identity (MFA off)",
      ...login("users", { identity: "users75657", password: pw }),
      prepare: usersWithoutMFA,
      expectedStatus: 200,
      expectedContent: [`"username":"users75657"`],
    },
    {
      name: "users: expand in the auth response",
      ...login("users", { identity: "test@example.com", password: pw }, "?expand=rel"),
      prepare: usersWithoutMFA,
      expectedStatus: 200,
      expectedContent: [`"expand":{"rel":`],
    },
    {
      name: "users: fields picker on the auth response",
      ...login("users", { identity: "test@example.com", password: pw }, "?fields=token,record.id"),
      prepare: usersWithoutMFA,
      expectedStatus: 200,
      expectedContent: [`"record":{"id":"4q1xlclmfloku33"}`],
    },
    {
      name: "clients: identityFields [username] rejects an email identity",
      ...login("clients", { identity: "test@example.com", password: pw }),
      prepare: setIdentityFields("clients", "username"),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "clients: identityFields [username, email] tries email first",
      ...login("clients", { identity: "test@example.com", password: pw }),
      prepare: setIdentityFields("clients", "username", "email"),
      expectedStatus: 200,
      expectedContent: [`"email":"test@example.com"`],
    },
    {
      name: "clients: explicit identityField email with a username value",
      ...login("clients", { identityField: "email", identity: "clients57772", password: pw }),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "clients: identityField that is not an identity field",
      ...login("clients", { identityField: "password", identity: "x", password: pw }),
      expectedStatus: 400,
      expectedContent: [`"identityField":{"code":"validation_in_invalid"`],
    },
    {
      name: "clients: identityField over 255 characters",
      ...login("clients", { identityField: "a".repeat(256), identity: "x", password: pw }),
      expectedStatus: 400,
      expectedContent: [`"identityField":{"code":"validation_length_out_of_range"`],
    },
    {
      name: "clients: identity and password over 255 characters",
      ...login("clients", { identity: "é".repeat(256), password: "p".repeat(256) }),
      expectedStatus: 400,
      expectedContent: [`"identity":{"code":"validation_length_out_of_range"`, `"password":{`],
    },
    {
      name: "clients: wrong password",
      ...login("clients", { identity: "clients57772", password: "wrong-password" }),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to authenticate."`],
    },
    {
      name: "clients: unknown identity",
      ...login("clients", { identity: "missing@example.com", password: pw }),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to authenticate."`],
    },
    {
      name: "clients: numeric identity is a body load error",
      ...login("clients", `{"identity":123,"password":"${pw}"}`),
      expectedStatus: 400,
      expectedContent: [`"message":"An error occurred while loading the submitted data."`],
    },
    {
      name: "clients: urlencoded form body",
      method: "POST",
      url: "/api/collections/clients/auth-with-password",
      body: `identity=test%40example.com&password=${pw}`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      expectedStatus: 200,
      expectedContent: [`"email":"test@example.com"`],
    },
    {
      name: "clients: multipart form body",
      method: "POST",
      url: "/api/collections/clients/auth-with-password",
      body: form.body,
      headers: form.headers,
      expectedStatus: 200,
      expectedContent: [`"email":"test@example.com"`],
    },
    {
      name: "missing collection",
      ...login("missing", { identity: "test@example.com", password: pw }),
      expectedStatus: 404,
      expectedContent: [`"message":"Missing or invalid collection context."`],
    },

    // superusers
    // -----------------------------------------------------------
    {
      name: "_superusers: email identity",
      ...login("_superusers", { identity: "test@example.com", password: pw }),
      expectedStatus: 200,
      expectedContent: [`"collectionName":"_superusers"`, `"token":`],
    },
    {
      name: "_superusers: username is not an identity field",
      ...login("_superusers", { identityField: "username", identity: "x", password: pw }),
      expectedStatus: 400,
      expectedContent: [`"identityField":{"code":"validation_in_invalid"`],
    },
    {
      name: "_superusers: login from an IP outside superuserIPs",
      ...login("_superusers", { identity: "test@example.com", password: pw }),
      prepare: ({ dataDir }) =>
        changeSettings(dataDir, (settings) => {
          settings.superuserIPs = ["10.0.0.1"];
        }),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },

    // authRule
    // -----------------------------------------------------------
    {
      name: "users: null authRule (superusers only) as a guest",
      ...login("users", { identity: "test@example.com", password: pw }),
      prepare: all(usersWithoutMFA, setAuthRule("users", null)),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "users: null authRule with a superuser Authorization header",
      ...login("users", { identity: "test@example.com", password: pw }),
      headers: { Authorization: superuserToken },
      prepare: all(usersWithoutMFA, setAuthRule("users", null)),
      expectedStatus: 200,
      expectedContent: [`"email":"test@example.com"`],
    },
    {
      name: "users: authRule on the password auth request context",
      ...login("users", { identity: "test@example.com", password: pw }),
      prepare: all(usersWithoutMFA, setAuthRule("users", `@request.context = "password"`)),
      expectedStatus: 200,
      expectedContent: [`"email":"test@example.com"`],
    },
    {
      name: "users: authRule on another request context",
      ...login("users", { identity: "test@example.com", password: pw }),
      prepare: all(usersWithoutMFA, setAuthRule("users", `@request.context = "oauth2"`)),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "users: authRule on a record field (verified, onlyVerified style)",
      ...login("users", { identity: "test@example.com", password: pw }),
      prepare: all(usersWithoutMFA, setAuthRule("users", "verified = true")),
      expectedStatus: 403,
      expectedContent: [
        `"message":"The request doesn't satisfy the collection requirements to authenticate."`,
      ],
    },

    // refresh
    // -----------------------------------------------------------
    {
      name: "refresh: missing collection without a token",
      method: "POST",
      url: "/api/collections/missing/auth-refresh",
      expectedStatus: 404,
      expectedContent: [`"message":"Missing or invalid collection context."`],
    },
    {
      name: "refresh: expired token",
      method: "POST",
      url: "/api/collections/users/auth-refresh",
      headers: { Authorization: tokens.usersExpired },
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "refresh: file token",
      method: "POST",
      url: "/api/collections/users/auth-refresh",
      headers: { Authorization: tokens.usersFile },
      expectedStatus: 401,
      expectedContent: [`"data":{}`],
    },
    {
      name: "refresh: Bearer prefix",
      method: "POST",
      url: "/api/collections/users/auth-refresh",
      headers: { Authorization: "Bearer " + usersToken },
      expectedStatus: 200,
      expectedContent: [`"id":"4q1xlclmfloku33"`],
      notExpectedContent: [usersToken],
    },
    {
      name: "refresh: nologin token (password auth disabled)",
      method: "POST",
      url: "/api/collections/nologin/auth-refresh",
      headers: { Authorization: nologinToken },
      expectedStatus: 200,
      expectedContent: [`"collectionName":"nologin"`],
    },
    {
      name: "refresh: clients token on users",
      method: "POST",
      url: "/api/collections/users/auth-refresh",
      headers: { Authorization: clientsToken },
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "refresh: superuser token on _superusers",
      method: "POST",
      url: "/api/collections/_superusers/auth-refresh",
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [`"collectionName":"_superusers"`],
    },
    {
      name: "refresh: MFA-enabled users are not asked for MFA",
      method: "POST",
      url: "/api/collections/users/auth-refresh",
      headers: { Authorization: usersToken },
      expectedStatus: 200,
      expectedContent: [`"token":`],
      after: mfasCount("_pb_users_auth_", "4q1xlclmfloku33", 0),
    },

    // impersonate
    // -----------------------------------------------------------
    {
      name: "impersonate: zero duration (the collection's)",
      method: "POST",
      url: "/api/collections/users/impersonate/4q1xlclmfloku33",
      headers: { Authorization: superuserToken },
      body: `{"duration":0}`,
      expectedStatus: 200,
      expectedContent: [`"token":"`],
    },
    {
      name: "impersonate: duration past int64 nanoseconds",
      method: "POST",
      url: "/api/collections/users/impersonate/4q1xlclmfloku33",
      headers: { Authorization: superuserToken },
      body: `{"duration":9999999999}`,
      expectedStatus: 200,
      expectedContent: [`"token":"`],
    },
    {
      name: "impersonate: string duration",
      method: "POST",
      url: "/api/collections/users/impersonate/4q1xlclmfloku33",
      headers: { Authorization: superuserToken },
      body: `{"duration":"100"}`,
      expectedStatus: 400,
      expectedContent: [`"message":"An error occurred while loading the submitted data."`],
    },
    {
      name: "impersonate: urlencoded duration",
      method: "POST",
      url: "/api/collections/users/impersonate/4q1xlclmfloku33",
      headers: {
        Authorization: superuserToken,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "duration=60",
      expectedStatus: 200,
      expectedContent: [`"token":"`],
    },
    {
      name: "impersonate: missing record",
      method: "POST",
      url: "/api/collections/users/impersonate/missing",
      headers: { Authorization: superuserToken },
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "impersonate: non-auth collection",
      method: "POST",
      url: "/api/collections/demo1/impersonate/84nmscqy84lsi1t",
      headers: { Authorization: superuserToken },
      expectedStatus: 404,
      expectedContent: [`"message":"Missing or invalid auth collection context."`],
    },
    {
      name: "impersonate: a superuser",
      method: "POST",
      url: "/api/collections/_superusers/impersonate/sbmbsdb40jyxf7h",
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [`"collectionName":"_superusers"`],
    },
    {
      name: "impersonate: MFA-enabled users are not asked for MFA",
      method: "POST",
      url: "/api/collections/users/impersonate/4q1xlclmfloku33",
      headers: { Authorization: superuserToken },
      expectedStatus: 200,
      expectedContent: [`"token":"`],
      after: mfasCount("_pb_users_auth_", "4q1xlclmfloku33", 0),
    },

    // auth methods
    // -----------------------------------------------------------
    {
      name: "auth-methods: _superusers",
      method: "GET",
      url: "/api/collections/_superusers/auth-methods",
      expectedStatus: 200,
      expectedContent: [`"password":{"identityFields":["email"],"enabled":true}`],
    },
    {
      name: "auth-methods: clients",
      method: "GET",
      url: "/api/collections/clients/auth-methods",
      expectedStatus: 200,
      expectedContent: [`"emailPassword":true`],
    },
    {
      name: "auth-methods: nologin with OAuth2 enabled",
      method: "GET",
      url: "/api/collections/nologin/auth-methods",
      prepare: ({ dataDir }) =>
        updateCollection(dataDir, "nologin", (c) => {
          c.oauth2.enabled = true;
        }),
      expectedStatus: 200,
      expectedContent: [`"name":"gitlab"`, `"emailPassword":false`],
    },
    {
      name: "auth-methods: provider overrides (display name, PKCE off, auth URL with a query)",
      method: "GET",
      url: "/api/collections/users/auth-methods",
      prepare: ({ dataDir }) =>
        updateCollection(dataDir, "users", (c) => {
          c.oauth2.providers = [
            new OAuth2ProviderConfig({
              name: "gitlab",
              clientId: "my client/id",
              clientSecret: "secret",
              authURL: "https://gitlab.example.com/oauth/authorize?tenant=a%20b",
              displayName: "My GitLab",
              pkce: false,
            }),
            new OAuth2ProviderConfig({ name: "google", clientId: "g", clientSecret: "s" }),
          ];
        }),
      expectedStatus: 200,
      expectedContent: [`"displayName":"My GitLab"`, `"codeChallengeMethod":""`],
    },

    // MFA
    // -----------------------------------------------------------
    {
      name: "mfa: mfaId in the query string",
      ...login("users", { identity: "test@example.com", password: pw }, `?mfaId=${mfaId}`),
      prepare: insertMFA("users", "test@example.com", mfaId, "oauth2"),
      expectedStatus: 200,
      expectedContent: [`"token":`],
      after: mfaRow(mfaId, 0),
    },
    {
      name: "mfa: the same method twice",
      ...login("users", { mfaId, identity: "test@example.com", password: pw }),
      prepare: insertMFA("users", "test@example.com", mfaId, "password"),
      expectedStatus: 400,
      expectedContent: [`"message":"A different authentication method is required."`],
      after: mfaRow(mfaId, 1),
    },
    {
      name: "mfa: unknown mfaId",
      ...login("users", { mfaId: "missing", identity: "test@example.com", password: pw }),
      expectedStatus: 400,
      expectedContent: [`"message":"Invalid or expired MFA session."`],
    },
    {
      name: "mfa: expired mfa is deleted",
      ...login("users", { mfaId, identity: "test@example.com", password: pw }),
      prepare: all(insertMFA("users", "test@example.com", mfaId, "oauth2"), ageMFA(mfaId)),
      expectedStatus: 400,
      expectedContent: [`"message":"Invalid or expired MFA session."`],
      after: mfaRow(mfaId, 0),
    },
    {
      name: "mfa: mfa of another record",
      ...login("users", { mfaId, identity: "test@example.com", password: pw }),
      prepare: insertMFA("users", "test2@example.com", mfaId, "oauth2"),
      expectedStatus: 400,
      expectedContent: [`"message":"Invalid MFA session."`],
      after: mfaRow(mfaId, 1),
    },
    {
      name: "mfa: rule not satisfied by the record skips MFA",
      ...login("users", { identity: "test@example.com", password: pw }),
      prepare: setMFA("users", true, "verified = true"),
      expectedStatus: 200,
      expectedContent: [`"token":`],
      after: mfasCount("_pb_users_auth_", "4q1xlclmfloku33", 0),
    },
    {
      name: "mfa: rule satisfied by the record",
      ...login("users", { identity: "test@example.com", password: pw }),
      prepare: setMFA("users", true, "verified = false"),
      expectedStatus: 401,
      expectedContent: [`"mfaId":"`],
      after: mfasCount("_pb_users_auth_", "4q1xlclmfloku33", 1),
    },
    {
      name: "mfa: wrong password does not create an mfa",
      ...login("users", { identity: "test@example.com", password: "wrong-password" }),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
      after: mfasCount("_pb_users_auth_", "4q1xlclmfloku33", 0),
    },
  ];
}
