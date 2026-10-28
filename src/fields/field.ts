// Upstream: core/field.go
//
// The Field contract every collection field implements, the optional
// interfaces the record and collection code look for, and the shared
// settings validation rules.
//
// Record, Collection and App are ported by later tasks (M1.6, M1.8). The
// fields depend only on the narrow interfaces below, named after the
// upstream methods they call; those tasks implement them:
//
//   - FieldRecord: getRaw, setRaw, getDateTime, isNew, original,
//     lastSavedPK, tableName (core/record_model.go);
//   - FieldCollection: id, name, type, fields, isNew
//     (core/collection_model.go), with FieldsListReader's getById and
//     iteration (core/fields_list.go);
//   - FieldApp: concurrentDB, clock, findCollectionByNameOrId and
//     findCachedCollectionByNameOrId (core/app.go). Upstream reads the time from time.Now(); here it comes
//     from the app's clock.
//
// Go's (value, error) results are kept as they are where a caller may use
// both (prepareValue returns [value, error]); validation results are the
// error or null. Go's context.Context arguments are left out: no simple
// field uses them. Intercept is async, because the file field (M1.5)
// uploads and deletes files around the record action; an error rejects.
//
// Not ported: the Fields map (Go's registry that init() functions fill)
// lives in src/fields/fields.ts as a fixed table of upstream's types, so
// that this module does not import every field type.

import type { Clock } from "@/app/clock";
import type { Builder } from "@/db/dbx/builder";
import { mustCompile } from "@/tools/regexp/regexp";
import type { DateTime } from "@/tools/types/datetime";
import { marshal, quote } from "@/tools/types/go-json";
import { IsPrint } from "@/tools/unicode/letter";
import { NewError, type Error as ValidationError } from "@/validation/error";
import { Length } from "@/validation/length";
import { Match } from "@/validation/match";
import { NotIn } from "@/validation/not-in";
import { Required } from "@/validation/required";
import { By, type Rule } from "@/validation/validation";
import { ErrUnsupportedValueType } from "@/validators/validators";

export const fieldNameRegex = mustCompile(String.raw`^\w+$`);

export const maxSafeJSONInt = 2 ** 53 - 1;

// Commonly used field names.
export const FieldNameId = "id";
export const FieldNameCollectionId = "collectionId";
export const FieldNameCollectionName = "collectionName";
export const FieldNameExpand = "expand";
export const FieldNameEmail = "email";
export const FieldNameEmailVisibility = "emailVisibility";
export const FieldNameVerified = "verified";
export const FieldNameTokenKey = "tokenKey";
export const FieldNamePassword = "password";

// SystemDynamicFieldNames returns special internal field names that are
// usually readonly.
export const SystemDynamicFieldNames: readonly string[] = Object.freeze([
  FieldNameCollectionId,
  FieldNameCollectionName,
  FieldNameExpand,
]);

// Common RecordInterceptor action names.
export const InterceptorActionValidate = "validate";
export const InterceptorActionDelete = "delete";
export const InterceptorActionDeleteExecute = "deleteExecute";
export const InterceptorActionAfterDelete = "afterDelete";
export const InterceptorActionAfterDeleteError = "afterDeleteError";
export const InterceptorActionCreate = "create";
export const InterceptorActionCreateExecute = "createExecute";
export const InterceptorActionAfterCreate = "afterCreate";
export const InterceptorActionAfterCreateError = "afterCreateFailure";
export const InterceptorActionUpdate = "update";
export const InterceptorActionUpdateExecute = "updateExecute";
export const InterceptorActionAfterUpdate = "afterUpdate";
export const InterceptorActionAfterUpdateError = "afterUpdateError";

// Common field errors.
export const ErrUnknownField = NewError("validation_unknown_field", "Unknown or invalid field.");
export const ErrInvalidFieldValue = NewError(
  "validation_invalid_field_value",
  "Invalid field value.",
);
export const ErrMustBeSystemAndHidden = NewError(
  "validation_must_be_system_and_hidden",
  `The field must be marked as "System" and "Hidden".`,
);
export const ErrMustBeSystem = NewError(
  "validation_must_be_system",
  `The field must be marked as "System".`,
);

