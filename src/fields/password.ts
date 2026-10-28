// Upstream: core/field_password.go, and the used subset of
// golang.org/x/crypto/bcrypt v0.58.0 (bcrypt.go, base64.go)
//
// Hashes are computed with Bun.password (bcrypt). Go's bcrypt writes
// "$2a$" hashes and its CompareHashAndPassword accepts any hash it can
// parse: a version byte up to '2' with an optional minor byte, two cost
// digits, a 22 character salt and at least the 31 character hash (bytes
// after it are ignored). The version is not part of the computation for
// passwords of at most 72 bytes, so a hash is parsed here as Go parses it
// and verified by Bun.password in its canonical "$2b$" form. Bun.password
// pre-hashes passwords over 72 bytes, so the password is truncated to 72
// bytes first, as Go's key schedule does.

import {
  DefaultFieldHelpValidationRule,
  DefaultFieldIdValidationRule,
  DefaultFieldNameValidationRule,
  InterceptorActionAfterCreate,
  InterceptorActionAfterUpdate,
  goQuote,
  marshalStruct,
  type DriverValuer,
  type Field,
  type FieldApp,
  type FieldCollection,
  type FieldRecord,
  type GetterFinder,
  type GetterFunc,
  type RecordInterceptor,
  type SetterFinder,
  type SetterFunc,
} from "@/fields/field";
import { matchString } from "@/tools/regexp/regexp";
import { toString as castToString } from "@/tools/types/cast";
import {
  boolType,
  bytesToText,
  intType,
  stringType,
  textToBytes,
  unmarshalStruct,
} from "@/tools/types/go-json";
import { NewError } from "@/validation/error";
import { Max, Min } from "@/validation/minmax";
import { Required } from "@/validation/required";
import { Field as StructField, ValidateStruct } from "@/validation/struct";
import { runeCount } from "@/validation/util";
import { By } from "@/validation/validation";
import { IsRegex } from "@/validators/string";
import { ErrUnsupportedValueType } from "@/validators/validators";

export const FieldTypePassword = "password";

