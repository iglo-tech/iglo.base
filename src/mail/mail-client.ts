// Upstream: core/base.go (NewMailClient)
//
// A new client per send, from the settings at that time. Not ported: the
// app level OnMailerSend hook and the dev mode console print of each sent
// mail it runs (D5; application code logs only errors).

import type { Clock } from "@/app/clock";
import type { Mailer } from "@/mail/mailer";
import { Sendmail } from "@/mail/sendmail";
import { SMTPClient } from "@/mail/smtp";
import type { Settings } from "@/settings/settings-model";

// NewMailClient creates and returns a new SMTP or Sendmail client based on
// the current app settings.
export function newMailClient(
  settings: Settings,
  clock: Clock,
  getenv: (name: string) => string,
): Mailer {
  const smtp = settings.SMTP;
  if (smtp.Enabled) {
    return new SMTPClient(
      {
        host: smtp.Host,
        port: Number(smtp.Port),
        username: smtp.Username,
        password: smtp.Password,
        tls: smtp.TLS,
        authMethod: smtp.AuthMethod,
        localName: smtp.LocalName,
      },
      clock,
    );
  }
  return new Sendmail(getenv);
}
