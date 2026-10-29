// Upstream: core/settings_model.go
//
// The app settings stored in the `_params` table under the "settings" key.
//
// Go's Settings embeds an unexported `settings` struct with the sub-configs.
// Here the sub-configs are plain objects with Go's field names (as upstream
// code reads them: `settings.Meta.AppName`), held in Settings.settings, and
// described by StructTypes (settingsType) so that the request binding and
// the json/v2 decoding of src/server unmarshal into them as Go does into the
// struct. Integers are GoInt (exact beyond 2^53).
//
// JSON is written as Go's json/v2 writes the structs: members in field
// order, nil slices as `[]`, Go's string escaping (no HTML escaping),
// `secret` omitted when empty, and the SMTP password moved last and omitted
// (empty) in the masked form (SMTPConfig.MarshalJSON with hidePassword).
//
// Not ported: the settings system hooks of registerSettingsHooks (D5). The
// reload after a save is done by saveSettings (src/settings/settings-query.ts);
// the delete guard ("the app params settings cannot be deleted") has no
// caller, as nothing deletes the settings param; the rate limit rule
// relabeling on collection rename (OnCollectionUpdate) belongs to the
// collection update path of the collections write task. The mutex is not
// needed (one event loop). String() is toString(); DurationTime returns
// milliseconds.

import { structOf, sliceOf, type StructType, unmarshalJSON } from "@/server/unmarshal-request-data";
import {
  decodeUTF8Bytes,
  decodeValue,
  hasInvalidUTF8,
  JsonSyntaxError,
} from "@/server/json-decode";
import { nowDateTime } from "@/tools/types/datetime";
import type { Clock } from "@/app/clock";
import { newSchedule } from "@/tools/cron/schedule";
import { encrypt } from "@/tools/security/encrypt";
import { type GoInt, quote } from "@/tools/types/go-json";
import { Errors, NewError } from "@/validation/error";
import { Each } from "@/validation/each";
import { In } from "@/validation/in";
import { EmailFormat, HexColor, Host, URL } from "@/validation/is/rules";
import { Length } from "@/validation/length";
import { Match } from "@/validation/match";
import { Max, Min } from "@/validation/minmax";
import { Required } from "@/validation/required";
import { Field, ValidateStruct } from "@/validation/struct";
import { By, type Validatable } from "@/validation/validation";
import { When } from "@/validation/when";
import { IPOrSubnet } from "@/validators/string";
import { ErrUnsupportedValueType } from "@/validators/validators";
import { maxSafeJSONInt } from "@/fields/field";
import { mustCompile } from "@/tools/regexp/regexp";

export const paramsTable = "_params";

export const paramsKeySettings = "settings";

// mailer.SMTPAuthLogin and mailer.SMTPAuthPlain (tools/mailer/smtp.go, M4.4)
export const SMTPAuthLogin = "LOGIN";
export const SMTPAuthPlain = "PLAIN";

export interface SMTPConfig {
  Enabled: boolean;
  Port: GoInt;
  Host: string;
  Username: string;
  Password: string;
  // SMTP AUTH - PLAIN (default) or LOGIN
  AuthMethod: string;
  // Whether to enforce TLS encryption for the mail server connection.
  //
  // When set to false StartTLS command is send, leaving the server
  // to decide whether to upgrade the connection or not.
  TLS: boolean;
  // LocalName is optional domain name or IP address used for the
  // EHLO/HELO exchange (if not explicitly set, defaults to "localhost").
  //
  // This is required only by some SMTP servers, such as Gmail SMTP-relay.
  LocalName: string;
}

export interface S3Config {
  Enabled: boolean;
  Bucket: string;
  Region: string;
  Endpoint: string;
  AccessKey: string;
  Secret: string;
  ForcePathStyle: boolean;
}

export interface BatchConfig {
  Enabled: boolean;
  // MaxRequests is the maximum allowed batch request to execute.
  MaxRequests: GoInt;
  // Timeout is the max duration in seconds to wait before cancelling the batch transaction.
  Timeout: GoInt;
  // MaxBodySize is the maximum allowed batch request body size in bytes.
  //
  // If not set, fallbacks to max ~128MB.
  MaxBodySize: GoInt;
}

