// More verification, password reset and email change cases (token.test.ts),
// beyond upstream's apis/record_auth_verification_*_test.go,
// record_auth_password_reset_*_test.go and record_auth_email_change_*_test.go
// scenarios. Each case is a scenario: both servers start on copies of the
// prepared fixture, upstream must meet the expectations and iglo.base must
// answer like upstream (test/differential/harness/compare.ts). The tokens
// are signed here with the fixture's keys, so a case can name any record,
// type and claims; token-flows.test.ts runs the same paths with tokens
// read from the Mailpit messages.

import { constants, Database } from "bun:sqlite";
import { join } from "node:path";

import { systemClock } from "@/app/clock";
import { newJWT } from "@/tools/security/jwt";

import { fixtureDir } from "@test/scenarios/fixture";
import { updateCollection } from "@test/scenarios/prepare";
import {
  insertAuthOrigin,
  insertMFA,
  insertOTPs,
  setAuthRecordField,
  updateIdentityIndex,
  updateKeepingTokenKey,
} from "@test/scenarios/record-auth-prepare";
import {
  authOriginsCount,
  checks,
  externalAuthsCount,
  passwordIs,
  queryRows,
  rowHas,
} from "@test/scenarios/record-checks";
import { usersToken } from "@test/scenarios/record-crud";
import type { AfterContext, PrepareContext, Scenario } from "@test/scenarios/scenario";
import {
  mailSent,
  noMailSent,
  smtpToEmptySink,
  smtpToSink,
} from "@test/scenarios/settings-prepare";

const usersId = "_pb_users_auth_";
const userId = "4q1xlclmfloku33";
const user2Id = "oap640cot4yru2s";
const email = "test@example.com";
const password = "1234567890";
const newPassword = "1234567!";

// the vendored fixture, read only and immutable: a plain open of a WAL
// database leaves -shm and -wal files next to it
function fixtureDB(): Database {
  return new Database(
    `file:${join(fixtureDir, "data.db")}?immutable=1`,
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
  );
}

type TokenType = "auth" | "verification" | "passwordReset" | "emailChange";

const secretNames: { [type in TokenType]: string } = {
  auth: "authToken",
  verification: "verificationToken",
  passwordReset: "passwordResetToken",
  emailChange: "emailChangeToken",
};

interface MintOptions {
  // the claims that replace the defaults (undefined removes one)
  claims?: { [key: string]: unknown };
  // seconds until exp
  duration?: number;
  // sign with this record's key instead (a token of another record)
  keyOf?: string;
}

// a token of the fixture's record, signed as the record would be
export function mint(
  type: TokenType,
  collection: string,
  recordId: string,
  options: MintOptions = {},
): string {
  const db = fixtureDB();
  try {
    const { id: collectionId, options: json } = db
      .query("SELECT id, options FROM _collections WHERE name = ?")
      .get(collection) as { id: string; options: string };
    const secret = (JSON.parse(json) as { [key: string]: { secret: string } })[secretNames[type]];
    const row = db
      .query(`SELECT tokenKey, email FROM "${collection}" WHERE id = ?`)
      .get(options.keyOf ?? recordId) as { tokenKey: string; email: string };
    const claims: { [key: string]: unknown } = {
      id: recordId,
      type,
      collectionId,
      ...(type === "auth" ? { refreshable: true } : { email: row.email }),
      ...options.claims,
    };
    for (const [key, value] of Object.entries(claims)) {
      if (value === undefined) {
        Reflect.deleteProperty(claims, key);
      }
    }
    return newJWT(
      claims,
      row.tokenKey + (secret?.secret ?? ""),
      BigInt(options.duration ?? 3600) * 1_000_000_000n,
      systemClock(),
    );
  } finally {
    db.close();
  }
}

const emailChange = (newEmail: string, recordId = userId, collection = "users"): string =>
  mint("emailChange", collection, recordId, { claims: { newEmail } });