// core/db.go idColumn: the primary key column name.
export const idColumn = "id";

// core/collection_model.go defaultLowercaseRecordIdPattern: the default
// "id" field pattern (the text field skips its extra primary key checks
// for it).
export const defaultLowercaseRecordIdPattern = "^[a-z0-9]+$";

// core/record_model.go internalCustomFieldKeyPrefix: the prefix of the
// record data keys that fields keep for themselves.
export const internalCustomFieldKeyPrefix = "@pbInternal";

// The record methods the fields call (core/record_model.go).
export interface FieldRecord {
  // GetRaw returns the stored value for key: the id, the changed data or
  // the original data, without getter modifiers.
  getRaw(key: string): unknown;
  // SetRaw stores value for key without any normalization.
  setRaw(key: string, value: unknown): void;
  // GetDateTime returns Get(key) as a DateTime (the zero time when it
  // cannot be parsed).
  getDateTime(key: string): DateTime;
  // IsNew reports whether the record has not been saved yet.
  isNew(): boolean;
  // Original returns a copy of the record with its last saved data.
  original(): FieldRecord;
  // LastSavedPK returns the primary key the record was last saved with.
  lastSavedPK(): string;
  // TableName returns the record's table name (its collection name).
  tableName(): string;
}

// The FieldsList methods the fields call (core/fields_list.go).
export interface FieldsListReader extends Iterable<Field> {
  // GetById returns a single field by its id (null when missing).
  getById(fieldId: string): Field | null;
}

// The collection members the fields read (core/collection_model.go).
export interface FieldCollection {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly fields: FieldsListReader;
  // IsNew reports whether the collection has not been saved yet.
  isNew(): boolean;
}

// The app members the fields use (core/app.go).
export interface FieldApp {
  // ConcurrentDB returns the concurrent (read) data.db builder.
  concurrentDB(): Builder;
  // the clock that replaces upstream's time.Now()
  readonly clock: Clock;
  // FindCollectionByNameOrId finds a single collection by its name
  // (case insensitive) or id. Throws when it is not found (Go's error).
  findCollectionByNameOrId(nameOrId: string): FieldCollection;
  // FindCachedCollectionByNameOrId is similar to FindCollectionByNameOrId
  // but retrieves the collection from the app collections cache (name case
  // insensitive). Throws when it is not found (Go's error).
  findCachedCollectionByNameOrId(nameOrId: string): FieldCollection;
}

// Field defines a common interface that all Collection fields should
// implement.
export interface Field {
  // note: the getters has an explicit "get" prefix to avoid conflicts with
  // their related field members

  // GetId returns the field id.
  getId(): string;
  // SetId changes the field id.
  setId(id: string): void;
  // GetName returns the field name.
  getName(): string;
  // SetName changes the field name.
  setName(name: string): void;
  // GetSystem returns the field system flag state.
  getSystem(): boolean;
  // SetSystem changes the field system flag state.
  setSystem(system: boolean): void;
  // GetHidden returns the field hidden flag state.
  getHidden(): boolean;
  // SetHidden changes the field hidden flag state.
  setHidden(hidden: boolean): void;

  // Type returns the unique type of the field.
  type(): string;

  // ColumnType returns the DB column definition of the field.
  columnType(app: FieldApp): string;

  // PrepareValue returns a properly formatted field value based on the
  // provided raw one, and an error (Go's (any, error)).
  //
  // This method is also called on record construction to initialize its
  // default field value.
  prepareValue(record: FieldRecord, raw: unknown): [unknown, Error | null];

  // ValidateValue validates the current field value associated with the
  // provided record.
  validateValue(app: FieldApp, record: FieldRecord): Error | null;

