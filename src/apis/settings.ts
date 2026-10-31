// Upstream: apis/settings.go, with the form structs and validations of
// forms/test_s3_filesystem.go, forms/test_email_send.go and
// forms/apple_client_secret_create.go
//
// The OnSettingsListRequest and OnSettingsUpdateRequest hooks are not
// ported (no extension surface): their default actions run directly. The
// handlers never run in a transaction, so execAfterSuccessTx writes the
// response at once.
//
// Not here yet, failing after upstream's validation with a "Raw error" that
// names the task: the S3 connection test of an enabled S3 config
// (TestS3Filesystem.Submit past the "not enabled" check), M5.4, S3 storage.

import type { App } from "@/app/app";
import type { Clock } from "@/app/clock";
import type { RequestEvent } from "@/app/event-request";
import { findCollectionByNameOrId } from "@/collections/collection-query";
import {
  sendRecordAuthAlert,
  sendRecordChangeEmail,
  sendRecordOTP,
  sendRecordPasswordReset,
  sendRecordVerification,
} from "@/mail/mails/record";
import { requireSuperuserAuth } from "@/middlewares/require-auth";
import { signAppleClientSecret } from "@/oauth2/apple-client-secret";
import { newRecord } from "@/records/record-model";
import { CollectionNameSuperusers } from "@/records/record-model-superusers";
import type { RouterGroup } from "@/server/group";
import type { HandlerResult } from "@/server/handler";
import { structOf } from "@/server/unmarshal-request-data";
import { type S3Config, Settings, settingsType } from "@/settings/settings-model";
import { saveSettings } from "@/settings/settings-query";
import { mustCompile } from "@/tools/regexp/regexp";
import { nowDateTime } from "@/tools/types/datetime";
import { Errors, NewError } from "@/validation/error";
import { In } from "@/validation/in";
import { EmailFormat } from "@/validation/is/rules";
import { Length } from "@/validation/length";
import { Match } from "@/validation/match";
import { Max, Min } from "@/validation/minmax";
import { Required } from "@/validation/required";
import { Field, ValidateStruct } from "@/validation/struct";
import { By } from "@/validation/validation";

// bindSettingsApi registers the settings api endpoints.
export function bindSettingsApi(_app: App, rg: RouterGroup<RequestEvent>): void {
  const subGroup = rg.group("/settings").bind(requireSuperuserAuth());
  subGroup.GET("", settingsList);
  subGroup.PATCH("", settingsSet);
  subGroup.POST("/test/s3", settingsTestS3);
  subGroup.POST("/test/email", settingsTestEmail);

  // @todo move to collections
  subGroup.POST("/apple/generate-client-secret", settingsGenerateAppleClientSecret);
}

function settingsList(e: RequestEvent): HandlerResult {
  let clone: Settings;
  try {
    clone = e.app.settings.clone();
  } catch (err) {
    return e.internalServerError("", err);
  }

  return e.json(200, clone);
}

async function settingsSet(e: RequestEvent): Promise<Error | undefined> {
  let newSettings: Settings;
  try {
    // OldSettings (a clone too) is only read by the update hook
    newSettings = e.app.settings.clone();
  } catch (err) {
    return e.badRequestError("", err);
  }

  const data = newSettings.settings;
  const bindErr = await e.bindBody(newSettings as unknown as Record<string, unknown>, settingsType);
  if (bindErr) {
    return e.badRequestError("An error occurred while loading the submitted data.", bindErr);
  }
  if (newSettings.settings !== data) {
    // a JSON null body sets upstream's *Settings to nil and the save
    // dereferences it: a panic (the panic recovery answers 500)
    throw new Error("runtime error: invalid memory address or nil pointer dereference");
  }
  newSettings.normalize();

  try {
    await saveSettings(e.app, newSettings);
  } catch (err) {
    return e.badRequestError("An error occurred while saving the new settings.", err);
  }

  let appSettings: Settings;
  try {
    appSettings = e.app.settings.clone();
  } catch (err) {
    return e.internalServerError("Failed to clone app settings.", err);
  }

  return e.json(200, appSettings);
}

// -------------------------------------------------------------------
// forms.TestS3Filesystem

const s3FilesystemStorage = "storage";
const s3FilesystemBackups = "backups";

const testS3FilesystemType = structOf([
  { name: "Filesystem", type: "string", tags: { form: "filesystem", json: "filesystem" } },
]);

interface TestS3Filesystem {
  // The name of the filesystem - storage or backups
  Filesystem: string;
}

function validateTestS3Filesystem(form: TestS3Filesystem): Error | null {
  return ValidateStruct(
    Field("filesystem", form.Filesystem, Required, In(s3FilesystemStorage, s3FilesystemBackups)),
  );
}