type Step = (ctx: PrepareContext) => void;

// several prepare steps in order
function all(...steps: Step[]): Step {
  return (ctx) => {
    for (const step of steps) {
      step(ctx);
    }
  };
}

type Target = Pick<Scenario, "method" | "url" | "body" | "headers">;

function post(collection: string, path: string, body: unknown, token?: string): Target {
  return {
    method: "POST",
    url: `/api/collections/${collection}/${path}`,
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(token === undefined ? {} : { headers: { Authorization: token } }),
  };
}

const requestVerification = (collection: string, body: unknown): Target =>
  post(collection, "request-verification", body);
const confirmVerification = (token: string, collection = "users"): Target =>
  post(collection, "confirm-verification", { token });
const requestReset = (collection: string, body: unknown): Target =>
  post(collection, "request-password-reset", body);
const confirmReset = (token: string, collection = "users", pass = newPassword): Target =>
  post(collection, "confirm-password-reset", { token, password: pass, passwordConfirm: pass });
const requestChange = (collection: string, newEmail: string, token: string): Target =>
  post(collection, "request-email-change", { newEmail }, token);
const confirmChange = (token: string, pass = password, collection = "users"): Target =>
  post(collection, "confirm-email-change", { token, password: pass });

const invalidToken = [`"data":{"token":{"code":"validation_invalid_token"`];

// the number of rows of the record in a table
function rowsCount(table: string, recordId: string, n: number) {
  return ({ dataDir }: AfterContext): Promise<void> => {
    const rows = queryRows(dataDir, `SELECT id FROM ${table} WHERE recordRef = ?`, recordId);
    if (rows.length !== n) {
      return Promise.reject(new Error(`expected ${n} ${table} rows, got ${rows.length}`));
    }
    return Promise.resolve();
  };
}

// the columns of a row, as the fixture has them
function fixtureColumn(table: string, id: string, column: string): unknown {
  const db = fixtureDB();
  try {
    return (db.query(`SELECT * FROM "${table}" WHERE id = ?`).get(id) as { [k: string]: unknown })[
      column
    ];
  } finally {
    db.close();
  }
}

// the token key is the fixture's, or another one
function tokenKeyKept(table: string, id: string, kept: boolean) {
  return ({ dataDir }: AfterContext): Promise<void> => {
    const [row] = queryRows(dataDir, `SELECT tokenKey FROM "${table}" WHERE id = ?`, id) as {
      tokenKey: string;
    }[];
    if ((row?.tokenKey === fixtureColumn(table, id, "tokenKey")) !== kept) {
      return Promise.reject(new Error(`expected the token key ${kept ? "kept" : "refreshed"}`));
    }
    return Promise.resolve();
  };
}

function setAuthRule(collection: string, rule: string | null): Step {
  return ({ dataDir }) =>
    updateCollection(dataDir, collection, (c) => {
      c.authRule = rule;
    });
}

function setPasswordAuth(collection: string, enabled: boolean): Step {
  return ({ dataDir }) =>
    updateCollection(dataDir, collection, (c) => {
      c.passwordAuth.enabled = enabled;
    });
}

function setEmailDomains(collection: string, onlyDomains: string[]): Step {
  return ({ dataDir }) =>
    updateCollection(dataDir, collection, (c) => {
      const field = c.fields.getByName("email") as unknown as { onlyDomains: string[] };
      field.onlyDomains = onlyDomains;
    });
}

function deleteUser({ dataDir }: PrepareContext): void {
  const db = new Database(join(dataDir, "data.db"));
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    db.query("DELETE FROM users WHERE id = ?").run(user2Id);
  } finally {
    db.close();
  }
}

// an MFA, an OTP and an auth origin of the fixture user
const withAuthRows = all(
  insertMFA("users", email, "m".repeat(15), "password"),
  insertOTPs("users", email, { id: "o".repeat(15) }),
  insertAuthOrigin("users", email, "fingerprint"),
);

