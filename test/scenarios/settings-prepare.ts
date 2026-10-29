// `prepare` and `after` steps of the settings scenarios (upstream's
// BeforeTestFunc and AfterTestFunc in apis/settings_test.go and
// apis/middlewares_test.go): they change or read the settings row of a
// scenario's pb_data with SQLite. The fixture's settings value is plain
// JSON stored as a BLOB; a changed value is written back as one.

import { Database } from "bun:sqlite";
import { join } from "node:path";

import type { AfterContext, PrepareContext } from "@test/scenarios/scenario";
import { sharedSmtpSink } from "@test/support/smtp-sink";

type SettingsJSON = { [key: string]: { [key: string]: unknown } } & {
  superuserIPs?: string[];
};

// the stored settings JSON of a pb_data
export function readStoredSettings(dataDir: string): SettingsJSON {
  const db = new Database(join(dataDir, "data.db"), { readonly: true });
  try {
    const row = db.query("SELECT value FROM _params WHERE id = 'settings'").get() as {
      value: string | Uint8Array;
    };
    const text = row.value instanceof Uint8Array ? new TextDecoder().decode(row.value) : row.value;
    return JSON.parse(text) as SettingsJSON;
  } finally {
    db.close();
  }
}

// changes the stored settings (app.Settings() + app.Save in upstream's tests)
export function changeSettings(dataDir: string, change: (settings: SettingsJSON) => void): void {
  const settings = readStoredSettings(dataDir);
  change(settings);
  const db = new Database(join(dataDir, "data.db"));
  try {
    db.query("UPDATE _params SET value = ? WHERE id = 'settings'").run(
      new TextEncoder().encode(JSON.stringify(settings)),
    );
  } finally {
    db.close();
  }
}

// setupWhitelist of TestSuperuserIPsWhitelist: the trusted proxy header
// x-test-ip and the superuser IPs
export function setupWhitelist(...superuserIPs: string[]): (ctx: PrepareContext) => void {
  return ({ dataDir }) => {
    changeSettings(dataDir, (settings) => {
      // allow loading a mock IP from the test scenario
      settings.trustedProxy = { headers: ["x-test-ip"], useLeftmostIP: false };
      settings.superuserIPs = superuserIPs;
    });
  };
}

// The test mailer: SMTP enabled and pointed at the shared in-process sink
// (upstream's test app has a TestMailer). Returns the prepare step; the
// `after` step of mailSent checks what the sink received.
export function smtpToSink(): (ctx: PrepareContext) => void {
  return ({ dataDir }) => {
    const sink = sharedSmtpSink();
    changeSettings(dataDir, (settings) => {
      settings.smtp = {
        ...settings.smtp,
        enabled: true,
        host: "127.0.0.1",
        port: sink.port,
        username: "",
        password: "",
        tls: false,
      };
    });
  };
}

// AfterTestFunc of the test email scenarios: the sink received a message
// for the address, recently, whose HTML has the template's text. Both
// servers of a differential run share the sink, so this cannot tell their
// messages apart; the response status does.
export function mailSent(to: string, htmlContains: string): (ctx: AfterContext) => void {
  return () => {
    const since = Date.now() - 30_000;
    const found = sharedSmtpSink().messages.some(
      (m) => m.received >= since && m.to.includes(to) && m.data.includes(htmlContains),
    );
    if (!found) {
      throw new Error(`expected a sent email to ${to} containing ${JSON.stringify(htmlContains)}`);
    }
  };
}

// AfterTestFunc of "authorized as superuser submitting valid data": the
// secrets are persisted (upstream reads them from app.Settings())
export function secretsPersisted(ctx: AfterContext): void {
  const settings = readStoredSettings(ctx.dataDir);
  const secrets: [string, unknown, string][] = [
    ["smtp.password", settings.smtp?.password, "new_smtp_password"],
    ["s3.secret", settings.s3?.secret, "new_s3_secret"],
    [
      "backups.s3.secret",
      (settings.backups?.s3 as { secret?: unknown } | undefined)?.secret,
      "new_backups_s3_secret",
    ],
  ];
  for (const [name, current, expected] of secrets) {
    if (current !== expected) {
      throw new Error(
        `[${name}] expected secret ${JSON.stringify(expected)}, got ${JSON.stringify(current)}`,
      );
    }
  }
}
