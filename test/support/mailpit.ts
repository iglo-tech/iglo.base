// Starts Mailpit (.upstream/bin/mailpit, see scripts/upstream/prepare.ts) with
// its SMTP sink and HTTP API on free 127.0.0.1 ports and a database in a temp
// directory. sendMail() speaks plain SMTP to the sink, as an application would.

import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnChild, waitUntilReady } from "@test/support/child";
import { freePort } from "@test/support/executable";
import { defaultLayout, requireTool, type Layout } from "@test/support/reference-tools";

export interface Mailpit {
  smtpPort: number;
  apiUrl: string;
  stop(): Promise<void>;
}

export async function startMailpit(layout: Layout = defaultLayout): Promise<Mailpit> {
  const binary = requireTool("mailpit", layout);
  const root = mkdtempSync(join(tmpdir(), "iglo-base-mailpit-"));
  const smtpPort = await freePort();
  const httpPort = await freePort();
  const apiUrl = `http://127.0.0.1:${httpPort}`;
  const child = spawnChild(
    [
      binary,
      "--smtp",
      `127.0.0.1:${smtpPort}`,
      "--listen",
      `127.0.0.1:${httpPort}`,
      "--database",
      join(root, "mailpit.db"),
      "--quiet",
    ],
    { cwd: root },
  );

  try {
    await waitUntilReady(child, "mailpit", async () => {
      const res = await fetch(`${apiUrl}/api/v1/info`);
      return res.ok;
    });
  } catch (error) {
    await child.stop();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  return {
    smtpPort,
    apiUrl,
    async stop() {
      try {
        await child.stop();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

export interface MailToSend {
  from: string;
  to: string;
  subject: string;
  text: string;
}

// Sends one message with EHLO, MAIL, RCPT, DATA and QUIT. Each reply must have
// the expected code; a failure throws with the server's reply.
export async function sendMail(port: number, mail: MailToSend, host = "127.0.0.1"): Promise<void> {
  const socket = await connect(host, port);
  const rl = createInterface({ input: socket, crlfDelay: Infinity });
  const lines = rl[Symbol.asyncIterator]();
  const reply = async (expected: number): Promise<void> => {
    for (;;) {
      const next = await lines.next();
      if (next.done) {
        throw new Error("SMTP connection closed");
      }
      const match = /^(\d{3})( |-)/.exec(next.value);
      if (match?.[2] === " ") {
        if (Number(match[1]) !== expected) {
          throw new Error(`SMTP expected ${expected}, got: ${next.value}`);
        }
        return;
      }
    }
  };
  const send = (line: string): void => {
    socket.write(`${line}\r\n`);
  };

  try {
    await reply(220);
    send("EHLO localhost");
    await reply(250);
    send(`MAIL FROM:<${mail.from}>`);
    await reply(250);
    send(`RCPT TO:<${mail.to}>`);
    await reply(250);
    send("DATA");
    await reply(354);
    const headers = [
      `From: ${mail.from}`,
      `To: ${mail.to}`,
      `Subject: ${mail.subject}`,
      "Content-Type: text/plain; charset=utf-8",
    ];
    // dot-stuffing (RFC 5321 4.5.2): a leading "." in the body is doubled
    const body = mail.text.split("\n").map((line) => (line.startsWith(".") ? `.${line}` : line));
    for (const line of [...headers, "", ...body]) {
      send(line);
    }
    send(".");
    await reply(250);
    send("QUIT");
    await reply(221);
  } finally {
    rl.close();
    socket.end();
  }
}

function connect(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port }, () => resolve(socket));
    socket.once("error", reject);
  });
}
