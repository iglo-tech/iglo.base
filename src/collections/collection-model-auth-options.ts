// Upstream: core/collection_model_auth_options.go
//
// The auth options are promoted fields of Go's Collection (it embeds
// collectionAuthOptions), so here they are properties of Collection
// itself: CollectionAuthOptions names them, and the functions below do
// what Go does with the embedded struct as a whole (its defaults, its JSON
// members, decoding into it).
//
// Go's option structs are values: assigning or returning one copies it.
// The classes have clone() for the places where Go copies, and marshaling
// never modifies them (secrets are left out of the output instead of
// being cleared on a copy).
//
// Not here: the Validate methods, collectionAuthOptions.validate,
// checkForDuplicatedProviders and checkProviderName (M1.6a), and
// OAuth2ProviderConfig.InitProvider (M4, with the providers).

import type { Field } from "@/fields/field";
import { FieldNameEmail, marshalStruct } from "@/fields/field";
import {
  type EmailTemplateData,
  defaultAuthAlertTemplate,
  defaultConfirmEmailChangeTemplate,
  defaultOTPTemplate,
  defaultResetPasswordTemplate,
  defaultVerificationTemplate,
} from "@/collections/collection-model-auth-templates";
import {
  type MemberDecoders,
  arrayElements,
  decodeAs,
  decodeBool,
  decodeInt,
  decodeInt64,
  decodeNullableBool,
  decodeNullableString,
  decodeString,
  unmarshalGoStruct,
} from "@/collections/go-json-struct";
import { randomString } from "@/tools/security/random";
import { toString as castToString } from "@/tools/types/cast";
import {
  type GoInt,
  anyType,
  mapOf,
  marshal,
  sliceOf,
  stringType,
  unmarshalMapInto,
} from "@/tools/types/go-json";

// the collection members the two helpers below read
interface AuthOptionsCollection extends CollectionAuthOptions {
  type: string;
  fields: { getByName(fieldName: string): Field | null };
}

// unsetMissingOAuth2MappedFields clears the OAuth2 mapped fields that are
// not fields of the (auth) collection.
export function unsetMissingOAuth2MappedFields(m: AuthOptionsCollection): void {
  if (m.type !== "auth") {
    return;
  }

  if (m.oauth2.mappedFields.id !== "") {
    if (m.fields.getByName(m.oauth2.mappedFields.id) === null) {
      m.oauth2.mappedFields.id = "";
    }
  }

  if (m.oauth2.mappedFields.name !== "") {
    if (m.fields.getByName(m.oauth2.mappedFields.name) === null) {
      m.oauth2.mappedFields.name = "";
    }
  }

  if (m.oauth2.mappedFields.username !== "") {
    if (m.fields.getByName(m.oauth2.mappedFields.username) === null) {
      m.oauth2.mappedFields.username = "";
    }
  }

  if (m.oauth2.mappedFields.avatarURL !== "") {
    if (m.fields.getByName(m.oauth2.mappedFields.avatarURL) === null) {
      m.oauth2.mappedFields.avatarURL = "";
    }
  }
}

// setDefaultAuthOptions replaces all auth options with their defaults
// (new random token secrets).
export function setDefaultAuthOptions(m: CollectionAuthOptions): void {
  setAuthOptions(m, {
    verificationTemplate: new EmailTemplate(defaultVerificationTemplate),
    resetPasswordTemplate: new EmailTemplate(defaultResetPasswordTemplate),
    confirmEmailChangeTemplate: new EmailTemplate(defaultConfirmEmailChangeTemplate),
    authRule: "",
    manageRule: null,
    authAlert: new AuthAlertConfig({
      enabled: true,
      emailTemplate: new EmailTemplate(defaultAuthAlertTemplate),
    }),
    oauth2: new OAuth2Config(),
    passwordAuth: new PasswordAuthConfig({
      enabled: true,
      identityFields: [FieldNameEmail],
    }),
    mfa: new MFAConfig({
      enabled: false,
      duration: 600, // 10min
    }),
    otp: new OTPConfig({
      enabled: false,
      duration: 180, // 3min
      length: 8,
      emailTemplate: new EmailTemplate(defaultOTPTemplate),
    }),
    authToken: new TokenConfig({
      secret: randomString(50),
      duration: 432000, // 5days
    }),
    passwordResetToken: new TokenConfig({
      secret: randomString(50),
      duration: 1800, // 30min
    }),
    emailChangeToken: new TokenConfig({
      secret: randomString(50),
      duration: 1800, // 30min
    }),
    verificationToken: new TokenConfig({
      secret: randomString(50),
      duration: 86400, // 1day
    }),
    fileToken: new TokenConfig({
      secret: randomString(50),
      duration: 180, // 3min
    }),
  });
}