export interface BackupsConfig {
  // Cron is a cron expression to schedule auto backups, eg. "* * * * *".
  //
  // Leave it empty to disable the auto backups functionality.
  Cron: string;
  // CronMaxKeep is the max number of cron generated backups to
  // keep before removing older entries.
  //
  // This field works only when the cron config has valid cron expression.
  CronMaxKeep: GoInt;
  // S3 is an optional S3 storage config specifying where to store the app backups.
  S3: S3Config;
}

export interface MetaConfig {
  // @todo experimental
  //
  // AccentColor specify the UI "accent" color (HEX).
  AccentColor: string;
  AppName: string;
  AppURL: string;
  SenderName: string;
  SenderAddress: string;
  HideControls: boolean;
}

export interface LogsConfig {
  // MaxDataSize specifies the maximum allowed serialized log data
  // size before it gets truncated (see [Log.DBExport]).
  //
  // If zero, fallbacks to ~16kb by default.
  MaxDataSize: GoInt;
  MaxDays: GoInt;
  MinLevel: GoInt;
  LogIP: boolean;
  LogAuthId: boolean;
}

export interface TrustedProxyConfig {
  // Headers is a list of explicit trusted header(s) to check.
  Headers: string[] | null;
  // UseLeftmostIP specifies to use the left-mostish IP from the trusted headers.
  //
  // Note that this could be insecure when used with X-Forwarded-For header
  // because some proxies like AWS ELB allow users to prepend their own header value
  // before appending the trusted ones.
  UseLeftmostIP: boolean;
}

export interface RateLimitRule {
  // Label is the identifier of the current rule.
  //
  // It could be a tag, complete path or path prerefix (when ends with `/`).
  //
  // Example supported labels:
  //   - test_a (plain text "tag")
  //   - users:create
  //   - *:create
  //   - /
  //   - /api
  //   - POST /api/collections/
  Label: string;
  // Audience specifies the auth group the rule should apply for:
  //   - ""      - both guests and authenticated users (default)
  //   - "@guest" - only for guests
  //   - "@auth"  - only for authenticated users
  Audience: string;
  // Duration specifies the interval (in seconds) per which to reset
  // the counted/accumulated rate limiter tokens.
  Duration: GoInt;
  // MaxRequests is the max allowed number of requests per Duration.
  MaxRequests: GoInt;
}

export interface RateLimitsConfig {
  Rules: RateLimitRule[] | null;
  ExcludedIPs: string[] | null;
  Enabled: boolean;
}

// Go's unexported `settings` struct
export interface SettingsData {
  // SuperuserIPs defines an optional list of the superuser allowed
  // individual IPs and subnets (in CIDR notation).
  SuperuserIPs: string[] | null;
  SMTP: SMTPConfig;
  Backups: BackupsConfig;
  S3: S3Config;
  Meta: MetaConfig;
  RateLimits: RateLimitsConfig;
  TrustedProxy: TrustedProxyConfig;
  Batch: BatchConfig;
  Logs: LogsConfig;
}

// -------------------------------------------------------------------
// Go struct types (field order, Go types and the form/json tags)

const tags = (name: string, jsonOpts = ""): Record<string, string> => ({
  form: name,
  json: name + jsonOpts,
});

const smtpConfigType = structOf([
  { name: "Enabled", type: "bool", tags: tags("enabled") },
  { name: "Port", type: "int", tags: tags("port") },
  { name: "Host", type: "string", tags: tags("host") },
  { name: "Username", type: "string", tags: tags("username") },
  { name: "Password", type: "string", tags: tags("password") },
  { name: "AuthMethod", type: "string", tags: tags("authMethod") },
  { name: "TLS", type: "bool", tags: tags("tls") },
  { name: "LocalName", type: "string", tags: tags("localName") },
]);

const s3ConfigType = structOf([
  { name: "Enabled", type: "bool", tags: tags("enabled") },
  { name: "Bucket", type: "string", tags: tags("bucket") },
  { name: "Region", type: "string", tags: tags("region") },
  { name: "Endpoint", type: "string", tags: tags("endpoint") },
  { name: "AccessKey", type: "string", tags: tags("accessKey") },
  { name: "Secret", type: "string", tags: tags("secret", ",omitempty") },
  { name: "ForcePathStyle", type: "bool", tags: tags("forcePathStyle") },
]);