// Submit validates and performs a S3 filesystem connection test.
function submitTestS3Filesystem(app: App, form: TestS3Filesystem): Error | null {
  const err = validateTestS3Filesystem(form);
  if (err !== null) {
    return err;
  }

  let s3Config: S3Config;
  if (form.Filesystem === s3FilesystemBackups) {
    s3Config = app.settings.Backups.S3;
  } else {
    s3Config = app.settings.S3;
  }

  if (!s3Config.Enabled) {
    return new Error("S3 storage filesystem is not enabled");
  }

  // the upload and prefix delete test needs the S3 filesystem (M5.4)
  return new Error("the S3 filesystem test is not available yet (M5.4)");
}

async function settingsTestS3(e: RequestEvent): Promise<Error | undefined> {
  const form: TestS3Filesystem = { Filesystem: "" };

  // load request
  const bindErr = await e.bindBody(
    form as unknown as Record<string, unknown>,
    testS3FilesystemType,
  );
  if (bindErr) {
    return e.badRequestError("An error occurred while loading the submitted data.", bindErr);
  }

  // send
  const err = submitTestS3Filesystem(e.app, form);
  if (err !== null) {
    // form error
    if (err instanceof Errors) {
      return e.badRequestError("Failed to test the S3 filesystem.", err);
    }

    // mailer error
    return e.badRequestError(`Failed to test the S3 filesystem. Raw error: \n${err.message}`, null);
  }

  return e.noContent(204);
}

// -------------------------------------------------------------------
// forms.TestEmailSend

const TestTemplateVerification = "verification";
const TestTemplatePasswordReset = "password-reset";
const TestTemplateEmailChange = "email-change";
const TestTemplateOTP = "otp";
const TestTemplateAuthAlert = "login-alert";

const testEmailSendType = structOf([
  { name: "Email", type: "string", tags: { form: "email", json: "email" } },
  { name: "Template", type: "string", tags: { form: "template", json: "template" } },
  // optional, fallbacks to _superusers
  { name: "Collection", type: "string", tags: { form: "collection", json: "collection" } },
]);

interface TestEmailSend {
  Email: string;
  Template: string;
  Collection: string;
}

function validateTestEmailSend(app: App, form: TestEmailSend): Error | null {
  return ValidateStruct(
    Field(
      "collection",
      form.Collection,
      Length(1, 255),
      By((value) => checkAuthCollection(app, value)),
    ),
    Field("email", form.Email, Required, Length(1, 255), EmailFormat),
    Field(
      "template",
      form.Template,
      Required,
      In(
        TestTemplateVerification,
        TestTemplatePasswordReset,
        TestTemplateEmailChange,
        TestTemplateOTP,
        TestTemplateAuthAlert,
      ),
    ),
  );
}

function checkAuthCollection(app: App, value: unknown): Error | null {
  const v = typeof value === "string" ? value : "";
  if (v === "") {
    return null; // nothing to check
  }

  let isAuth = false;
  try {
    isAuth = findCollectionByNameOrId(app, v).isAuth();
  } catch {
    // not found
  }
  if (!isAuth) {
    return NewError(
      "validation_invalid_auth_collection",
      "Must be a valid auth collection id or name.",
    );
  }

  return null;
}

// Submit validates and sends a test email to the form.Email address.
async function submitTestEmailSend(app: App, form: TestEmailSend): Promise<Error | null> {
  const err = validateTestEmailSend(app, form);
  if (err !== null) {
    return err;
  }

  let collectionIdOrName = form.Collection;
  if (collectionIdOrName === "") {
    collectionIdOrName = CollectionNameSuperusers;
  }

  try {
    const collection = findCollectionByNameOrId(app, collectionIdOrName);

    const record = newRecord(collection);
    for (const field of collection.fields) {
      if (field.getHidden()) {
        continue;
      }
      record.set(field.getName(), "__pb_test_" + field.getName() + "__");
    }
    record.refreshTokenKey();
    record.setEmail(form.Email);

    switch (form.Template) {
      case TestTemplateVerification:
        await sendRecordVerification(app, record);
        break;
      case TestTemplatePasswordReset:
        await sendRecordPasswordReset(app, record);
        break;
      case TestTemplateEmailChange:
        await sendRecordChangeEmail(app, record, form.Email);
        break;
      case TestTemplateOTP:
        await sendRecordOTP(app, record, "_PB_TEST_OTP_ID_", "123456");
        break;
      case TestTemplateAuthAlert: {
        const testEvent = nowDateTime(app.clock).toString() + " - TEST_IP TEST_USER_AGENT";
        await sendRecordAuthAlert(app, record, testEvent);
        break;
      }
      default:
        return new Error("unknown template " + form.Template);
    }
  } catch (sendErr) {
    return sendErr instanceof Error ? sendErr : new Error(String(sendErr));
  }

  return null;
}

