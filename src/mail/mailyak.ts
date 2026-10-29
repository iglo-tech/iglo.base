// Upstream: github.com/domodwyer/mailyak/v3 v3.6.2 (mailyak.go, setters.go,
// mime.go, attachments.go, splitter.go), the MIME writer of upstream's SMTP
// client
//
// Only the message is built here; the SMTP exchange is nodemailer's
// (src/mail/smtp.ts), which sends this text as a raw message. The custom
// headers are written in their insertion order (Go ranges over a map, in
// random order).

import { QEncoding, quote, quotedPrintable, wordEncode } from "@/mail/go-mime";

export interface YakAttachment {
  filename: string;
  content: Uint8Array;
  inline: boolean;
  mimeType: string;
}

// MailYak: the fields the message is built from, set through the setters
// below
export class MailYak {
  fromAddr = "";
  fromName = "";
  subject = "";
  html = "";
  plain = "";
  toAddrs: string[] = [];
  ccAddrs: string[] = [];
  bccAddrs: string[] = [];
  headers = new Map<string, string[]>();
  attachments: YakAttachment[] = [];
  localName = "";

  // the Date header (time.RFC1123Z of New's time)
  constructor(readonly date: string) {}

  // To sets a list of recipient addresses (empty ones are ignored).
  to(...addrs: string[]): void {
    this.toAddrs = trimAll(addrs);
  }

  // Bcc sets a list of blind carbon copy (BCC) addresses (not written as a
  // header).
  bcc(...addrs: string[]): void {
    this.bccAddrs = trimAll(addrs);
  }

  // Cc sets a list of carbon copy (CC) addresses.
  cc(...addrs: string[]): void {
    this.ccAddrs = trimAll(addrs);
  }

  // From sets the sender email address.
  from(addr: string): void {
    this.fromAddr = trim(addr);
  }

  // FromName sets the sender name.
  setFromName(name: string): void {
    this.fromName = wordEncode(QEncoding, "UTF-8", trim(name));
  }

  // Subject sets the email subject line.
  setSubject(sub: string): void {
    this.subject = wordEncode(QEncoding, "UTF-8", trim(sub));
  }

  // AddHeader adds an arbitrary email header.
  addHeader(name: string, value: string): void {
    const key = trim(name);
    const values = this.headers.get(key) ?? [];
    values.push(wordEncode(QEncoding, "UTF-8", trim(value)));
    this.headers.set(key, values);
  }

  // LocalName sets the sender domain name used in the EHLO/HELO exchange.
  setLocalName(name: string): void {
    this.localName = trim(name);
  }

  // AttachWithMimeType / AttachInlineWithMimeType
  attach(filename: string, content: Uint8Array, mimeType: string, inline: boolean): void {
    this.attachments.push({ filename, content, inline, mimeType });
  }

  // getToAddrs returns the RCPT TO addresses: the email parts of the To,
  // Cc and Bcc addresses.
  getToAddrs(): string[] {
    return [...stripNames(this.toAddrs), ...stripNames(this.ccAddrs), ...stripNames(this.bccAddrs)];
  }

  // buildMime writes the full email to a string, with random boundaries.
  buildMime(): string {
    return this.buildMimeWithBoundaries(randomBoundary(), randomBoundary());
  }

  buildMimeWithBoundaries(mb: string, ab: string): string {
    let w = this.writeHeaders();

    const hasBody = this.html.length !== 0 || this.plain.length !== 0;
    const hasAttachments = this.attachments.length !== 0;

    // if we don't have text/html body or attachments we can skip Content-Type header
    if (!hasBody && !hasAttachments) {
      return w + "\r\n";
    }

    const mixed = new MultipartWriter(mb);

    w += `Content-Type: multipart/mixed;\r\n\tboundary="${mb}"; charset=UTF-8\r\n\r\n`;

    if (hasBody) {
      w += mixed.createPart([["Content-Type", `multipart/alternative;\r\n\tboundary="${ab}"`]]);
      w += this.writeBody(ab);
    }
    if (hasAttachments) {
      w += this.writeAttachments(mixed);
    }

    return w + mixed.close();
  }