const batchConfigType = structOf([
  { name: "Enabled", type: "bool", tags: tags("enabled") },
  { name: "MaxRequests", type: "int", tags: tags("maxRequests") },
  { name: "Timeout", type: "int64", tags: tags("timeout") },
  { name: "MaxBodySize", type: "int64", tags: tags("maxBodySize") },
]);

const backupsConfigType = structOf([
  { name: "Cron", type: "string", tags: tags("cron") },
  { name: "CronMaxKeep", type: "int", tags: tags("cronMaxKeep") },
  { name: "S3", type: s3ConfigType, tags: tags("s3") },
]);

const metaConfigType = structOf([
  { name: "AccentColor", type: "string", tags: tags("accentColor") },
  { name: "AppName", type: "string", tags: tags("appName") },
  { name: "AppURL", type: "string", tags: tags("appURL") },
  { name: "SenderName", type: "string", tags: tags("senderName") },
  { name: "SenderAddress", type: "string", tags: tags("senderAddress") },
  { name: "HideControls", type: "bool", tags: tags("hideControls") },
]);

const logsConfigType = structOf([
  { name: "MaxDataSize", type: "int64", tags: tags("maxDataSize") },
  { name: "MaxDays", type: "int", tags: tags("maxDays") },
  { name: "MinLevel", type: "int", tags: tags("minLevel") },
  { name: "LogIP", type: "bool", tags: tags("logIP") },
  { name: "LogAuthId", type: "bool", tags: tags("logAuthId") },
]);

const trustedProxyConfigType = structOf([
  { name: "Headers", type: sliceOf("string"), tags: tags("headers") },
  { name: "UseLeftmostIP", type: "bool", tags: tags("useLeftmostIP") },
]);

const rateLimitRuleType = structOf([
  { name: "Label", type: "string", tags: tags("label") },
  { name: "Audience", type: "string", tags: tags("audience") },
  { name: "Duration", type: "int64", tags: tags("duration") },
  { name: "MaxRequests", type: "int", tags: tags("maxRequests") },
]);

const rateLimitsConfigType = structOf([
  { name: "Rules", type: sliceOf(rateLimitRuleType), tags: tags("rules") },
  { name: "ExcludedIPs", type: sliceOf("string"), tags: tags("excludedIPs") },
  { name: "Enabled", type: "bool", tags: tags("enabled") },
]);

const settingsDataType = structOf([
  { name: "SuperuserIPs", type: sliceOf("string"), tags: tags("superuserIPs") },
  { name: "SMTP", type: smtpConfigType, tags: tags("smtp") },
  { name: "Backups", type: backupsConfigType, tags: tags("backups") },
  { name: "S3", type: s3ConfigType, tags: tags("s3") },
  { name: "Meta", type: metaConfigType, tags: tags("meta") },
  { name: "RateLimits", type: rateLimitsConfigType, tags: tags("rateLimits") },
  { name: "TrustedProxy", type: trustedProxyConfigType, tags: tags("trustedProxy") },
  { name: "Batch", type: batchConfigType, tags: tags("batch") },
  { name: "Logs", type: logsConfigType, tags: tags("logs") },
]);

// The Go Settings struct: the embedded `settings` (held in
// Settings.settings); the unexported mu and isNew are not bound.
export const settingsType: StructType = structOf([
  { name: "settings", type: settingsDataType, embedded: true },
]);

// -------------------------------------------------------------------
// zero values

function zeroS3(): S3Config {
  return {
    Enabled: false,
    Bucket: "",
    Region: "",
    Endpoint: "",
    AccessKey: "",
    Secret: "",
    ForcePathStyle: false,
  };
}

function zeroRateLimitRule(): RateLimitRule {
  return { Label: "", Audience: "", Duration: 0, MaxRequests: 0 };
}

