// OTP flows across both servers (src/apis/record-auth-otp-request.ts,
// src/apis/record-auth-with-otp.ts, sendRecordOTP): each flow runs the same
// steps on upstream PocketBase v0.41.0 and iglo.base, each on its own copy of
// the fixture and its own Mailpit, and the two transcripts (statuses and
// bodies with generated values replaced) must be equal. The OTP passwords
// are read from the Mailpit messages. The emails must match after the
// normalization of test/differential/mail/mail.test.ts. `_otps` and `_mfas`
// rows written by one server are then used on the other, `superuser otp`
// output included. Not part of `bun test`: run `bun run test:reference`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { updateCollection } from "@test/scenarios/prepare";
import { otpRows, setAuthRecordField, setMFA, setOTP } from "@test/scenarios/record-auth-prepare";
import { queryRows } from "@test/scenarios/record-checks";
import { superuserToken } from "@test/scenarios/record-crud";
import { changeSettings } from "@test/scenarios/settings-prepare";
import { executable, startServer } from "@test/support/executable";
import { type Mailpit, startMailpit } from "@test/support/mailpit";
import { defaultLayout, requireTool } from "@test/support/reference-tools";
import { startUpstream } from "@test/support/upstream";

// starting and stopping the servers is slow on some runners
const timeout = 120_000;

const pw = "1234567890";
const email = "test@example.com";
const userId = "4q1xlclmfloku33";
const usersId = "_pb_users_auth_";

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
  const root = mkdtempSync(join(tmpdir(), "iglo-base-otp-flows-"));
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

async function post(server: Server, path: string, body: unknown): Promise<Reply> {
  const res = await fetch(server.url + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? {} : JSON.parse(text) };
}

