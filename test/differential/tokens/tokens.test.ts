// Record tokens (src/records/record-tokens.ts), FindAuthRecordByToken
// (src/records/record-query.ts), loadAuthToken and the Require* guards
// (src/middlewares/) against the reference PocketBase v0.41.0 binary. Not
// part of `bun test`: run `bun run test:reference`.
//
// A fresh upstream install (superuser upsert, then serve) gets two auth
// collections through its API, `members` (list and view rules
// `@request.auth.id != ""`, a protected file field) and `staff`, their
// users and a second superuser, and sends its mails to the harness's
// Mailpit. Upstream issues every token type it exposes: auth-with-password,
// impersonate with a duration (static), POST /api/files/token, and the
// verification, password-reset and email-change tokens read from the
// mails. Upstream stops and its pb_data is the base state; each side then
// runs on its own copy of it.
//
//   (a) iglo.base's FindAuthRecordByToken verifies every upstream token and
//       loads the same record; it rejects each one for the other types,
//       after its exp (clock moved), with a tampered signature or payload,
//       and malformed. The same Authorization headers (raw, "Bearer "
//       variants, broken, other token types) go to upstream's guarded
//       endpoints (RequireSuperuserAuth: GET /api/collections; RequireAuth:
//       POST /api/files/token; RequireSameCollectionContextAuth: POST
//       auth-refresh of members, staff and _superusers) and to
//       iglo.base's default router with the same guards on test routes at
//       the same paths: the error statuses and bodies must be the same
//       bytes, and the successes must load the same record. (A missing
//       collection is not compared: upstream's collectionPathRateLimit,
//       which runs before the guard, answers 404 for it.)
//   (b) iglo.base signs each token type for the same records. With the
//       clock at upstream's issue second the tokens are byte-identical to
//       upstream's; with the real clock exp is now + duration, as
//       upstream's. Upstream, on its own copy, accepts them: auth-refresh
//       and the members list (auth), GET /api/collections (superuser), a
//       protected file download (file), and confirm-verification,
//       confirm-email-change and confirm-password-reset, which change the
//       records as upstream's own tokens do. A token signed with an
//       expired clock is rejected by both.
//   (c) Upstream then changes one user's tokenKey (SQL), another's
//       password, the staff collection's auth token secret, and deletes a
//       user. The upstream tokens of those users are rejected by upstream,
//       and, on a copy of the changed pb_data, by iglo.base with the error
//       FindAuthRecordByToken returns; an unchanged user's token stays
//       valid on both.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newRouter } from "@/apis/base";
import { newApp } from "@/app/app";
import type { Clock } from "@/app/clock";
import type { RequestEvent } from "@/app/event-request";
import {
  findCachedCollectionByNameOrId,
  reloadCachedCollections,
} from "@/collections/collection-query";
import {
  requireAuth,
  requireSameCollectionContextAuth,
  requireSuperuserAuth,
} from "@/middlewares/require-auth";
import type { Record } from "@/records/record-model";
import { findAuthRecordByEmail, findAuthRecordByToken } from "@/records/record-query";
import {
  TokenTypeAuth,
  TokenTypeEmailChange,
  TokenTypeFile,
  TokenTypePasswordReset,
  TokenTypeVerification,
  newAuthToken,
  newEmailChangeToken,
  newFileToken,
  newPasswordResetToken,
  newStaticAuthToken,
  newVerificationToken,
} from "@/records/record-tokens";
import { RawURLEncoding } from "@/tools/security/base64";

import { openDataDir, type TestCollectionsApp } from "@test/collections/app";
import { runUpstream } from "@test/differential/db/fixture";
import { copyDataDir } from "@test/scenarios/fixture";
import { type Mailpit, startMailpit } from "@test/support/mailpit";
import { serveTest } from "@test/support/router";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

const password = "1234567890";
const superEmail = "tokens@example.com";
const super2Email = "tokens2@example.com";
const staticDuration = 3600;
const Second = 1_000_000_000n;

// members: alice (verification, file), bob (email change), carol (password
// reset), dave (tokenKey change), erin (password change), gina (deleted);
// staff: frank (secret change)
const members = ["alice", "bob", "carol", "dave", "erin", "gina"] as const;
const email = (name: string): string => `${name}@example.com`;
const bobNewEmail = "bob-new@example.com";

let root: string;
let baseDir: string;
let upstream: UpstreamServer | undefined;
let mailpit: Mailpit | undefined;

let superToken = "";
const ids = new Map<string, string>();
let aliceFile = "";

// the upstream tokens, by name ("alice:auth", "super:file", ...)
const upstreamTokens = new Map<string, string>();
// the Unix second before and after each upstream token was issued
const issuedAt = new Map<string, [number, number]>();

