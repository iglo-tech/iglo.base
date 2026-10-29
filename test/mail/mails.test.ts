// Upstream: mails/record_test.go
//
// The send functions on a fixture app whose SMTP settings point at the
// in-process sink (upstream's TestMailer); the message is read back from
// the sink and its HTML part decoded.

import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  sendRecordAuthAlert,
  sendRecordChangeEmail,
  sendRecordOTP,
  sendRecordPasswordReset,
  sendRecordVerification,
} from "@/mail/mails/record";
import type { Record } from "@/records/record-model";
import { findFirstRecordByData } from "@/records/record-query";

import { openFixtureApp, type TestApp } from "@test/app/app";
import { sharedSmtpSink, type SinkMessage } from "@test/support/smtp-sink";

let app: TestApp;
let user: Record;
let since: number;

beforeEach(async () => {
  app = await openFixtureApp();
  const sink = sharedSmtpSink();
  Object.assign(app.settings.SMTP, { Enabled: true, Host: "127.0.0.1", Port: sink.port });

  user = findFirstRecordByData(app, "users", "email", "test@example.com");

  // to test that it is escaped
  user.set("name", "<p>" + user.getString("name") + "</p>");

  since = Date.now();
});

afterEach(async () => {
  await app.cleanup();
});

// html.EscapeString
function escape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&#34;");
}

// the messages sent since the test started
function sent(): SinkMessage[] {
  return sharedSmtpSink().messages.filter((m) => m.received >= since);
}

// the decoded text/html part of the only message sent to `to`
function lastHTML(to: string): string {
  const messages = sent().filter((m) => m.to.includes(to));
  expect(messages.length).toBe(1);
  const data = (messages[0] as SinkMessage).data;
  const start = data.indexOf("Content-Type: text/html; charset=UTF-8\r\n\r\n");
  expect(start).toBeGreaterThan(-1);
  const qp = data.slice(start).split("\r\n\r\n")[1]?.split("\r\n--")[0] ?? "";
  const bytes = Buffer.from(
    qp.replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),
    "latin1",
  );
  return bytes.toString("utf8");
}

test("SendRecordAuthAlert", async () => {
  const info = "<p>test_info</p>";

  await sendRecordAuthAlert(app, user, info);

  const html = lastHTML("test@example.com");
  for (const part of [
    escape(user.getString("name")) + "{RECORD:tokenKey}", // public and private record placeholder checks
    "login to your " + app.settings.Meta.AppName + " account from a new location",
    "If this was you",
    "If this wasn't you",
    escape(info),
  ]) {
    expect(html).toContain(part);
  }
});

test("SendRecordPasswordReset", async () => {
  await sendRecordPasswordReset(app, user);

  const html = lastHTML("test@example.com");
  for (const part of [
    escape(user.getString("name")) + "{RECORD:tokenKey}", // the record name as {RECORD:name}
    "http://localhost:8090/_/#/auth/confirm-password-reset/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.",
  ]) {
    expect(html).toContain(part);
  }
});

test("SendRecordVerification", async () => {
  await sendRecordVerification(app, user);

  const html = lastHTML("test@example.com");
  for (const part of [
    escape(user.getString("name")) + "{RECORD:tokenKey}", // the record name as {RECORD:name}
    "http://localhost:8090/_/#/auth/confirm-verification/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.",
  ]) {
    expect(html).toContain(part);
  }
});

test("SendRecordChangeEmail", async () => {
  await sendRecordChangeEmail(app, user, "new_test@example.com");

  const html = lastHTML("new_test@example.com");
  for (const part of [
    escape(user.getString("name")) + "{RECORD:tokenKey}", // the record name as {RECORD:name}
    "http://localhost:8090/_/#/auth/confirm-email-change/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.",
  ]) {
    expect(html).toContain(part);
  }
});

test("SendRecordOTP", async () => {
  await sendRecordOTP(app, user, "test_otp_id", "test_otp_code");

  const html = lastHTML("test@example.com");
  for (const part of [
    escape(user.getString("name")) + "{RECORD:tokenKey}", // the record name as {RECORD:name}
    "one-time password",
    "test_otp_code",
  ]) {
    expect(html).toContain(part);
  }
});
