// Verification, password reset and email change flows across both servers
// (src/apis/record-auth-verification-*.ts, -password-reset-*.ts,
// -email-change-*.ts, the send functions of src/mail/mails/record.ts): each
// flow runs the same steps on upstream PocketBase v0.41.0 and iglo.base, each
// on its own copy of the fixture and its own Mailpit, and the two transcripts
// (statuses, bodies with generated values replaced, the rows the steps
// left) must be equal. The tokens are read from the Mailpit messages. The
// emails must match after the normalization of
// test/differential/mail/mail.test.ts, and their token claims too. Data and
// tokens of one server are then used on the other. Not part of `bun test`:
// run `bun run test:reference`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import {
  insertAuthOrigin,
  insertMFA,
  insertOTPs,
  setMFA,
} from "@test/scenarios/record-auth-prepare";
import { queryRows } from "@test/scenarios/record-checks";
import { superuserToken, usersToken } from "@test/scenarios/record-crud";
import { changeSettings } from "@test/scenarios/settings-prepare";
import { freePort, startServer } from "@test/support/executable";
import { type Mailpit, startMailpit } from "@test/support/mailpit";
import { startUpstream } from "@test/support/upstream";

// starting and stopping the servers is slow on some runners
const timeout = 120_000;

const oldPassword = "1234567890";
const newPassword = "1234567!";
const email = "test@example.com";
const newEmail = "change@example.com";
const userId = "4q1xlclmfloku33";

type Kind = "upstream" | "igloBase";
const kinds: Kind[] = ["upstream", "igloBase"];

interface Server {
  kind: Kind;
  url: string;
  dataDir: string;
  stop(): Promise<unknown>;
}

interface Reply {
  status: number;
  json: { [key: string]: unknown };
}

type Row = { [key: string]: unknown };

type Confirm = (server: Server, token: string) => Promise<Reply>;

const roots: string[] = [];
const running = new Set<Server>();
let mailpits: Record<Kind, Mailpit>;

beforeAll(async () => {
  mailpits = { upstream: await startMailpit(), igloBase: await startMailpit() };
}, timeout);

