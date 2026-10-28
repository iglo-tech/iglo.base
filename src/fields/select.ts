// Upstream: core/field_select.go

import {
  DefaultFieldHelpValidationRule,
  DefaultFieldIdValidationRule,
  DefaultFieldNameValidationRule,
  marshalStruct,
  type DriverValuer,
  type Field,
  type FieldApp,
  type FieldCollection,
  type FieldRecord,
  type MultiValuer,
  type SetterFinder,
  type SetterFunc,
} from "@/fields/field";
import { subtractSlice, toUniqueStringSlice } from "@/tools/list/list";
import {
  boolType,
  intType,
  maxGoInt,
  sliceOf,
  stringType,
  unmarshalStruct,
  type GoInt,
} from "@/tools/types/go-json";
import type { JSONArray } from "@/tools/types/json-array";
import { NewError } from "@/validation/error";
import { Max, Min } from "@/validation/minmax";
import { ErrRequired, Required } from "@/validation/required";
import { Field as StructField, ValidateStruct } from "@/validation/struct";
import { By } from "@/validation/validation";

export const FieldTypeSelect = "select";

// SelectField defines "select" type field for storing single or multiple
// string values from a predefined list.
//
// Requires the Values option to be set.
//
// If MaxSelect is not set or <= 1, then the field value is expected to be
// a single Values element.
//
// If MaxSelect is > 1, then the field value is expected to be a subset of
// Values slice.
//
// The respective zero record field value is either empty string (single)
// or empty string slice (multiple).
//
// ---
//
// The following additional setter keys are available:
//
//   - "fieldName+" - append one or more values to the existing record one.
//     For example:
//
//     record.set("roles+", ["new1", "new2"]) // ["old1", "old2", "new1", "new2"]
//
//   - "+fieldName" - prepend one or more values to the existing record one.
//     For example:
//
//     record.set("+roles", ["new1", "new2"]) // ["new1", "new2", "old1", "old2"]
//
//   - "fieldName-" - subtract one or more values from the existing record
//     one. For example:
//
//     record.set("roles-", "old1") // ["old2"]
export class SelectField implements Field, MultiValuer, DriverValuer, SetterFinder {
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

  // Values specifies the list of accepted values.
  //
  // (Go's nil slice is an empty array: json v2 marshals both as [].)
  values: string[] = [];

  // MaxSelect specifies the max allowed selected values.
  //
  // For multiple select the value must be > 1, otherwise fallbacks to
  // single (default).
  maxSelect: GoInt = 0;

  // Required will require the field value to be non-empty.
  required = false;

  constructor(init: Partial<SelectFieldSettings> = {}) {
    Object.assign(this, init);
  }

