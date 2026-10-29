// Upstream: tools/mailer/sendmail.go
//
// The message is written as upstream writes it (net/http.Header's wire
// format: sorted, canonical keys) and piped to `sendmail -i -t` with
// Bun.spawn. The executable is looked up as Go's exec.LookPath does, in the
// PATH of the app's environment.
//
// Not ported: the OnSend hook (D5).

import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  addressString,
  getHeader,
  type Header,
  QEncoding,
  setHeader,
  wordEncode,
  writeHeader,
} from "@/mail/go-mime";
import { addressesToStrings, type Mailer, type Message } from "@/mail/mailer";
import { pseudorandomString } from "@/tools/security/random";

// Sendmail implements the Mailer interface and defines a mail client that
// sends emails via the "sendmail" *nix command.
//
// This client is usually recommended only for development and testing.
export class Sendmail implements Mailer {
  // getenv reads PATH for the executable lookup
  constructor(private readonly getenv: (name: string) => string) {}

  // Send implements the Mailer interface.
  async send(m: Message): Promise<void> {
    const toAddresses = addressesToStrings(m.to, false);

    const headers: Header = new Map();
    setHeader(headers, "Subject", wordEncode(QEncoding, "utf-8", m.subject));
    setHeader(headers, "From", addressString(m.from));
    setHeader(headers, "To", toAddresses.join(","));

    // @todo evaluate handling multipart/mixed together with the attachments support
    if (m.html !== "") {
      setHeader(headers, "Content-Type", "text/html; charset=UTF-8");
    } else {
      setHeader(headers, "Content-Type", "text/plain; charset=UTF-8");
    }

    if (m.cc && m.cc.length > 0) {
      setHeader(headers, "Cc", addressesToStrings(m.cc, false).join(","));
    }

    if (m.bcc && m.bcc.length > 0) {
      setHeader(headers, "Bcc", addressesToStrings(m.bcc, false).join(","));
    }

    // add custom headers (if any)
    for (const [k, v] of m.headers ?? []) {
      setHeader(headers, k, v);
    }

    // add a default message id if missing
    if (getHeader(headers, "Message-ID") === "") {
      const fromParts = m.from.address.split("@");
      if (fromParts.length === 2) {
        setHeader(headers, "Message-ID", `<${pseudorandomString(15)}@${fromParts[1]}>`);
      }
    }

    const cmdPath = this.findSendmailPath();

    // write
    // ---
    const buffer = writeHeader(headers) + "\r\n" + (m.html !== "" ? m.html : (m.text ?? ""));
    // ---

    const proc = Bun.spawn([cmdPath, "-i", "-t"], {
      stdin: Buffer.from(buffer),
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(
        proc.signalCode !== null
          ? `signal: ${signalName(String(proc.signalCode))}`
          : `exit status ${code}`,
      );
    }
  }

  private findSendmailPath(): string {
    const options = ["/usr/sbin/sendmail", "/usr/bin/sendmail", "sendmail"];

    for (const option of options) {
      const path = lookPath(option, this.getenv("PATH"));
      if (path !== null) {
        return path;
      }
    }

    throw new Error("failed to locate a sendmail executable path");
  }
}

// exec.LookPath: a name with a slash is checked as it is; otherwise the
// absolute directories of PATH are searched (Go refuses a match in a
// relative directory, exec.ErrDot)
function lookPath(file: string, path: string): string | null {
  if (file.includes("/")) {
    return isExecutable(file) ? file : null;
  }
  for (let dir of path.split(":")) {
    if (dir === "") {
      // Unix shell semantics: path element "" means "."
      dir = ".";
    }
    const candidate = join(dir, file);
    if (isExecutable(candidate)) {
      return isAbsolute(candidate) ? candidate : null;
    }
  }
  return null;
}

function isExecutable(file: string): boolean {
  try {
    const st = statSync(file);
    return !st.isDirectory() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

// os.Signal's String for the signals a killed sendmail reports
function signalName(signal: string): string {
  const names: Record<string, string> = {
    SIGKILL: "killed",
    SIGTERM: "terminated",
    SIGINT: "interrupt",
    SIGPIPE: "broken pipe",
    SIGSEGV: "segmentation fault",
    SIGABRT: "aborted",
    SIGHUP: "hangup",
  };
  return names[signal] ?? signal;
}
