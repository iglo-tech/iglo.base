// Upstream: tools/mailer/smtp.go, with mailyak's SMTP exchange (sender.go,
// sender_starttls.go, sender_explicit_tls.go) and Go's net/smtp PlainAuth
//
// The message is built as mailyak builds it (src/mail/mailyak.ts) and sent
// as a raw message over nodemailer's SMTPConnection, which does the
// exchange as mailyak does: implicit TLS when TLS is set, otherwise
// STARTTLS only when the EHLO reply offers it; EHLO with the local name
// ("localhost" unless set); AUTH PLAIN or LOGIN when a username or password
// is set, even if the server does not advertise AUTH (Go's client tries it
// and fails). As Go's PLAIN and LOGIN auths, the send refuses to send
// credentials over an unencrypted connection to a host other than
// localhost, 127.0.0.1 or ::1 ("unencrypted connection", before AUTH).
//
// Not ported: the OnSend hook (D5).

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import SMTPConnection from "nodemailer/lib/smtp-connection";

import type { Clock } from "@/app/clock";
import { quote } from "@/mail/go-mime";
import { addressesToStrings, detectReaderMimeType, type Mailer, type Message } from "@/mail/mailer";
import { MailYak } from "@/mail/mailyak";
import { html2Text } from "@/mail/html2text";
import { pseudorandomString } from "@/tools/security/random";

export const SMTPAuthPlain = "PLAIN";
export const SMTPAuthLogin = "LOGIN";

export interface SMTPClientConfig {
  tls: boolean;
  port: number;
  host: string;
  username: string;
  password: string;

  // SMTP auth method to use
  // (if not explicitly set, defaults to "PLAIN")
  authMethod: string;

  // LocalName is optional domain name used for the EHLO/HELO exchange
  // (if not explicitly set, defaults to "localhost").
  //
  // This is required only by some SMTP servers, such as Gmail SMTP-relay.
  localName: string;
}

// SMTPClient defines a SMTP mail client that implements the Mailer
// interface.
export class SMTPClient implements Mailer {
  constructor(
    private readonly config: SMTPClientConfig,
    private readonly clock: Clock,
  ) {}

  // Send implements the Mailer interface.
  async send(m: Message): Promise<void> {
    const c = this.config;

    // create mail instance
    const yak = new MailYak(rfc1123Z(this.clock.now()));

    if (c.localName !== "") {
      yak.setLocalName(c.localName);
    }

    if (m.from.name !== "") {
      yak.setFromName(m.from.name);
    }
    yak.from(m.from.address);
    yak.setSubject(m.subject);

    if (m.html !== "") {
      yak.html = m.html;
    }

    if (!m.text) {
      // try to generate a plain text version of the HTML
      yak.plain = html2Text(m.html);
    } else {
      yak.plain = m.text;
    }

    if (m.to.length > 0) {
      yak.to(...addressesToStrings(m.to, true));
    }

    if (m.bcc && m.bcc.length > 0) {
      yak.bcc(...addressesToStrings(m.bcc, true));
    }

    if (m.cc && m.cc.length > 0) {
      yak.cc(...addressesToStrings(m.cc, true));
    }

    // add regular attachements (if any)
    for (const [name, data] of m.attachments ?? []) {
      const mime = await detectReaderMimeType(data);
      yak.attach(name, new Uint8Array(await data.arrayBuffer()), mime, false);
    }

    // add inline attachments (if any)
    for (const [name, data] of m.inlineAttachments ?? []) {
      const mime = await detectReaderMimeType(data);
      yak.attach(name, new Uint8Array(await data.arrayBuffer()), mime, true);
    }

    // add custom headers (if any)
    let hasMessageIdHeader = false;
    for (const [k, v] of m.headers ?? []) {
      if (!hasMessageIdHeader && k.toLowerCase() === "message-id") {
        hasMessageIdHeader = true;
      }
      yak.addHeader(k, v);
    }

    // add a default message id if missing
    if (!hasMessageIdHeader) {
      const fromParts = m.from.address.split("@");
      if (fromParts.length === 2) {
        yak.addHeader("Message-ID", `<${pseudorandomString(15)}@${fromParts[1]}>`);
      }
    }

    await this.exchange(yak);
  }

