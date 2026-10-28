// Upstream: core/field_date.go

import {
  DefaultFieldHelpValidationRule,
  DefaultFieldIdValidationRule,
  DefaultFieldNameValidationRule,
  marshalStruct,
  type Field,
  type FieldApp,
  type FieldCollection,
  type FieldRecord,
} from "@/fields/field";
import { DateTime, DefaultDateLayout, parseDateTime } from "@/tools/types/datetime";
import { boolType, stringType, unmarshalStruct } from "@/tools/types/go-json";
import { Date as DateRule } from "@/validation/date";
import { Max, Min } from "@/validation/minmax";
import { ErrRequired } from "@/validation/required";
import { Field as StructField, ValidateStruct } from "@/validation/struct";
import { By, type RuleFunc } from "@/validation/validation";
import { ErrUnsupportedValueType } from "@/validators/validators";

export const FieldTypeDate = "date";

// DateField defines "date" type field to store a single [DateTime] value.
//
// The respective zero record field value is the zero [DateTime].
export class DateField implements Field {
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
  // Leave it empty to skip the validator.
  min = new DateTime();

  // Max specifies the max allowed field value.
  //
  // Leave it empty to skip the validator.
  max = new DateTime();

  // Required will require the field value to be non-zero.
  required = false;

  constructor(init: Partial<DateFieldSettings> = {}) {
    Object.assign(this, init);
  }

  // Type implements [Field.Type] interface method.
  type(): string {
    return FieldTypeDate;
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

  // PrepareValue implements [Field.PrepareValue] interface method.
  prepareValue(_record: FieldRecord, raw: unknown): [unknown, Error | null] {
    return [parseDateTime(raw), null];
  }

  // ValidateValue implements [Field.ValidateValue] interface method.
  validateValue(_app: FieldApp, record: FieldRecord): Error | null {
    const val = record.getRaw(this.name);
    if (!(val instanceof DateTime)) {
      return ErrUnsupportedValueType;
    }

    if (val.isZero()) {
      if (this.required) {
        return ErrRequired;
      }
      return null; // nothing to check
    }

    if (!this.min.isZero()) {
      const err = Min(this.min).validate(val);
      if (err !== null) {
        return err;
      }
    }

    if (!this.max.isZero()) {
      const err = Max(this.max).validate(val);
      if (err !== null) {
        return err;
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
      StructField("max", this.max, By(this.checkRange(this.min, this.max))),
    );
  }

  private checkRange(min: DateTime, max: DateTime): RuleFunc {
    return (value) => {
      if (!(value instanceof DateTime) || value.isZero()) {
        return null; // nothing to check
      }

      const dr = DateRule(DefaultDateLayout);

      // note: upstream discards the rules these return (Go's DateRule
      // methods have value receivers), so the range is never applied and
      // only the layout of v is checked
      if (!min.isZero()) {
        dr.min(min);
      }

      if (!max.isZero()) {
        dr.max(max);
      }

      return dr.validate(value.string());
    };
  }

  // json.Marshal: the Go struct field order (a zero DateTime is "")
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
      ["required", this.required],
    ]);
  }

  // json.Unmarshal (DateTime.UnmarshalJSON: a JSON string, scanned)
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
        min: (v) => (this.min = parseDateTime(v)),
        max: (v) => (this.max = parseDateTime(v)),
        required: (v) => (this.required = v as boolean),
      },
      {
        name: stringType,
        id: stringType,
        system: boolType,
        hidden: boolType,
        presentable: boolType,
        help: stringType,
        min: stringType,
        max: stringType,
        required: boolType,
      },
      () => Object.assign(this, new DateField()),
    );
  }
}

export type DateFieldSettings = Pick<
  DateField,
  "name" | "id" | "system" | "hidden" | "presentable" | "help" | "min" | "max" | "required"
>;