// collectionAuthOptions defines the options for the "auth" type collection.
export interface CollectionAuthOptions {
  // AuthRule could be used to specify additional record constraints
  // applied after record authentication and right before returning the
  // auth token response to the client.
  //
  // For example, to allow only verified users you could set it to
  // "verified = true".
  //
  // Set it to empty string to allow any Auth collection record to authenticate.
  //
  // Set it to null to disallow authentication altogether for the collection
  // (that includes password, OAuth2, etc.).
  authRule: string | null;

  // ManageRule gives admin-like permissions to allow fully managing
  // the auth record(s), eg. changing the password without requiring
  // to enter the old one, directly updating the verified state and email, etc.
  //
  // This rule is executed in addition to the Create and Update API rules.
  manageRule: string | null;

  // AuthAlert defines options related to the auth alerts on new device login.
  authAlert: AuthAlertConfig;

  // OAuth2 specifies whether OAuth2 auth is enabled for the collection
  // and which OAuth2 providers are allowed.
  oauth2: OAuth2Config;

  // PasswordAuth defines options related to the collection password authentication.
  passwordAuth: PasswordAuthConfig;

  // MFA defines options related to the Multi-factor authentication (MFA).
  mfa: MFAConfig;

  // OTP defines options related to the One-time password authentication (OTP).
  otp: OTPConfig;

  // Various token configurations
  // ---
  authToken: TokenConfig;
  passwordResetToken: TokenConfig;
  emailChangeToken: TokenConfig;
  verificationToken: TokenConfig;
  fileToken: TokenConfig;

  // Default email templates
  // ---
  verificationTemplate: EmailTemplate;
  resetPasswordTemplate: EmailTemplate;
  confirmEmailChangeTemplate: EmailTemplate;
}

// the zero value of collectionAuthOptions
export function zeroAuthOptions(): CollectionAuthOptions {
  return {
    authRule: null,
    manageRule: null,
    authAlert: new AuthAlertConfig(),
    oauth2: new OAuth2Config(),
    passwordAuth: new PasswordAuthConfig(),
    mfa: new MFAConfig(),
    otp: new OTPConfig(),
    authToken: new TokenConfig(),
    passwordResetToken: new TokenConfig(),
    emailChangeToken: new TokenConfig(),
    verificationToken: new TokenConfig(),
    fileToken: new TokenConfig(),
    verificationTemplate: new EmailTemplate(),
    resetPasswordTemplate: new EmailTemplate(),
    confirmEmailChangeTemplate: new EmailTemplate(),
  };
}

// assigns all auth options of src to m (Go's struct assignment)
export function setAuthOptions(m: CollectionAuthOptions, src: CollectionAuthOptions): void {
  m.authRule = src.authRule;
  m.manageRule = src.manageRule;
  m.authAlert = src.authAlert;
  m.oauth2 = src.oauth2;
  m.passwordAuth = src.passwordAuth;
  m.mfa = src.mfa;
  m.otp = src.otp;
  m.authToken = src.authToken;
  m.passwordResetToken = src.passwordResetToken;
  m.emailChangeToken = src.emailChangeToken;
  m.verificationToken = src.verificationToken;
  m.fileToken = src.fileToken;
  m.verificationTemplate = src.verificationTemplate;
  m.resetPasswordTemplate = src.resetPasswordTemplate;
  m.confirmEmailChangeTemplate = src.confirmEmailChangeTemplate;
}