  // ValidateSettings validates the current field settings.
  validateSettings(app: FieldApp, collection: FieldCollection): Error | null;

  // json.Marshal(field): the settings in the Go struct field order.
  marshalJSON(): string;

  // json.Unmarshal(data, field): reads the settings back (json v2: member
  // names are case sensitive, unknown members are ignored, a member of the
  // wrong type or a duplicate name is an error).
  unmarshalJSON(data: string | Uint8Array): void;
}

// MaxBodySizeCalculator defines an optional field interface for
// specifying the max size of a field value.
export interface MaxBodySizeCalculator {
  // CalculateMaxBodySize returns the approximate max body size of a field
  // value.
  calculateMaxBodySize(): number;
}

export type SetterFunc = (record: FieldRecord, raw: unknown) => void;

// SetterFinder defines a field interface for registering custom field
// value setters.
export interface SetterFinder {
  // FindSetter returns a single field value setter function by performing
  // pattern-like field matching using the specified key.
  //
  // The key is usually just the field name but it could also contains
  // "modifier" characters based on which you can perform custom set
  // operations (ex. "users+" could be mapped to a function that will append
  // new user to the existing field value).
  //
  // Return null if you want to fallback to the default field value setter.
  findSetter(key: string): SetterFunc | null;
}

export type GetterFunc = (record: FieldRecord) => unknown;

// GetterFinder defines a field interface for registering custom field
// value getters.
export interface GetterFinder {
  // FindGetter returns a single field value getter function by performing
  // pattern-like field matching using the specified key.
  //
  // The key is usually just the field name but it could also contains
  // "modifier" characters based on which you can perform custom get
  // operations (ex. "description:excerpt" could be mapped to a function
  // that will return an excerpt of the current field value).
  //
  // Return null if you want to fallback to the default field value getter.
  findGetter(key: string): GetterFunc | null;
}

// DriverValuer defines a Field interface for exporting and formatting a
// field value for the database.
export interface DriverValuer {
  // DriverValue exports a single field value for persistence in the
  // database, and an error (Go's (driver.Value, error)).
  driverValue(record: FieldRecord): [unknown, Error | null];
}

// MultiValuer defines a field interface that every multi-valued (eg. with
// MaxSelect) field has.
export interface MultiValuer {
  // IsMultiple checks whether the field is configured to support multiple
  // or single values.
  isMultiple(): boolean;
}

// RecordInterceptor defines a field interface for reacting to various
// Record related operations (create, delete, validate, etc.).
export interface RecordInterceptor {
  // Intercept is invoked when a specific record action occurs allowing you
  // to perform extra validations and normalization (ex. uploading or
  // deleting files).
  //
  // Note that callers must call actionFunc() manually if they want to
  // execute the specific record action.
  intercept(
    app: FieldApp,
    record: FieldRecord,
    actionName: string,
    actionFunc: () => Promise<void>,
  ): Promise<void>;
}

// Go's type assertions for the optional interfaces.

export function isSetterFinder(f: Field): f is Field & SetterFinder {
  return typeof (f as Partial<SetterFinder>).findSetter === "function";
}

export function isGetterFinder(f: Field): f is Field & GetterFinder {
  return typeof (f as Partial<GetterFinder>).findGetter === "function";
}

export function isDriverValuer(f: Field): f is Field & DriverValuer {
  return typeof (f as Partial<DriverValuer>).driverValue === "function";
}

export function isMultiValuer(f: Field): f is Field & MultiValuer {
  return typeof (f as Partial<MultiValuer>).isMultiple === "function";
}

export function isMaxBodySizeCalculator(f: Field): f is Field & MaxBodySizeCalculator {
  return typeof (f as Partial<MaxBodySizeCalculator>).calculateMaxBodySize === "function";
}

export function isRecordInterceptor(f: Field): f is Field & RecordInterceptor {
  return typeof (f as Partial<RecordInterceptor>).intercept === "function";
}