// the zero value of Go's settings struct
export function zeroSettingsData(): SettingsData {
  return {
    SuperuserIPs: null,
    SMTP: {
      Enabled: false,
      Port: 0,
      Host: "",
      Username: "",
      Password: "",
      AuthMethod: "",
      TLS: false,
      LocalName: "",
    },
    Backups: { Cron: "", CronMaxKeep: 0, S3: zeroS3() },
    S3: zeroS3(),
    Meta: {
      AccentColor: "",
      AppName: "",
      AppURL: "",
      SenderName: "",
      SenderAddress: "",
      HideControls: false,
    },
    RateLimits: { Rules: null, ExcludedIPs: null, Enabled: false },
    TrustedProxy: { Headers: null, UseLeftmostIP: false },
    Batch: { Enabled: false, MaxRequests: 0, Timeout: 0, MaxBodySize: 0 },
    Logs: { MaxDataSize: 0, MaxDays: 0, MinLevel: 0, LogIP: false, LogAuthId: false },
  };
}

// Fills the members a decoding left unset (a struct reset by JSON null is
// an empty object, a new slice element starts empty) with their Go zero
// values, keeping the objects in place.
function fillZero(target: Record<string, unknown>, zero: Record<string, unknown>): void {
  for (const [name, zeroValue] of Object.entries(zero)) {
    const current = target[name];
    if (current === undefined) {
      target[name] = zeroValue;
    } else if (
      zeroValue !== null &&
      typeof zeroValue === "object" &&
      typeof current === "object" &&
      current !== null
    ) {
      fillZero(current as Record<string, unknown>, zeroValue as Record<string, unknown>);
    }
  }
}

function normalize(data: SettingsData): void {
  fillZero(
    data as unknown as Record<string, unknown>,
    zeroSettingsData() as unknown as Record<string, unknown>,
  );
  for (const rule of data.RateLimits.Rules ?? []) {
    fillZero(
      rule as unknown as Record<string, unknown>,
      zeroRateLimitRule() as unknown as Record<string, unknown>,
    );
  }
}

// -------------------------------------------------------------------
// JSON (Go's json/v2 Marshal of the structs)

const quoteFlags = { escapeForHTML: false, escapeForJS: false, allowInvalidUTF8: false };

function str(s: string): string {
  return quote(s, quoteFlags);
}

function int(n: GoInt): string {
  return typeof n === "bigint" ? n.toString() : String(n);
}

function strings(list: string[] | null): string {
  return "[" + (list ?? []).map(str).join(",") + "]";
}

function marshalSMTP(c: SMTPConfig, hidePassword: boolean): string {
  let out =
    `{"enabled":${c.Enabled},"port":${int(c.Port)},"host":${str(c.Host)},` +
    `"username":${str(c.Username)}`;
  if (!hidePassword) {
    out += `,"password":${str(c.Password)}`;
  }
  out += `,"authMethod":${str(c.AuthMethod)},"tls":${c.TLS},"localName":${str(c.LocalName)}`;
  // the `password,omitempty` field of the hidePassword wrapper comes after
  // the embedded alias fields
  if (hidePassword && c.Password !== "") {
    out += `,"password":${str(c.Password)}`;
  }
  return out + "}";
}

function marshalS3(c: S3Config): string {
  return (
    `{"enabled":${c.Enabled},"bucket":${str(c.Bucket)},"region":${str(c.Region)},` +
    `"endpoint":${str(c.Endpoint)},"accessKey":${str(c.AccessKey)},` +
    (c.Secret === "" ? "" : `"secret":${str(c.Secret)},`) +
    `"forcePathStyle":${c.ForcePathStyle}}`
  );
}

function marshalRateLimitRule(r: RateLimitRule): string {
  return (
    `{"label":${str(r.Label)},"audience":${str(r.Audience)},` +
    `"duration":${int(r.Duration)},"maxRequests":${int(r.MaxRequests)}}`
  );
}