// The JSON members of collectionAuthOptions in the Go struct order. With
// redact, as Collection.MarshalJSON does, the token secrets and the OAuth2
// client secrets are left out (they are cleared on a copy and omitted by
// omitempty) and nil providers are an empty array (as they are anyway in
// json v2).
export function authOptionsMembers(o: CollectionAuthOptions, redact = false): [string, unknown][] {
  const token = (t: TokenConfig): TokenConfig =>
    redact ? new TokenConfig({ duration: t.duration }) : t;
  return [
    ["authRule", o.authRule],
    ["manageRule", o.manageRule],
    ["authAlert", o.authAlert],
    ["oauth2", redact ? o.oauth2.redacted() : o.oauth2],
    ["passwordAuth", o.passwordAuth],
    ["mfa", o.mfa],
    ["otp", o.otp],
    ["authToken", token(o.authToken)],
    ["passwordResetToken", token(o.passwordResetToken)],
    ["emailChangeToken", token(o.emailChangeToken)],
    ["verificationToken", token(o.verificationToken)],
    ["fileToken", token(o.fileToken)],
    ["verificationTemplate", o.verificationTemplate],
    ["resetPasswordTemplate", o.resetPasswordTemplate],
    ["confirmEmailChangeTemplate", o.confirmEmailChangeTemplate],
  ];
}

// json.Marshal(collectionAuthOptions)
export function marshalAuthOptions(o: CollectionAuthOptions): string {
  return marshalStruct(authOptionsMembers(o));
}

// The member decoders of collectionAuthOptions (json.Unmarshal into the
// embedded struct, merging into the current values).
export function authOptionsDecoders(o: CollectionAuthOptions): MemberDecoders {
  return {
    authRule: (raw) => (o.authRule = decodeNullableString(raw)),
    manageRule: (raw) => (o.manageRule = decodeNullableString(raw)),
    authAlert: (raw) => o.authAlert.unmarshalJSON(raw),
    oauth2: (raw) => o.oauth2.unmarshalJSON(raw),
    passwordAuth: (raw) => o.passwordAuth.unmarshalJSON(raw),
    mfa: (raw) => o.mfa.unmarshalJSON(raw),
    otp: (raw) => o.otp.unmarshalJSON(raw),
    authToken: (raw) => o.authToken.unmarshalJSON(raw),
    passwordResetToken: (raw) => o.passwordResetToken.unmarshalJSON(raw),
    emailChangeToken: (raw) => o.emailChangeToken.unmarshalJSON(raw),
    verificationToken: (raw) => o.verificationToken.unmarshalJSON(raw),
    fileToken: (raw) => o.fileToken.unmarshalJSON(raw),
    verificationTemplate: (raw) => o.verificationTemplate.unmarshalJSON(raw),
    resetPasswordTemplate: (raw) => o.resetPasswordTemplate.unmarshalJSON(raw),
    confirmEmailChangeTemplate: (raw) => o.confirmEmailChangeTemplate.unmarshalJSON(raw),
  };
}

// json.Unmarshal(data, &collectionAuthOptions)
export function unmarshalAuthOptions(o: CollectionAuthOptions, data: string | Uint8Array): void {
  unmarshalGoStruct(data, authOptionsDecoders(o), () => setAuthOptions(o, zeroAuthOptions()));
}

// time.Duration(seconds) * time.Second: nanoseconds as Go's int64 (which
// wraps around on overflow)
function durationTime(seconds: GoInt): bigint {
  return BigInt.asIntN(64, BigInt(seconds) * 1_000_000_000n);
}

// -------------------------------------------------------------------

export class EmailTemplate {
  subject = "";
  body = "";

  constructor(init: Partial<EmailTemplateData> = {}) {
    Object.assign(this, init);
  }

  clone(): EmailTemplate {
    return new EmailTemplate(this);
  }