  private writeHeaders(): string {
    let w = this.fromHeader();
    w += "MIME-Version: 1.0\r\n";
    w += `Date: ${this.date}\r\n`;
    w += `Subject: ${this.subject}\r\n`;

    if (this.toAddrs.length > 0) {
      w += `To: ${this.toAddrs.join(",")}\r\n`;
    }

    if (this.ccAddrs.length > 0) {
      w += `CC: ${this.ccAddrs.join(",")}\r\n`;
    }

    for (const [k, values] of this.headers) {
      for (const v of values) {
        w += `${k}: ${v}\r\n`;
      }
    }

    return w;
  }

  private fromHeader(): string {
    if (this.fromName === "") {
      return `From: ${this.fromAddr}\r\n`;
    }
    return `From: ${this.fromName} <${this.fromAddr}>\r\n`;
  }

  // writeBody writes the text/plain and text/html mime parts.
  private writeBody(boundary: string): string {
    const alt = new MultipartWriter(boundary);
    let w = "";

    const writePart = (ctype: string, data: string): void => {
      if (data.length === 0) {
        return;
      }
      w += alt.createPart([
        ["Content-Transfer-Encoding", "quoted-printable"],
        ["Content-Type", `${ctype}; charset=UTF-8`],
      ]);
      w += quotedPrintable(new TextEncoder().encode(data));
    };

    writePart("text/plain", this.plain);
    writePart("text/html", this.html);

    return w + alt.close();
  }

  private writeAttachments(mixed: MultipartWriter): string {
    let w = "";
    for (const item of this.attachments) {
      const ctype = `${item.mimeType};\n\tfilename=${quote(item.filename)}; name=${quote(item.filename)}`;
      const disp = `${item.inline ? "inline" : "attachment"};\n\tfilename=${quote(item.filename)}; name=${quote(item.filename)}`;
      w += mixed.createPart([
        ["Content-Disposition", disp],
        ["Content-ID", `<${item.filename}>`],
        ["Content-Transfer-Encoding", "base64"],
        ["Content-Type", ctype],
      ]);
      w += splitLines(Buffer.from(item.content).toString("base64"), maxLineLen);
    }
    return w;
  }
}

// mime/multipart.Writer with a fixed boundary; the part headers are given
// sorted by key, as Go writes them
class MultipartWriter {
  private hasPart = false;

  constructor(private readonly boundary: string) {}

  createPart(header: [string, string][]): string {
    let b = this.hasPart ? `\r\n--${this.boundary}\r\n` : `--${this.boundary}\r\n`;
    this.hasPart = true;
    for (const [k, v] of header) {
      b += `${k}: ${v}\r\n`;
    }
    return b + "\r\n";
  }

  close(): string {
    return `\r\n--${this.boundary}--\r\n`;
  }
}

// randomBoundary: 30 random bytes, hex encoded
function randomBoundary(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(30))).toString("hex");
}

// the trimRegex (`\r?\n`) of every setter
function trim(s: string): string {
  return s.replace(/\r?\n/g, "");
}

function trimAll(addrs: string[]): string[] {
  const out: string[] = [];
  for (const addr of addrs) {
    const trimmed = trim(addr);
    if (trimmed !== "") {
      out.push(trimmed);
    }
  }
  return out;
}

// stripNames returns the email parts of RFC 5322 addresses ("John
// <b@example.com>" is "b@example.com"); other values are kept as they are.
// The addresses come from addressesToStrings, so the name form is the only
// one with angle brackets.
function stripNames(addresses: string[]): string[] {
  return addresses.map((original) => {
    const match = /<([^<>]*)>$/.exec(original);
    return match ? (match[1] as string) : original;
  });
}

// the lineSplitter of the base64 attachment encoder
const maxLineLen = 60;

function splitLines(s: string, maxLen: number): string {
  let out = "";
  for (let i = 0; i < s.length; i += maxLen) {
    const chunk = s.slice(i, i + maxLen);
    out += chunk;
    if (chunk.length === maxLen) {
      out += "\r\n";
    }
  }
  return out;
}