function marshalSettingsData(s: SettingsData, hidePassword: boolean): string {
  const m = s.Meta;
  const b = s.Batch;
  const l = s.Logs;
  return (
    `{"superuserIPs":${strings(s.SuperuserIPs)},` +
    `"smtp":${marshalSMTP(s.SMTP, hidePassword)},` +
    `"backups":{"cron":${str(s.Backups.Cron)},"cronMaxKeep":${int(s.Backups.CronMaxKeep)},` +
    `"s3":${marshalS3(s.Backups.S3)}},` +
    `"s3":${marshalS3(s.S3)},` +
    `"meta":{"accentColor":${str(m.AccentColor)},"appName":${str(m.AppName)},` +
    `"appURL":${str(m.AppURL)},"senderName":${str(m.SenderName)},` +
    `"senderAddress":${str(m.SenderAddress)},"hideControls":${m.HideControls}},` +
    `"rateLimits":{"rules":[${(s.RateLimits.Rules ?? []).map(marshalRateLimitRule).join(",")}],` +
    `"excludedIPs":${strings(s.RateLimits.ExcludedIPs)},"enabled":${s.RateLimits.Enabled}},` +
    `"trustedProxy":{"headers":${strings(s.TrustedProxy.Headers)},` +
    `"useLeftmostIP":${s.TrustedProxy.UseLeftmostIP}},` +
    `"batch":{"enabled":${b.Enabled},"maxRequests":${int(b.MaxRequests)},` +
    `"timeout":${int(b.Timeout)},"maxBodySize":${int(b.MaxBodySize)}},` +
    `"logs":{"maxDataSize":${int(l.MaxDataSize)},"maxDays":${int(l.MaxDays)},` +
    `"minLevel":${int(l.MinLevel)},"logIP":${l.LogIP},"logAuthId":${l.LogAuthId}}}`
  );
}

// json.Unmarshal (json/v2, case-sensitive names) of data into the settings
// struct s, merging into its current values. Throws the decoding error;
// members before it may already be applied, as Go's streaming decoder
// leaves them.
export function unmarshalSettings(data: string | Uint8Array, s: Settings): void {
  const text = typeof data === "string" ? data : decodeUTF8Bytes(data);
  const value = decodeValue(text);
  if (hasInvalidUTF8(text)) {
    throw new JsonSyntaxError("invalid UTF-8 within string");
  }
  try {
    unmarshalJSON(value, s as unknown as Record<string, unknown>, settingsType, false);
  } finally {
    s.normalize();
  }
}

// -------------------------------------------------------------------

// The values a Settings DBExport writes (the `_params` row).
export interface SettingsExport {
  id: string;
  created?: string;
  updated: string;
  // the JSON bytes (a BLOB), or the encrypted text (TEXT)
  value: Uint8Array | string;
}

// Settings defines the PocketBase app settings.
export class Settings {
  settings: SettingsData;

  #isNew: boolean;

  // a zero Settings (Go's &Settings{}), or one holding data
  constructor(data: SettingsData = zeroSettingsData(), isNew = false) {
    this.settings = data;
    this.#isNew = isNew;
  }

  // shortcuts to the embedded struct's fields
  get SuperuserIPs(): string[] | null {
    return this.settings.SuperuserIPs;
  }
  set SuperuserIPs(v: string[] | null) {
    this.settings.SuperuserIPs = v;
  }
  get SMTP(): SMTPConfig {
    return this.settings.SMTP;
  }
  get Backups(): BackupsConfig {
    return this.settings.Backups;
  }
  get S3(): S3Config {
    return this.settings.S3;
  }
  get Meta(): MetaConfig {
    return this.settings.Meta;
  }
  get RateLimits(): RateLimitsConfig {
    return this.settings.RateLimits;
  }
  get TrustedProxy(): TrustedProxyConfig {
    return this.settings.TrustedProxy;
  }
  get Batch(): BatchConfig {
    return this.settings.Batch;
  }
  get Logs(): LogsConfig {
    return this.settings.Logs;
  }

  // fills the fields a decoding left unset with their zero values
  normalize(): void {
    if (typeof this.settings !== "object" || this.settings === null) {
      this.settings = zeroSettingsData();
    }
    normalize(this.settings);
  }

  // TableName implements [Model.TableName] interface method.
  tableName(): string {
    return paramsTable;
  }

  // LastSavedPK implements [Model.LastSavedPK] interface method.
  lastSavedPK(): string {
    return paramsKeySettings;
  }

  // PK implements [Model.PK] interface method.
  pk(): string {
    return paramsKeySettings;
  }

  // IsNew implements [Model.IsNew] interface method.
  isNew(): boolean {
    return this.#isNew;
  }

