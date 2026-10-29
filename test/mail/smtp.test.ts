// Upstream: tools/mailer/smtp_test.go (TestLoginAuthStart,
// TestLoginAuthNext) and the SMTP exchange of tools/mailer/smtp.go
//
// The SMTP client against a scripted SMTP server that records every command:
// which AUTH is sent (PLAIN, LOGIN, none without credentials, none over an
// unencrypted connection to a host other than localhost), the EHLO name,
// the envelope, and the message as mailyak writes it (headers, the
// multipart/mixed and multipart/alternative parts, attachments). Upstream's
// tests call the LOGIN auth's Start and Next directly; here the same rules
// are checked through what reaches the server.

import { afterAll, expect, test } from "bun:test";

import { SMTPClient } from "@/mail/smtp";
import type { Message } from "@/mail/mailer";

interface Server {
  host: string;
  port: number;
  commands: string[];
  data: string[];
  stop(): void;
}

interface Session {
  buffer: string;
  inData: boolean;
  data: string;
  login: number;
}

const servers: Server[] = [];

afterAll(() => {
  for (const s of servers) {
    s.stop();
  }
});

// a scripted SMTP server: EHLO advertises AUTH PLAIN LOGIN unless noAuth
// (and never STARTTLS);
// every AUTH succeeds; RCPT to "reject@..." fails with 550
function startServer(host = "127.0.0.1", noAuth = false): Server {
  const commands: string[] = [];
  const data: string[] = [];
  const listener = Bun.listen<Session>({
    hostname: host,
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buffer: "", inData: false, data: "", login: 0 };
        socket.write("220 test ESMTP\r\n");
      },
      data(socket, chunk) {
        const s = socket.data;
        s.buffer += new TextDecoder().decode(chunk);
        for (;;) {
          if (s.inData) {
            const end = s.buffer.indexOf("\r\n.\r\n");
            if (end < 0) {
              return;
            }
            data.push(s.buffer.slice(0, end + 2));
            s.buffer = s.buffer.slice(end + 5);
            s.inData = false;
            socket.write("250 OK\r\n");
            continue;
          }
          const eol = s.buffer.indexOf("\r\n");
          if (eol < 0) {
            return;
          }
          const line = s.buffer.slice(0, eol);
          s.buffer = s.buffer.slice(eol + 2);
          if (s.login > 0) {
            // the LOGIN exchange: username, then password
            commands.push(`LOGIN ${Buffer.from(line, "base64").toString()}`);
            s.login--;
            socket.write(s.login > 0 ? "334 UGFzc3dvcmQ6\r\n" : "235 OK\r\n");
            continue;
          }
          commands.push(line);
          const verb = line.split(" ")[0]?.toUpperCase();
          if (verb === "EHLO") {
            socket.write(noAuth ? "250 test\r\n" : "250-test\r\n250 AUTH PLAIN LOGIN\r\n");
          } else if (verb === "AUTH") {
            if (/^AUTH LOGIN$/i.test(line)) {
              s.login = 2;
              socket.write("334 VXNlcm5hbWU6\r\n");
            } else if (/^AUTH LOGIN /i.test(line)) {
              s.login = 1;
              socket.write("334 UGFzc3dvcmQ6\r\n");
            } else {
              socket.write("235 OK\r\n");
            }
          } else if (verb === "STARTTLS") {
            socket.write("502 5.5.1 not implemented\r\n");
          } else if (verb === "RCPT" && line.includes("reject@")) {
            socket.write("550 5.1.1 no such user\r\n");
          } else if (verb === "DATA") {
            s.inData = true;
            socket.write("354 go ahead\r\n");
          } else if (verb === "QUIT") {
            socket.write("221 bye\r\n");
            socket.end();
            return;
          } else {
            socket.write("250 OK\r\n");
          }
        }
      },
    },
  });
  const server = { host, port: listener.port, commands, data, stop: () => listener.stop(true) };
  servers.push(server);
  return server;
}

function client(
  server: Server,
  config: Partial<ConstructorParameters<typeof SMTPClient>[0]> = {},
): SMTPClient {
  return new SMTPClient(
    {
      tls: false,
      port: server.port,
      host: server.host,
      username: "",
      password: "",
      authMethod: "",
      localName: "",
      ...config,
    },
    { now: () => new Date("2026-01-02T03:04:05Z") },
  );
}

const message: Message = {
  from: { name: "Support", address: "support@example.com" },
  to: [{ name: "", address: "to@example.com" }],
  subject: "Hello",
  html: "<p>Hello</p>",
};

// the AUTH commands, decoded
function auths(server: Server): string[] {
  return server.commands
    .filter((c) => /^(AUTH|LOGIN) /i.test(c))
    .map((c) => {
      const plain = /^AUTH PLAIN (\S+)$/i.exec(c);
      if (plain) {
        return `PLAIN ${JSON.stringify(Buffer.from(plain[1] as string, "base64").toString())}`;
      }
      const login = /^AUTH LOGIN (\S+)$/i.exec(c);
      if (login) {
        return `AUTH LOGIN\nLOGIN ${Buffer.from(login[1] as string, "base64").toString()}`;
      }
      return c;
    })
    .join("\n")
    .split("\n");
}

test("no credentials: no AUTH, EHLO localhost", async () => {
  const server = startServer();
  await client(server).send(message);
  expect(server.commands[0]).toBe("EHLO localhost");
  expect(auths(server)).toEqual([""]);
  expect(server.commands).toContain("MAIL FROM:<support@example.com>");
  expect(server.commands).toContain("RCPT TO:<to@example.com>");
});