  // Resolve replaces the placeholder parameters in the current email
  // template and returns its components as ready-to-use strings
  // ([subject, body]). Go ranges over a map, in random order; here the
  // placeholders are replaced in their insertion order.
  resolve(
    placeholders: Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown> | null,
  ): [subject: string, body: string] {
    let body = this.body;
    let subject = this.subject;

    const entries =
      placeholders === null
        ? []
        : placeholders instanceof Map
          ? [...placeholders.entries()]
          : Object.entries(placeholders);

    for (const [k, v] of entries) {
      const vStr = castToString(v);

      // replace subject placeholder params (if any)
      subject = replaceAll(subject, k, vStr);

      // replace body placeholder params (if any)
      body = replaceAll(body, k, vStr);
    }

    return [subject, body];
  }

  marshalJSON(): string {
    return marshalStruct([
      ["subject", this.subject],
      ["body", this.body],
    ]);
  }

  unmarshalJSON(data: string | Uint8Array): void {
    unmarshalGoStruct(
      data,
      {
        subject: (raw) => (this.subject = decodeString(raw)),
        body: (raw) => (this.body = decodeString(raw)),
      },
      () => Object.assign(this, new EmailTemplate()),
    );
  }
}

// strings.ReplaceAll: an empty old string inserts new before each rune
// and at the end
function replaceAll(s: string, old: string, replacement: string): string {
  if (old === "") {
    let out = replacement;
    for (const ch of s) {
      out += ch + replacement;
    }
    return out;
  }
  return s.split(old).join(replacement);
}

// -------------------------------------------------------------------

export class AuthAlertConfig {
  enabled = false;
  emailTemplate = new EmailTemplate();

  constructor(init: Partial<Pick<AuthAlertConfig, "enabled" | "emailTemplate">> = {}) {
    Object.assign(this, init);
  }

  clone(): AuthAlertConfig {
    return new AuthAlertConfig({
      enabled: this.enabled,
      emailTemplate: this.emailTemplate.clone(),
    });
  }

  marshalJSON(): string {
    return marshalStruct([
      ["enabled", this.enabled],
      ["emailTemplate", this.emailTemplate],
    ]);
  }

  unmarshalJSON(data: string | Uint8Array): void {
    unmarshalGoStruct(
      data,
      {
        enabled: (raw) => (this.enabled = decodeBool(raw)),
        emailTemplate: (raw) => this.emailTemplate.unmarshalJSON(raw),
      },
      () => Object.assign(this, new AuthAlertConfig()),
    );
  }
}

// -------------------------------------------------------------------

export class TokenConfig {
  secret = "";

  // Duration specifies how long an issued token to be valid (in seconds)
  duration: GoInt = 0;

  constructor(init: Partial<Pick<TokenConfig, "secret" | "duration">> = {}) {
    Object.assign(this, init);
  }

  clone(): TokenConfig {
    return new TokenConfig(this);
  }

  // DurationTime returns the current Duration as Go's time.Duration
  // (nanoseconds).
  durationTime(): bigint {
    return durationTime(this.duration);
  }

  marshalJSON(): string {
    const members: [string, unknown][] = [];
    if (this.secret !== "") {
      members.push(["secret", this.secret]); // omitempty
    }
    members.push(["duration", this.duration]);
    return marshalStruct(members);
  }

  unmarshalJSON(data: string | Uint8Array): void {
    unmarshalGoStruct(
      data,
      {
        secret: (raw) => (this.secret = decodeString(raw)),
        duration: (raw) => (this.duration = decodeInt64(raw)),
      },
      () => Object.assign(this, new TokenConfig()),
    );
  }
}

// -------------------------------------------------------------------

export class OTPConfig {
  enabled = false;

  // Duration specifies how long the OTP to be valid (in seconds)
  duration: GoInt = 0;

  // Length specifies the auto generated password length.
  length: GoInt = 0;

  // EmailTemplate is the default OTP email template that will be send to the auth record.
  //
  // In addition to the system placeholders you can also make use of
  // EmailPlaceholderOTPId and EmailPlaceholderOTP.
  emailTemplate = new EmailTemplate();

  constructor(
    init: Partial<Pick<OTPConfig, "enabled" | "duration" | "length" | "emailTemplate">> = {},
  ) {
    Object.assign(this, init);
  }

  clone(): OTPConfig {
    return new OTPConfig({ ...this, emailTemplate: this.emailTemplate.clone() });
  }

