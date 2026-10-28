// Upstream: core/field_number.go
//
// Values are Go float64s (JS numbers). Min, Max and the error params are
// float64 too (Float64 in the params, so that they print and marshal as Go
// prints a float64).

import {
  DefaultFieldHelpValidationRule,
  DefaultFieldIdValidationRule,
  DefaultFieldNameValidationRule,
  marshalStruct,
  type Field,
  type FieldApp,
  type FieldCollection,
  type FieldRecord,
  type SetterFinder,
  type SetterFunc,
} from "@/fields/field";
import { toFloat64 } from "@/tools/types/cast";
import { anyType, boolType, stringType, unmarshalStruct } from "@/tools/types/go-json";
import { Float64, NewError } from "@/validation/error";
import { Required } from "@/validation/required";
import { Field as StructField, ValidateStruct } from "@/validation/struct";
import { By, type Rule } from "@/validation/validation";
import { ErrUnsupportedValueType } from "@/validators/validators";

export const FieldTypeNumber = "number";

const onlyIntValidationError = NewError(
  "validation_only_int_constraint",
  "Decimal numbers are not allowed",
);
const minNumberValidationError = NewError(
  "validation_min_number_constraint",
  "Must be greater or equal than {{.min}}",
);
const maxNumberValidationError = NewError(
  "validation_max_number_constraint",
  "Must be less or equal than {{.max}}",
);

// NumberField defines "number" type field for storing numeric (float64)
// value.
//
// The respective zero record field value is 0.
//
// The following additional setter keys are available:
//
//   - "fieldName+" - appends to the existing record value. For example:
//     record.set("total+", 5)
//   - "fieldName-" - subtracts from the existing record value. For example:
//     record.set("total-", 5)
export class NumberField implements Field, SetterFinder {
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

  // Presentable hints the Dashboard UI to use the underlying field record
  // value in the relation preview label.
  presentable = false;

  // Help is an extra text explaining what the field is about. It is
  // usually shown in Dashboard UI under the field input.
  help = "";

  // Min specifies the min allowed field value.
  //
  // Leave it null to skip the validator.
  min: number | null = null;

  // Max specifies the max allowed field value.
  //
  // Leave it null to skip the validator.
  max: number | null = null;

  // OnlyInt will require the field value to be integer.
  onlyInt = false;

  // Required will require the field value to be non-zero.
  required = false;

  constructor(init: Partial<NumberFieldSettings> = {}) {
    Object.assign(this, init);
  }

  // Type implements [Field.Type] interface method.
  type(): string {
    return FieldTypeNumber;
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
    return "NUMERIC DEFAULT 0 NOT NULL";
  }

  // PrepareValue implements [Field.PrepareValue] interface method.
  prepareValue(_record: FieldRecord, raw: unknown): [unknown, Error | null] {
    return [toFloat64(raw), null];
  }

  // ValidateValue implements [Field.ValidateValue] interface method.
  validateValue(_app: FieldApp, record: FieldRecord): Error | null {
    const val = record.getRaw(this.name);
    if (typeof val !== "number") {
      return ErrUnsupportedValueType;
    }

    if (!Number.isFinite(val)) {
      return NewError("validation_not_a_number", "The submitted number is not properly formatted");
    }

    if (val === 0) {
      if (this.required) {
        const err = Required.validate(val);
        if (err !== null) {
          return err;
        }
      }
      return null;
    }

    if (this.onlyInt && val !== float64OfInt64(val)) {
      return onlyIntValidationError;
    }

    if (this.min !== null && val < this.min) {
      return minNumberValidationError.setParams({ min: new Float64(this.min) });
    }

    if (this.max !== null && val > this.max) {
      return maxNumberValidationError.setParams({ max: new Float64(this.max) });
    }

    return null;
  }