  // Type implements [Field.Type] interface method.
  type(): string {
    return FieldTypeSelect;
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

  // IsMultiple implements [MultiValuer] interface and checks whether the
  // current field options support multiple values.
  isMultiple(): boolean {
    return this.maxSelect > 1;
  }

  // ColumnType implements [Field.ColumnType] interface method.
  columnType(_app: FieldApp): string {
    if (this.isMultiple()) {
      return "JSON DEFAULT '[]' NOT NULL";
    }

    return "TEXT DEFAULT '' NOT NULL";
  }

  // PrepareValue implements [Field.PrepareValue] interface method.
  prepareValue(_record: FieldRecord, raw: unknown): [unknown, Error | null] {
    return [this.normalizeValue(raw), null];
  }

  private normalizeValue(raw: unknown): string | string[] {
    const val = toUniqueStringSlice(raw);

    if (!this.isMultiple()) {
      if (val.length > 0) {
        return val[val.length - 1] as string; // the last selected
      }
      return "";
    }

    return val;
  }

  // DriverValue implements the [DriverValuer] interface. A multiple value
  // is a types.JSONArray (an array here); the db layer stores it with
  // JSONArray's Value (jsonArrayValue in src/tools/types/json-array.ts).
  driverValue(record: FieldRecord): [unknown, Error | null] {
    const val = toUniqueStringSlice(record.getRaw(this.name));

    if (!this.isMultiple()) {
      if (val.length > 0) {
        return [val[val.length - 1] as string, null]; // the last selected
      }
      return ["", null];
    }

    // serialize as json string array
    const arr: JSONArray<string> = [...val];
    return [arr, null];
  }

  // ValidateValue implements [Field.ValidateValue] interface method.
  validateValue(_app: FieldApp, record: FieldRecord): Error | null {
    const normalizedVal = toUniqueStringSlice(record.getRaw(this.name));
    if (normalizedVal.length === 0) {
      if (this.required) {
        return ErrRequired;
      }
      return null; // nothing to check
    }

    const maxSelect = maxGoInt(this.maxSelect, 1);

    // check max selected items
    if (normalizedVal.length > maxSelect) {
      return NewError("validation_too_many_values", "Select no more than {{.maxSelect}}").setParams(
        { maxSelect },
      );
    }

    // check against the allowed values
    for (const val of normalizedVal) {
      if (!this.values.includes(val)) {
        return NewError("validation_invalid_value", "Invalid value {{.value}}").setParams({
          value: val,
        });
      }
    }

    return null;
  }

  // ValidateSettings implements [Field.ValidateSettings] interface method.
  validateSettings(_app: FieldApp, _collection: FieldCollection): Error | null {
    let max = this.values.length;
    if (max === 0) {
      max = 1;
    }

    return ValidateStruct(
      StructField("id", this.id, By(DefaultFieldIdValidationRule)),
      StructField("name", this.name, By(DefaultFieldNameValidationRule)),
      StructField("help", this.help, By(DefaultFieldHelpValidationRule)),
      StructField("values", this.values, Required),
      StructField("maxSelect", this.maxSelect, Min(0), Max(max)),
    );
  }

  // FindSetter implements the [SetterFinder] interface.
  findSetter(key: string): SetterFunc | null {
    switch (key) {
      case this.name:
        return (record, raw) => this.setValue(record, raw);
      case "+" + this.name:
        return (record, raw) => this.prependValue(record, raw);
      case this.name + "+":
        return (record, raw) => this.appendValue(record, raw);
      case this.name + "-":
        return (record, raw) => this.subtractValue(record, raw);
      default:
        return null;
    }
  }

  private setValue(record: FieldRecord, raw: unknown): void {
    record.setRaw(this.name, this.normalizeValue(raw));
  }

  private appendValue(record: FieldRecord, modifierValue: unknown): void {
    const val = record.getRaw(this.name);

    this.setValue(record, [...toUniqueStringSlice(val), ...toUniqueStringSlice(modifierValue)]);
  }

  private prependValue(record: FieldRecord, modifierValue: unknown): void {
    const val = record.getRaw(this.name);

    this.setValue(record, [...toUniqueStringSlice(modifierValue), ...toUniqueStringSlice(val)]);
  }

  private subtractValue(record: FieldRecord, modifierValue: unknown): void {
    const val = record.getRaw(this.name);

    this.setValue(
      record,
      subtractSlice(toUniqueStringSlice(val), toUniqueStringSlice(modifierValue)),
    );
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
      ["values", this.values],
      ["maxSelect", this.maxSelect],
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
        values: (v) => (this.values = (v as string[] | undefined) ?? []),
        maxSelect: (v) => (this.maxSelect = v as GoInt),
        required: (v) => (this.required = v as boolean),
      },
      {
        name: stringType,
        id: stringType,
        system: boolType,
        hidden: boolType,
        presentable: boolType,
        help: stringType,
        values: sliceOf(stringType),
        maxSelect: intType,
        required: boolType,
      },
      () => Object.assign(this, new SelectField()),
    );
  }
}

export type SelectFieldSettings = Pick<
  SelectField,
  "name" | "id" | "system" | "hidden" | "presentable" | "help" | "values" | "maxSelect" | "required"
>;
