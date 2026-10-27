// Smoke test for the reference Mailpit: one message sent over SMTP is read
// back through Mailpit's HTTP API. Run with `bun run test:reference`.

import { afterAll, beforeAll, expect, test } from "bun:test";

import { startMailpit, sendMail, type Mailpit } from "@test/support/mailpit";

// the fields of Mailpit's API (v1) that the smoke test reads
interface MessageSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

interface Message {
  From: { Address: string };
  Text: string;
}

let mailpit: Mailpit;

beforeAll(async () => {
  mailpit = await startMailpit();
});

afterAll(async () => {
  await mailpit?.stop();
});

test("a message sent over SMTP is read back through the API", async () => {
  const subject = "M0.2 reference smoke";
  const text = "Sent over SMTP to the reference Mailpit.";
  await sendMail(mailpit.smtpPort, {
    from: "sender@example.test",
    to: "recipient@example.test",
    subject,
    text,
  });

  const list = (await fetch(`${mailpit.apiUrl}/api/v1/messages`).then((res) => res.json())) as {
    messages: MessageSummary[];
  };
  const summary = list.messages.find((m) => m.Subject === subject);
  expect(summary?.To.map((to) => to.Address)).toEqual(["recipient@example.test"]);

  const message = (await fetch(`${mailpit.apiUrl}/api/v1/message/${summary?.ID}`).then((res) =>
    res.json(),
  )) as Message;
  expect(message.From.Address).toBe("sender@example.test");
  expect(message.Text).toContain(text);
});
