// Upstream: core/field_password.go
//
// The bcrypt hashing and verification is src/tools/crypto/bcrypt.ts.

import {
  DefaultFieldHelpValidationRule,
  DefaultFieldIdValidationRule,
  DefaultFieldNameValidationRule,
  InterceptorActionAfterCreate,
  InterceptorActionAfterUpdate,
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
import {
  DefaultCost,
  MaxCost,
  MinCost,
  compareHashAndPassword,
  generateFromPassword,
} from "@/tools/crypto/bcrypt";
import { matchString } from "@/tools/regexp/regexp";
import { toString as castToString } from "@/tools/types/cast";
import {
  boolType,
  intType,
  stringType,
  textToBytes,
  unmarshalStruct,
  type GoInt,
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
  min: GoInt = 0;

  // Max specifies an optional required field string length.
  //
  // If zero, fallback to max 71 bytes.
  max: GoInt = 0;

  // Cost specifies the cost/weight/iteration/etc. bcrypt factor.
  //
  // If zero, fallback to [DefaultCost].
  //
  // If explicitly set, must be between [MinCost] and [MaxCost].
  cost: GoInt = 0;

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
        min: (v) => (this.min = v as GoInt),
        max: (v) => (this.max = v as GoInt),
        cost: (v) => (this.cost = v as GoInt),
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