  // DurationTime returns the current Duration as Go's time.Duration
  // (nanoseconds).
  durationTime(): bigint {
    return durationTime(this.duration);
  }

  marshalJSON(): string {
    return marshalStruct([
      ["enabled", this.enabled],
      ["duration", this.duration],
      ["length", this.length],
      ["emailTemplate", this.emailTemplate],
    ]);
  }

  unmarshalJSON(data: string | Uint8Array): void {
    unmarshalGoStruct(
      data,
      {
        enabled: (raw) => (this.enabled = decodeBool(raw)),
        duration: (raw) => (this.duration = decodeInt64(raw)),
        length: (raw) => (this.length = decodeInt(raw)),
        emailTemplate: (raw) => this.emailTemplate.unmarshalJSON(raw),
      },
      () => Object.assign(this, new OTPConfig()),
    );
  }
}

// -------------------------------------------------------------------

export class MFAConfig {
  enabled = false;

  // Duration specifies how long an issued MFA to be valid (in seconds)
  duration: GoInt = 0;

  // Rule is an optional field to restrict MFA only for the records that satisfy the rule.
  //
  // Leave it empty to enable MFA for everyone.
  rule = "";

  constructor(init: Partial<Pick<MFAConfig, "enabled" | "duration" | "rule">> = {}) {
    Object.assign(this, init);
  }

  clone(): MFAConfig {
    return new MFAConfig(this);
  }

  // DurationTime returns the current Duration as Go's time.Duration
  // (nanoseconds).
  durationTime(): bigint {
    return durationTime(this.duration);
  }

  marshalJSON(): string {
    return marshalStruct([
      ["enabled", this.enabled],
      ["duration", this.duration],
      ["rule", this.rule],
    ]);
  }

  unmarshalJSON(data: string | Uint8Array): void {
    unmarshalGoStruct(
      data,
      {
        enabled: (raw) => (this.enabled = decodeBool(raw)),
        duration: (raw) => (this.duration = decodeInt64(raw)),
        rule: (raw) => (this.rule = decodeString(raw)),
      },
      () => Object.assign(this, new MFAConfig()),
    );
  }
}

// -------------------------------------------------------------------

export class PasswordAuthConfig {
  enabled = false;

  // IdentityFields is a list of field names that could be used as
  // identity during password authentication.
  //
  // Usually only fields that has single column UNIQUE index are accepted
  // as values. A nil Go slice is an empty array (json v2 marshals both as
  // []).
  identityFields: string[] = [];

  constructor(init: Partial<Pick<PasswordAuthConfig, "enabled" | "identityFields">> = {}) {
    Object.assign(this, init);
  }

  clone(): PasswordAuthConfig {
    return new PasswordAuthConfig({
      enabled: this.enabled,
      identityFields: [...this.identityFields],
    });
  }

  marshalJSON(): string {
    return marshalStruct([
      ["enabled", this.enabled],
      ["identityFields", this.identityFields],
    ]);
  }

  unmarshalJSON(data: string | Uint8Array): void {
    unmarshalGoStruct(
      data,
      {
        enabled: (raw) => (this.enabled = decodeBool(raw)),
        identityFields: (raw) =>
          (this.identityFields =
            (decodeAs(raw, sliceOf(stringType)) as string[] | undefined) ?? []),
      },
      () => Object.assign(this, new PasswordAuthConfig()),
    );
  }
}

// -------------------------------------------------------------------

export class OAuth2KnownFields {
  id = "";
  name = "";
  username = "";
  avatarURL = "";

  constructor(
    init: Partial<Pick<OAuth2KnownFields, "id" | "name" | "username" | "avatarURL">> = {},
  ) {
    Object.assign(this, init);
  }

  clone(): OAuth2KnownFields {
    return new OAuth2KnownFields(this);
  }

  marshalJSON(): string {
    return marshalStruct([
      ["id", this.id],
      ["name", this.name],
      ["username", this.username],
      ["avatarURL", this.avatarURL],
    ]);
  }

