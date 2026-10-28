// Upstream: core/field_editor.go

import {
  DefaultFieldHelpValidationRule,
  DefaultFieldIdValidationRule,
  DefaultFieldNameValidationRule,
  marshalStruct,
  maxSafeJSONInt,
  type Field,
  type FieldApp,
  type FieldCollection,
  type FieldRecord,
  type MaxBodySizeCalculator,
} from "@/fields/field";
import { toString as castToString } from "@/tools/types/cast";
import { boolType, intType, stringType, unmarshalStruct } from "@/tools/types/go-json";
import { NewError } from "@/validation/error";
import { Max, Min } from "@/validation/minmax";
import { Required } from "@/validation/required";
import { Field as StructField, ValidateStruct } from "@/validation/struct";
import { byteLength } from "@/validation/util";
import { By } from "@/validation/validation";
import { ErrUnsupportedValueType } from "@/validators/validators";

export const FieldTypeEditor = "editor";

// DefaultEditorFieldMaxSize: 5 MiB
export const DefaultEditorFieldMaxSize = 5 * 2 ** 20;

// EditorField defines "editor" type field to store HTML formatted text.
//
// The respective zero record field value is empty string.
export class EditorField implements Field, MaxBodySizeCalculator {
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

  // MaxSize specifies the maximum size of the allowed field value (in
  // bytes and up to 2^53-1).
  //
  // If zero, a default limit of ~5MB is applied.
  maxSize = 0;

  // ConvertURLs is usually used to instruct the editor whether to apply
  // url conversion (eg. stripping the domain name in case the urls are
  // using the same domain as the one where the editor is loaded).
  //
  // (see also https://www.tiny.cloud/docs/tinymce/6/url-handling/#convert_urls)
  convertURLs = false;

  // Required will require the field value to be non-empty string.
  required = false;

  constructor(init: Partial<EditorFieldSettings> = {}) {
    Object.assign(this, init);
  }

  // Type implements [Field.Type] interface method.
  type(): string {
    return FieldTypeEditor;
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

    const maxSize = this.calculateMaxBodySize();

    if (byteLength(val) > maxSize) {
      return NewError(
        "validation_content_size_limit",
        "The maximum allowed content size is {{.maxSize}} bytes",
      ).setParams({ maxSize });
    }

    return null;
  }

  // ValidateSettings implements [Field.ValidateSettings] interface method.
  validateSettings(_app: FieldApp, _collection: FieldCollection): Error | null {
    return ValidateStruct(
      StructField("id", this.id, By(DefaultFieldIdValidationRule)),
      StructField("name", this.name, By(DefaultFieldNameValidationRule)),
      StructField("help", this.help, By(DefaultFieldHelpValidationRule)),
      StructField("maxSize", this.maxSize, Min(0), Max(maxSafeJSONInt)),
    );
  }

  // CalculateMaxBodySize implements the [MaxBodySizeCalculator] interface.
  calculateMaxBodySize(): number {
    if (this.maxSize <= 0) {
      return DefaultEditorFieldMaxSize;
    }

    return this.maxSize;
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
      ["maxSize", this.maxSize],
      ["convertURLs", this.convertURLs],
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
        maxSize: (v) => (this.maxSize = v as number),
        convertURLs: (v) => (this.convertURLs = v as boolean),
        required: (v) => (this.required = v as boolean),
      },
      {
        name: stringType,
        id: stringType,
        system: boolType,
        hidden: boolType,
        presentable: boolType,
        help: stringType,
        maxSize: intType,
        convertURLs: boolType,
        required: boolType,
      },
      () => Object.assign(this, new EditorField()),
    );
  }
}

export type EditorFieldSettings = Pick<
  EditorField,
  | "name"
  | "id"
  | "system"
  | "hidden"
  | "presentable"
  | "help"
  | "maxSize"
  | "convertURLs"
  | "required"
>;