// updates the fixture user as a superuser
async function updateUser(server: Server, body: unknown): Promise<Reply> {
  const res = await fetch(`${server.url}/api/collections/users/records/${userId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: superuserToken },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Reply["json"] };
}

const requestOTP = (server: Server, collection = "users", to = email): Promise<Reply> =>
  post(server, `/api/collections/${collection}/request-otp`, { email: to });

const authWithOTP = (
  server: Server,
  otpId: unknown,
  password: string,
  extra: object = {},
  collection = "users",
): Promise<Reply> =>
  post(server, `/api/collections/${collection}/auth-with-otp`, { otpId, password, ...extra });

const login = (server: Server, extra: object = {}, collection = "users"): Promise<Reply> =>
  post(server, `/api/collections/${collection}/auth-with-password`, {
    identity: email,
    password: pw,
    ...extra,
  });

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

// waits for n OTP messages and returns them raw, the newest first (a login
// alert from a new origin can arrive between them)
async function rawMessages(m: Mailpit, n: number): Promise<string[]> {
  const until = Date.now() + 10_000;
  for (;;) {
    const ids = await messageIds(m);
    const raws = await Promise.all(
      ids.map((id) => fetch(`${m.apiUrl}/api/v1/message/${id}/raw`).then((res) => res.text())),
    );
    const otpMessages = raws.filter((raw) => otpPasswordRegex.test(unfold(raw)));
    if (otpMessages.length >= n) {
      return otpMessages;
    }
    if (Date.now() > until) {
      throw new Error(`expected ${n} OTP messages, got ${otpMessages.length}`);
    }
    await Bun.sleep(25);
  }
}

// the OTP password of the default template ("<strong>123456</strong>")
const otpPasswordRegex = /<strong>(\d+)<\/strong>/;

function unfold(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/=\n/g, "");
}

function mailedPassword(raw: string): string {
  const text = unfold(raw);
  const match = otpPasswordRegex.exec(text);
  if (match?.[1] === undefined) {
    throw new Error(`no password in the message:\n${text}`);
  }
  return match[1];
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
  return text
    .replace(/<strong>\d+<\/strong>/g, "<strong>otp</strong>")
    .replace(/\b\d{6,}\b/g, "otp");
}

// -------------------------------------------------------------------
// transcripts

// generated values replaced, for comparing two servers' replies
function shape(reply: Reply): unknown {
  const json = JSON.parse(JSON.stringify(reply.json)) as { [key: string]: unknown };
  for (const key of ["otpId", "mfaId", "token"]) {
    if (typeof json[key] === "string") {
      json[key] = `<${key}>`;
    }
  }
  for (const item of [json, json["record"] as { [key: string]: unknown } | undefined]) {
    if (item?.["updated"] !== undefined) {
      item["updated"] = "<updated>";
    }
  }
  return { status: reply.status, json };
}

// runs the flow on both servers, each on a prepared fixture copy with
// SMTP to its Mailpit, and compares the transcripts
async function bothFlows(
  prepare: (dataDir: string) => void,
  flow: (server: Server, mail: Mailpit, step: (reply: Reply) => Reply) => Promise<void>,
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
      await flow(server, mail, (reply) => {
        transcript.push(shape(reply));
        return reply;
      });
    } finally {
      await stop(server);
    }
    transcripts.push(transcript);
  }
  expect(transcripts[1]).toEqual(transcripts[0] as unknown[]);
}

const usersWithoutMFA = (dataDir: string): void => {
  setMFA("users", false, "")({ dataDir });
};

// -------------------------------------------------------------------

describe("the OTP email", () => {
  test(
    "the message of each server is the same, and its password signs in",
    async () => {
      const messages: string[] = [];
      await bothFlows(usersWithoutMFA, async (server, mail, step) => {
        const { json } = step(await requestOTP(server));
        const [raw = ""] = await rawMessages(mail, 1);
        messages.push(normalizeMail(raw).replaceAll(json["otpId"] as string, "<otpId>"));

        const password = mailedPassword(raw);
        expect(password).toMatch(/^\d{8}$/);

        step(await authWithOTP(server, json["otpId"], password));
      });
      expect(messages[1]).toBe(messages[0] as string);
    },
    timeout,
  );

  test(
    "otp.length sets the mailed password's length; the row is hashed with the _otps cost",
    async () => {
      await bothFlows(
        (dataDir) => {
          usersWithoutMFA(dataDir);
          updateCollection(dataDir, "users", (c) => {
            c.otp.length = 9;
          });
        },
        async (server, mail, step) => {
          step(await requestOTP(server));
          const [raw = ""] = await rawMessages(mail, 1);
          expect(mailedPassword(raw)).toMatch(/^\d{9}$/);

          const until = Date.now() + 5000;
          while (otpRows(server.dataDir, userId)[0]?.sentTo !== email && Date.now() < until) {
            await Bun.sleep(25);
          }
          const [row] = otpRows(server.dataDir, userId);
          expect(row?.collectionRef).toBe(usersId);
          expect(row?.recordRef).toBe(userId);
          expect(row?.sentTo).toBe(email);
          expect(row?.password).toMatch(/^\$2[ab]\$08\$/);
          expect(row?.created).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        },
      );
    },
    timeout,
  );

  test(
    "a refused SMTP connection answers 200 and removes the OTP",
    async () => {
      await bothFlows(
        (dataDir) => {
          usersWithoutMFA(dataDir);
          // nothing listens on port 1
          smtpTo(dataDir, 1);
        },
        async (server, _mail, step) => {
          const { json } = step(await requestOTP(server));

          const until = Date.now() + 5000;
          while (otpRows(server.dataDir, userId).length > 0 && Date.now() < until) {
            await Bun.sleep(25);
          }
          expect(otpRows(server.dataDir, userId).length).toBe(0);

          step(await authWithOTP(server, json["otpId"], "123456"));
        },
      );
    },
    timeout,
  );

  test(
    "the response does not wait for the send, and the row is written before it",
    async () => {
      // accepts the connection and never greets
      const silent = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: { data() {} },
      });
      try {
        await bothFlows(
          (dataDir) => {
            usersWithoutMFA(dataDir);
            smtpTo(dataDir, silent.port);
          },
          async (server, _mail, step) => {
            const started = Date.now();
            const reply = step(await requestOTP(server));
            expect(Date.now() - started).toBeLessThan(2000);

            // no write transaction is held during the send
            const other = step(await requestOTP(server, "users", "test2@example.com"));
            expect(other.status).toBe(200);

            const [row] = queryRows(
              server.dataDir,
              "SELECT sentTo FROM _otps WHERE id = ?",
              reply.json["otpId"] as string,
            ) as { sentTo: string }[];
            expect(row?.sentTo).toBe("");
          },
        );
      } finally {
        silent.stop(true);
      }
    },
    timeout,
  );
});

describe("repeated requests", () => {
  test(
    "two requests give two OTPs, each valid once",
    async () => {
      await bothFlows(usersWithoutMFA, async (server, mail, step) => {
        const first = step(await requestOTP(server));
        const [firstRaw = ""] = await rawMessages(mail, 1);
        const second = step(await requestOTP(server));
        const [secondRaw = ""] = await rawMessages(mail, 2);
        expect(second.json["otpId"]).not.toBe(first.json["otpId"]);

        step(await authWithOTP(server, first.json["otpId"], mailedPassword(firstRaw)));
        // consumed
        step(await authWithOTP(server, first.json["otpId"], mailedPassword(firstRaw)));
        step(await authWithOTP(server, second.json["otpId"], mailedPassword(secondRaw)));
      });
    },
    timeout,
  );

  test(
    "the eleventh request reuses the last issued OTP and sends nothing",
    async () => {
      await bothFlows(usersWithoutMFA, async (server, mail, step) => {
        const ids: unknown[] = [];
        for (let i = 0; i < 11; i++) {
          ids.push(step(await requestOTP(server)).json["otpId"]);
        }
        expect(new Set(ids).size).toBe(10);
        expect(ids[10]).toBe(ids[9]);

        await rawMessages(mail, 10);
        await Bun.sleep(200);
        expect((await messageIds(mail)).length).toBe(10);
      });
    },
    timeout,
  );
});

describe("invalidation", () => {
  test(
    "a password change removes the OTPs",
    async () => {
      await bothFlows(usersWithoutMFA, async (server, mail, step) => {
        const { json } = step(await requestOTP(server));
        const [raw = ""] = await rawMessages(mail, 1);

        step(
          await updateUser(server, {
            password: "new-password-1",
            passwordConfirm: "new-password-1",
          }),
        );

        expect(otpRows(server.dataDir, userId).length).toBe(0);
        step(await authWithOTP(server, json["otpId"], mailedPassword(raw)));
      });
    },
    timeout,
  );

  test(
    "a tokenKey change removes the OTPs",
    async () => {
      await bothFlows(usersWithoutMFA, async (server, mail, step) => {
        const { json } = step(await requestOTP(server));
        const [raw = ""] = await rawMessages(mail, 1);

        step(await updateUser(server, { tokenKey: "t".repeat(50) }));

        expect(otpRows(server.dataDir, userId).length).toBe(0);
        step(await authWithOTP(server, json["otpId"], mailedPassword(raw)));
      });
    },
    timeout,
  );

  test(
    "another record update keeps the OTPs",
    async () => {
      await bothFlows(usersWithoutMFA, async (server, mail, step) => {
        const { json } = step(await requestOTP(server));
        const [raw = ""] = await rawMessages(mail, 1);

        const update = await updateUser(server, { name: "changed" });
        expect(update.status).toBe(200);

        step(await authWithOTP(server, json["otpId"], mailedPassword(raw)));
      });
    },
    timeout,
  );

  test(
    "the verified upgrade of a mailed OTP resets the password and old tokens",
    async () => {
      await bothFlows(
        (dataDir) => {
          usersWithoutMFA(dataDir);
          setAuthRecordField("users", email, "verified", false)({ dataDir });
        },
        async (server, mail, step) => {
          const { json } = step(await requestOTP(server));
          const [raw = ""] = await rawMessages(mail, 1);
          const until = Date.now() + 5000;
          while (otpRows(server.dataDir, userId)[0]?.sentTo !== email && Date.now() < until) {
            await Bun.sleep(25);
          }

          step(await authWithOTP(server, json["otpId"], mailedPassword(raw)));
          step(await login(server));
        },
      );
    },
    timeout,
  );
});

describe("the OTP rate limit", () => {
  // TestRecordAuthWithOTPManualRateLimiterCheck, with the password read from
  // the message
  test(
    "the sixth attempt of a record is refused, even with the right password",
    async () => {
      await bothFlows(usersWithoutMFA, async (server, mail, step) => {
        const a = step(await requestOTP(server));
        const [rawA = ""] = await rawMessages(mail, 1);
        const b = step(await requestOTP(server));
        await rawMessages(mail, 2);

        for (const id of [a, a, b, b, b]) {
          const reply = step(await authWithOTP(server, id.json["otpId"], "wrong"));
          expect(reply.status).toBe(400);
        }
        const refused = step(await authWithOTP(server, a.json["otpId"], mailedPassword(rawA)));
        expect(refused.status).toBe(429);
        expect(refused.json["message"]).toBe(
          "Too many attempts, please try again later with a new OTP.",
        );
      });
    },
    timeout,
  );
});

describe("MFA", () => {
  test(
    "OTP first, then the password",
    async () => {
      await bothFlows(
        () => {},
        async (server, mail, step) => {
          const { json } = step(await requestOTP(server));
          const [raw = ""] = await rawMessages(mail, 1);

          const first = step(await authWithOTP(server, json["otpId"], mailedPassword(raw)));
          expect(first.status).toBe(401);

          const second = step(await login(server, { mfaId: first.json["mfaId"] }));
          expect(second.status).toBe(200);
        },
      );
    },
    timeout,
  );

  test(
    "the password first, then OTP",
    async () => {
      await bothFlows(
        () => {},
        async (server, mail, step) => {
          const first = step(await login(server));
          expect(first.status).toBe(401);

          const { json } = step(await requestOTP(server));
          const [raw = ""] = await rawMessages(mail, 1);

          const second = step(
            await authWithOTP(server, json["otpId"], mailedPassword(raw), {
              mfaId: first.json["mfaId"],
            }),
          );
          expect(second.status).toBe(200);
        },
      );
    },
    timeout,
  );

  test(
    "two OTPs do not make two factors",
    async () => {
      await bothFlows(
        () => {},
        async (server, mail, step) => {
          const a = step(await requestOTP(server));
          const [rawA = ""] = await rawMessages(mail, 1);
          const b = step(await requestOTP(server));
          const [rawB = ""] = await rawMessages(mail, 2);
          const passwords = await Promise.all([rawA, rawB].map(mailedPassword));

          const first = step(await authWithOTP(server, a.json["otpId"], passwords[0] as string));
          const second = step(
            await authWithOTP(server, b.json["otpId"], passwords[1] as string, {
              mfaId: first.json["mfaId"],
            }),
          );
          expect(second.status).toBe(400);
        },
      );
    },
    timeout,
  );

  test(
    "superusers: OTP and password, in both orders",
    async () => {
      await bothFlows(
        (dataDir) => {
          setOTP("_superusers", true)({ dataDir });
          setMFA("_superusers", true, "")({ dataDir });
        },
        async (server, mail, step) => {
          const a = step(await requestOTP(server, "_superusers"));
          const [rawA = ""] = await rawMessages(mail, 1);
          const first = step(
            await authWithOTP(server, a.json["otpId"], mailedPassword(rawA), {}, "_superusers"),
          );
          expect(first.status).toBe(401);
          const done = step(await login(server, { mfaId: first.json["mfaId"] }, "_superusers"));
          expect(done.status).toBe(200);

          const second = step(await login(server, {}, "_superusers"));
          expect(second.status).toBe(401);
          const b = step(await requestOTP(server, "_superusers"));
          const [rawB = ""] = await rawMessages(mail, 2);
          const finished = step(
            await authWithOTP(
              server,
              b.json["otpId"],
              mailedPassword(rawB),
              { mfaId: second.json["mfaId"] },
              "_superusers",
            ),
          );
          expect(finished.status).toBe(200);
        },
      );
    },
    timeout,
  );
});

describe("rows across servers", () => {
  for (const [from, to] of [
    ["upstream", "igloBase"],
    ["igloBase", "upstream"],
  ] as const) {
    test(
      `an OTP row of ${from} signs in on ${to}`,
      async () => {
        const mail = mailpits[from];
        await clear(mail);
        const dataDir = fixtureCopy();
        smtpTo(dataDir, mail.smtpPort);
        usersWithoutMFA(dataDir);

        const writer = await start(from, dataDir);
        const { json } = await requestOTP(writer);
        const [raw = ""] = await rawMessages(mail, 1);
        const until = Date.now() + 5000;
        while (otpRows(dataDir, userId)[0]?.sentTo !== email && Date.now() < until) {
          await Bun.sleep(25);
        }
        await stop(writer);

        const before = otpRows(dataDir, userId);
        expect(before.length).toBe(1);

        const reader = await start(to, dataDir);
        // the row is not rewritten by reading it
        const list = await fetch(`${reader.url}/api/collections/_otps/records`, {
          headers: { Authorization: superuserToken },
        }).then((res) => res.json() as Promise<{ totalItems: number }>);
        expect(list.totalItems).toBe(1);
        expect(otpRows(dataDir, userId)).toEqual(before);

        const res = await authWithOTP(reader, json["otpId"], mailedPassword(raw));
        expect(res.status).toBe(200);
        expect(otpRows(dataDir, userId).length).toBe(0);
        await stop(reader);
      },
      timeout,
    );

    test(
      `an MFA row of ${from}'s OTP step is finished on ${to}`,
      async () => {
        const mail = mailpits[from];
        await clear(mail);
        const dataDir = fixtureCopy();
        smtpTo(dataDir, mail.smtpPort);

        const writer = await start(from, dataDir);
        const { json } = await requestOTP(writer);
        const [raw = ""] = await rawMessages(mail, 1);
        const first = await authWithOTP(writer, json["otpId"], mailedPassword(raw));
        expect(first.status).toBe(401);
        await stop(writer);

        const [row] = queryRows(
          dataDir,
          "SELECT collectionRef, recordRef, method FROM _mfas WHERE id = ?",
          first.json["mfaId"] as string,
        );
        expect(row).toEqual({ collectionRef: usersId, recordRef: userId, method: "otp" });

        const reader = await start(to, dataDir);
        const res = await login(reader, { mfaId: first.json["mfaId"] });
        expect(res.status).toBe(200);
        expect(queryRows(dataDir, "SELECT id FROM _mfas").length).toBe(0);
        await stop(reader);
      },
      timeout,
    );

    test(
      `\`superuser otp\` of ${from} is a first factor on ${to}`,
      async () => {
        const dataDir = fixtureCopy();
        setOTP("_superusers", true)({ dataDir });

        const binary =
          from === "upstream" ? requireTool("pocketbase", defaultLayout) : await executable();
        const proc = Bun.spawn([binary, "--dir", dataDir, "superuser", "otp", email], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NO_COLOR: "1" },
          timeout: 10_000,
        });
        const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        expect(proc.exitCode).toBe(0);
        // the output, without its colors
        const clean = Bun.stripANSI(stdout);
        const id = /Id:\s+(\S+)/.exec(clean)?.[1];
        const pass = /Pass:\s+(\S+)/.exec(clean)?.[1] as string;

        const reader = await start(to, dataDir);
        const res = await authWithOTP(reader, id, pass, {}, "_superusers");
        // enabling OTP on the collection also enables MFA
        expect(res.status).toBe(401);
        expect(res.json["mfaId"]).toBeString();
        await stop(reader);
      },
      timeout,
    );
  }
});