// PasswordField defines "password" type field for storing bcrypt hashed
// strings (usually used only internally for the "password" auth collection
// system field).
//
// If you want to set a direct bcrypt hash as record field value you can
// use the SetRaw method, for example:
//
//	// generates a bcrypt hash of "123456" and set it as field value
//	// (record.getString("password") returns the plain password until persisted, otherwise empty string)
//	record.set("password", "123456")
//
//	// set directly a bcrypt hash of "123456" as field value
//	// (record.getString("password") returns empty string)
//	record.setRaw("password", "$2a$10$.5Elh8fgxypNUWhpUUr/xOa2sZm0VIaE0qWuGGl9otUfobb46T1Pq")
//
// The following additional getter keys are available:
//
//   - "fieldName:hash" - returns the bcrypt hash string of the record field
//     value (if any). For example: record.getString("password:hash")
export class PasswordField
  implements Field, GetterFinder, SetterFinder, DriverValuer, RecordInterceptor
{
  // Name (required) is the unique name of the field.
  name = "";

  // Id is the unique stable field identifier.
  //
  // It is automatically generated from the name when adding to a
  // collection FieldsList.
  id = "";

  // System prevents the renaming and removal of the field.
  system = false;

  // Hidden hides the field from the API response.
  hidden = false;

  // ---

  // @todo remove
  //
  // Presentable hints the Dashboard UI to use the underlying field record
  // value in the relation preview label.
  presentable = false;

  // Help is an extra text explaining what the field is about. It is
  // usually shown in Dashboard UI under the field input.
  help = "";

  // Pattern specifies an optional regex pattern to match against the field
  // value.
  //
  // Leave it empty to skip the pattern check.
  pattern = "";

  // Min specifies an optional required field string length.
  min = 0;

  // Max specifies an optional required field string length.
  //
  // If zero, fallback to max 71 bytes.
  max = 0;

  // Cost specifies the cost/weight/iteration/etc. bcrypt factor.
  //
  // If zero, fallback to [DefaultCost].
  //
  // If explicitly set, must be between [MinCost] and [MaxCost].
  cost = 0;

  // Required will require the field value to be non-empty string.
  required = false;

  constructor(init: Partial<PasswordFieldSettings> = {}) {
    Object.assign(this, init);
  }

  // Type implements [Field.Type] interface method.
  type(): string {
    return FieldTypePassword;
  }

  // GetId implements [Field.GetId] interface method.
  getId(): string {
    return this.id;
  }

  // SetId implements [Field.SetId] interface method.
  setId(id: string): void {
    this.id = id;
  }

  // GetName implements [Field.GetName] interface method.
  getName(): string {
    return this.name;
  }

  // SetName implements [Field.SetName] interface method.
  setName(name: string): void {
    this.name = name;
  }

  // GetSystem implements [Field.GetSystem] interface method.
  getSystem(): boolean {
    return this.system;
  }

  // SetSystem implements [Field.SetSystem] interface method.
  setSystem(system: boolean): void {
    this.system = system;
  }

  // GetHidden implements [Field.GetHidden] interface method.
  getHidden(): boolean {
    return this.hidden;
  }

  // SetHidden implements [Field.SetHidden] interface method.
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
  }

  // ColumnType implements [Field.ColumnType] interface method.
  columnType(_app: FieldApp): string {
    return "TEXT DEFAULT '' NOT NULL";
  }

  // DriverValue implements the [DriverValuer] interface.
  driverValue(record: FieldRecord): [unknown, Error | null] {
    const fp = this.getPasswordValue(record);
    return [fp.hash, fp.lastError];
  }

  // PrepareValue implements [Field.PrepareValue] interface method.
  prepareValue(_record: FieldRecord, raw: unknown): [unknown, Error | null] {
    return [new PasswordFieldValue({ hash: castToString(raw) }), null];
  }

  // ValidateValue implements [Field.ValidateValue] interface method.
  validateValue(_app: FieldApp, record: FieldRecord): Error | null {
    const fp = record.getRaw(this.name);
    if (!(fp instanceof PasswordFieldValue)) {
      return ErrUnsupportedValueType;
    }

    if (fp.lastError !== null) {
      return fp.lastError;
    }

    if (this.required) {
      const err = Required.validate(fp.hash);
      if (err !== null) {
        return err;
      }
    }

    if (fp.plain === "") {
      return null; // nothing to check
    }

    // note: counted in runes to count multi-byte chars as one for the sake
    // of more intuitive UX and clearer user error messages
    //
    // note2: technically multi-byte strings could produce bigger length
    // than the bcrypt limit but it should be fine as it will be just
    // truncated (even if it cuts a byte sequence in the middle)
    const length = runeCount(fp.plain);

    if (length < this.min) {
      return NewError(
        "validation_min_text_constraint",
        `Must be at least ${this.min} character(s)`,
      );
    }

    let maxLength = this.max;
    if (maxLength <= 0) {
      maxLength = 71;
    }
    if (length > maxLength) {
      return NewError(
        "validation_max_text_constraint",
        `Must be less than ${maxLength} character(s)`,
      );
    }

    if (this.pattern !== "") {
      let match = false;
      try {
        match = matchString(this.pattern, fp.plain);
      } catch {
        // regexp.MatchString returns false with the compile error
      }
      if (!match) {
        return NewError("validation_invalid_format", "Invalid value format");
      }
    }

    return null;
  }

  // ValidateSettings implements [Field.ValidateSettings] interface method.
  validateSettings(_app: FieldApp, _collection: FieldCollection): Error | null {
    return ValidateStruct(
      StructField("id", this.id, By(DefaultFieldIdValidationRule)),
      StructField("name", this.name, By(DefaultFieldNameValidationRule)),
      StructField("help", this.help, By(DefaultFieldHelpValidationRule)),
      StructField("min", this.min, Min(1), Max(71)),
      StructField("max", this.max, Min(this.min), Max(71)),
      StructField("cost", this.cost, Min(MinCost), Max(MaxCost)),
      StructField("pattern", this.pattern, By(IsRegex)),
    );
  }

  private getPasswordValue(record: FieldRecord): PasswordFieldValue {
    const raw = record.getRaw(this.name);

    if (raw instanceof PasswordFieldValue) {
      return raw;
    }
    // we assume that any raw string starting with $2 is bcrypt hash
    if (typeof raw === "string" && raw.startsWith("$2")) {
      return new PasswordFieldValue({ hash: raw });
    }

    return new PasswordFieldValue();
  }

  // Intercept implements the [RecordInterceptor] interface.
  async intercept(
    _app: FieldApp,
    record: FieldRecord,
    actionName: string,
    actionFunc: () => Promise<void>,
  ): Promise<void> {
    switch (actionName) {
      case InterceptorActionAfterCreate:
      case InterceptorActionAfterUpdate: {
        // unset the plain field value after successful create/update
        const fp = this.getPasswordValue(record);
        fp.plain = "";
        break;
      }
    }

    return actionFunc();
  }

  // FindGetter implements the [GetterFinder] interface.
  findGetter(key: string): GetterFunc | null {
    switch (key) {
      case this.name:
        return (record) => this.getPasswordValue(record).plain;
      case this.name + ":hash":
        return (record) => this.getPasswordValue(record).hash;
      default:
        return null;
    }
  }

  // FindSetter implements the [SetterFinder] interface.
  findSetter(key: string): SetterFunc | null {
    switch (key) {
      case this.name:
        return (record, raw) => this.setValue(record, raw);
      default:
        return null;
    }
  }

  private setValue(record: FieldRecord, raw: unknown): void {
    const fv = new PasswordFieldValue({ plain: castToString(raw) });

    // hash the password
    if (fv.plain !== "") {
      let cost = this.cost;
      if (cost <= 0) {
        cost = DefaultCost;
      }

      try {
        fv.hash = generateFromPassword(textToBytes(fv.plain), cost);
      } catch (err) {
        fv.lastError = err as Error;
      }
    }

    record.setRaw(this.name, fv);
  }

  // json.Marshal: the Go struct field order
  marshalJSON(): string {
    return marshalStruct([
      ["name", this.name],
      ["id", this.id],
      ["system", this.system],
      ["hidden", this.hidden],
      ["presentable", this.presentable],
      ["help", this.help],
      ["pattern", this.pattern],
      ["min", this.min],
      ["max", this.max],
      ["cost", this.cost],
      ["required", this.required],
    ]);
  }

  // json.Unmarshal
  unmarshalJSON(data: string | Uint8Array): void {
    unmarshalStruct(
      data,
      {
        name: (v) => (this.name = v as string),
        id: (v) => (this.id = v as string),
        system: (v) => (this.system = v as boolean),
        hidden: (v) => (this.hidden = v as boolean),
        presentable: (v) => (this.presentable = v as boolean),
        help: (v) => (this.help = v as string),
        pattern: (v) => (this.pattern = v as string),
        min: (v) => (this.min = v as number),
        max: (v) => (this.max = v as number),
        cost: (v) => (this.cost = v as number),
        required: (v) => (this.required = v as boolean),
      },
      {
        name: stringType,
        id: stringType,
        system: boolType,
        hidden: boolType,
        presentable: boolType,
        help: stringType,
        pattern: stringType,
        min: intType,
        max: intType,
        cost: intType,
        required: boolType,
      },
      () => Object.assign(this, new PasswordField()),
    );
  }
}