  // mailyak's sender: connect (implicit TLS, or STARTTLS when the EHLO
  // reply offers it), then net/smtp's auth check on the actual connection
  // state, then MAIL, RCPT, DATA and QUIT.
  private async exchange(yak: MailYak): Promise<void> {
    const c = this.config;
    const hasAuth = c.username !== "" || c.password !== "";

    const conn = new SMTPConnection({
      host: c.host,
      port: c.port,
      secure: c.tls,
      name: yak.localName || "localhost",
    });
    // the first error fails the send; the connection reports it once as an
    // event and again to the pending callback
    let failure: Error | undefined;
    const failed = new Promise<never>((_, reject) => {
      conn.on("error", (err: Error) => {
        failure ??= err;
        reject(failure);
      });
    });
    failed.catch(() => {});
    const step = <T>(run: (done: (err: Error | null, value?: T) => void) => void): Promise<T> =>
      Promise.race([
        failed,
        new Promise<T>((resolve, reject) =>
          run((err, value) => (err ? reject(failure ?? err) : resolve(value as T))),
        ),
      ]);

    try {
      await step<void>((done) => conn.connect(() => done(null)));
      if (hasAuth) {
        // Go's PlainAuth and upstream's LOGIN auth refuse to send
        // credentials over an unencrypted connection to another host
        if (!conn.secure && !isLocalhost(c.host)) {
          throw new Error("unencrypted connection");
        }
        await step<unknown>((done) =>
          conn.login(
            {
              user: c.username,
              pass: c.password,
              method: c.authMethod === SMTPAuthLogin ? SMTPAuthLogin : SMTPAuthPlain,
            },
            done,
          ),
        );
      }
      await step<unknown>((done) =>
        conn.send({ from: yak.fromAddr, to: yak.getToAddrs() }, Buffer.from(yak.buildMime()), done),
      );
      conn.quit();
    } catch (err) {
      throw await goError(err, c.host, c.port);
    } finally {
      conn.close();
    }
  }
}

// The address Go names in a failed dial: Go returns the first address's
// error, after sorting the resolved addresses by RFC 6724, which puts IPv6
// first for loopback and dual-stack hosts. Which address nodemailer and
// Node try first varies (nodemailer may resolve the name itself), so the
// name is resolved again here.
async function goDialAddress(host: string): Promise<string> {
  if (isIP(host) !== 0) {
    return host;
  }
  try {
    const addrs = await lookup(host, { all: true, order: "ipv6first" });
    return addrs[0]?.address ?? host;
  } catch {
    return host;
  }
}

function isLocalhost(name: string): boolean {
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
}

// The errors read as Go's where the test email endpoint shows them: a
// refused connection as Go's dial error, a server reply (including a
// refused STARTTLS the server offered) as textproto.Error
// (`<code> "<message>"`). Other errors (DNS, TLS handshake, timeouts) keep
// nodemailer's text.
async function goError(err: unknown, host: string, port: number): Promise<Error> {
  const e = err instanceof Error ? err : new Error(String(err));
  const { code, response, errors } = e as {
    code?: string;
    response?: unknown;
    errors?: unknown[];
  };
  // Node's dial error is "connect ECONNREFUSED <ip>:<port>", or an
  // AggregateError of them when it tried several addresses; nodemailer
  // copies it as ESOCKET
  const dialErrors = Array.isArray(errors) && errors.length > 0 ? errors : [e];
  const refused = dialErrors.some(
    (d) => d instanceof Error && d.message.startsWith("connect ECONNREFUSED "),
  );
  if (code === "ESOCKET" && refused) {
    const addr = await goDialAddress(host);
    const hostPort = addr.includes(":") ? `[${addr}]:${port}` : `${addr}:${port}`;
    return new Error(`dial tcp ${hostPort}: connect: connection refused`);
  }
  const reply = typeof response === "string" && /^\d{3}[ -]/.test(response) ? response : "";
  if (reply !== "") {
    const lines = reply.split(/\r?\n/).filter((line) => line !== "");
    return new Error(
      `${reply.slice(0, 3)} ${quote(lines.map((line) => line.slice(4)).join("\n"))}`,
    );
  }
  return e;
}

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// time.Now().Format(time.RFC1123Z) in the local time zone:
// "Mon, 02 Jan 2006 15:04:05 -0700"
export function rfc1123Z(d: Date): string {
  const offset = -d.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return (
    `${days[d.getDay()]}, ${pad(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}
