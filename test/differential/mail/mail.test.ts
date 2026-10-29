// The mailer (src/mail) against the reference PocketBase v0.41.0 binary,
// both sending to the same Mailpit. Not part of `bun test`: run
// `bun run test:reference`.
//
// Each case runs on both servers in turn, each on its own copy of
// upstream's fixture: the settings are changed through PATCH
// /api/settings (and the users collection through the Collections API),
// as the dashboard changes them; then the request is sent and the message
// Mailpit received is read back raw. The raw messages must be the same
// after normalizing what differs per send: the Date and Message-ID header
// values (checked against their formats), the MIME boundaries (60 hex
// characters), Mailpit's Received timestamp, the alert info's timestamp,
// and the tokens, whose claims are compared instead (exp within a minute).
// Quoted-printable soft line breaks are removed first, so a token is one
// word. The responses must be equal (status and JSON body).
//
// Covered: the test email of every template (verification, password-reset,
// email-change, otp, login-alert) for the superusers and users
// collections; a custom template with every placeholder kind and a
// non-ASCII sender name and subject; SMTP AUTH PLAIN and LOGIN, a wrong
// password, credentials over an unencrypted connection to a host other
// than localhost, a refused connection; the form's validation errors;
// sendmail through a stub `sendmail` on PATH that keeps its arguments and
// stdin; the login alert of a password login from a new device and none
// from a known one.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { superuserToken } from "@test/scenarios/record-crud";
import { freePort, startServer } from "@test/support/executable";
import { type Mailpit, startMailpit } from "@test/support/mailpit";
import { startUpstream } from "@test/support/upstream";

// starting and stopping the servers is slow on some runners
const timeout = 120_000;

interface Server {
  url: string;
  stop(): Promise<unknown>;
}

const roots: string[] = [];
const running: Server[] = [];
const mailpits: Mailpit[] = [];

let mailpit: Mailpit;
// SMTP AUTH required (user "mailer", password "secret"), insecure auth allowed
let authMailpit: Mailpit;
// the same on 127.0.0.2, a host other than localhost
let remoteMailpit: Mailpit;

let stubDir: string;
let servers: { name: "upstream" | "iglo.base"; server: Server; sendmailOut: string }[];

function newRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

// the stub sendmail: its arguments and stdin go to $SENDMAIL_OUT.args and
// $SENDMAIL_OUT
const sendmailStub = `#!/bin/sh
printf '%s\\n' "$@" > "$SENDMAIL_OUT.args"
cat > "$SENDMAIL_OUT"
`;

// upstream looks for /usr/sbin/sendmail and /usr/bin/sendmail before PATH
const hostSendmail = existsSync("/usr/sbin/sendmail") || existsSync("/usr/bin/sendmail");

beforeAll(async () => {
  const authRoot = newRoot("iglo-base-mail-auth-");
  const authFile = join(authRoot, "auth");
  writeFileSync(authFile, "mailer:secret\n");
  const authArgs = ["--smtp-auth-file", authFile, "--smtp-auth-allow-insecure"];

  mailpit = await startMailpit();
  mailpits.push(mailpit);
  authMailpit = await startMailpit(undefined, { args: authArgs });
  mailpits.push(authMailpit);
  remoteMailpit = await startMailpit(undefined, { args: authArgs, smtpHost: "127.0.0.2" });
  mailpits.push(remoteMailpit);

  stubDir = newRoot("iglo-base-mail-stub-");
  writeFileSync(join(stubDir, "sendmail"), sendmailStub);
  chmodSync(join(stubDir, "sendmail"), 0o755);
  const path = `${stubDir}:${process.env.PATH ?? ""}`;

  const upDir = join(newRoot("iglo-base-mail-up-"), "pb_data");
  copyDataDir(fixtureDir, upDir);
  const igDir = join(newRoot("iglo-base-mail-ig-"), "pb_data");
  copyDataDir(fixtureDir, igDir);
  const upOut = join(stubDir, "upstream.eml");
  const igOut = join(stubDir, "iglo.eml");

  // startUpstream puts its own directory before process.env.PATH
  const originalPath = process.env.PATH;
  process.env.PATH = path;
  let up: Server;
  try {
    up = await startUpstream({ dataDir: upDir, env: { SENDMAIL_OUT: upOut } });
  } finally {
    process.env.PATH = originalPath;
  }
  running.push(up);
  const ig = await startServer([], igDir, "127.0.0.1", undefined, {
    PATH: path,
    SENDMAIL_OUT: igOut,
  });
  running.push(ig);

  servers = [
    { name: "upstream", server: up, sendmailOut: upOut },
    { name: "iglo.base", server: ig, sendmailOut: igOut },
  ];
}, timeout);