afterAll(async () => {
  await Promise.allSettled([...running].map((s) => s.stop()));
  await Promise.allSettled(Object.values(mailpits).map((m) => m.stop()));
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-token-flows-"));
  roots.push(root);
  const dataDir = join(root, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  return dataDir;
}

function smtpTo(dataDir: string, port: number): void {
  changeSettings(dataDir, (settings) => {
    settings.smtp = {
      ...settings.smtp,
      enabled: true,
      host: "127.0.0.1",
      port,
      username: "",
      password: "",
      tls: false,
    };
  });
}

async function start(kind: Kind, dataDir: string): Promise<Server> {
  const server =
    kind === "upstream"
      ? await startUpstream({ dataDir })
      : { ...(await startServer([], dataDir)), dataDir };
  const s: Server = { kind, url: server.url, dataDir, stop: () => server.stop() };
  running.add(s);
  return s;
}

async function stop(server: Server): Promise<void> {
  running.delete(server);
  await server.stop();
}

async function request(
  server: Server,
  method: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<Reply> {
  const res = await fetch(server.url + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token === undefined ? {} : { Authorization: token }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? {} : JSON.parse(text) };
}

const users = (server: Server, path: string, body: unknown, token?: string): Promise<Reply> =>
  request(server, "POST", `/api/collections/users/${path}`, body, token);

const requestVerification = (server: Server, to = email): Promise<Reply> =>
  users(server, "request-verification", { email: to });
const confirmVerification = (server: Server, token: string): Promise<Reply> =>
  users(server, "confirm-verification", { token });
const requestReset = (server: Server, to = email): Promise<Reply> =>
  users(server, "request-password-reset", { email: to });
const confirmReset = (server: Server, token: string, password = newPassword): Promise<Reply> =>
  users(server, "confirm-password-reset", { token, password, passwordConfirm: password });
const requestChange = (server: Server, to = newEmail): Promise<Reply> =>
  users(server, "request-email-change", { newEmail: to }, usersToken);
const confirmChange = (server: Server, token: string, password = oldPassword): Promise<Reply> =>
  users(server, "confirm-email-change", { token, password });
const login = (server: Server, identity: string, password: string): Promise<Reply> =>
  users(server, "auth-with-password", { identity, password });
const updateUser = (server: Server, body: unknown): Promise<Reply> =>
  request(server, "PATCH", `/api/collections/users/records/${userId}`, body, superuserToken);
const updateUserEmail = (server: Server, id: string, to: string): Promise<Reply> =>
  request(server, "PATCH", `/api/collections/users/records/${id}`, { email: to }, superuserToken);
const viewUser = (server: Server): Promise<Reply> =>
  request(server, "GET", `/api/collections/users/records/${userId}`, undefined, superuserToken);

// -------------------------------------------------------------------
// Mailpit

async function clear(m: Mailpit): Promise<void> {
  await fetch(`${m.apiUrl}/api/v1/messages`, { method: "DELETE" });
}

async function allRaw(m: Mailpit): Promise<string[]> {
  const list = (await fetch(`${m.apiUrl}/api/v1/messages`).then((res) => res.json())) as {
    messages: { ID: string }[];
  };
  return Promise.all(
    list.messages.map((msg) =>
      fetch(`${m.apiUrl}/api/v1/message/${msg.ID}/raw`).then((res) => res.text()),
    ),
  );
}

function unfold(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/=\n/g, "");
}

// waits for n messages with the confirm link, returned raw, the newest first
async function rawMessages(m: Mailpit, link: string, n: number): Promise<string[]> {
  const until = Date.now() + 10_000;
  for (;;) {
    const matching = (await allRaw(m)).filter((raw) => unfold(raw).includes(link));
    if (matching.length >= n) {
      return matching;
    }
    if (Date.now() > until) {
      throw new Error(`expected ${n} ${link} messages, got ${matching.length}`);
    }
    await Bun.sleep(25);
  }
}

async function countNow(m: Mailpit, link: string): Promise<number> {
  return (await allRaw(m)).filter((raw) => unfold(raw).includes(link)).length;
}

// the number of messages with the link once a background send had its time
async function settledCount(m: Mailpit, link: string): Promise<number> {
  await Bun.sleep(300);
  return countNow(m, link);
}

const jwtRegex = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

function mailedToken(raw: string): string {
  const match = jwtRegex.exec(unfold(raw));
  if (match === null) {
    throw new Error(`no token in the message:\n${unfold(raw)}`);
  }
  return match[0];
}

function claimsOf(token: string): { [key: string]: unknown } {
  const payload = token.split(".")[1] as string;
  const { exp, ...claims } = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
    [key: string]: unknown;
  };
  expect(typeof exp).toBe("number");
  return claims;
}

// the raw message without what differs per send, as mail.test.ts
function normalizeMail(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n");
  text = text.replace(/(\n\s+for <[^>]*>;) [^\n]+/g, "$1 <received>");
  text = text.replace(/^Date: .*$/m, "Date: <date>");
  text = text.replace(/^(Message-I[Dd]): <[A-Za-z0-9]{15}@/m, "$1: <id@");
  const boundaries = [
    ...new Set([...text.matchAll(/boundary="([0-9a-f]{60})"/g)].map((m) => m[1])),
  ];
  boundaries.forEach((b, i) => {
    text = text.replaceAll(b as string, `<boundary${i}>`);
  });
  text = text.replace(/=\n/g, "");
  return text.replaceAll(new RegExp(jwtRegex, "g"), "<token>");
}

// -------------------------------------------------------------------
// transcripts

// generated values replaced, for comparing two servers' replies
function shape(reply: Reply): unknown {
  const json = JSON.parse(JSON.stringify(reply.json)) as { [key: string]: unknown };
  if (typeof json["token"] === "string") {
    json["token"] = "<token>";
  }
  for (const item of [json, json["record"] as { [key: string]: unknown } | undefined]) {
    if (item?.["updated"] !== undefined) {
      item["updated"] = "<updated>";
    }
  }
  return { status: reply.status, json };
}

function userRow(dataDir: string, id = userId): Row {
  const [row] = queryRows(dataDir, "SELECT * FROM users WHERE id = ?", id) as Row[];
  return row as Row;
}

// the row as it is now, with the secret and generated columns as whether
// they changed since `before`, and the system rows that point to the record
function stateSince(dataDir: string, before: Row): unknown {
  const row = userRow(dataDir, before["id"] as string);
  const changed = (key: string): string => (row[key] === before[key] ? "same" : "changed");
  const refs = (table: string, columns: string): unknown =>
    queryRows(
      dataDir,
      `SELECT ${columns} FROM ${table} WHERE recordRef = ? ORDER BY ${columns}`,
      row["id"] as string,
    );
  return {
    row: {
      ...row,
      tokenKey: changed("tokenKey"),
      password: changed("password"),
      updated: changed("updated"),
    },
    _externalAuths: refs("_externalAuths", "id, provider"),
    _mfas: refs("_mfas", "id, method"),
    _otps: refs("_otps", "id"),
    _authOrigins: refs("_authOrigins", "fingerprint"),
  };
}

interface Flow {
  server: Server;
  mail: Mailpit;
  // adds a value (a reply is shaped) to the transcript
  step(reply: Reply): Reply;
  note(value: unknown): void;
}

// runs the flow on both servers, each on a prepared fixture copy with
// SMTP to its Mailpit, and compares the transcripts
async function bothFlows(
  prepare: (dataDir: string) => void,
  flow: (f: Flow) => Promise<void>,
): Promise<void> {
  const transcripts: unknown[][] = [];
  for (const kind of kinds) {
    const mail = mailpits[kind];
    await clear(mail);
    const dataDir = fixtureCopy();
    smtpTo(dataDir, mail.smtpPort);
    prepare(dataDir);
    const server = await start(kind, dataDir);
    const transcript: unknown[] = [];
    try {
      await flow({
        server,
        mail,
        step: (reply) => {
          transcript.push(shape(reply));
          return reply;
        },
        note: (value) => {
          transcript.push(value);
        },
      });
    } finally {
      await stop(server);
    }
    transcripts.push(transcript);
  }
  expect(transcripts[1]).toEqual(transcripts[0] as unknown[]);
}

// no second factor, and a row of each kind that a confirm can remove
function withAuthRows(dataDir: string): void {
  const ctx = { dataDir };
  setMFA("users", false, "")(ctx);
  insertMFA("users", email, "m".repeat(15), "password")(ctx);
  insertOTPs("users", email, { id: "o".repeat(15) })(ctx);
  insertAuthOrigin("users", email, "fingerprint")(ctx);
}

const verificationLink = "/auth/confirm-verification/";
const resetLink = "/auth/confirm-password-reset/";
const changeLink = "/auth/confirm-email-change/";

// -------------------------------------------------------------------

describe("the three emails", () => {
  const cases: [string, (server: Server) => Promise<Reply>, string][] = [
    ["verification", requestVerification, verificationLink],
    ["password reset", requestReset, resetLink],
    ["email change", requestChange, changeLink],
  ];
  for (const [name, send, link] of cases) {
    test(
      `${name}: the message and its token claims are upstream's`,
      async () => {
        const messages: string[] = [];
        await bothFlows(withAuthRows, async ({ server, mail, step, note }) => {
          step(await send(server));
          const [raw = ""] = await rawMessages(mail, link, 1);
          messages.push(normalizeMail(raw));
          note(claimsOf(mailedToken(raw)));
        });
        expect(messages[1]).toBe(messages[0] as string);
      },
      timeout,
    );
  }
});

describe("verification", () => {
  test(
    "the mailed token verifies the record once",
    async () => {
      await bothFlows(withAuthRows, async ({ server, mail, step, note }) => {
        const before = userRow(server.dataDir);
        step(await requestVerification(server));
        const [raw = ""] = await rawMessages(mail, verificationLink, 1);
        const token = mailedToken(raw);

        step(await confirmVerification(server, token));
        note(stateSince(server.dataDir, before));
        // the removed external auths refreshed the token key
        step(await confirmVerification(server, token));
        step(await viewUser(server));
        step(await requestVerification(server));
        note(await settledCount(mail, verificationLink));
      });
    },
    timeout,
  );
});

describe("password reset", () => {
  test(
    "the mailed token resets the password once and ends old tokens and sessions",
    async () => {
      await bothFlows(withAuthRows, async ({ server, mail, step, note }) => {
        const before = userRow(server.dataDir);
        step(await requestReset(server));
        const [raw = ""] = await rawMessages(mail, resetLink, 1);
        const token = mailedToken(raw);

        step(await users(server, "auth-refresh", undefined, usersToken));
        step(await confirmReset(server, token));
        note(stateSince(server.dataDir, before));

        step(await confirmReset(server, token));
        step(await users(server, "auth-refresh", undefined, usersToken));
        step(await login(server, email, oldPassword));
        const session = step(await login(server, email, newPassword));
        step(await users(server, "auth-refresh", undefined, session.json["token"] as string));
        step(await viewUser(server));

        // the confirm lifted the resend limit
        step(await requestReset(server));
        await rawMessages(mail, resetLink, 2);
      });
    },
    timeout,
  );

  test(
    "a superuser's mailed token resets its password",
    async () => {
      await bothFlows(
        () => undefined,
        async ({ server, mail, step }) => {
          const collection = "/api/collections/_superusers";
          const to = "test2@example.com";
          step(
            await request(server, "POST", `${collection}/request-password-reset`, { email: to }),
          );
          const [raw = ""] = await rawMessages(mail, resetLink, 1);
          const token = mailedToken(raw);
          step(
            await request(server, "POST", `${collection}/confirm-password-reset`, {
              token,
              password: newPassword,
              passwordConfirm: newPassword,
            }),
          );
          // no MFA on superusers in the fixture: the new password signs in
          const reply = await request(server, "POST", `${collection}/auth-with-password`, {
            identity: to,
            password: newPassword,
          });
          step(reply);
        },
      );
    },
    timeout,
  );
});

describe("email change", () => {
  test(
    "the mailed token changes the email once, with the password",
    async () => {
      await bothFlows(withAuthRows, async ({ server, mail, step, note }) => {
        const before = userRow(server.dataDir);
        step(await requestChange(server));
        // the send comes before the response
        expect(await countNow(mail, changeLink)).toBe(1);
        const [raw = ""] = await rawMessages(mail, changeLink, 1);
        note(raw.includes(`To: <${newEmail}>`));
        const token = mailedToken(raw);

        step(await confirmChange(server, token, "wrong-password"));
        note(stateSince(server.dataDir, before));
        step(await confirmChange(server, token));
        note(stateSince(server.dataDir, before));

        step(await confirmChange(server, token));
        step(await users(server, "auth-refresh", undefined, usersToken));
        step(await login(server, email, oldPassword));
        step(await login(server, newEmail, oldPassword));
        step(await viewUser(server));
      });
    },
    timeout,
  );

  test(
    "the new email is taken between the request and the confirm",
    async () => {
      await bothFlows(withAuthRows, async ({ server, mail, step, note }) => {
        const before = userRow(server.dataDir);
        step(await requestChange(server));
        const [raw = ""] = await rawMessages(mail, changeLink, 1);

        step(await updateUserEmail(server, "oap640cot4yru2s", newEmail));
        step(await confirmChange(server, mailedToken(raw)));
        note(stateSince(server.dataDir, before));
      });
    },
    timeout,
  );

  test(
    "the email field's domains are checked on the confirm only",
    async () => {
      await bothFlows(withAuthRows, async ({ server, mail, step, note }) => {
        const before = userRow(server.dataDir);
        step(
          await request(
            server,
            "PATCH",
            "/api/collections/users",
            {
              fields: [
                {
                  id: "_pbf_auth_email_",
                  name: "email",
                  type: "email",
                  onlyDomains: ["iglo.test"],
                },
              ],
            },
            superuserToken,
          ),
        );
        step(await requestChange(server));
        const [raw = ""] = await rawMessages(mail, changeLink, 1);

        step(await confirmChange(server, mailedToken(raw)));
        note(stateSince(server.dataDir, before));
      });
    },
    timeout,
  );
});

describe("the two minute resend limits", () => {
  test(
    "verification: the second request sends nothing",
    async () => {
      await bothFlows(withAuthRows, async ({ server, mail, step, note }) => {
        step(await requestVerification(server));
        await rawMessages(mail, verificationLink, 1);
        await settledCount(mail, verificationLink);
        step(await requestVerification(server));
        note(await settledCount(mail, verificationLink));
      });
    },
    timeout,
  );

  test(
    "verification: a confirm lifts the limit",
    async () => {
      await bothFlows(withAuthRows, async ({ server, mail, step, note }) => {
        step(await requestVerification(server));
        const [raw = ""] = await rawMessages(mail, verificationLink, 1);
        await settledCount(mail, verificationLink);
        step(await confirmVerification(server, mailedToken(raw)));
        step(await updateUser(server, { verified: false }));
        step(await requestVerification(server));
        await rawMessages(mail, verificationLink, 2);
        note("sent again");
      });
    },
    timeout,
  );

  test(
    "password reset: the second request sends nothing, for a verified record too",
    async () => {
      await bothFlows(withAuthRows, async ({ server, mail, step, note }) => {
        step(await requestReset(server, "test2@example.com"));
        await rawMessages(mail, resetLink, 1);
        await settledCount(mail, resetLink);
        step(await requestReset(server, "test2@example.com"));
        note(await settledCount(mail, resetLink));
      });
    },
    timeout,
  );

  test(
    "email change has no limit",
    async () => {
      await bothFlows(withAuthRows, async ({ server, mail, step, note }) => {
        step(await requestChange(server));
        step(await requestChange(server));
        note(await settledCount(mail, changeLink));
      });
    },
    timeout,
  );
});

describe("a failed send", () => {
  // moves SMTP to a port nobody listens on, or back to Mailpit
  async function brokenSmtp(server: Server, port: number): Promise<Reply> {
    return request(
      server,
      "PATCH",
      "/api/settings",
      { smtp: { enabled: true, host: "127.0.0.1", port, tls: false } },
      superuserToken,
    );
  }

  test(
    "verification: 204, and the limit is set anyway",
    async () => {
      const closed = await freePort();
      await bothFlows(withAuthRows, async ({ server, mail, step, note }) => {
        step(await brokenSmtp(server, closed));
        step(await requestVerification(server));
        note(await settledCount(mail, verificationLink));

        expect((await brokenSmtp(server, mail.smtpPort)).status).toBe(200);
        step(await requestVerification(server));
        note(await settledCount(mail, verificationLink));
      });
    },
    timeout,
  );

  test(
    "password reset: 204, and no limit",
    async () => {
      const closed = await freePort();
      await bothFlows(withAuthRows, async ({ server, mail, step, note }) => {
        step(await brokenSmtp(server, closed));
        step(await requestReset(server));
        note(await settledCount(mail, resetLink));

        expect((await brokenSmtp(server, mail.smtpPort)).status).toBe(200);
        step(await requestReset(server));
        note(await settledCount(mail, resetLink));
      });
    },
    timeout,
  );

  test(
    "email change: the failure is the response",
    async () => {
      const closed = await freePort();
      await bothFlows(withAuthRows, async ({ server, step }) => {
        step(await brokenSmtp(server, closed));
        step(await requestChange(server));
      });
    },
    timeout,
  );
});

describe("tokens after the record changed", () => {
  const sends: [string, (server: Server) => Promise<Reply>, string, Confirm][] = [
    ["verification", requestVerification, verificationLink, confirmVerification],
    ["password reset", requestReset, resetLink, confirmReset],
    ["email change", requestChange, changeLink, confirmChange],
  ];
  const changes: [string, unknown][] = [
    ["password", { password: newPassword, passwordConfirm: newPassword }],
    ["email", { email: "other@example.com" }],
  ];
  for (const [name, send, link, confirm] of sends) {
    for (const [what, body] of changes) {
      test(
        `${name}: a ${what} change invalidates the mailed token`,
        async () => {
          await bothFlows(withAuthRows, async ({ server, mail, step }) => {
            step(await send(server));
            const [raw = ""] = await rawMessages(mail, link, 1);
            step(await updateUser(server, body));
            step(await confirm(server, mailedToken(raw)));
          });
        },
        timeout,
      );
    }
  }
});

describe("across the servers", () => {
  const flows: [string, (s: Server) => Promise<Reply>, string, Confirm][] = [
    ["verification", requestVerification, verificationLink, confirmVerification],
    ["password reset", requestReset, resetLink, confirmReset],
    ["email change", requestChange, changeLink, confirmChange],
  ];

  for (const [name, send, link, confirm] of flows) {
    for (const [issuer, confirmer] of [
      ["upstream", "igloBase"],
      ["igloBase", "upstream"],
    ] as [Kind, Kind][]) {
      test(
        `${name}: a token mailed by ${issuer} confirms on ${confirmer}, and ${issuer} reads the row`,
        async () => {
          const mail = mailpits[issuer];
          await clear(mail);
          const dataDir = fixtureCopy();
          smtpTo(dataDir, mail.smtpPort);
          withAuthRows(dataDir);

          const first = await start(issuer, dataDir);
          expect((await send(first)).status).toBe(204);
          const [raw = ""] = await rawMessages(mail, link, 1);
          await stop(first);

          const second = await start(confirmer, dataDir);
          expect((await confirm(second, mailedToken(raw))).status).toBe(204);
          const written = await viewUser(second);
          await stop(second);

          const third = await start(issuer, dataDir);
          try {
            const read = await viewUser(third);
            expect(read.json).toEqual(written.json);
            const identity = (written.json["email"] as string) || newEmail;
            const password = name === "password reset" ? newPassword : oldPassword;
            expect((await login(third, identity, password)).status).toBe(200);
          } finally {
            await stop(third);
          }
        },
        timeout,
      );
    }
  }
});