  // MarkAsNew implements [Model.MarkAsNew] interface method.
  markAsNew(): void {
    this.#isNew = true;
  }

  // MarkAsNotNew implements [Model.MarkAsNotNew] interface method.
  markAsNotNew(): void {
    this.#isNew = false;
  }

  // PostScan implements [Model.PostScan] interface method.
  postScan(): void {
    this.markAsNotNew();
  }

  // String returns a serialized string representation of the current settings.
  toString(): string {
    try {
      return this.marshalJSON();
    } catch {
      return "";
    }
  }

  // DBExport prepares and exports the current settings for db persistence.
  //
  // encryptionKey is the value of the app's encryption env variable
  // (os.Getenv(app.EncryptionEnv())); empty stores plain JSON.
  async dbExport(clock: Clock, encryptionKey: string): Promise<SettingsExport> {
    const now = nowDateTime(clock).string();

    const result: SettingsExport = { id: this.pk(), updated: now, value: "" };
    if (this.isNew()) {
      result.created = now;
    }

    const encoded = new TextEncoder().encode(marshalSettingsData(this.settings, false));

    if (encryptionKey !== "") {
      result.value = await encrypt(encoded, encryptionKey);
    } else {
      result.value = encoded;
    }

    return result;
  }

  // PostValidate implements the [PostValidator] interface and defines
  // the Settings model validations.
  validate(): Error | null {
    const s = this.settings;
    return ValidateStruct(
      Field("superuserIPs", s.SuperuserIPs, Each(Required, By(IPOrSubnet))),
      Field(
        "meta",
        validatable(() => validateMeta(s.Meta)),
      ),
      Field(
        "logs",
        validatable(() => validateLogs(s.Logs)),
      ),
      Field(
        "smtp",
        validatable(() => validateSMTP(s.SMTP)),
      ),
      Field(
        "s3",
        validatable(() => validateS3(s.S3)),
      ),
      Field(
        "backups",
        validatable(() => validateBackups(s.Backups)),
      ),
      Field(
        "batch",
        validatable(() => validateBatch(s.Batch)),
      ),
      Field(
        "rateLimits",
        validatable(() => validateRateLimits(s.RateLimits)),
      ),
      Field(
        "trustedProxy",
        validatable(() => validateTrustedProxy(s.TrustedProxy)),
      ),
    );
  }

  // Merge merges the "other" settings into the current one.
  merge(other: Settings): void {
    unmarshalSettings(marshalSettingsData(other.settings, false), this);
  }

