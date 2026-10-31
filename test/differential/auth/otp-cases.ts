// More OTP and OTP-based MFA cases (otp.test.ts), beyond upstream's
// apis/record_auth_otp_request_test.go and apis/record_auth_with_otp_test.go
// scenarios. Each case is a scenario: both servers start on copies of the
// prepared fixture, upstream must meet the expectations and iglo.base must
// answer like upstream (test/differential/harness/compare.ts). The OTPs are
// inserted with known passwords; otp-flows.test.ts runs the same paths
// with OTPs requested from the servers.

import { Database } from "bun:sqlite";
import { join } from "node:path";

import { updateCollection } from "@test/scenarios/prepare";
import {
  insertMFA,
  insertOTPs,
  mfasCount,
  otpRows,
  setAuthRecordField,
  setMFA,
  setOTP,
} from "@test/scenarios/record-auth-prepare";
import { passwordIs, queryRows } from "@test/scenarios/record-checks";
import type { AfterContext, PrepareContext, Scenario } from "@test/scenarios/scenario";
import { changeSettings, smtpToSink } from "@test/scenarios/settings-prepare";

const userId = "4q1xlclmfloku33";
const usersId = "_pb_users_auth_";
const email = "test@example.com";
const otpId = "a".repeat(15);
const mfaId = "m".repeat(15);
const pass = "123456";

// several prepare steps in order
function all(...steps: ((ctx: PrepareContext) => void)[]): (ctx: PrepareContext) => void {
  return (ctx) => {
    for (const step of steps) {
      step(ctx);
    }
  };
}