// DefaultFieldHelpValidationRule performs base validation on a field's
// "help" value.
export function DefaultFieldHelpValidationRule(value: unknown): Error | null {
  if (typeof value !== "string") {
    return ErrUnsupportedValueType;
  }

  const rules: Rule[] = [Length(1, 300)];

  for (const r of rules) {
    const err = r.validate(value);
    if (err !== null) {
      return err;
    }
  }

  return null;
}

// DefaultFieldIdValidationRule performs base validation on a field id
// value.
export function DefaultFieldIdValidationRule(value: unknown): Error | null {
  if (typeof value !== "string") {
    return ErrUnsupportedValueType;
  }

  const rules: Rule[] = [Required, Length(1, 100)];

  for (const r of rules) {
    const err = r.validate(value);
    if (err !== null) {
      return err;
    }
  }

  return null;
}

// exclude special filter and system literals
const excludeNames: unknown[] = ["null", "true", "false", "_rowid_", ...SystemDynamicFieldNames];

// DefaultFieldNameValidationRule performs base validation on a field name
// value.
export function DefaultFieldNameValidationRule(value: unknown): Error | null {
  if (typeof value !== "string") {
    return ErrUnsupportedValueType;
  }

  const rules: Rule[] = [
    Required,
    Length(1, 100),
    Match(fieldNameRegex),
    NotIn(...excludeNames),
    By(checkForVia),
  ];

  for (const r of rules) {
    const err = r.validate(value);
    if (err !== null) {
      return err;
    }
  }

  return null;
}

function checkForVia(value: unknown): ValidationError | null {
  const v = typeof value === "string" ? value : "";
  if (v === "") {
    return null;
  }

  // strings.ToLower. Go and JS lower a few non-ASCII letters differently
  // (Go lowers U+0130 to "i", JS to "i" + U+0307), but a name reaches this
  // rule only after Match(fieldNameRegex), whose Go \w is ASCII only.
  if (v.toLowerCase().includes("_via_")) {
    return NewError("validation_found_via", `The value cannot contain "_via_".`);
  }

  return null;
}

export function noopSetter(_record: FieldRecord, _raw: unknown): void {
  // do nothing
}

// json.Marshal of a Go struct (json v2 defaults): the members in the
// struct field order, without HTML escaping. Values are marshaled as Go
// marshals them (go-json's marshal; a JSON marshaler's own text).
export function marshalStruct(members: readonly (readonly [string, unknown])[]): string {
  const flags = { escapeForHTML: false, escapeForJS: false, allowInvalidUTF8: false };
  let out = "{";
  for (const [i, [name, value]] of members.entries()) {
    out += (i > 0 ? "," : "") + quote(name, flags) + ":" + marshal(value);
  }
  return out + "}";
}

// strconv.Quote: a double-quoted Go string literal; non-printable runes
// (unicode.IsPrint) are escaped, invalid UTF-8 bytes (lone surrogates
// here) as \xNN.
export function goQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const r = ch.codePointAt(0) as number;
    if (r >= 0xd800 && r <= 0xdfff) {
      // an invalid byte (U+DC80+n stands for the byte 0x80+n)
      if (r >= 0xdc80 && r <= 0xdcff) {
        out += "\\x" + (r - 0xdc00).toString(16);
      } else {
        out += "\ufffd";
      }
      continue;
    }
    switch (ch) {
      case '"':
        out += '\\"';
        continue;
      case "\\":
        out += "\\\\";
        continue;
    }
    if (IsPrint(r)) {
      out += ch;
      continue;
    }
    switch (ch) {
      case "\x07":
        out += "\\a";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\v":
        out += "\\v";
        break;
      default:
        if (r < 0x20 || r === 0x7f) {
          out += "\\x" + r.toString(16).padStart(2, "0");
        } else if (r < 0x10000) {
          out += "\\u" + r.toString(16).padStart(4, "0");
        } else {
          out += "\\U" + r.toString(16).padStart(8, "0");
        }
    }
  }
  return out + '"';
}
