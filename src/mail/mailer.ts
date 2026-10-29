// Upstream: tools/mailer/mailer.go
//
// Not ported: SendInterceptor and SendEvent (the OnSend hook, D5).
// Attachments are Blobs (a Bun file, an upload, bytes); detecting their
// MIME type reads the first bytes through a slice, so no combined reader
// is needed.

import { type Address, addressString } from "@/mail/go-mime";
import { detectReader } from "@/tools/mimetype/mimetype";

// Message defines a generic email message struct.
export interface Message {
  from: Address;
  to: Address[];
  bcc?: Address[];
  cc?: Address[];
  subject: string;
  html: string;
  text?: string;
  headers?: Map<string, string>;
  attachments?: Map<string, Blob>;
  inlineAttachments?: Map<string, Blob>;
}

// Mailer defines a base mail client interface.
export interface Mailer {
  // Send sends an email with the provided Message.
  send(message: Message): Promise<void>;
}

// addressesToStrings converts the provided address to a list of serialized
// RFC 5322 strings.
//
// To export only the email part of mail.Address, you can set withName to
// false.
export function addressesToStrings(addresses: readonly Address[], withName: boolean): string[] {
  return addresses.map((addr) =>
    withName && addr.name !== ""
      ? addressString(addr)
      : // keep only the email part to avoid wrapping in angle-brackets
        addr.address,
  );
}

// detectReaderMimeType reads the first couple bytes of the blob to detect
// its MIME type.
export async function detectReaderMimeType(r: Blob): Promise<string> {
  const [mime, err] = await detectReader(r);
  if (err !== null) {
    throw err;
  }
  return mime.toString();
}