export type PasswordFieldSettings = Pick<
  PasswordField,
  | "name"
  | "id"
  | "system"
  | "hidden"
  | "presentable"
  | "help"
  | "pattern"
  | "min"
  | "max"
  | "cost"
  | "required"
>;

// -------------------------------------------------------------------

export class PasswordFieldValue {
  lastError: Error | null = null;
  hash = "";
  plain = "";

  constructor(init: Partial<Pick<PasswordFieldValue, "lastError" | "hash" | "plain">> = {}) {
    Object.assign(this, init);
  }

  validate(pass: string): boolean {
    if (this.hash === "" || this.lastError !== null) {
      return false;
    }

    const err = compareHashAndPassword(textToBytes(this.hash), textToBytes(pass));

    return err === null;
  }
}

// -------------------------------------------------------------------
// golang.org/x/crypto/bcrypt

export const MinCost = 4; // the minimum allowable cost as passed in to GenerateFromPassword
export const MaxCost = 31; // the maximum allowable cost as passed in to GenerateFromPassword
export const DefaultCost = 10; // the cost that will actually be set if a cost below MinCost is passed into GenerateFromPassword

// The error returned from CompareHashAndPassword when a password and hash
// do not match.
export const ErrMismatchedHashAndPassword = new Error(
  "crypto/bcrypt: hashedPassword is not the hash of the given password",
);