const request = (collection: string, body: unknown): Pick<Scenario, "method" | "url" | "body"> => ({
  method: "POST",
  url: `/api/collections/${collection}/request-otp`,
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const auth = (
  collection: string,
  body: unknown,
  query = "",
): Pick<Scenario, "method" | "url" | "body"> => ({
  method: "POST",
  url: `/api/collections/${collection}/auth-with-otp${query}`,
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const validBody = { otpId, password: pass };

const usersWithoutMFA = setMFA("users", false, "");
const unverified = setAuthRecordField("users", email, "verified", false);

const secondsAgo = (s: number): Date => new Date(Date.now() - s * 1000);

function setAuthRule(collection: string, rule: string | null): (ctx: PrepareContext) => void {
  return ({ dataDir }) =>
    updateCollection(dataDir, collection, (c) => {
      c.authRule = rule;
    });
}

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

function otpsCount(n: number): (ctx: AfterContext) => void {
  return ({ dataDir }) => {
    const total = otpRows(dataDir, userId).length;
    if (total !== n) {
      throw new Error(`expected ${n} OTPs, got ${total}`);
    }
  };
}

function userRow(dataDir: string): { verified: number; password: string; tokenKey: string } {
  return (
    queryRows(dataDir, "SELECT verified, password, tokenKey FROM users WHERE id = ?", userId) as {
      verified: number;
      password: string;
      tokenKey: string;
    }[]
  )[0] as { verified: number; password: string; tokenKey: string };
}

function verifiedIs(expected: boolean): (ctx: AfterContext) => void {
  return ({ dataDir }) => {
    if (Boolean(userRow(dataDir).verified) !== expected) {
      throw new Error(`expected verified ${expected}`);
    }
  };
}

// the fixture's "1234567890" still signs in, or not
const passwordKept = passwordIs("users", userId, "1234567890");

async function passwordReset(ctx: AfterContext): Promise<void> {
  let matched = true;
  try {
    await passwordKept(ctx);
  } catch {
    matched = false;
  }
  if (matched) {
    throw new Error("expected the password to be replaced on the verified upgrade");
  }
}

export function otpCases(): Scenario[] {
  return [
    // the OTP request
    // -----------------------------------------------------------
    {
      name: "request: OTP disabled on clients",
      ...request("clients", { email }),
      prepare: setOTP("clients", false),
      expectedStatus: 403,
      expectedContent: [
        `"message":"The collection is not configured to allow OTP authentication."`,
      ],
    },
    {
      name: "request: the disabled answer comes before the body checks",
      ...request("users", `{"email`),
      prepare: setOTP("users", false),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "request: unknown collection",
      ...request("missing", { email }),
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "request: view collection",
      ...request("view1", { email }),
      expectedStatus: 404,
      expectedContent: [`"data":{}`],
    },
    {
      name: "request: unknown email gets the fake otpId and writes nothing",
      ...request("users", { email: "nobody@example.com" }),
      expectedStatus: 200,
      expectedContent: [`"otpId":"`],
      after: ({ dataDir }) => {
        const rows = queryRows(dataDir, "SELECT id FROM _otps");
        if (rows.length !== 0) {
          throw new Error(`expected no OTP rows, got ${rows.length}`);
        }
      },
    },
    {
      name: "request: email in another case misses the record (no NOCASE index on users)",
      ...request("users", { email: "TEST@example.com" }),
      prepare: smtpToSink(),
      delayMs: 300,
      expectedStatus: 200,
      expectedContent: [`"otpId":"`],
      after: otpsCount(0),
    },
    {
      name: "request: email over 255 characters",
      ...request("users", { email: `${"a".repeat(250)}@example.com` }),
      expectedStatus: 400,
      expectedContent: [`"email":{"code":"validation_length_out_of_range"`],
    },
    {
      name: "request: email as a number",
      ...request("users", `{"email":1}`),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },
    {
      name: "request: form encoded body",
      method: "POST",
      url: "/api/collections/users/request-otp",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "email=nobody%40example.com",
      expectedStatus: 200,
      expectedContent: [`"otpId":"`],
    },
    {
      name: "request: exactly 9 recent OTPs still creates a new one",
      ...request("users", { email }),
      prepare: all(
        smtpToSink(),
        insertOTPs("users", email, ...Array.from({ length: 9 }, (_, i) => ({ id: `otp_${i}` }))),
      ),
      delayMs: 300,
      expectedStatus: 200,
      expectedContent: [`"otpId":"`],
      notExpectedContent: [`"otpId":"otp_`],
      after: otpsCount(10),
    },
    {
      name: "request: 9 recent and 3 expired OTPs still creates a new one",
      ...request("users", { email }),
      prepare: all(
        smtpToSink(),
        insertOTPs(
          "users",
          email,
          ...Array.from({ length: 9 }, (_, i) => ({ id: `otp_${i}` })),
          ...Array.from({ length: 3 }, (_, i) => ({ id: `old_${i}`, date: secondsAgo(4000) })),
        ),
      ),
      delayMs: 300,
      expectedStatus: 200,
      expectedContent: [`"otpId":"`],
      notExpectedContent: [`"otpId":"otp_`, `"otpId":"old_`],
      after: otpsCount(13),
    },
    {
      name: "request: the failed send of a fixture without a mailer removes the OTP",
      ...request("users", { email }),
      delayMs: 500,
      expectedStatus: 200,
      expectedContent: [`"otpId":"`],
      after: otpsCount(0),
    },

    // the OTP password
    // -----------------------------------------------------------
    {
      name: "auth: OTP disabled comes before the body checks",
      ...auth("users", `{"otpId`),
      prepare: setOTP("users", false),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "auth: unknown otpId",
      ...auth("users", { otpId: "nothing", password: pass }),
      expectedStatus: 400,
      expectedContent: [`"message":"Invalid or expired OTP."`, `"data":{}`],
    },
    {
      name: "auth: password of 71 bytes passes validation",
      ...auth("users", { otpId, password: "a".repeat(71) }),
      prepare: insertOTPs("users", email, { id: otpId }),
      expectedStatus: 400,
      expectedContent: [`"message":"Invalid or expired OTP."`],
      after: otpsCount(1),
    },
    {
      name: "auth: password of 72 multi-byte characters fails validation",
      ...auth("users", { otpId, password: "ż".repeat(36) }),
      expectedStatus: 400,
      expectedContent: [`"password":{"code":"validation_length_out_of_range"`],
    },
    {
      name: "auth: wrong password keeps the OTP",
      ...auth("users", { otpId, password: "654321" }),
      prepare: all(usersWithoutMFA, insertOTPs("users", email, { id: otpId })),
      expectedStatus: 400,
      expectedContent: [`"message":"Invalid or expired OTP."`],
      after: otpsCount(1),
    },
    {
      name: "auth: expired OTP stays in the table",
      ...auth("users", validBody),
      prepare: all(
        usersWithoutMFA,
        insertOTPs("users", email, { id: otpId, date: secondsAgo(4000) }),
      ),
      expectedStatus: 400,
      expectedContent: [`"message":"Invalid or expired OTP."`],
      after: otpsCount(1),
    },
    {
      name: "auth: OTP inside the collection's duration",
      ...auth("users", validBody),
      prepare: all(
        usersWithoutMFA,
        ({ dataDir }) =>
          updateCollection(dataDir, "users", (c) => {
            c.otp.duration = 3600;
          }),
        insertOTPs("users", email, { id: otpId, date: secondsAgo(3000) }),
      ),
      expectedStatus: 200,
      expectedContent: [`"token":"`],
      after: otpsCount(0),
    },
    {
      name: "auth: otpId of another collection",
      ...auth("clients", validBody),
      prepare: all(setOTP("clients", true), insertOTPs("users", email, { id: otpId })),
      expectedStatus: 400,
      expectedContent: [`"message":"Invalid or expired OTP."`],
    },
    {
      name: "auth: otpId of a record that no longer exists",
      ...auth("users", validBody),
      prepare: all(insertOTPs("users", email, { id: otpId }), ({ dataDir }) => {
        const db = new Database(join(dataDir, "data.db"));
        try {
          db.query("UPDATE _otps SET recordRef = 'missing' WHERE id = ?").run(otpId);
        } finally {
          db.close();
        }
      }),
      expectedStatus: 400,
      expectedContent: [`"message":"Invalid or expired OTP."`],
    },
    {
      name: "auth: form encoded body",
      method: "POST",
      url: "/api/collections/users/auth-with-otp",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `otpId=${otpId}&password=${pass}`,
      prepare: all(usersWithoutMFA, insertOTPs("users", email, { id: otpId })),
      expectedStatus: 200,
      expectedContent: [`"token":"`],
    },
    {
      name: "auth: expand and fields apply to the response",
      ...auth("users", validBody, "?expand=rel&fields=token,record.id,record.email"),
      prepare: all(usersWithoutMFA, insertOTPs("users", email, { id: otpId })),
      expectedStatus: 200,
      expectedContent: [`"token":"`, `"id":"${userId}"`],
      notExpectedContent: [`"username"`],
    },
    {
      name: "auth: the response stores the new auth origin",
      ...auth("users", validBody),
      prepare: all(
        usersWithoutMFA,
        ({ dataDir }) =>
          updateCollection(dataDir, "users", (c) => {
            c.authAlert.enabled = true;
          }),
        insertOTPs("users", email, { id: otpId }),
      ),
      expectedStatus: 200,
      expectedContent: [`"token":"`],
      after: ({ dataDir }) => {
        const rows = queryRows(dataDir, "SELECT id FROM _authOrigins WHERE recordRef = ?", userId);
        if (rows.length !== 1) {
          throw new Error(`expected 1 auth origin, got ${rows.length}`);
        }
      },
    },

    // the verified upgrade
    // -----------------------------------------------------------
    {
      name: "verified upgrade: sentTo equals the email (MFA off) resets the password",
      ...auth("users", validBody),
      prepare: all(
        unverified,
        usersWithoutMFA,
        insertOTPs("users", email, { id: otpId, sentTo: email }),
      ),
      expectedStatus: 200,
      expectedContent: [`"verified":true`],
      after: async (ctx) => {
        verifiedIs(true)(ctx);
        await passwordReset(ctx);
      },
    },
    {
      name: "verified upgrade: sentTo equals the email (MFA on) keeps the password",
      ...auth("users", validBody),
      prepare: all(unverified, insertOTPs("users", email, { id: otpId, sentTo: email })),
      expectedStatus: 401,
      expectedContent: [`"mfaId":"`],
      after: async (ctx) => {
        verifiedIs(true)(ctx);
        await passwordKept(ctx);
      },
    },
    {
      name: "verified upgrade: sentTo mismatch stays unverified",
      ...auth("users", validBody),
      prepare: all(
        unverified,
        usersWithoutMFA,
        insertOTPs("users", email, { id: otpId, sentTo: "other@example.com" }),
      ),
      expectedStatus: 200,
      expectedContent: [`"verified":false`],
      after: async (ctx) => {
        verifiedIs(false)(ctx);
        await passwordKept(ctx);
      },
    },
    {
      name: "verified upgrade: sentTo compared with case",
      ...auth("users", validBody),
      prepare: all(
        unverified,
        usersWithoutMFA,
        insertOTPs("users", email, { id: otpId, sentTo: "TEST@example.com" }),
      ),
      expectedStatus: 200,
      expectedContent: [`"verified":false`],
      after: verifiedIs(false),
    },
    {
      name: "verified upgrade: a verified user keeps the password",
      ...auth("users", validBody),
      prepare: all(
        setAuthRecordField("users", email, "verified", true),
        usersWithoutMFA,
        insertOTPs("users", email, { id: otpId, sentTo: email }),
      ),
      expectedStatus: 200,
      expectedContent: [`"verified":true`],
      after: passwordKept,
    },

    // request context, rules
    // -----------------------------------------------------------
    {
      name: "rules: authRule sees the otp request context",
      ...auth("users", validBody),
      prepare: all(
        usersWithoutMFA,
        setAuthRule("users", `@request.context = "otp"`),
        insertOTPs("users", email, { id: otpId }),
      ),
      expectedStatus: 200,
      expectedContent: [`"token":"`],
    },
    {
      name: "rules: a failed authRule consumes the OTP",
      ...auth("users", validBody),
      prepare: all(
        usersWithoutMFA,
        setAuthRule("users", `@request.context = "password"`),
        insertOTPs("users", email, { id: otpId }),
      ),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
      after: otpsCount(0),
    },
    {
      name: "rules: a null authRule refuses the OTP auth",
      ...auth("users", validBody),
      prepare: all(
        usersWithoutMFA,
        setAuthRule("users", null),
        insertOTPs("users", email, { id: otpId }),
      ),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "rules: mfa rule on the otp context asks for MFA",
      ...auth("users", validBody),
      prepare: all(
        setMFA("users", true, `@request.context = "otp"`),
        insertOTPs("users", email, { id: otpId }),
      ),
      expectedStatus: 401,
      expectedContent: [`"mfaId":"`],
      after: mfasCount(usersId, userId, 1),
    },
    {
      name: "rules: mfa rule on the password context skips MFA",
      ...auth("users", validBody),
      prepare: all(
        setMFA("users", true, `@request.context = "password"`),
        insertOTPs("users", email, { id: otpId }),
      ),
      expectedStatus: 200,
      expectedContent: [`"token":"`],
      after: mfasCount(usersId, userId, 0),
    },

    // MFA
    // -----------------------------------------------------------
    {
      name: "mfa: OTP as the second factor after a password (mfaId in the body)",
      ...auth("users", { ...validBody, mfaId }),
      prepare: all(
        insertMFA("users", email, mfaId, "password"),
        insertOTPs("users", email, { id: otpId }),
      ),
      expectedStatus: 200,
      expectedContent: [`"token":"`],
      after: mfasCount(usersId, userId, 0),
    },
    {
      name: "mfa: OTP as the second factor (mfaId in the query)",
      ...auth("users", validBody, `?mfaId=${mfaId}`),
      prepare: all(
        insertMFA("users", email, mfaId, "password"),
        insertOTPs("users", email, { id: otpId }),
      ),
      expectedStatus: 200,
      expectedContent: [`"token":"`],
      after: mfasCount(usersId, userId, 0),
    },
    {
      name: "mfa: OTP after an oauth2 first factor",
      ...auth("users", { ...validBody, mfaId }),
      prepare: all(
        insertMFA("users", email, mfaId, "oauth2"),
        insertOTPs("users", email, { id: otpId }),
      ),
      expectedStatus: 200,
      expectedContent: [`"token":"`],
    },
    {
      name: "mfa: OTP twice needs a different method",
      ...auth("users", { ...validBody, mfaId }),
      prepare: all(
        insertMFA("users", email, mfaId, "otp"),
        insertOTPs("users", email, { id: otpId }),
      ),
      expectedStatus: 400,
      expectedContent: [`"message":"A different authentication method is required."`],
      after: async (ctx) => {
        otpsCount(0)(ctx);
        await mfasCount(usersId, userId, 1)(ctx);
      },
    },
    {
      name: "mfa: unknown mfaId",
      ...auth("users", { ...validBody, mfaId: "missing" }),
      prepare: insertOTPs("users", email, { id: otpId }),
      expectedStatus: 400,
      expectedContent: [`"message":"Invalid or expired MFA session."`],
    },
    {
      name: "mfa: expired MFA session is removed",
      ...auth("users", { ...validBody, mfaId }),
      prepare: all(
        insertMFA("users", email, mfaId, "password"),
        ageMFA(mfaId),
        insertOTPs("users", email, { id: otpId }),
      ),
      expectedStatus: 400,
      expectedContent: [`"message":"Invalid or expired MFA session."`],
      after: mfasCount(usersId, userId, 0),
    },
    {
      name: "mfa: MFA session of another record",
      ...auth("users", { ...validBody, mfaId }),
      prepare: all(
        insertMFA("users", "test2@example.com", mfaId, "password"),
        insertOTPs("users", email, { id: otpId }),
      ),
      expectedStatus: 400,
      expectedContent: [`"message":"Invalid MFA session."`],
    },

    // superusers
    // -----------------------------------------------------------
    {
      name: "superusers: OTP is disabled by default",
      ...request("_superusers", { email }),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
    },
    {
      name: "superusers: OTP without MFA signs in",
      ...auth("_superusers", validBody),
      prepare: all(setOTP("_superusers", true), insertOTPs("_superusers", email, { id: otpId })),
      expectedStatus: 200,
      expectedContent: [`"token":"`, `"email":"test@example.com"`],
    },
    {
      name: "superusers: OTP with MFA asks for the second factor",
      ...auth("_superusers", validBody),
      prepare: all(
        setOTP("_superusers", true),
        setMFA("_superusers", true, ""),
        insertOTPs("_superusers", email, { id: otpId }),
      ),
      expectedStatus: 401,
      expectedContent: [`"mfaId":"`],
    },
    {
      name: "superusers: OTP from an IP off the whitelist",
      ...auth("_superusers", validBody),
      prepare: all(
        setOTP("_superusers", true),
        insertOTPs("_superusers", email, { id: otpId }),
        ({ dataDir }) => {
          changeSettings(dataDir, (settings) => {
            settings.superuserIPs = ["10.1.2.3"];
          });
        },
      ),
      expectedStatus: 403,
      expectedContent: [`"data":{}`],
      after: ({ dataDir }) => {
        const rows = queryRows(dataDir, "SELECT id FROM _otps WHERE id = ?", otpId);
        if (rows.length !== 0) {
          throw new Error("expected the OTP to be consumed");
        }
      },
    },
  ];
}