// every token type that upstream issued, with the record and type
const tokenCases: { name: string; who: string; collection: string; type: string }[] = [
  { name: "alice:auth", who: "alice", collection: "members", type: TokenTypeAuth },
  { name: "alice:static", who: "alice", collection: "members", type: TokenTypeAuth },
  { name: "alice:file", who: "alice", collection: "members", type: TokenTypeFile },
  { name: "alice:verification", who: "alice", collection: "members", type: TokenTypeVerification },
  { name: "bob:emailChange", who: "bob", collection: "members", type: TokenTypeEmailChange },
  {
    name: "carol:passwordReset",
    who: "carol",
    collection: "members",
    type: TokenTypePasswordReset,
  },
  { name: "frank:auth", who: "frank", collection: "staff", type: TokenTypeAuth },
  { name: "super:auth", who: "super", collection: "_superusers", type: TokenTypeAuth },
  { name: "super:static", who: "super", collection: "_superusers", type: TokenTypeAuth },
  { name: "super:file", who: "super", collection: "_superusers", type: TokenTypeFile },
  { name: "super2:auth", who: "super2", collection: "_superusers", type: TokenTypeAuth },
];
const allTypes = [
  TokenTypeAuth,
  TokenTypeFile,
  TokenTypeVerification,
  TokenTypePasswordReset,
  TokenTypeEmailChange,
];

function emailOf(who: string): string {
  if (who === "super") {
    return superEmail;
  }
  if (who === "super2") {
    return super2Email;
  }
  return email(who);
}

function upstreamToken(name: string): string {
  const token = upstreamTokens.get(name);
  if (token === undefined) {
    throw new Error(`no upstream token ${name}`);
  }
  return token;
}