// The error returned from CompareHashAndPassword when a hash is too short
// to be a bcrypt hash.
export const ErrHashTooShort = new Error(
  "crypto/bcrypt: hashedSecret too short to be a bcrypted password",
);

// ErrPasswordTooLong is returned when the password passed to
// GenerateFromPassword is too long (i.e. > 72 bytes).
export const ErrPasswordTooLong = new Error("bcrypt: password length exceeds 72 bytes");

const majorVersion = 0x32; // '2'
const encodedSaltSize = 22;
const encodedHashSize = 31;
const minHashSize = 59;
const maxKeySize = 72;

// The error returned from CompareHashAndPassword when a hash was created
// with a bcrypt algorithm newer than this implementation.
export class HashVersionTooNewError extends Error {
  constructor(readonly version: number) {
    super(
      `crypto/bcrypt: bcrypt algorithm version '${String.fromCharCode(version)}' requested is newer than current version '2'`,
    );
  }
}

// The error returned from CompareHashAndPassword when a hash starts with
// something other than '$'
export class InvalidHashPrefixError extends Error {
  constructor(readonly prefix: number) {
    super(
      `crypto/bcrypt: bcrypt hashes must start with '$', but hashedSecret started with '${String.fromCharCode(prefix)}'`,
    );
  }
}

export class InvalidCostError extends Error {
  constructor(readonly cost: number) {
    super(`crypto/bcrypt: cost ${cost} is outside allowed inclusive range ${MinCost}..${MaxCost}`);
  }
}

// GenerateFromPassword returns the bcrypt hash of the password at the
// given cost. If the cost given is less than MinCost, the cost will be set
// to DefaultCost, instead. GenerateFromPassword does not accept passwords
// longer than 72 bytes, which is the longest password bcrypt will operate
// on. Throws the error.
export function generateFromPassword(password: Uint8Array, cost: number): string {
  if (password.length > maxKeySize) {
    throw ErrPasswordTooLong;
  }
  if (cost < MinCost) {
    cost = DefaultCost;
  }
  checkCost(cost);

  const hash = Bun.password.hashSync(bunPassword(password), { algorithm: "bcrypt", cost });

  // Bun writes "$2b$"; the computation is the same, Go writes "$2a$"
  return "$2a$" + hash.slice("$2b$".length);
}

// CompareHashAndPassword compares a bcrypt hashed password with its
// possible plaintext equivalent. Returns null on success, or an error on
// failure.
export function compareHashAndPassword(
  hashedPassword: Uint8Array,
  password: Uint8Array,
): Error | null {
  let p: Hashed;
  try {
    p = newFromHash(hashedPassword);
  } catch (err) {
    return err as Error;
  }

  // expensiveBlowfishSetup decodes the salt (Go's base64 with "=="
  // appended). Go's decoder skips '\r' and '\n', which would leave a salt
  // shorter than 16 bytes; no bcrypt implementation writes such a hash and
  // Bun.password cannot compute one, so it is treated as invalid data.
  const salt = canonicalBase64(p.salt);
  if (salt === null) {
    return new Error(`illegal base64 data at input byte ${invalidBase64Index(p.salt)}`);
  }

  // Go compares the whole hashes, which differ only in the encoded hash:
  // the computed one is always 31 canonical characters, the stored one is
  // cut or zero padded to 31 bytes.
  const stored = p.hash.subarray(0, encodedHashSize);
  if (stored.length < encodedHashSize || canonicalBase64(stored) !== bytesToText(stored)) {
    return ErrMismatchedHashAndPassword;
  }

  const canonical = `$2b$${String(p.cost).padStart(2, "0")}$${salt}${bytesToText(stored)}`;
  let ok = false;
  try {
    ok = Bun.password.verifySync(bunPassword(password), canonical, "bcrypt");
  } catch {
    // not the hash of the password
  }

  return ok ? null : ErrMismatchedHashAndPassword;
}