afterAll(async () => {
  await Promise.allSettled(running.map((s) => s.stop()));
  await Promise.allSettled(mailpits.map((m) => m.stop()));
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------
// requests

interface Reply {
  status: number;
  body: unknown;
}

async function call(
  url: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const res = await fetch(url + path, {
    method,
    headers: {
      Authorization: superuserToken,
      "Content-Type": "application/json",
      "User-Agent": "iglo-base-mail-test",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : JSON.parse(text) };
}

async function patchSettings(url: string, settings: unknown): Promise<void> {
  const res = await call(url, "PATCH", "/api/settings", settings);
  if (res.status !== 200) {
    throw new Error(`PATCH /api/settings: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

function smtpTo(
  m: Mailpit | { smtpPort: number },
  extra: Record<string, unknown> = {},
  host = "127.0.0.1",
): unknown {
  return {
    smtp: {
      enabled: true,
      host,
      port: m.smtpPort,
      username: "",
      password: "",
      authMethod: "PLAIN",
      tls: false,
      localName: "",
      ...extra,
    },
  };
}

// -------------------------------------------------------------------
// Mailpit

async function clear(m: Mailpit): Promise<void> {
  await fetch(`${m.apiUrl}/api/v1/messages`, { method: "DELETE" });
}

async function messageIds(m: Mailpit): Promise<string[]> {
  const list = (await fetch(`${m.apiUrl}/api/v1/messages`).then((res) => res.json())) as {
    messages: { ID: string }[];
  };
  return list.messages.map((msg) => msg.ID);
}

// the raw text of the only message, waiting for it
async function onlyMessage(m: Mailpit): Promise<string> {
  const until = Date.now() + 10_000;
  for (;;) {
    const ids = await messageIds(m);
    if (ids.length > 1) {
      throw new Error(`expected one message, got ${ids.length}`);
    }
    if (ids.length === 1) {
      return fetch(`${m.apiUrl}/api/v1/message/${ids[0]}/raw`).then((res) => res.text());
    }
    if (Date.now() > until) {
      throw new Error("no message received");
    }
    await Bun.sleep(50);
  }
}

// -------------------------------------------------------------------
// normalization

interface Normalized {
  text: string;
  claims: Record<string, unknown>[];
}

const jwtRegex = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;

function normalize(raw: string): Normalized {
  let text = raw.replace(/\r\n/g, "\n");

  // Mailpit's Received header ends with the receive time
  text = text.replace(/(\n\s+for <[^>]*>;) [^\n]+/g, "$1 <received>");

  // SMTP messages only (sendmail adds its own)
  const date = /^Date: (.*)$/m.exec(text)?.[1];
  if (date !== undefined) {
    expect(date).toMatch(
      /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d\d [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d [+-]\d{4}$/,
    );
    text = text.replace(/^Date: .*$/m, "Date: <date>");
  }

  const messageId = /^Message-I[Dd]: (.*)$/m.exec(text)?.[1] ?? "";
  expect(messageId).toMatch(/^<[A-Za-z0-9]{15}@[^>]+>$/);
  text = text.replace(/^(Message-I[Dd]): <[A-Za-z0-9]{15}@/m, "$1: <id@");

  const boundaries = [
    ...new Set([...text.matchAll(/boundary="([0-9a-f]{60})"/g)].map((m) => m[1])),
  ];
  boundaries.forEach((b, i) => {
    text = text.replaceAll(b as string, `<boundary${i}>`);
  });

  // quoted-printable soft line breaks
  text = text.replace(/=\n/g, "");

  text = text.replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}Z/g, "<datetime>");

  const claims: Record<string, unknown>[] = [];
  text = text.replace(jwtRegex, (token) => {
    claims.push(
      JSON.parse(Buffer.from(token.split(".")[1] as string, "base64url").toString()) as Record<
        string,
        unknown
      >,
    );
    return `<token${claims.length - 1}>`;
  });

  return { text, claims };
}

function expectSameMessages(up: string, ig: string): void {
  const a = normalize(up);
  const b = normalize(ig);
  expect(b.text).toBe(a.text);
  expect(b.claims.length).toBe(a.claims.length);
  a.claims.forEach((claims, i) => {
    const other = b.claims[i] as Record<string, unknown>;
    const { exp: expA, ...restA } = claims;
    const { exp: expB, ...restB } = other;
    expect(restB).toEqual(restA);
    expect(Math.abs(Number(expA) - Number(expB))).toBeLessThan(60);
  });
}

// -------------------------------------------------------------------
// runs

// sends the request to both servers, one after the other, after the setup;
// returns the replies and, with a mailpit, the raw message each sent after
// a successful reply (or checks that none was sent, with expectMail false)
async function both(
  setup: (url: string) => Promise<void>,
  request: (url: string) => Promise<Reply>,
  m?: Mailpit,
  expectMail = true,
): Promise<{ replies: Reply[]; messages: string[] }> {
  const replies: Reply[] = [];
  const messages: string[] = [];
  for (const { name, server } of servers) {
    await setup(server.url);
    if (m) {
      await clear(m);
    }
    const reply = await request(server.url);
    replies.push(reply);
    if (!m) {
      continue;
    }
    if (expectMail && reply.status < 300) {
      messages.push(await onlyMessage(m));
    } else {
      await Bun.sleep(300);
      expect({ server: name, messages: await messageIds(m) }).toEqual({
        server: name,
        messages: [],
      });
    }
  }
  return { replies, messages };
}

function testEmail(body: unknown): (url: string) => Promise<Reply> {
  return (url) => call(url, "POST", "/api/settings/test/email", body);
}

const templates = ["verification", "password-reset", "email-change", "otp", "login-alert"];

describe("test email over SMTP", () => {
  for (const collection of ["", "users"]) {
    for (const template of templates) {
      test(
        `${template}${collection ? ` (${collection})` : ""}`,
        async () => {
          const { replies, messages } = await both(
            (url) => patchSettings(url, smtpTo(mailpit)),
            testEmail({ template, email: "to@example.com", collection }),
            mailpit,
          );
          expect(replies[0]?.status).toBe(204);
          expect(replies[1]).toEqual(replies[0] as Reply);
          expectSameMessages(messages[0] as string, messages[1] as string);
        },
        timeout,
      );
    }
  }

  test(
    "custom template with placeholders, sender name and local name",
    async () => {
      const verificationTemplate = {
        subject: "Ověření {APP_NAME} – {RECORD:name} {RECORD:verified}",
        body:
          `<p>{APP_NAME} {APP_URL} {RECORD:id} {RECORD:email} {RECORD:name} ` +
          `{RECORD:emailVisibility} {RECORD:verified} {RECORD:created} {RECORD:updated} ` +
          `{RECORD:avatar} {RECORD:rel} {RECORD:file} {RECORD:tokenKey} {RECORD:password}</p>\n` +
          `<a href="{APP_URL}/_/#/auth/confirm-verification/{TOKEN}">Zweryfikuj ` +
          "a long line of text that is wrapped by quoted-printable at 76 characters, with ü and ž</a>",
      };
      const { replies, messages } = await both(
        async (url) => {
          await patchSettings(url, {
            ...(smtpTo(mailpit, { localName: "mail.example.test" }) as object),
            meta: {
              appName: "Acme <b>&",
              appURL: "https://acme.example.test",
              senderName: 'Zespół "Acme"',
              senderAddress: "no-reply@acme.example.test",
            },
          });
          const res = await call(url, "PATCH", "/api/collections/users", { verificationTemplate });
          expect(res.status).toBe(200);
        },
        testEmail({ template: "verification", email: "to@example.com", collection: "users" }),
        mailpit,
      );
      expect(replies[0]?.status).toBe(204);
      expect(replies[1]).toEqual(replies[0] as Reply);
      expectSameMessages(messages[0] as string, messages[1] as string);
    },
    timeout,
  );
});

describe("SMTP auth and failures", () => {
  for (const authMethod of ["PLAIN", "LOGIN"]) {
    test(
      `AUTH ${authMethod}`,
      async () => {
        const { replies, messages } = await both(
          (url) =>
            patchSettings(
              url,
              smtpTo(authMailpit, { username: "mailer", password: "secret", authMethod }),
            ),
          testEmail({ template: "verification", email: "to@example.com" }),
          authMailpit,
        );
        expect(replies[0]?.status).toBe(204);
        expect(replies[1]).toEqual(replies[0] as Reply);
        expectSameMessages(messages[0] as string, messages[1] as string);
      },
      timeout,
    );

    test(
      `AUTH ${authMethod} with a wrong password`,
      async () => {
        const { replies } = await both(
          (url) =>
            patchSettings(
              url,
              smtpTo(authMailpit, { username: "mailer", password: "wrong", authMethod }),
            ),
          testEmail({ template: "verification", email: "to@example.com" }),
          authMailpit,
        );
        expect(replies[0]?.status).toBe(400);
        expect(replies[1]).toEqual(replies[0] as Reply);
      },
      timeout,
    );

    test(
      `AUTH ${authMethod} over an unencrypted connection to another host`,
      async () => {
        const { replies } = await both(
          (url) =>
            patchSettings(
              url,
              smtpTo(
                remoteMailpit,
                { username: "mailer", password: "secret", authMethod },
                "127.0.0.2",
              ),
            ),
          testEmail({ template: "verification", email: "to@example.com" }),
          remoteMailpit,
        );
        expect(replies[0]?.status).toBe(400);
        expect(replies[1]).toEqual(replies[0] as Reply);
      },
      timeout,
    );
  }

  test(
    "no credentials for a server that requires AUTH",
    async () => {
      const { replies } = await both(
        (url) => patchSettings(url, smtpTo(authMailpit)),
        testEmail({ template: "otp", email: "to@example.com" }),
        authMailpit,
      );
      expect(replies[0]?.status).toBe(400);
      expect(replies[1]).toEqual(replies[0] as Reply);
    },
    timeout,
  );

  test(
    "a refused connection",
    async () => {
      const port = await freePort();
      const { replies } = await both(
        (url) => patchSettings(url, smtpTo({ smtpPort: port })),
        testEmail({ template: "verification", email: "to@example.com" }),
      );
      expect(replies[0]?.status).toBe(400);
      expect(replies[1]).toEqual(replies[0] as Reply);
    },
    timeout,
  );

  const invalid: [string, unknown][] = [
    ["empty body", {}],
    ["unknown template", { template: "unknown", email: "to@example.com" }],
    ["invalid email", { template: "otp", email: "not an email" }],
    ["not an auth collection", { template: "otp", email: "to@example.com", collection: "demo1" }],
    ["missing collection", { template: "otp", email: "to@example.com", collection: "missing" }],
  ];
  for (const [name, body] of invalid) {
    test(
      `validation: ${name}`,
      async () => {
        const { replies } = await both(
          (url) => patchSettings(url, smtpTo(mailpit)),
          testEmail(body),
          mailpit,
        );
        expect(replies[0]?.status).toBe(400);
        expect(replies[1]).toEqual(replies[0] as Reply);
      },
      timeout,
    );
  }
});

describe("sendmail", () => {
  for (const template of templates) {
    test.skipIf(hostSendmail)(
      template,
      async () => {
        const replies: Reply[] = [];
        for (const { server, sendmailOut } of servers) {
          rmSync(sendmailOut, { force: true });
          await patchSettings(server.url, { smtp: { enabled: false } });
          replies.push(
            await testEmail({ template, email: "to@example.com", collection: "users" })(server.url),
          );
        }
        expect(replies[0]?.status).toBe(204);
        expect(replies[1]).toEqual(replies[0] as Reply);

        const [up, ig] = servers.map((s) => ({
          message: readFileSync(s.sendmailOut, "utf8"),
          args: readFileSync(`${s.sendmailOut}.args`, "utf8"),
        }));
        expect(up?.args).toBe("-i\n-t\n");
        expect(ig?.args).toBe(up?.args as string);
        expectSameMessages(up?.message as string, ig?.message as string);
      },
      timeout,
    );
  }
});

describe("login alert", () => {
  test(
    "a password login from a new device",
    async () => {
      // the clients record has logged in before (one stored origin)
      const login = (userAgent: string) => (url: string) =>
        call(
          url,
          "POST",
          "/api/collections/clients/auth-with-password",
          { identity: "test@example.com", password: "1234567890" },
          { Authorization: "", "User-Agent": userAgent },
        );

      // a login from a new device sends the alert before the response
      const first = await both(
        (url) => patchSettings(url, smtpTo(mailpit)),
        login("device A"),
        mailpit,
      );
      expect(first.replies.map((r) => r.status)).toEqual([200, 200]);
      expectSameMessages(first.messages[0] as string, first.messages[1] as string);
      expect(first.messages[0]).toContain("device A");

      // the same device again sends nothing
      const second = await both(async () => {}, login("device A"), mailpit, false);
      expect(second.replies.map((r) => r.status)).toEqual([200, 200]);
    },
    timeout,
  );
});