  // ValidateSettings implements [Field.ValidateSettings] interface method.
  validateSettings(_app: FieldApp, _collection: FieldCollection): Error | null {
    const maxRules: Rule[] = [By((value) => this.checkOnlyInt(value))];
    if (this.min !== null && this.max !== null) {
      maxRules.push(
        By((value) => {
          // similar to validation.Min but doesn't ignore zero values
          const v = typeof value === "number" ? value : null;
          if (v === null || this.min === null || v >= this.min) {
            return null;
          }
          return minNumberValidationError.setParams({ min: new Float64(this.min) });
        }),
      );
    }

    return ValidateStruct(
      StructField("id", this.id, By(DefaultFieldIdValidationRule)),
      StructField("name", this.name, By(DefaultFieldNameValidationRule)),
      StructField("help", this.help, By(DefaultFieldHelpValidationRule)),
      StructField(
        "min",
        this.min,
        By((value) => this.checkOnlyInt(value)),
      ),
      StructField("max", this.max, ...maxRules),
    );
  }

  private checkOnlyInt(value: unknown): Error | null {
    const v = typeof value === "number" ? value : null;
    if (v === null || !this.onlyInt) {
      return null; // nothing to check
    }

    if (v !== float64OfInt64(v)) {
      return onlyIntValidationError;
    }

    return null;
  }

  // FindSetter implements the [SetterFinder] interface.
  findSetter(key: string): SetterFunc | null {
    switch (key) {
      case this.name:
        return (record, raw) => this.setValue(record, raw);
      case this.name + "+":
        return (record, raw) => this.addValue(record, raw);
      case this.name + "-":
        return (record, raw) => this.subtractValue(record, raw);
      default:
        return null;
    }
  }

  private setValue(record: FieldRecord, raw: unknown): void {
    record.setRaw(this.name, toFloat64(raw));
  }

  private addValue(record: FieldRecord, raw: unknown): void {
    const val = toFloat64(record.getRaw(this.name));

    record.setRaw(this.name, val + toFloat64(raw));
  }

  private subtractValue(record: FieldRecord, raw: unknown): void {
    const val = toFloat64(record.getRaw(this.name));

    record.setRaw(this.name, val - toFloat64(raw));
  }

  // json.Marshal: the Go struct field order (a nil Min or Max is null)
  marshalJSON(): string {
    return marshalStruct([
      ["name", this.name],
      ["id", this.id],
      ["system", this.system],
      ["hidden", this.hidden],
      ["presentable", this.presentable],
      ["help", this.help],
      ["min", this.min],
      ["max", this.max],
      ["onlyInt", this.onlyInt],
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
        min: (v) => (this.min = float64Pointer(v)),
        max: (v) => (this.max = float64Pointer(v)),
        onlyInt: (v) => (this.onlyInt = v as boolean),
        required: (v) => (this.required = v as boolean),
      },
      {
        name: stringType,
        id: stringType,
        system: boolType,
        hidden: boolType,
        presentable: boolType,
        help: stringType,
        min: anyType,
        max: anyType,
        onlyInt: boolType,
        required: boolType,
      },
      () => Object.assign(this, new NumberField()),
    );
  }
}

export type NumberFieldSettings = Pick<
  NumberField,
  | "name"
  | "id"
  | "system"
  | "hidden"
  | "presentable"
  | "help"
  | "min"
  | "max"
  | "onlyInt"
  | "required"
>;

// a *float64 member: null is a nil pointer, a JSON number its value
function float64Pointer(v: unknown): number | null {
  if (v === null) {
    return null;
  }
  if (typeof v !== "number") {
    throw new Error(`json: cannot unmarshal JSON ${typeof v} into Go float64`);
  }
  return v;
}

const two63 = 2 ** 63;

// float64(int64(v)) as the amd64 upstream binary computes it: in-range
// values are truncated; NaN and values outside the int64 range convert to
// the "integer indefinite" value -2^63 (CVTTSD2SQ). (On arm64 they
// saturate instead; upstream's own builds differ there.)
function float64OfInt64(v: number): number {
  if (!(v >= -two63 && v < two63)) {
    return -two63;
  }
  return Math.trunc(v);
}
