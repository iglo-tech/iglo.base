// Some tests need a host without sendmail (the fixture has SMTP off, so a mail
// is sent through sendmail, and the send must fail). Upstream looks for the
// binary in these two places; macOS has one at /usr/sbin/sendmail.

import { existsSync } from "node:fs";

export const hostHasSendmail = existsSync("/usr/sbin/sendmail") || existsSync("/usr/bin/sendmail");

// the scenarios and cases whose names say that a send fails for lack of a mailer
export function needsNoSendmail(name: string): boolean {
  return /without a mailer|a failed send is the response/.test(name);
}