  // Clone creates a new deep copy of the current settings.
  clone(): Settings {
    const clone = new Settings(zeroSettingsData(), this.#isNew);
    clone.merge(this);
    return clone;
  }

  // MarshalJSON implements the [json.Marshaler] interface.
  //
  // Note that sensitive fields (S3 secret, SMTP password, etc.) are excluded.
  marshalJSON(): string {
    const copy: SettingsData = {
      ...this.settings,
      SMTP: { ...this.settings.SMTP },
      S3: { ...this.settings.S3 },
      Backups: { ...this.settings.Backups, S3: { ...this.settings.Backups.S3 } },
    };

    // mask all sensitive fields
    copy.SMTP.Password = "";
    copy.S3.Secret = "";
    copy.Backups.S3.Secret = "";

    return marshalSettingsData(copy, true);
  }
}

// newDefaultSettings: the settings of a fresh app
export function newDefaultSettings(): Settings {
  const data = zeroSettingsData();
  data.Meta = {
    AccentColor: "#1055c9",
    AppName: "Acme",
    AppURL: "http://localhost:8090",
    HideControls: false,
    SenderName: "Support",
    SenderAddress: "support@example.com",
  };
  data.Logs = { ...data.Logs, MaxDays: 5, LogIP: true };
  data.SMTP = {
    ...data.SMTP,
    Enabled: false,
    Host: "smtp.example.com",
    Port: 587,
    Username: "",
    Password: "",
    TLS: false,
  };
  data.Backups = { ...data.Backups, CronMaxKeep: 3 };
  data.Batch = { ...data.Batch, Enabled: false, MaxRequests: 50, Timeout: 3 };
  data.RateLimits = {
    ...data.RateLimits,
    Enabled: false, // @todo once tested enough enable by default for new installations
    Rules: [
      { Label: "*:auth", Audience: "", MaxRequests: 2, Duration: 3 },
      { Label: "*:create", Audience: "", MaxRequests: 20, Duration: 5 },
      { Label: "/api/batch", Audience: "", MaxRequests: 3, Duration: 1 },
      { Label: "/api/", Audience: "", MaxRequests: 300, Duration: 10 },
    ],
  };
  return new Settings(data, true);
}

// a sub-config as a Validatable value (Go's value with a Validate method)
function validatable(validate: () => Error | null): Validatable {
  return { validate };
}

// -------------------------------------------------------------------

// SMTPConfig.Validate
export function validateSMTP(c: SMTPConfig): Error | null {
  return ValidateStruct(
    Field("host", c.Host, When(c.Enabled, Required), Host),
    Field("port", c.Port, When(c.Enabled, Required), Min(0)),
    Field(
      "authMethod",
      c.AuthMethod,
      // don't require it for backward compatibility
      // (fallback internally to PLAIN)
      // validation.When(c.Enabled, validation.Required),
      In(SMTPAuthLogin, SMTPAuthPlain),
    ),
    Field("localName", c.LocalName, Host),
  );
}

// S3Config.Validate
export function validateS3(c: S3Config): Error | null {
  return ValidateStruct(
    Field("endpoint", c.Endpoint, URL, When(c.Enabled, Required)),
    Field("bucket", c.Bucket, When(c.Enabled, Required)),
    Field("region", c.Region, When(c.Enabled, Required)),
    Field("accessKey", c.AccessKey, When(c.Enabled, Required)),
    Field("secret", c.Secret, When(c.Enabled, Required)),
  );
}

// BatchConfig.Validate
export function validateBatch(c: BatchConfig): Error | null {
  return ValidateStruct(
    Field("maxRequests", c.MaxRequests, When(c.Enabled, Required), Min(0)),
    Field("timeout", c.Timeout, When(c.Enabled, Required), Min(0)),
    Field("maxBodySize", c.MaxBodySize, Min(0)),
  );
}

// BackupsConfig.Validate
export function validateBackups(c: BackupsConfig): Error | null {
  return ValidateStruct(
    Field(
      "s3",
      validatable(() => validateS3(c.S3)),
    ),
    Field("cron", c.Cron, By(checkCronExpression)),
    Field("cronMaxKeep", c.CronMaxKeep, When(c.Cron !== "", Required), Min(1)),
  );
}

function checkCronExpression(value: unknown): Error | null {
  const v = typeof value === "string" ? value : "";
  if (v === "") {
    return null; // nothing to check
  }

  try {
    newSchedule(v);
  } catch (err) {
    return NewError("validation_invalid_cron", (err as Error).message);
  }

  return null;
}

// MetaConfig.Validate
export function validateMeta(c: MetaConfig): Error | null {
  return ValidateStruct(
    Field("accentColor", c.AccentColor, Length(7, 7), HexColor),
    Field("appName", c.AppName, Required, Length(1, 255)),
    // @todo when replacing the URL validator we may need a system migration to normalize values without protocol
    Field("appURL", c.AppURL, Required, URL),
    Field("senderName", c.SenderName, Required, Length(1, 255)),
    Field("senderAddress", c.SenderAddress, EmailFormat, Required),
  );
}

// LogsConfig.Validate
export function validateLogs(c: LogsConfig): Error | null {
  return ValidateStruct(
    Field("maxDataSize", c.MaxDataSize, Min(0), Max(maxSafeJSONInt)),
    Field("maxDays", c.MaxDays, Min(0), Max(maxSafeJSONInt)),
    Field("minLevel", c.MinLevel, Max(maxSafeJSONInt)),
  );
}

// TrustedProxyConfig.Validate
export function validateTrustedProxy(_c: TrustedProxyConfig): Error | null {
  return null;
}

// FindRateLimitRule returns the first matching rule based on the provided labels.
//
// Optionally you can further specify a list of valid RateLimitRule.Audience values to further filter the matching rule
// (aka. the rule Audience will have to exist in one of the specified options).
export function findRateLimitRule(
  c: RateLimitsConfig,
  searchLabels: string[],
  ...optOnlyAudience: string[]
): [RateLimitRule, boolean] {
  const rules = c.Rules ?? [];
  const prefixRules: number[] = [];

  for (const [i, label] of searchLabels.entries()) {
    // check for direct match
    for (const [j, rule] of rules.entries()) {
      if (
        label === rule.Label &&
        (optOnlyAudience.length === 0 || optOnlyAudience.includes(rule.Audience))
      ) {
        return [rule, true];
      }

      if (i === 0 && rule.Label.endsWith("/")) {
        prefixRules.push(j);
      }
    }

    // check for prefix match
    for (const j of prefixRules) {
      const rule = rules[j] as RateLimitRule;
      if (
        (label + "/").startsWith(rule.Label) &&
        (optOnlyAudience.length === 0 || optOnlyAudience.includes(rule.Audience))
      ) {
        return [rule, true];
      }
    }
  }

  return [zeroRateLimitRule(), false];
}

// RateLimitsConfig.Validate
export function validateRateLimits(c: RateLimitsConfig): Error | null {
  return ValidateStruct(
    Field(
      "rules",
      c.Rules === null ? null : c.Rules.map((rule) => new ValidatableRule(rule)),
      When(c.Enabled, Required),
      By(checkUniqueRuleLabel),
    ),
    Field("excludedIPs", c.ExcludedIPs, Each(Required, By(IPOrSubnet))),
  );
}

// a []RateLimitRule element (validated by its Validate method)
class ValidatableRule implements Validatable {
  constructor(readonly rule: RateLimitRule) {}