async function settingsTestEmail(e: RequestEvent): Promise<Error | undefined> {
  const form: TestEmailSend = { Email: "", Template: "", Collection: "" };

  // load request
  const bindErr = await e.bindBody(form as unknown as Record<string, unknown>, testEmailSendType);
  if (bindErr) {
    return e.badRequestError("An error occurred while loading the submitted data.", bindErr);
  }

  // send
  const err = await submitTestEmailSend(e.app, form);
  if (err !== null) {
    // form error
    if (err instanceof Errors) {
      return e.badRequestError("Failed to send the test email.", err);
    }

    // mailer error
    return e.badRequestError(`Failed to send the test email. Raw error: \n${err.message}`, null);
  }

  return e.noContent(204);
}

// -------------------------------------------------------------------
// forms.AppleClientSecretCreate

const privateKeyRegex = mustCompile(
  String.raw`(?m)-----BEGIN PRIVATE KEY----[\s\S]+-----END PRIVATE KEY-----`,
);

const appleClientSecretCreateType = structOf([
  // ClientId is the identifier of your app (aka. Service ID).
  { name: "ClientId", type: "string", tags: { form: "clientId", json: "clientId" } },
  // TeamId is a 10-character string associated with your developer account
  // (usually could be found next to your name in the Apple Developer site).
  { name: "TeamId", type: "string", tags: { form: "teamId", json: "teamId" } },
  // KeyId is a 10-character key identifier generated for the "Sign in with Apple"
  // private key associated with your developer account.
  { name: "KeyId", type: "string", tags: { form: "keyId", json: "keyId" } },
  // PrivateKey is the private key associated to your app.
  // Usually wrapped within -----BEGIN PRIVATE KEY----- X -----END PRIVATE KEY-----.
  { name: "PrivateKey", type: "string", tags: { form: "privateKey", json: "privateKey" } },
  // Duration specifies how long the generated JWT should be considered valid.
  // The specified value must be in seconds and max 15777000 (~6months).
  { name: "Duration", type: "int", tags: { form: "duration", json: "duration" } },
]);

interface AppleClientSecretCreate {
  ClientId: string;
  TeamId: string;
  KeyId: string;
  PrivateKey: string;
  Duration: number | bigint;
}

function validateAppleClientSecretCreate(form: AppleClientSecretCreate): Error | null {
  return ValidateStruct(
    Field("clientId", form.ClientId, Required),
    Field("teamId", form.TeamId, Required, Length(10, 10)),
    Field("keyId", form.KeyId, Required, Length(10, 10)),
    Field("privateKey", form.PrivateKey, Required, Match(privateKeyRegex)),
    Field("duration", form.Duration, Required, Min(1), Max(15777000)),
  );
}

// Submit validates the form and returns a new Apple Client Secret JWT.
async function submitAppleClientSecretCreate(
  form: AppleClientSecretCreate,
  clock: Clock,
): Promise<[string, Error | null]> {
  const err = validateAppleClientSecretCreate(form);
  if (err !== null) {
    return ["", err];
  }

  try {
    const secret = await signAppleClientSecret(
      {
        clientId: form.ClientId,
        teamId: form.TeamId,
        keyId: form.KeyId,
        privateKey: form.PrivateKey,
        duration: form.Duration,
      },
      clock,
    );
    return [secret, null];
  } catch (signErr) {
    return ["", signErr as Error];
  }
}

async function settingsGenerateAppleClientSecret(e: RequestEvent): Promise<Error | undefined> {
  const form: AppleClientSecretCreate = {
    ClientId: "",
    TeamId: "",
    KeyId: "",
    PrivateKey: "",
    Duration: 0,
  };

  // load request
  const bindErr = await e.bindBody(
    form as unknown as Record<string, unknown>,
    appleClientSecretCreateType,
  );
  if (bindErr) {
    return e.badRequestError("An error occurred while loading the submitted data.", bindErr);
  }

  // generate
  const [secret, err] = await submitAppleClientSecretCreate(form, e.app.clock);
  if (err !== null) {
    // form error
    if (err instanceof Errors) {
      return e.badRequestError("Invalid client secret data.", err);
    }

    // secret generation error
    return e.badRequestError(`Failed to generate client secret. Raw error: \n${err.message}`, null);
  }

  return e.json(200, { secret });
}