test("localName is the EHLO name", async () => {
  const server = startServer();
  await client(server, { localName: "mail.example.test" }).send(message);
  expect(server.commands[0]).toBe("EHLO mail.example.test");
});

test("AUTH PLAIN (the default method)", async () => {
  for (const authMethod of ["", "PLAIN", "unknown"]) {
    const server = startServer();
    await client(server, { username: "test", password: "123456", authMethod }).send(message);
    expect(auths(server)).toEqual([`PLAIN ${JSON.stringify("\u0000test\u0000123456")}`]);
  }
});

test("AUTH LOGIN", async () => {
  const server = startServer();
  await client(server, { username: "test", password: "123456", authMethod: "LOGIN" }).send(message);
  expect(auths(server)).toEqual(["AUTH LOGIN", "LOGIN test", "LOGIN 123456"]);
});

test("AUTH is tried even when the server does not advertise it", async () => {
  const server = startServer("127.0.0.1", true);
  await client(server, { username: "test", password: "123456" }).send(message);
  expect(auths(server)).toEqual([`PLAIN ${JSON.stringify("\u0000test\u0000123456")}`]);
});

test("no credentials over an unencrypted connection to another host", async () => {
  for (const authMethod of ["PLAIN", "LOGIN"]) {
    const server = startServer("127.0.0.2");
    const send = client(server, { username: "test", password: "123456", authMethod }).send(message);
    await expect(send).rejects.toThrow("unencrypted connection");
    expect(server.commands.some((c) => /^AUTH/i.test(c))).toBe(false);
    expect(server.data).toEqual([]);
  }
});

test("a server error reads as Go's textproto.Error", async () => {
  const server = startServer();
  await expect(
    client(server).send({ ...message, to: [{ name: "", address: "reject@example.com" }] }),
  ).rejects.toThrow(`550 "5.1.1 no such user"`);
});

test("the message as mailyak writes it", async () => {
  const server = startServer();
  await client(server).send({
    from: { name: "Zespół", address: "support@example.com" },
    to: [
      { name: "John Doe", address: "john@example.com" },
      { name: "", address: "jane@example.com" },
    ],
    cc: [{ name: "", address: "cc@example.com" }],
    bcc: [{ name: "Hidden", address: "bcc@example.com" }],
    subject: "Witaj świecie",
    html: '<p>Hello <a href="https://example.com">world</a></p>',
    headers: new Map([["X-Custom", "żółw"]]),
    attachments: new Map([["a.txt", new Blob(["x".repeat(100)])]]),
    inlineAttachments: new Map([["logo.png", new Blob([Buffer.from("89504e470d0a1a0a", "hex")])]]),
  });

  expect(server.commands.filter((c) => c.startsWith("RCPT"))).toEqual([
    "RCPT TO:<john@example.com>",
    "RCPT TO:<jane@example.com>",
    "RCPT TO:<cc@example.com>",
    "RCPT TO:<bcc@example.com>",
  ]);

  const raw = server.data[0] as string;
  const boundaries = [...raw.matchAll(/boundary="([0-9a-f]{60})"/g)].map((m) => m[1] as string);
  expect(boundaries.length).toBe(2);
  const [mb, ab] = boundaries as [string, string];
  const messageId = /^Message-ID: (<[A-Za-z0-9]{15}@example\.com>)\r$/m.exec(raw)?.[1];
  expect(messageId).toBeDefined();
  // the local time zone of the host
  const date = /^Date: (.*)\r$/m.exec(raw)?.[1];
  expect(date).toMatch(/^Fri, 02 Jan 2026 \d\d:\d\d:05 [+-]\d{4}$/);

  expect(raw).toBe(
    [
      "From: =?UTF-8?q?Zesp=C3=B3=C5=82?= <support@example.com>",
      "MIME-Version: 1.0",
      `Date: ${date}`,
      "Subject: =?UTF-8?q?Witaj_=C5=9Bwiecie?=",
      `To: "John Doe" <john@example.com>,jane@example.com`,
      "CC: cc@example.com",
      "X-Custom: =?UTF-8?q?=C5=BC=C3=B3=C5=82w?=",
      `Message-ID: ${messageId}`,
      "Content-Type: multipart/mixed;",
      `\tboundary="${mb}"; charset=UTF-8`,
      "",
      `--${mb}`,
      "Content-Type: multipart/alternative;",
      `\tboundary="${ab}"`,
      "",
      `--${ab}`,
      "Content-Transfer-Encoding: quoted-printable",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Hello [world](https://example.com)",
      `--${ab}`,
      "Content-Transfer-Encoding: quoted-printable",
      "Content-Type: text/html; charset=UTF-8",
      "",
      '<p>Hello <a href=3D"https://example.com">world</a></p>',
      `--${ab}--`,
      "",
      `--${mb}`,
      "Content-Disposition: attachment;",
      '\tfilename="a.txt"; name="a.txt"',
      "Content-ID: <a.txt>",
      "Content-Transfer-Encoding: base64",
      "Content-Type: text/plain; charset=utf-8;",
      '\tfilename="a.txt"; name="a.txt"',
      "",
      Buffer.from("x".repeat(100)).toString("base64").slice(0, 60),
      Buffer.from("x".repeat(100)).toString("base64").slice(60, 120),
      Buffer.from("x".repeat(100)).toString("base64").slice(120),
      `--${mb}`,
      "Content-Disposition: inline;",
      '\tfilename="logo.png"; name="logo.png"',
      "Content-ID: <logo.png>",
      "Content-Transfer-Encoding: base64",
      "Content-Type: image/png;",
      '\tfilename="logo.png"; name="logo.png"',
      "",
      "iVBORw0KGgo=",
      `--${mb}--`,
      "",
    ].join("\r\n"),
  );
});