// directly: a verified upgrade would remove the external auths
function verified({ dataDir }: PrepareContext): void {
  const db = new Database(join(dataDir, "data.db"));
  try {
    db.query("UPDATE users SET verified = 1 WHERE id = ?").run(userId);
  } finally {
    db.close();
  }
}

const longLocalPart = "a".repeat(250);

export function tokenCases(): Scenario[] {
  return [
    // enumeration-safe answers
    // -----------------------------------------------------------
    {
      name: "request-verification: unknown email, no mail",
      ...requestVerification("clients", { email: "missing@example.com" }),
      prepare: smtpToEmptySink(),
      delayMs: 100,
      expectedStatus: 204,
      after: noMailSent,
    },
    {
      name: "request-verification: already verified, no mail",
      ...requestVerification("clients", { email }),
      prepare: smtpToEmptySink(),
      delayMs: 100,
      expectedStatus: 204,
      after: noMailSent,
    },
    {
      name: "request-password-reset: unknown email, no mail",
      ...requestReset("clients", { email: "missing@example.com" }),
      prepare: smtpToEmptySink(),
      delayMs: 100,
      expectedStatus: 204,
      after: noMailSent,
    },
    {
      name: "request-password-reset: a verified record gets the mail",
      ...requestReset("clients", { email }),
      prepare: smtpToSink(),
      delayMs: 200,
      expectedStatus: 204,
      after: mailSent(email, "/auth/confirm-password-reset"),
    },
    {
      name: "request-verification: urlencoded body",
      method: "POST",
      url: "/api/collections/users/request-verification",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `email=${encodeURIComponent(email)}`,
      prepare: smtpToSink(),
      delayMs: 200,
      expectedStatus: 204,
      after: mailSent(email, "/auth/confirm-verification"),
    },
    {
      name: "request-verification: the email lookup follows the index collation",
      ...requestVerification("clients", { email: "TEST2@example.com" }),
      prepare: all(smtpToSink(), updateIdentityIndex({ email: "NOCASE" })),
      delayMs: 200,
      expectedStatus: 204,
      after: mailSent("test2@example.com", "/auth/confirm-verification"),
    },
    {
      name: "request-verification: an invalid email",
      ...requestVerification("users", { email: "invalid" }),
      expectedStatus: 400,
      expectedContent: [`"data":{"email":{"code":"validation_is_email"`],
    },
    {
      name: "request-verification: a too long email",
      ...requestVerification("users", { email: `${longLocalPart}@example.com` }),
      expectedStatus: 400,
      expectedContent: [`"data":{"email":{"code":"validation_length_out_of_range"`],
    },
    {
      name: "request-password-reset: an email of the wrong type",
      ...requestReset("users", `{"email":1}`),
      expectedStatus: 400,
      expectedContent: [`"data":{}`],
    },

    // superusers
    // -----------------------------------------------------------
    {
      name: "request-verification on _superusers",
      ...requestVerification("_superusers", { email }),
      expectedStatus: 400,
      expectedContent: [`"message":"All superusers are verified by default."`, `"data":{}`],
    },
    {
      name: "confirm-verification on _superusers, before any check of the body",
      ...post("_superusers", "confirm-verification", `{"token`),
      expectedStatus: 400,
      expectedContent: [`"message":"All superusers are verified by default."`],
    },
    {
      name: "request-email-change on _superusers",
      ...requestChange(
        "_superusers",
        "change@example.com",
        mint("auth", "_superusers", "sywbhecnh46rhm0"),
      ),
      expectedStatus: 400,
      expectedContent: [`"message":"All superusers can change their emails directly."`],
    },
    {
      name: "confirm-email-change on _superusers",
      ...post("_superusers", "confirm-email-change", {}),
      expectedStatus: 400,
      expectedContent: [`"message":"All superusers can change their emails directly."`],
    },
    {
      name: "superuser password reset: the mail goes out",
      ...requestReset("_superusers", { email: "test2@example.com" }),
      prepare: smtpToSink(),
      delayMs: 200,
      expectedStatus: 204,
      after: mailSent("test2@example.com", "/auth/confirm-password-reset"),
    },
    {
      name: "superuser password reset: confirmed",
      ...confirmReset(mint("passwordReset", "_superusers", "sbmbsdb40jyxf7h"), "_superusers"),
      expectedStatus: 204,
      after: checks(
        passwordIs("_superusers", "sbmbsdb40jyxf7h", newPassword),
        rowHas("_superusers", "sbmbsdb40jyxf7h", { verified: 1 }),
        tokenKeyKept("_superusers", "sbmbsdb40jyxf7h", false),
        // the superuser's three login origins
        rowsCount("_authOrigins", "sbmbsdb40jyxf7h", 0),
      ),
    },
    {
      name: "no password reset mail for the installer superuser",
      ...requestReset("_superusers", { email: "__pbinstaller@example.com" }),
      prepare: all(
        smtpToEmptySink(),
        setAuthRecordField(
          "_superusers",
          "test4@example.com",
          "email",
          "__pbinstaller@example.com",
        ),
      ),
      delayMs: 200,
      expectedStatus: 204,
      after: noMailSent,
    },

    // tokens of another type, record or collection, expired or stale
    // -----------------------------------------------------------
    {
      name: "confirm-verification: an auth token has no email claim",
      ...confirmVerification(usersToken),
      expectedStatus: 400,
      expectedContent: [`"data":{"token":{"code":"validation_invalid_token_claims"`],
    },
    {
      name: "confirm-verification: not a token",
      ...confirmVerification("abc"),
      expectedStatus: 400,
      expectedContent: [`"data":{"token":{"code":"validation_invalid_token_claims"`],
    },
    {
      name: "confirm-verification: an email change token",
      ...confirmVerification(emailChange("change@example.com")),
      expectedStatus: 400,
      expectedContent: invalidToken,
    },
    {
      name: "confirm-verification: signed with another record's key",
      ...confirmVerification(mint("verification", "users", userId, { keyOf: user2Id })),
      expectedStatus: 400,
      expectedContent: invalidToken,
    },
    {
      name: "confirm-verification: expired",
      ...confirmVerification(mint("verification", "users", userId, { duration: -10 })),
      expectedStatus: 400,
      expectedContent: invalidToken,
    },
    {
      name: "confirm-verification: the record is gone",
      ...confirmVerification(mint("verification", "users", user2Id)),
      prepare: deleteUser,
      expectedStatus: 400,
      expectedContent: invalidToken,
    },
    {
      name: "confirm-verification: the tokenKey changed",
      ...confirmVerification(mint("verification", "users", userId)),
      prepare: setAuthRecordField("users", email, "tokenKey", "a".repeat(50)),
      expectedStatus: 400,
      expectedContent: invalidToken,
    },
    {
      name: "confirm-verification: the email changed, the tokenKey did not",
      ...confirmVerification(mint("verification", "users", userId)),
      prepare: updateKeepingTokenKey("users", email, (record) => {
        record.setEmail("other@example.com");
      }),
      expectedStatus: 400,
      expectedContent: [`"data":{"token":{"code":"validation_token_email_mismatch"`],
    },
    {
      name: "confirm-password-reset: a verification token",
      ...confirmReset(mint("verification", "users", userId)),
      expectedStatus: 400,
      expectedContent: invalidToken,
    },
    {
      name: "confirm-password-reset: an auth token",
      ...confirmReset(usersToken),
      expectedStatus: 400,
      expectedContent: invalidToken,
    },
    {
      name: "confirm-password-reset: signed with another record's key",
      ...confirmReset(mint("passwordReset", "users", userId, { keyOf: user2Id })),
      expectedStatus: 400,
      expectedContent: invalidToken,
    },
    {
      name: "confirm-password-reset: the tokenKey changed",
      ...confirmReset(mint("passwordReset", "users", userId)),
      prepare: setAuthRecordField("users", email, "tokenKey", "a".repeat(50)),
      expectedStatus: 400,
      expectedContent: invalidToken,
    },
    {
      name: "confirm-password-reset: a token of another auth collection",
      ...confirmReset(mint("passwordReset", "clients", "gk390qegs4y47wn")),
      expectedStatus: 400,
      expectedContent: [`"data":{"token":{"code":"validation_token_collection_mismatch"`],
    },
    {
      name: "confirm-email-change: a verification token has no newEmail claim",
      ...confirmChange(mint("verification", "users", userId)),
      expectedStatus: 400,
      expectedContent: [`"token":{"code":"validation_invalid_token_payload"`],
    },
    {
      name: "confirm-email-change: another type with a newEmail claim",
      ...confirmChange(
        mint("verification", "users", userId, { claims: { newEmail: "change@example.com" } }),
      ),
      expectedStatus: 400,
      expectedContent: [`"token":{"code":"validation_invalid_token"`],
    },
    {
      name: "confirm-email-change: signed with another record's key",
      ...confirmChange(
        mint("emailChange", "users", userId, {
          keyOf: user2Id,
          claims: { newEmail: "change@example.com" },
        }),
      ),
      expectedStatus: 400,
      expectedContent: [`"token":{"code":"validation_invalid_token"`],
    },
    {
      name: "confirm-email-change: a token of another auth collection",
      ...confirmChange(emailChange("change@example.com", "gk390qegs4y47wn", "clients")),
      expectedStatus: 400,
      expectedContent: [`"token":{"code":"validation_token_collection_mismatch"`],
    },
    {
      name: "confirm-email-change: the tokenKey changed",
      ...confirmChange(emailChange("change@example.com")),
      prepare: setAuthRecordField("users", email, "tokenKey", "a".repeat(50)),
      expectedStatus: 400,
      expectedContent: [`"token":{"code":"validation_invalid_token"`],
    },
    {
      name: "confirm-email-change: expired, with the wrong password",
      ...confirmChange(
        mint("emailChange", "users", userId, {
          duration: -10,
          claims: { newEmail: "change@example.com" },
        }),
        "wrong-password",
      ),
      expectedStatus: 400,
      expectedContent: [
        `"password":{"code":"validation_invalid_password"`,
        `"token":{"code":"validation_invalid_token"`,
      ],
    },

    // password rules of confirm-password-reset
    // -----------------------------------------------------------
    {
      name: "confirm-password-reset: password mismatch",
      ...post("users", "confirm-password-reset", {
        token: mint("passwordReset", "users", userId),
        password: newPassword,
        passwordConfirm: "1234567?",
      }),
      expectedStatus: 400,
      expectedContent: [`"data":{"passwordConfirm":{"code":"validation_values_mismatch"`],
    },
    {
      name: "confirm-password-reset: shorter than the field's min",
      ...confirmReset(mint("passwordReset", "users", userId), "users", "1234567"),
      expectedStatus: 400,
      expectedContent: [`"data":{"password":{"code":"validation_length_out_of_range"`, `"min":8`],
    },
    {
      name: "confirm-password-reset: longer than 255",
      ...confirmReset(mint("passwordReset", "users", userId), "users", "a".repeat(256)),
      expectedStatus: 400,
      expectedContent: [`"data":{"password":{"code":"validation_length_out_of_range"`],
    },
    {
      name: "confirm-password-reset: within the form's limit, over the field's",
      ...confirmReset(mint("passwordReset", "users", userId), "users", "a".repeat(80)),
      expectedStatus: 400,
      expectedContent: [`"data":{"password":`],
      after: passwordIs("users", userId, password),
    },
    {
      name: "confirm-password-reset: a field pattern fails on the save",
      ...confirmReset(mint("passwordReset", "users", userId)),
      prepare: ({ dataDir }) =>
        updateCollection(dataDir, "users", (c) => {
          (c.fields.getByName("password") as unknown as { pattern: string }).pattern = "^x+$";
        }),
      expectedStatus: 400,
      expectedContent: [`"data":{"password":{"code":"validation_invalid_format"`],
      after: passwordIs("users", userId, password),
    },
    {
      name: "confirm-password-reset: another field of the record fails on the save",
      ...confirmReset(mint("passwordReset", "users", userId)),
      prepare: ({ dataDir }) => {
        const db = new Database(join(dataDir, "data.db"));
        try {
          db.query("UPDATE users SET name = '' WHERE id = ?").run(userId);
        } finally {
          db.close();
        }
        updateCollection(dataDir, "users", (c) => {
          (c.fields.getByName("name") as unknown as { required: boolean }).required = true;
        });
      },
      expectedStatus: 400,
      expectedContent: [`"data":{"name":{"code":"validation_required"`],
      after: passwordIs("users", userId, password),
    },

    // what a confirm leaves behind
    // -----------------------------------------------------------
    {
      name: "confirm-verification: the rows after a verified upgrade",
      ...confirmVerification(mint("verification", "users", userId)),
      prepare: withAuthRows,
      expectedStatus: 204,
      after: checks(
        rowHas("users", userId, { verified: 1, email }),
        passwordIs("users", userId, password),
        // the external auths force a token key refresh, which removes the OTPs
        externalAuthsCount(usersId, userId, 0),
        tokenKeyKept("users", userId, false),
        rowsCount("_otps", userId, 0),
        // the password did not change
        rowsCount("_mfas", userId, 1),
        authOriginsCount(usersId, userId, 1),
      ),
    },
    {
      name: "confirm-verification: disabled password auth resets the password",
      ...confirmVerification(mint("verification", "users", userId)),
      prepare: all(withAuthRows, setPasswordAuth("users", false)),
      expectedStatus: 204,
      after: checks(
        rowHas("users", userId, { verified: 1 }),
        externalAuthsCount(usersId, userId, 0),
        tokenKeyKept("users", userId, false),
        rowsCount("_otps", userId, 0),
        rowsCount("_mfas", userId, 0),
        authOriginsCount(usersId, userId, 0),
      ),
    },
    {
      name: "confirm-verification: without external auths the token key stays",
      ...confirmVerification(mint("verification", "clients", "o1y0dd0spd786md"), "clients"),
      expectedStatus: 204,
      after: checks(
        rowHas("clients", "o1y0dd0spd786md", { verified: 1 }),
        tokenKeyKept("clients", "o1y0dd0spd786md", true),
      ),
    },
    {
      name: "confirm-verification: a collection without password auth",
      ...confirmVerification(mint("verification", "nologin", "dc49k6jgejn40h3"), "nologin"),
      expectedStatus: 204,
      after: checks(
        rowHas("nologin", "dc49k6jgejn40h3", { verified: 1 }),
        tokenKeyKept("nologin", "dc49k6jgejn40h3", false),
      ),
    },
    {
      name: "confirm-verification: already verified changes nothing",
      ...confirmVerification(mint("verification", "users", user2Id)),
      expectedStatus: 204,
      after: checks(
        rowHas("users", user2Id, {
          updated: fixtureColumn("users", user2Id, "updated"),
          verified: 1,
        }),
        tokenKeyKept("users", user2Id, true),
      ),
    },
    {
      name: "confirm-password-reset: the rows of an unverified record",
      ...confirmReset(mint("passwordReset", "users", userId)),
      prepare: withAuthRows,
      expectedStatus: 204,
      after: checks(
        rowHas("users", userId, { verified: 1, email }),
        passwordIs("users", userId, newPassword),
        tokenKeyKept("users", userId, false),
        externalAuthsCount(usersId, userId, 0),
        rowsCount("_otps", userId, 0),
        rowsCount("_mfas", userId, 0),
        authOriginsCount(usersId, userId, 0),
      ),
    },
    {
      name: "confirm-password-reset: a verified record keeps its external auths",
      ...confirmReset(mint("passwordReset", "users", userId)),
      prepare: all(verified, withAuthRows),
      expectedStatus: 204,
      after: checks(
        rowHas("users", userId, { verified: 1 }),
        externalAuthsCount(usersId, userId, 2),
        rowsCount("_otps", userId, 0),
        rowsCount("_mfas", userId, 0),
        authOriginsCount(usersId, userId, 0),
      ),
    },
    {
      name: "confirm-password-reset: the same password",
      ...confirmReset(mint("passwordReset", "users", userId), "users", password),
      expectedStatus: 204,
      after: checks(
        passwordIs("users", userId, password),
        rowHas("users", userId, { verified: 1 }),
      ),
    },
    {
      name: "confirm-password-reset: disabled password auth does not block the confirm",
      ...confirmReset(mint("passwordReset", "users", userId)),
      prepare: setPasswordAuth("users", false),
      expectedStatus: 204,
      after: passwordIs("users", userId, newPassword),
    },
    {
      name: "request-password-reset: disabled password auth, before any check of the body",
      ...requestReset("users", `{"email`),
      prepare: setPasswordAuth("users", false),
      expectedStatus: 400,
      expectedContent: [`"message":"The collection is not configured to allow password`],
    },
    {
      name: "the auth rule does not affect request-password-reset",
      ...requestReset("users", { email }),
      prepare: all(smtpToSink(), setAuthRule("users", null)),
      delayMs: 200,
      expectedStatus: 204,
      after: mailSent(email, "/auth/confirm-password-reset"),
    },
    {
      name: "the auth rule does not affect confirm-password-reset",
      ...confirmReset(mint("passwordReset", "users", userId)),
      prepare: setAuthRule("users", null),
      expectedStatus: 204,
      after: passwordIs("users", userId, newPassword),
    },
    {
      name: "the auth rule does not affect confirm-verification",
      ...confirmVerification(mint("verification", "users", userId)),
      prepare: setAuthRule("users", "verified = false && id = ''"),
      expectedStatus: 204,
      after: rowHas("users", userId, { verified: 1 }),
    },
    {
      name: "request-email-change: a token refused by the auth rule still loads",
      ...requestChange("users", "change@example.com", usersToken),
      prepare: all(smtpToSink(), setAuthRule("users", null)),
      expectedStatus: 204,
      after: mailSent("change@example.com", "/auth/confirm-email-change"),
    },

    // email change
    // -----------------------------------------------------------
    {
      name: "request-email-change: the current email",
      ...requestChange("users", email, usersToken),
      expectedStatus: 400,
      expectedContent: [`"data":{"newEmail":{"code":"validation_not_in_invalid"`],
    },
    {
      name: "request-email-change: a too long email",
      ...requestChange("users", `${longLocalPart}@example.com`, usersToken),
      expectedStatus: 400,
      expectedContent: [`"data":{"newEmail":{"code":"validation_length_out_of_range"`],
    },
    {
      name: "request-email-change: an invalid email",
      ...requestChange("users", "invalid", usersToken),
      expectedStatus: 400,
      expectedContent: [`"data":{"newEmail":{"code":"validation_is_email"`],
    },
    {
      name: "request-email-change: taken in another letter case under a NOCASE index",
      ...requestChange("clients", "TEST2@example.com", mint("auth", "clients", "gk390qegs4y47wn")),
      prepare: updateIdentityIndex({ email: "NOCASE" }),
      expectedStatus: 400,
      expectedContent: [`"data":{"newEmail":{"code":"validation_invalid_new_email"`],
    },
    {
      name: "request-email-change: an email of another auth collection is free",
      ...requestChange("clients", "test3@example.com", mint("auth", "clients", "gk390qegs4y47wn")),
      prepare: smtpToSink(),
      expectedStatus: 204,
      after: mailSent("test3@example.com", "/auth/confirm-email-change"),
    },
    {
      name: "request-email-change: a failed send is the response",
      ...requestChange("users", "change@example.com", usersToken),
      expectedStatus: 400,
      expectedContent: [`"message":"Failed to request email change."`, `"data":{}`],
    },
    {
      name: "confirm-email-change: the new email was taken after the request",
      ...confirmChange(emailChange("change@example.com")),
      prepare: setAuthRecordField("users", "test2@example.com", "email", "change@example.com"),
      expectedStatus: 400,
      expectedContent: [
        `"password":{"code":"validation_invalid_password"`,
        `"token":{"code":"validation_invalid_token_email"`,
      ],
    },
    {
      name: "confirm-email-change: the own email in another letter case under a NOCASE index",
      ...confirmChange(
        emailChange("TEST@example.com", "gk390qegs4y47wn", "clients"),
        password,
        "clients",
      ),
      prepare: updateIdentityIndex({ email: "NOCASE" }),
      expectedStatus: 400,
      expectedContent: [`"token":{"code":"validation_invalid_token_email"`],
    },
    {
      name: "confirm-email-change: missing password",
      ...post("users", "confirm-email-change", { token: emailChange("change@example.com") }),
      expectedStatus: 400,
      expectedContent: [`"data":{"password":{"code":"validation_required"`],
    },
    {
      name: "confirm-email-change: a too long password",
      ...confirmChange(emailChange("change@example.com"), "a".repeat(101)),
      expectedStatus: 400,
      expectedContent: [`"data":{"password":{"code":"validation_length_out_of_range"`],
    },
    {
      name: "confirm-email-change: the rows of a verified record",
      ...confirmChange(emailChange("change@example.com", user2Id)),
      prepare: all(
        insertMFA("users", "test2@example.com", "m".repeat(15), "password"),
        insertOTPs("users", "test2@example.com", { id: "o".repeat(15) }),
        insertAuthOrigin("users", "test2@example.com", "fingerprint"),
      ),
      expectedStatus: 204,
      after: checks(
        rowHas("users", user2Id, { verified: 1, email: "change@example.com" }),
        passwordIs("users", user2Id, password),
        tokenKeyKept("users", user2Id, false),
        rowsCount("_otps", user2Id, 0),
        rowsCount("_mfas", user2Id, 1),
        authOriginsCount(usersId, user2Id, 1),
      ),
    },
    {
      name: "confirm-email-change: the rows of an unverified record",
      ...confirmChange(emailChange("change@example.com")),
      prepare: withAuthRows,
      expectedStatus: 204,
      after: checks(
        rowHas("users", userId, { verified: 1, email: "change@example.com" }),
        tokenKeyKept("users", userId, false),
        externalAuthsCount(usersId, userId, 0),
        rowsCount("_otps", userId, 0),
        rowsCount("_mfas", userId, 1),
        authOriginsCount(usersId, userId, 1),
      ),
    },
    {
      name: "confirm-email-change: disabled password auth still asks for the password",
      ...confirmChange(emailChange("change@example.com")),
      prepare: setPasswordAuth("users", false),
      expectedStatus: 204,
      after: rowHas("users", userId, { email: "change@example.com" }),
    },
    {
      name: "confirm-email-change: the email field's domains fail on the save",
      ...confirmChange(emailChange("change@example.com")),
      prepare: setEmailDomains("users", ["iglo.test"]),
      expectedStatus: 400,
      expectedContent: [`"data":{"email":{"code":"validation_email_domain_not_allowed"`],
      after: rowHas("users", userId, { email, verified: 0 }),
    },
  ];
}
