// Upstream: core/field_email.go

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
import { toString as castToString } from "@/tools/types/cast";
import { boolType, sliceOf, stringType, unmarshalStruct } from "@/tools/types/go-json";
import { Domain, EmailFormat } from "@/validation/is/rules";
import { Empty } from "@/validation/absent";
import { Each } from "@/validation/each";
import { NewError } from "@/validation/error";
import { Required } from "@/validation/required";
import { Field as StructField, ValidateStruct } from "@/validation/struct";
import { By } from "@/validation/validation";
import { When } from "@/validation/when";
import { ErrUnsupportedValueType } from "@/validators/validators";

export const FieldTypeEmail = "email";

// EmailField defines "email" type field for storing a single email string
// address.
//
// The respective zero record field value is empty string.
export class EmailField implements Field {
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

  // ExceptDomains will require the email domain to NOT be included in the
  // listed ones.
  //
  // This validator can be set only if OnlyDomains is empty.
  //
  // (Go's nil slice is an empty array: json v2 marshals both as [].)
  exceptDomains: string[] = [];

  // OnlyDomains will require the email domain to be included in the listed
  // ones.
  //
  // This validator can be set only if ExceptDomains is empty.
  onlyDomains: string[] = [];

  // Required will require the field value to be non-empty email string.
  required = false;

  constructor(init: Partial<EmailFieldSettings> = {}) {
    Object.assign(this, init);
  }

  // Type implements [Field.Type] interface method.
  type(): string {
    return FieldTypeEmail;
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
    return [castToString(raw), null];
  }

  // ValidateValue implements [Field.ValidateValue] interface method.
  validateValue(_app: FieldApp, record: FieldRecord): Error | null {
    const val = record.getRaw(this.name);
    if (typeof val !== "string") {
      return ErrUnsupportedValueType;
    }

    if (this.required) {
      const err = Required.validate(val);
      if (err !== null) {
        return err;
      }
    }

    if (val === "") {
      return null; // nothing to check
    }

    const err = EmailFormat.validate(val);
    if (err !== null) {
      return err;
    }

    const domain = val.slice(val.lastIndexOf("@") + 1);

    if (this.onlyDomains.length > 0 && !this.onlyDomains.includes(domain)) {
      return NewError("validation_email_domain_not_allowed", "Email domain is not allowed");
    }

    if (this.exceptDomains.length > 0 && this.exceptDomains.includes(domain)) {
      return NewError("validation_email_domain_not_allowed", "Email domain is not allowed");
    }

    return null;
  }

  // ValidateSettings implements [Field.ValidateSettings] interface method.
  validateSettings(_app: FieldApp, _collection: FieldCollection): Error | null {
    return ValidateStruct(
      StructField("id", this.id, By(DefaultFieldIdValidationRule)),
      StructField("name", this.name, By(DefaultFieldNameValidationRule)),
      StructField("help", this.help, By(DefaultFieldHelpValidationRule)),
      StructField(
        "exceptDomains",
        this.exceptDomains,
        When(this.onlyDomains.length > 0, Empty).else(Each(Domain)),
      ),
      StructField(
        "onlyDomains",
        this.onlyDomains,
        When(this.exceptDomains.length > 0, Empty).else(Each(Domain)),
      ),
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
      ["exceptDomains", this.exceptDomains],
      ["onlyDomains", this.onlyDomains],
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
        exceptDomains: (v) => (this.exceptDomains = (v as string[] | undefined) ?? []),
        onlyDomains: (v) => (this.onlyDomains = (v as string[] | undefined) ?? []),
        required: (v) => (this.required = v as boolean),
      },
      {
        name: stringType,
        id: stringType,
        system: boolType,
        hidden: boolType,
        presentable: boolType,
        help: stringType,
        exceptDomains: sliceOf(stringType),
        onlyDomains: sliceOf(stringType),
        required: boolType,
      },
      () => Object.assign(this, new EmailField()),
    );
  }
}

export type EmailFieldSettings = Pick<
  EmailField,
  | "name"
  | "id"
  | "system"
  | "hidden"
  | "presentable"
  | "help"
  | "exceptDomains"
  | "onlyDomains"
  | "required"
>;
