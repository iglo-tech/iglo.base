// Upstream: mails/record.go
//
// The OnMailerRecord*Send hooks are not ported (D5): each function sends
// its message directly. The mail client is the app's (app.newMailClient,
// a new client from the current settings).

import type { App } from "@/app/app";
import {
  EmailPlaceholderAlertInfo,
  EmailPlaceholderAppName,
  EmailPlaceholderAppURL,
  EmailPlaceholderOTP,
  EmailPlaceholderOTPId,
  EmailPlaceholderToken,
} from "@/collections/collection-model-auth-templates";
import type { EmailTemplate } from "@/collections/collection-model-auth-options";
import { FieldTypeAutodate } from "@/fields/autodate";
import { FieldTypeBool } from "@/fields/bool";
import { FieldTypeDate } from "@/fields/date";
import { FieldTypeNumber } from "@/fields/number";
import { resolveLayout } from "@/mail/mails/templates";
import type { Message } from "@/mail/mailer";
import { type OTP, saveOTP } from "@/records/otp-model";
import { findOTPById } from "@/records/otp-query";
import type { Record } from "@/records/record-model";
import {
  newEmailChangeToken,
  newPasswordResetToken,
  newVerificationToken,
} from "@/records/record-tokens";

// SendRecordAuthAlert sends a new device login alert to the specified auth
// record.
export async function sendRecordAuthAlert(
  app: App,
  authRecord: Record,
  info: string,
): Promise<void> {
  const mailClient = app.newMailClient();

  info = escapeString(info);

  const [subject, body] = resolveEmailTemplate(
    app,
    authRecord,
    authRecord.collection().authAlert.emailTemplate,
    new Map([[EmailPlaceholderAlertInfo, info]]),
  );

  await mailClient.send(newMessage(app, authRecord.email(), subject, body));
}

// SendRecordOTP sends OTP email to the specified auth record.
export async function sendRecordOTP(
  app: App,
  authRecord: Record,
  otpId: string,
  pass: string,
): Promise<void> {
  const mailClient = app.newMailClient();

  const [subject, body] = resolveEmailTemplate(
    app,
    authRecord,
    authRecord.collection().otp.emailTemplate,
    new Map([
      [EmailPlaceholderOTPId, otpId],
      [EmailPlaceholderOTP, pass],
    ]),
  );

  const message = newMessage(app, authRecord.email(), subject, body);

  await mailClient.send(message);

  const toAddress = message.to[0]?.address ?? "";
  if (toAddress === "") {
    return;
  }

  let otp: OTP;
  try {
    otp = findOTPById(app, otpId);
  } catch (err) {
    app.logger.error(
      `Unable to find OTP to update its sentTo field (either it was already deleted or the id is nonexisting) (otpId ${otpId})`,
      err,
    );
    return;
  }

  if (otp.sentTo() !== "") {
    return; // was already sent to another target
  }

  otp.setSentTo(toAddress);
  try {
    await saveOTP(app, otp);
  } catch (err) {
    app.logger.error(`Failed to update OTP sentTo field (otpId ${otpId}, to ${toAddress})`, err);
  }
}

// SendRecordPasswordReset sends a password reset request email to the
// specified auth record.
export async function sendRecordPasswordReset(app: App, authRecord: Record): Promise<void> {
  const token = newPasswordResetToken(authRecord, app.clock);

  const mailClient = app.newMailClient();

  const [subject, body] = resolveEmailTemplate(
    app,
    authRecord,
    authRecord.collection().resetPasswordTemplate,
    new Map([[EmailPlaceholderToken, token]]),
  );

  await mailClient.send(newMessage(app, authRecord.email(), subject, body));
}

// SendRecordVerification sends a verification request email to the
// specified auth record.
export async function sendRecordVerification(app: App, authRecord: Record): Promise<void> {
  const token = newVerificationToken(authRecord, app.clock);

  const mailClient = app.newMailClient();

  const [subject, body] = resolveEmailTemplate(
    app,
    authRecord,
    authRecord.collection().verificationTemplate,
    new Map([[EmailPlaceholderToken, token]]),
  );

  await mailClient.send(newMessage(app, authRecord.email(), subject, body));
}

// SendRecordChangeEmail sends a change email confirmation email to the
// specified auth record.
export async function sendRecordChangeEmail(
  app: App,
  authRecord: Record,
  newEmail: string,
): Promise<void> {
  const token = newEmailChangeToken(authRecord, newEmail, app.clock);

  const mailClient = app.newMailClient();

  const [subject, body] = resolveEmailTemplate(
    app,
    authRecord,
    authRecord.collection().confirmEmailChangeTemplate,
    new Map([[EmailPlaceholderToken, token]]),
  );

  await mailClient.send(newMessage(app, newEmail, subject, body));
}

function newMessage(app: App, to: string, subject: string, body: string): Message {
  return {
    from: {
      name: app.settings.Meta.SenderName,
      address: app.settings.Meta.SenderAddress,
    },
    to: [{ name: "", address: to }],
    subject,
    html: body,
  };
}

const nonescapeTypes = [FieldTypeAutodate, FieldTypeDate, FieldTypeBool, FieldTypeNumber];

function resolveEmailTemplate(
  app: App,
  authRecord: Record,
  emailTemplate: EmailTemplate,
  placeholders: Map<string, string>,
): [subject: string, body: string] {
  // register default system placeholders
  if (!placeholders.has(EmailPlaceholderAppName)) {
    placeholders.set(EmailPlaceholderAppName, app.settings.Meta.AppName);
  }
  if (!placeholders.has(EmailPlaceholderAppURL)) {
    placeholders.set(EmailPlaceholderAppURL, app.settings.Meta.AppURL);
  }

  // register default auth record placeholders
  for (const field of authRecord.collection().fields) {
    if (field.getHidden()) {
      continue;
    }

    const fieldPlaceholder = "{RECORD:" + field.getName() + "}";
    if (!placeholders.has(fieldPlaceholder)) {
      let val = authRecord.getString(field.getName());

      // note: the escaping is not strictly necessary but for just in case
      // the user decide to store and render the email as plain html
      if (!nonescapeTypes.includes(field.type())) {
        val = escapeString(val);
      }

      placeholders.set(fieldPlaceholder, val);
    }
  }

  const [subject, rawBody] = emailTemplate.resolve(placeholders);

  return [subject, resolveLayout(rawBody)];
}

// html.EscapeString (Go's standard library): escapes only <, >, &, ' and "
function escapeString(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => htmlEscapes[c] as string);
}

const htmlEscapes: { [c: string]: string } = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  "'": "&#39;",
  '"': "&#34;",
};