// Cost returns the hashing cost used to create the given hashed password.
// Throws the error.
export function Cost(hashedPassword: Uint8Array): number {
  return newFromHash(hashedPassword).cost;
}

// Bun.password's input for the bcrypt key: at most 72 bytes (Go's key
// schedule uses no more; Bun.password pre-hashes longer ones), and the
// empty password as one NUL byte (bcrypt appends a NUL to the key, so the
// two have the same key schedule; Bun.password refuses an empty one).
function bunPassword(password: Uint8Array): Uint8Array {
  if (password.length === 0) {
    return Uint8Array.of(0);
  }
  return password.subarray(0, maxKeySize);
}

interface Hashed {
  hash: Uint8Array;
  salt: Uint8Array;
  cost: number;
}

function newFromHash(hashedSecret: Uint8Array): Hashed {
  if (hashedSecret.length < minHashSize) {
    throw ErrHashTooShort;
  }

  // decodeVersion
  if (hashedSecret[0] !== 0x24) {
    throw new InvalidHashPrefixError(hashedSecret[0] as number);
  }
  if ((hashedSecret[1] as number) > majorVersion) {
    throw new HashVersionTooNewError(hashedSecret[1] as number);
  }
  let n = 3;
  if (hashedSecret[2] !== 0x24) {
    n++;
  }

  // decodeCost
  const cost = atoi(hashedSecret.subarray(n, n + 2));
  checkCost(cost);
  n += 3;

  return {
    salt: hashedSecret.subarray(n, n + encodedSaltSize),
    hash: hashedSecret.subarray(n + encodedSaltSize),
    cost,
  };
}

function checkCost(cost: number): void {
  if (cost < MinCost || cost > MaxCost) {
    throw new InvalidCostError(cost);
  }
}

// strconv.Atoi of a two byte string: an optional sign and decimal digits
function atoi(s: Uint8Array): number {
  let i = 0;
  let neg = false;
  if (s[0] === 0x2b || s[0] === 0x2d) {
    neg = s[0] === 0x2d;
    i++;
  }
  let n = 0;
  if (i >= s.length) {
    throw atoiSyntaxError(s);
  }
  for (; i < s.length; i++) {
    const c = s[i] as number;
    if (c < 0x30 || c > 0x39) {
      throw atoiSyntaxError(s);
    }
    n = n * 10 + (c - 0x30);
  }
  return neg ? -n : n;
}

function atoiSyntaxError(s: Uint8Array): Error {
  return new Error(`strconv.Atoi: parsing ${goQuote(bytesToText(s))}: invalid syntax`);
}

// the bcrypt base64 alphabet (base64.go)
const alphabet = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const decodeMap = new Int8Array(256).fill(-1);
for (const [i, ch] of [...alphabet].entries()) {
  decodeMap[ch.charCodeAt(0)] = i;
}

// The canonical encoding of the unpadded bcrypt base64 text src: the
// bytes it decodes to (bits past the last whole byte are dropped, as Go's
// non-strict decoder does) encoded again. Null when src has a byte that is
// not in the alphabet.
function canonicalBase64(src: Uint8Array): string | null {
  const bits = src.length * 6;
  const bytes = new Uint8Array(Math.floor(bits / 8));
  let acc = 0;
  let accBits = 0;
  let j = 0;
  for (const c of src) {
    const v = decodeMap[c] as number;
    if (v < 0) {
      return null;
    }
    acc = (acc << 6) | v;
    accBits += 6;
    if (accBits >= 8) {
      accBits -= 8;
      bytes[j++] = (acc >> accBits) & 0xff;
    }
    acc &= (1 << accBits) - 1;
  }

  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const remaining = bytes.length - i;
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (remaining > 1) {
      out += alphabet[((b1 & 0x0f) << 2) | (b2 >> 6)];
    }
    if (remaining > 2) {
      out += alphabet[b2 & 0x3f];
    }
  }
  return out;
}

// the index Go's base64 CorruptInputError reports for the first byte of
// src that is not in the alphabet
function invalidBase64Index(src: Uint8Array): number {
  return src.findIndex((c) => (decodeMap[c] as number) < 0);
}