  unmarshalJSON(data: string | Uint8Array): void {
    unmarshalGoStruct(
      data,
      {
        id: (raw) => (this.id = decodeString(raw)),
        name: (raw) => (this.name = decodeString(raw)),
        username: (raw) => (this.username = decodeString(raw)),
        avatarURL: (raw) => (this.avatarURL = decodeString(raw)),
      },
      () => Object.assign(this, new OAuth2KnownFields()),
    );
  }
}

export class OAuth2Config {
  // null is Go's nil slice (marshaled as [] by json v2)
  providers: OAuth2ProviderConfig[] | null = null;

  mappedFields = new OAuth2KnownFields();

  enabled = false;

  constructor(init: Partial<Pick<OAuth2Config, "providers" | "mappedFields" | "enabled">> = {}) {
    Object.assign(this, init);
  }

  // a copy with copies of the providers (Go's struct copy and
  // slices.Clone; each provider's PKCE pointer and Extra map stay shared,
  // as in Go)
  clone(): OAuth2Config {
    return new OAuth2Config({
      providers: this.providers === null ? null : this.providers.map((p) => p.clone()),
      mappedFields: this.mappedFields.clone(),
      enabled: this.enabled,
    });
  }

  // the config as Collection.MarshalJSON serializes it: providers always
  // an array, without their client secrets
  redacted(): OAuth2Config {
    return new OAuth2Config({
      providers: (this.providers ?? []).map((p) => {
        const copy = p.clone();
        copy.clientSecret = "";
        return copy;
      }),
      mappedFields: this.mappedFields,
      enabled: this.enabled,
    });
  }

  marshalJSON(): string {
    return marshalStruct([
      ["providers", this.providers ?? []],
      ["mappedFields", this.mappedFields],
      ["enabled", this.enabled],
    ]);
  }

  // UnmarshalJSON implements the [json.Unmarshaler] interface.
  //
  // The main difference from the standard unmarshalization is that
  // instead of replacing the entire providers config slice, we ensure
  // that partially submitted provider data (e.g. without clientSecret)
  // is merged on per config level based on the provider name
  // (https://ganigeorgiev.com/pocketbase/discussions/7815).
  unmarshalJSON(data: string | Uint8Array): void {
    const originalProviders = this.providers === null ? null : this.providers.map((p) => p.clone());

    unmarshalGoStruct(
      data,
      {
        providers: (raw) => {
          const items = arrayElements(raw);
          if (items === null) {
            this.providers = null;
            return;
          }
          // the elements are zeroed before decoding (no merge)
          this.providers = [];
          for (const item of items) {
            const p = new OAuth2ProviderConfig();
            this.providers.push(p);
            p.unmarshalJSON(item);
          }
        },
        mappedFields: (raw) => this.mappedFields.unmarshalJSON(raw),
        enabled: (raw) => (this.enabled = decodeBool(raw)),
      },
      () => Object.assign(this, new OAuth2Config()),
    );

    if (this.providers === null || this.providers.length === 0) {
      return;
    }

    // unmarshal again but this time into a plain array of objects
    // so that we have only the submitted fields and no zero defaults
    let plainProviders: (Record<string, unknown> | undefined)[] = [];
    unmarshalGoStruct(
      data,
      {
        providers: (raw) =>
          (plainProviders =
            (decodeAs(raw, sliceOf(mapOf(anyType))) as
              | (Record<string, unknown> | undefined)[]
              | undefined) ?? []),
      },
      () => {},
    );

    // no providers were submitted
    if (plainProviders.length === 0) {
      return;
    }

    if (this.providers.length !== plainProviders.length) {
      throw new Error(
        "the length of the plain unmarshalized providers and the ones from the config doesn't match",
      );
    }

    providersMergeLoop: for (const [i, plain] of plainProviders.entries()) {
      for (const originalProvider of originalProviders ?? []) {
        const name = plain?.name;
        if (typeof name === "string" && originalProvider.name === name) {
          const raw = marshal(plain ?? {});

          // unmarshal the new plain data on top of the original one
          // (the range variable is a copy; its PKCE pointer and Extra map
          // are shared, so a submitted pkce bool changes every provider
          // merged from the same original, earlier ones included)
          const original = originalProvider.clone();
          original.unmarshalJSON(raw);

          // reassigne to the updated original
          this.providers[i] = original;

          continue providersMergeLoop;
        }
      }
    }
  }