  validate(): Error | null {
    return validateRateLimitRule(this.rule);
  }
}

function checkUniqueRuleLabel(value: unknown): Error | null {
  if (
    value !== null &&
    !(Array.isArray(value) && value.every((v) => v instanceof ValidatableRule))
  ) {
    return ErrUnsupportedValueType;
  }
  const rules = ((value ?? []) as ValidatableRule[]).map((v) => v.rule);

  const existing: string[] = [];

  for (const [i, rule] of rules.entries()) {
    const fullKey = rule.Label + "@@" + rule.Audience;

    let conflicts = false;
    for (const key of existing) {
      if (key.startsWith(fullKey) || fullKey.startsWith(key)) {
        conflicts = true;
        break;
      }
    }

    if (conflicts) {
      return new Errors({
        [String(i)]: new Errors({
          label: NewError(
            "validation_conflicting_rate_limit_rule",
            "Rate limit rule configuration with label {{.label}} already exists or conflicts with another rule.",
          ).setParams({ label: rule.Label }),
        }),
      });
    } else {
      existing.push(fullKey);
    }
  }

  return null;
}

const rateLimitRuleLabelRegex = mustCompile(
  String.raw`^(\w+\ \/[\w\/-]*|\/[\w\/-]*|^\w+\:\w+|\*\:\w+|\w+)$`,
);

// The allowed RateLimitRule.Audience values
export const RateLimitRuleAudienceAll = "";
export const RateLimitRuleAudienceGuest = "@guest";
export const RateLimitRuleAudienceAuth = "@auth";

// RateLimitRule.Validate
export function validateRateLimitRule(c: RateLimitRule): Error | null {
  return ValidateStruct(
    Field("label", c.Label, Required, Match(rateLimitRuleLabelRegex)),
    Field("maxRequests", c.MaxRequests, Required, Min(1)),
    Field("duration", c.Duration, Required, Min(1)),
    Field(
      "audience",
      c.Audience,
      In(RateLimitRuleAudienceAll, RateLimitRuleAudienceGuest, RateLimitRuleAudienceAuth),
    ),
  );
}

// DurationTime returns the tag's Duration in milliseconds (Go's
// time.Duration).
export function rateLimitRuleDurationTime(c: RateLimitRule): number {
  return Number(c.Duration) * 1000;
}

// String returns a string representation of the rule.
export function rateLimitRuleString(c: RateLimitRule): string {
  try {
    return marshalRateLimitRule(c);
  } catch {
    return c.Label; // extremely rare case
  }
}