interface Response_ {
  status: number;
  text: string;
  json: unknown;
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  auth = superToken,
): Promise<Response_> {
  if (upstream === undefined) {
    throw new Error("upstream is not running");
  }
  const headers: { [key: string]: string } = {};
  if (auth !== "") {
    headers.authorization = auth;
  }
  const init: RequestInit = { method, headers };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${upstream.url}${path}`, init);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text === "" ? null : (JSON.parse(text) as unknown);
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

async function ok(
  method: string,
  path: string,
  body?: unknown,
  auth = superToken,
): Promise<unknown> {
  const res = await api(method, path, body, auth);
  if (res.status !== 200 && res.status !== 204) {
    throw new Error(`${method} ${path}: ${res.status} ${res.text}`);
  }
  return res.json;
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

// issues a token on upstream and records the second range around it
async function issue(name: string, fn: () => Promise<string>): Promise<void> {
  const before = unixNow();
  const token = await fn();
  issuedAt.set(name, [before, unixNow()]);
  upstreamTokens.set(name, token);
}

async function signIn(collection: string, identity: string): Promise<string> {
  const res = (await ok(
    "POST",
    `/api/collections/${collection}/auth-with-password`,
    { identity, password },
    "",
  )) as { token: string };
  return res.token;
}

// the token in the newest mail to `to` (polls Mailpit: upstream sends in
// the background)
async function tokenFromMail(to: string): Promise<string> {
  if (mailpit === undefined) {
    throw new Error("mailpit is not running");
  }
  for (let i = 0; i < 200; i++) {
    const list = (await fetch(`${mailpit.apiUrl}/api/v1/messages`).then((r) => r.json())) as {
      messages: { ID: string; To: { Address: string }[] }[];
    };
    const summary = list.messages.find((m) => m.To.some((t) => t.Address === to));
    if (summary !== undefined) {
      const message = (await fetch(`${mailpit.apiUrl}/api/v1/message/${summary.ID}`).then((r) =>
        r.json(),
      )) as { Text: string };
      const match = /eyJ[\w-]+\.[\w-]+\.[\w-]+/.exec(message.Text);
      if (match === null) {
        throw new Error(`no token in the mail to ${to}`);
      }
      return match[0];
    }
    await Bun.sleep(50);
  }
  throw new Error(`no mail to ${to}`);
}

function claimsJSON(token: string): string {
  return new TextDecoder().decode(RawURLEncoding.decodeString(token.split(".")[1] as string));
}

function claimsOf(token: string): { [key: string]: unknown } {
  return JSON.parse(claimsJSON(token)) as { [key: string]: unknown };
}

// -------------------------------------------------------------------
// iglo.base side

// a mutable clock: real time unless a check sets it
let fixedMs: number | undefined;
const clock: Clock = { now: () => new Date(fixedMs ?? Date.now()) };

function openCopy(fromDir: string, name: string): TestCollectionsApp {
  const copyDir = join(root, name, "pb_data");
  copyDataDir(fromDir, copyDir);
  const app = openDataDir(copyDir, clock);
  reloadCachedCollections(app);
  return app;
}

function atSecond<T>(unixSec: number | undefined, fn: () => T): T {
  fixedMs = unixSec === undefined ? undefined : unixSec * 1000;
  try {
    return fn();
  } finally {
    fixedMs = undefined;
  }
}

// FindAuthRecordByToken as "collectionName/id", or the error text
function lookup(app: TestCollectionsApp, token: string, ...types: string[]): string {
  try {
    const record = findAuthRecordByToken(app, token, ...types);
    return `${record.collection().name}/${record.id}`;
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }
}

// the loaded record (the test routes' response)
const authId = (e: RequestEvent) =>
  e.json(200, { record: { id: e.auth?.id, collectionName: e.auth?.collection().name } });

// iglo.base's default router on an App over app's databases and upstream's
// guarded endpoints as test routes (same paths and guards)
function guardRouter(app: TestCollectionsApp) {
  const router = newRouter(
    newApp({
      dataDir: "/tmp/pb_data",
      isDev: false,
      encryptionEnv: "",
      queryTimeout: 30,
      clock,
      logger: app.logger,
      databases: app.databases,
      store: app.store,
    }),
  );
  router.GET("/api/collections", authId).bind(requireSuperuserAuth());
  router.POST("/api/files/token", authId).bind(requireAuth());
  router
    .POST("/api/collections/{collection}/auth-refresh", authId)
    .bind(requireSameCollectionContextAuth(""));
  return router.buildMux();
}

// -------------------------------------------------------------------

interface GuardCase {
  name: string;
  // the Authorization header (undefined: none)
  header: () => string | undefined;
}

const tamper = (token: string, at: number): string => {
  const parts = token.split(".") as [string, string, string];
  const segment = parts[at] as string;
  const c = segment[5] === "A" ? "B" : "A";
  parts[at] = segment.slice(0, 5) + c + segment.slice(6);
  return parts.join(".");
};

const guardCases: GuardCase[] = [
  { name: "no header", header: () => undefined },
  { name: "empty", header: () => "" },
  { name: "alice auth", header: () => upstreamToken("alice:auth") },
  { name: "alice auth, Bearer", header: () => "Bearer " + upstreamToken("alice:auth") },
  { name: "alice auth, bearer", header: () => "bearer " + upstreamToken("alice:auth") },
  { name: "alice auth, BEARER", header: () => "BEARER " + upstreamToken("alice:auth") },
  { name: "alice auth, Bearer + 2 spaces", header: () => "Bearer  " + upstreamToken("alice:auth") },
  {
    name: "alice auth, Bearer twice",
    header: () => "Bearer Bearer " + upstreamToken("alice:auth"),
  },
  { name: "alice auth, Bearer no space", header: () => "Bearer" + upstreamToken("alice:auth") },
  { name: "alice auth, Token scheme", header: () => "Token " + upstreamToken("alice:auth") },
  { name: "Bearer only", header: () => "Bearer " },
  { name: "Bearer word", header: () => "Bearer" },
  { name: "alice static", header: () => upstreamToken("alice:static") },
  { name: "alice file token", header: () => upstreamToken("alice:file") },
  { name: "alice verification token", header: () => upstreamToken("alice:verification") },
  { name: "carol password reset token", header: () => upstreamToken("carol:passwordReset") },
  { name: "bob email change token", header: () => upstreamToken("bob:emailChange") },
  { name: "alice auth, tampered signature", header: () => tamper(upstreamToken("alice:auth"), 2) },
  { name: "alice auth, tampered payload", header: () => tamper(upstreamToken("alice:auth"), 1) },
  { name: "alice auth, tampered header", header: () => tamper(upstreamToken("alice:auth"), 0) },
  { name: "alice auth, truncated", header: () => upstreamToken("alice:auth").slice(0, -3) },
  {
    name: "alice auth, 2 segments",
    header: () => upstreamToken("alice:auth").split(".").slice(0, 2).join("."),
  },
  { name: "malformed", header: () => "abc" },
  { name: "empty segments", header: () => ".." },
  { name: "frank auth", header: () => upstreamToken("frank:auth") },
  { name: "superuser auth", header: () => upstreamToken("super:auth") },
  { name: "superuser auth, Bearer", header: () => "Bearer " + upstreamToken("super:auth") },
  { name: "superuser static", header: () => upstreamToken("super:static") },
  { name: "superuser file token", header: () => upstreamToken("super:file") },
  { name: "second superuser auth", header: () => upstreamToken("super2:auth") },
];

const guardEndpoints: { method: string; path: string }[] = [
  { method: "GET", path: "/api/collections" },
  { method: "POST", path: "/api/files/token" },
  { method: "POST", path: "/api/collections/members/auth-refresh" },
  { method: "POST", path: "/api/collections/staff/auth-refresh" },
  { method: "POST", path: "/api/collections/_superusers/auth-refresh" },
];

interface GuardOutcome {
  status: number;
  // the error body, or the loaded record ("collectionName/id")
  body: string;
}

// upstream's success responses carry the record (auth-refresh) or nothing
// that names it (collections list, file token): the record is checked
// where the response has it
function upstreamOutcome(path: string, res: Response_): GuardOutcome {
  if (res.status >= 200 && res.status < 300) {
    const record = (res.json as { record?: { id: string; collectionName: string } }).record;
    return {
      status: 200,
      body:
        record === undefined || !path.endsWith("auth-refresh")
          ? "ok"
          : `${record.collectionName}/${record.id}`,
    };
  }
  return { status: res.status, body: res.text };
}

function igloOutcome(path: string, status: number, text: string): GuardOutcome {
  if (status >= 200 && status < 300) {
    const record = (JSON.parse(text) as { record: { id: string; collectionName: string } }).record;
    return {
      status: 200,
      body: path.endsWith("auth-refresh") ? `${record.collectionName}/${record.id}` : "ok",
    };
  }
  return { status, body: text };
}

const upstreamGuards = new Map<string, GuardOutcome>();

// (b): what upstream answered for each iglo.base token check
const acceptance = new Map<string, unknown>();
// (b): iglo.base's tokens with the real clock, and their issue seconds
const igloTokens = new Map<string, string>();
const igloIssued = new Map<string, [number, number]>();
const igloToken = (name: string): string => igloTokens.get(name) as string;
// (c): upstream's outcome for the old tokens after the changes
const changedUpstream = new Map<string, number>();

// -------------------------------------------------------------------

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "iglo-base-tokens-ref-"));
  baseDir = join(root, "base", "pb_data");
  const upsert = await runUpstream(
    ["superuser", "upsert", superEmail, password, "--dir", baseDir],
    root,
  );
  expect(upsert.exitCode).toBe(0);
  mailpit = await startMailpit();
  upstream = await startUpstream({ dataDir: baseDir });

  superToken = await signIn("_superusers", superEmail);

  await ok("PATCH", "/api/settings", {
    meta: {
      appURL: "http://127.0.0.1",
      senderName: "Tokens",
      senderAddress: "tokens@example.test",
    },
    smtp: { enabled: true, host: "127.0.0.1", port: mailpit.smtpPort },
  });

  const authRule = '@request.auth.id != ""';
  await ok("POST", "/api/collections", {
    name: "members",
    type: "auth",
    listRule: authRule,
    viewRule: authRule,
    fields: [{ name: "doc", type: "file", protected: true, maxSelect: 1, maxSize: 1048576 }],
  });
  await ok("POST", "/api/collections", { name: "staff", type: "auth" });

  for (const name of members) {
    const rec = (await ok("POST", "/api/collections/members/records", {
      email: email(name),
      password,
      passwordConfirm: password,
    })) as { id: string };
    ids.set(name, rec.id);
  }
  const frank = (await ok("POST", "/api/collections/staff/records", {
    email: email("frank"),
    password,
    passwordConfirm: password,
  })) as { id: string };
  ids.set("frank", frank.id);
  const super2 = (await ok("POST", "/api/collections/_superusers/records", {
    email: super2Email,
    password,
    passwordConfirm: password,
  })) as { id: string };
  ids.set("super2", super2.id);
  const superList = (await ok(
    "GET",
    `/api/collections/_superusers/records?filter=${encodeURIComponent(`email="${superEmail}"`)}`,
  )) as { items: { id: string }[] };
  ids.set("super", superList.items[0]?.id ?? "");

  const form = new FormData();
  form.append("doc", new File(["hello"], "doc.txt", { type: "text/plain" }));
  const alice = (await ok(
    "PATCH",
    `/api/collections/members/records/${ids.get("alice")}`,
    form,
  )) as {
    doc: string;
  };
  aliceFile = alice.doc;

  // upstream's tokens
  for (const name of [...members, "frank"]) {
    const collection = name === "frank" ? "staff" : "members";
    await issue(`${name}:auth`, () => signIn(collection, email(name)));
  }
  await issue("super:auth", () => signIn("_superusers", superEmail));
  superToken = upstreamToken("super:auth");
  await issue("super2:auth", () => signIn("_superusers", super2Email));
  await issue("alice:static", async () => {
    const res = (await ok("POST", `/api/collections/members/impersonate/${ids.get("alice")}`, {
      duration: staticDuration,
    })) as { token: string };
    return res.token;
  });
  await issue("super:static", async () => {
    const res = (await ok("POST", `/api/collections/_superusers/impersonate/${ids.get("super")}`, {
      duration: staticDuration,
    })) as { token: string };
    return res.token;
  });
  await issue("alice:file", async () => {
    const res = (await ok("POST", "/api/files/token", undefined, upstreamToken("alice:auth"))) as {
      token: string;
    };
    return res.token;
  });
  await issue("super:file", async () => {
    const res = (await ok("POST", "/api/files/token")) as { token: string };
    return res.token;
  });
  await issue("alice:verification", async () => {
    await ok(
      "POST",
      "/api/collections/members/request-verification",
      { email: email("alice") },
      "",
    );
    return tokenFromMail(email("alice"));
  });
  await issue("carol:passwordReset", async () => {
    await ok(
      "POST",
      "/api/collections/members/request-password-reset",
      { email: email("carol") },
      "",
    );
    return tokenFromMail(email("carol"));
  });
  await issue("bob:emailChange", async () => {
    await ok(
      "POST",
      "/api/collections/members/request-email-change",
      { newEmail: bobNewEmail },
      upstreamToken("bob:auth"),
    );
    return tokenFromMail(bobNewEmail);
  });

  // (a) upstream's guarded endpoints
  for (const gc of guardCases) {
    for (const ep of guardEndpoints) {
      const res = await api(ep.method, ep.path, undefined, gc.header() ?? "");
      upstreamGuards.set(`${gc.name} ${ep.method} ${ep.path}`, upstreamOutcome(ep.path, res));
    }
  }

  await upstream.stop();
  upstream = undefined;
}, 120_000);

afterAll(async () => {
  await upstream?.stop();
  await mailpit?.stop();
  rmSync(root, { recursive: true, force: true });
});

// -------------------------------------------------------------------
// (a) upstream's tokens in iglo.base

test("(a) every upstream token loads its record, for its own type only", () => {
  const app = openCopy(baseDir, "a-lookup");
  try {
    for (const tc of tokenCases) {
      const token = upstreamToken(tc.name);
      const expected = `${tc.collection}/${ids.get(tc.who)}`;
      expect({ name: tc.name, got: lookup(app, token) }).toEqual({ name: tc.name, got: expected });
      expect({ name: tc.name, got: lookup(app, token, tc.type) }).toEqual({
        name: tc.name,
        got: expected,
      });
      for (const other of allTypes.filter((t) => t !== tc.type)) {
        expect({ name: tc.name, other, got: lookup(app, token, other) }).toEqual({
          name: tc.name,
          other,
          got: `error: invalid token type "${tc.type}", expects "${other}"`,
        });
      }
      expect(lookup(app, token, TokenTypeFile, tc.type)).toBe(expected);
    }
  } finally {
    app.cleanup();
  }
});

test("(a) upstream tokens expire at their exp second on the iglo.base clock", () => {
  const app = openCopy(baseDir, "a-expiry");
  try {
    for (const tc of tokenCases) {
      const token = upstreamToken(tc.name);
      const exp = claimsOf(token).exp as number;
      const expected = `${tc.collection}/${ids.get(tc.who)}`;
      // the last valid moment is just before exp
      fixedMs = exp * 1000 - 1;
      expect({ name: tc.name, got: lookup(app, token) }).toEqual({ name: tc.name, got: expected });
      fixedMs = exp * 1000;
      expect({ name: tc.name, got: lookup(app, token) }).toEqual({
        name: tc.name,
        got: "error: token has invalid claims: token is expired",
      });
      fixedMs = undefined;
    }
  } finally {
    fixedMs = undefined;
    app.cleanup();
  }
});

test("(a) tampered and malformed upstream tokens are rejected", () => {
  const app = openCopy(baseDir, "a-broken");
  try {
    const token = upstreamToken("alice:auth");
    expect(lookup(app, tamper(token, 2))).toBe(
      "error: token signature is invalid: signature is invalid",
    );
    expect(lookup(app, token.slice(0, -3))).toBe(
      "error: token signature is invalid: signature is invalid",
    );
    expect(lookup(app, "Bearer " + token)).toBe(
      "error: token is malformed: could not base64 decode header",
    );
    expect(lookup(app, "abc")).toBe(
      "error: token is malformed: token contains an invalid number of segments",
    );
    expect(lookup(app, "")).toBe("error: missing token");
    // a payload naming another user, with alice's signature
    const parts = token.split(".") as [string, string, string];
    const claims = claimsJSON(token).replace(ids.get("alice") as string, ids.get("dave") as string);
    const forged = [
      parts[0],
      RawURLEncoding.encodeToString(new TextEncoder().encode(claims)),
      parts[2],
    ].join(".");
    expect(lookup(app, forged)).toBe("error: token signature is invalid: signature is invalid");
  } finally {
    app.cleanup();
  }
});

test("(a) the guarded endpoints answer as upstream's for every Authorization header", async () => {
  const app = openCopy(baseDir, "a-guards");
  try {
    const mux = guardRouter(app);
    for (const gc of guardCases) {
      for (const ep of guardEndpoints) {
        const header = gc.header();
        const res = await serveTest(mux, {
          method: ep.method,
          target: ep.path,
          headers: header === undefined ? {} : { Authorization: header },
        });
        const key = `${gc.name} ${ep.method} ${ep.path}`;
        const outcome = igloOutcome(ep.path, res.status, await res.text());
        expect({ key, outcome }).toEqual({ key, outcome: upstreamGuards.get(key) as GuardOutcome });
      }
    }
  } finally {
    app.cleanup();
  }
});

// -------------------------------------------------------------------
// (b) iglo.base's tokens in upstream

function igloRecord(app: TestCollectionsApp, who: string): Record {
  const collection =
    who === "frank" ? "staff" : who.startsWith("super") ? "_superusers" : "members";
  return findAuthRecordByEmail(app, collection, emailOf(who));
}

// signs the token type of a token case for its record
function igloSign(app: TestCollectionsApp, name: string): string {
  const [who, kind] = name.split(":") as [string, string];
  const record = igloRecord(app, who);
  switch (kind) {
    case "auth":
      return newAuthToken(record, clock);
    case "static":
      return newStaticAuthToken(record, BigInt(staticDuration) * Second, clock);
    case "file":
      return newFileToken(record, clock);
    case "verification":
      return newVerificationToken(record, clock);
    case "passwordReset":
      return newPasswordResetToken(record, clock);
    case "emailChange":
      return newEmailChangeToken(record, bobNewEmail, clock);
  }
  throw new Error(`unknown token case ${name}`);
}

function durationOf(
  app: TestCollectionsApp,
  tc: { name: string; collection: string; type: string },
): number {
  if (tc.name.endsWith(":static")) {
    return staticDuration;
  }
  const c = findCachedCollectionByNameOrId(app, tc.collection);
  switch (tc.type) {
    case TokenTypeAuth:
      return Number(c.authToken.duration);
    case TokenTypeFile:
      return Number(c.fileToken.duration);
    case TokenTypeVerification:
      return Number(c.verificationToken.duration);
    case TokenTypePasswordReset:
      return Number(c.passwordResetToken.duration);
    default:
      return Number(c.emailChangeToken.duration);
  }
}

test("(b) at upstream's issue second, iglo.base signs the same token bytes", () => {
  const app = openCopy(baseDir, "b-bytes");
  try {
    for (const tc of tokenCases) {
      const token = upstreamToken(tc.name);
      const exp = claimsOf(token).exp as number;
      const duration = durationOf(app, tc);
      const [before, after] = issuedAt.get(tc.name) as [number, number];
      // upstream's exp is its issue second + duration
      expect({
        name: tc.name,
        issued: exp - duration >= before && exp - duration <= after,
      }).toEqual({
        name: tc.name,
        issued: true,
      });
      const signed = atSecond(exp - duration, () => igloSign(app, tc.name));
      expect({ name: tc.name, token: signed }).toEqual({ name: tc.name, token });
    }
  } finally {
    app.cleanup();
  }
});

beforeAll(async () => {
  // (b) and (c) run after the upstream setup above (bun runs beforeAll
  // hooks in order): iglo.base signs on its copy, upstream checks on its own
  const app = openCopy(baseDir, "b-sign");
  try {
    for (const tc of tokenCases) {
      const before = unixNow();
      igloTokens.set(tc.name, igloSign(app, tc.name));
      igloIssued.set(tc.name, [before, unixNow()]);
    }
    // an auth token that expired a second ago
    const past = unixNow() - durationOf(app, tokenCases[0]!) - 1;
    igloTokens.set(
      "alice:expired",
      atSecond(past, () => igloSign(app, "alice:auth")),
    );
    expect(lookup(app, igloTokens.get("alice:expired") as string)).toBe(
      "error: token has invalid claims: token is expired",
    );
  } finally {
    app.cleanup();
  }

  const upstreamDir = join(root, "b-upstream", "pb_data");
  copyDataDir(baseDir, upstreamDir);
  upstream = await startUpstream({ dataDir: upstreamDir });
  superToken = await signIn("_superusers", superEmail);

  for (const name of [
    "alice:auth",
    "alice:static",
    "frank:auth",
    "super:auth",
    "super:static",
    "super2:auth",
    "alice:expired",
  ]) {
    const collection = name.startsWith("frank")
      ? "staff"
      : name.startsWith("super")
        ? "_superusers"
        : "members";
    const refresh = await api(
      "POST",
      `/api/collections/${collection}/auth-refresh`,
      undefined,
      igloToken(name),
    );
    const record = (refresh.json as { record?: { id: string } } | null)?.record;
    // upstream refreshes refreshable tokens (a new token, the same bytes
    // within the same second) and returns static ones as they are
    const returned = (refresh.json as { token?: string } | null)?.token;
    let token: string | undefined;
    if (returned !== undefined) {
      if (name.endsWith(":static")) {
        token = returned === igloToken(name) ? "the same" : "another";
      } else {
        token = claimsOf(returned).refreshable === true ? "refreshable" : "not refreshable";
      }
    }
    acceptance.set(`${name} auth-refresh`, { status: refresh.status, id: record?.id, token });
  }
  for (const name of ["alice:auth", "alice:static", "super:auth", "alice:expired"]) {
    const list = await api(
      "GET",
      "/api/collections/members/records?perPage=1",
      undefined,
      igloToken(name),
    );
    acceptance.set(`${name} members list`, {
      status: list.status,
      totalItems: (list.json as { totalItems?: number }).totalItems,
    });
  }
  for (const name of ["super:auth", "super:static", "super2:auth", "alice:auth"]) {
    const res = await api("GET", "/api/collections?perPage=1", undefined, igloToken(name));
    acceptance.set(`${name} collections`, res.status);
  }
  for (const name of ["alice:file", "super:file", "alice:auth"]) {
    const res = await fetch(
      `${upstream.url}/api/files/members/${ids.get("alice")}/${aliceFile}?token=${igloToken(name)}`,
    );
    acceptance.set(`${name} file`, { status: res.status, body: await res.text() });
  }

  const verify = await api(
    "POST",
    "/api/collections/members/confirm-verification",
    { token: igloToken("alice:verification") },
    "",
  );
  const alice = (await ok("GET", `/api/collections/members/records/${ids.get("alice")}`)) as {
    verified: boolean;
  };
  acceptance.set("alice:verification confirm", { status: verify.status, verified: alice.verified });

  const change = await api(
    "POST",
    "/api/collections/members/confirm-email-change",
    { token: igloToken("bob:emailChange"), password },
    "",
  );
  const bob = (await ok("GET", `/api/collections/members/records/${ids.get("bob")}`)) as {
    email: string;
  };
  acceptance.set("bob:emailChange confirm", { status: change.status, email: bob.email });

  const newPassword = "0987654321";
  const reset = await api(
    "POST",
    "/api/collections/members/confirm-password-reset",
    {
      token: igloToken("carol:passwordReset"),
      password: newPassword,
      passwordConfirm: newPassword,
    },
    "",
  );
  const carolLogin = await api(
    "POST",
    "/api/collections/members/auth-with-password",
    { identity: email("carol"), password: newPassword },
    "",
  );
  acceptance.set("carol:passwordReset confirm", { status: reset.status, login: carolLogin.status });

  // (c) the changes, on the same upstream
  await ok("POST", "/api/sql", {
    query: `UPDATE members SET tokenKey = 'changed-token-key-for-dave-0123456789' WHERE id = '${ids.get("dave")}'`,
  });
  await ok("PATCH", `/api/collections/members/records/${ids.get("erin")}`, {
    password: "erin-new-password",
    passwordConfirm: "erin-new-password",
  });
  await ok("PATCH", "/api/collections/staff", {
    authToken: { secret: "a-new-staff-auth-token-secret-0123456789abcdef" },
  });
  await ok("DELETE", `/api/collections/members/records/${ids.get("gina")}`);
  for (const name of ["dave:auth", "erin:auth", "frank:auth", "gina:auth", "alice:auth"]) {
    const collection = name.startsWith("frank") ? "staff" : "members";
    const res = await api(
      "POST",
      `/api/collections/${collection}/auth-refresh`,
      undefined,
      upstreamToken(name),
    );
    changedUpstream.set(name, res.status);
  }

  await upstream.stop();
  upstream = undefined;
}, 120_000);

test("(b) with the real clock, exp is the issue second + the duration, as upstream's", () => {
  const app = openCopy(baseDir, "b-claims");
  try {
    for (const tc of tokenCases) {
      const up = upstreamToken(tc.name);
      const own = igloTokens.get(tc.name) as string;
      const duration = durationOf(app, tc);
      const [before, after] = igloIssued.get(tc.name) as [number, number];
      const exp = claimsOf(own).exp as number;
      expect({ name: tc.name, ok: exp - duration >= before && exp - duration <= after }).toEqual({
        name: tc.name,
        ok: true,
      });
      // the same claim names, order and values apart from exp
      const upExp = claimsOf(up).exp as number;
      expect({ name: tc.name, claims: claimsJSON(own).replace(`"exp":${exp}`, '"exp":0') }).toEqual(
        {
          name: tc.name,
          claims: claimsJSON(up).replace(`"exp":${upExp}`, '"exp":0'),
        },
      );
      expect(own.split(".")[0]).toBe(up.split(".")[0] as string);
    }
  } finally {
    app.cleanup();
  }
});

test("(b) upstream accepts iglo.base's auth tokens", () => {
  const alice = ids.get("alice");
  expect(
    Object.fromEntries(
      [...acceptance].filter(([k]) => !k.includes("confirm") && !k.endsWith(" file")),
    ),
  ).toEqual({
    "alice:auth auth-refresh": { status: 200, id: alice, token: "refreshable" },
    // static tokens are not refreshed
    "alice:static auth-refresh": { status: 200, id: alice, token: "the same" },
    "frank:auth auth-refresh": { status: 200, id: ids.get("frank"), token: "refreshable" },
    "super:auth auth-refresh": { status: 200, id: ids.get("super"), token: "refreshable" },
    "super:static auth-refresh": { status: 200, id: ids.get("super"), token: "the same" },
    "super2:auth auth-refresh": { status: 200, id: ids.get("super2"), token: "refreshable" },
    "alice:expired auth-refresh": {
      status: 401,
      id: undefined,
      token: undefined,
    },
    "alice:auth members list": { status: 200, totalItems: members.length },
    "alice:static members list": { status: 200, totalItems: members.length },
    "super:auth members list": { status: 200, totalItems: members.length },
    // a guest by the list rule
    "alice:expired members list": { status: 200, totalItems: 0 },
    "super:auth collections": 200,
    "super:static collections": 200,
    "super2:auth collections": 200,
    "alice:auth collections": 403,
  });
});

test("(b) upstream accepts iglo.base's file tokens for a protected file", () => {
  expect(acceptance.get("alice:file file")).toEqual({ status: 200, body: "hello" });
  expect(acceptance.get("super:file file")).toEqual({ status: 200, body: "hello" });
  // an auth token is not a file token
  expect((acceptance.get("alice:auth file") as { status: number }).status).toBe(404);
});

test("(b) upstream confirms with iglo.base's verification, email change and password reset tokens", () => {
  expect(acceptance.get("alice:verification confirm")).toEqual({ status: 204, verified: true });
  expect(acceptance.get("bob:emailChange confirm")).toEqual({ status: 204, email: bobNewEmail });
  expect(acceptance.get("carol:passwordReset confirm")).toEqual({ status: 204, login: 200 });
});

// -------------------------------------------------------------------
// (c) changed records and secrets

test("(c) a changed tokenKey, password or secret and a deleted record reject the old tokens on both", () => {
  expect(Object.fromEntries(changedUpstream)).toEqual({
    "dave:auth": 401,
    "erin:auth": 401,
    "frank:auth": 401,
    "gina:auth": 401,
    "alice:auth": 200,
  });

  const app = openCopy(join(root, "b-upstream", "pb_data"), "c-lookup");
  try {
    expect({
      dave: lookup(app, upstreamToken("dave:auth")),
      erin: lookup(app, upstreamToken("erin:auth")),
      frank: lookup(app, upstreamToken("frank:auth")),
      gina: lookup(app, upstreamToken("gina:auth")),
      alice: lookup(app, upstreamToken("alice:auth")),
    }).toEqual({
      dave: "error: token signature is invalid: signature is invalid",
      erin: "error: token signature is invalid: signature is invalid",
      frank: "error: token signature is invalid: signature is invalid",
      gina: "error: sql: no rows in result set",
      alice: `members/${ids.get("alice")}`,
    });
    // bob's and carol's tokenKeys changed with the confirmations (email
    // change and password reset), on both sides
    expect(lookup(app, upstreamToken("bob:auth"))).toBe(
      "error: token signature is invalid: signature is invalid",
    );
    expect(lookup(app, upstreamToken("carol:auth"))).toBe(
      "error: token signature is invalid: signature is invalid",
    );
  } finally {
    app.cleanup();
  }
});