  // GetProviderConfig returns the first OAuth2ProviderConfig that matches
  // the specified name, and whether it exists (a zero config when not).
  getProviderConfig(name: string): [config: OAuth2ProviderConfig, exists: boolean] {
    for (const p of this.providers ?? []) {
      if (p.name === name) {
        return [p.clone(), true];
      }
    }
    return [new OAuth2ProviderConfig(), false];
  }
}

export class OAuth2ProviderConfig {
  // PKCE overwrites the default provider PKCE config option.
  //
  // This usually shouldn't be needed but some OAuth2 vendors, like the LinkedIn OIDC,
  // may require manual adjustment due to returning error if extra parameters are added to the request
  // (https://ganigeorgiev.com/pocketbase/discussions/3799#discussioncomment-7640312)
  //
  // Go's *bool is pkceRef: a copy of the config shares the pointed-to
  // value, and decoding a JSON bool writes through a non-nil pointer (to
  // every copy). Assigning pkce points it to a new value, as `&v` would.
  pkceRef: { value: boolean } | null = null;

  get pkce(): boolean | null {
    return this.pkceRef === null ? null : this.pkceRef.value;
  }

  set pkce(v: boolean | null) {
    this.pkceRef = v === null ? null : { value: v };
  }

  name = "";
  clientId = "";
  clientSecret = "";
  authURL = "";
  tokenURL = "";
  userInfoURL = "";
  displayName = "";
  // null is Go's nil map (marshaled as {} by json v2)
  extra: Record<string, unknown> | null = null;

  constructor(init: Partial<OAuth2ProviderSettings> = {}) {
    Object.assign(this, init);
  }

  // Go's struct copy: the PKCE pointer and the Extra map are shared
  clone(): OAuth2ProviderConfig {
    return new OAuth2ProviderConfig(this);
  }

  marshalJSON(): string {
    const members: [string, unknown][] = [
      ["pkce", this.pkce],
      ["name", this.name],
      ["clientId", this.clientId],
    ];
    if (this.clientSecret !== "") {
      members.push(["clientSecret", this.clientSecret]); // omitempty
    }
    members.push(
      ["authURL", this.authURL],
      ["tokenURL", this.tokenURL],
      ["userInfoURL", this.userInfoURL],
      ["displayName", this.displayName],
      ["extra", this.extra ?? {}],
    );
    return marshalStruct(members);
  }

  unmarshalJSON(data: string | Uint8Array): void {
    unmarshalGoStruct(
      data,
      {
        // null sets the pointer to nil, a bool is written through a
        // non-nil pointer (a nil one is allocated)
        pkce: (raw) => {
          const v = decodeNullableBool(raw);
          if (v === null || this.pkceRef === null) {
            this.pkce = v;
          } else {
            this.pkceRef.value = v;
          }
        },
        name: (raw) => (this.name = decodeString(raw)),
        clientId: (raw) => (this.clientId = decodeString(raw)),
        clientSecret: (raw) => (this.clientSecret = decodeString(raw)),
        authURL: (raw) => (this.authURL = decodeString(raw)),
        tokenURL: (raw) => (this.tokenURL = decodeString(raw)),
        userInfoURL: (raw) => (this.userInfoURL = decodeString(raw)),
        displayName: (raw) => (this.displayName = decodeString(raw)),
        // a non-nil map is merged into
        extra: (raw) =>
          (this.extra =
            this.extra === null
              ? ((decodeAs(raw, mapOf(anyType)) as Record<string, unknown> | undefined) ?? null)
              : (unmarshalMapInto(raw, anyType, this.extra) ?? null)),
      },
      () => Object.assign(this, new OAuth2ProviderConfig()),
    );
  }
}

type OAuth2ProviderSettings = Pick<
  OAuth2ProviderConfig,
  | "pkce"
  | "name"
  | "clientId"
  | "clientSecret"
  | "authURL"
  | "tokenURL"
  | "userInfoURL"
  | "displayName"
  | "extra"
>;
