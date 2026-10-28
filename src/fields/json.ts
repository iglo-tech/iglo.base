// Upstream: core/field_json.go
//
// Values are JSONRaw: the raw JSON text, kept byte for byte.

import {
  DefaultFieldHelpValidationRule,
  DefaultFieldIdValidationRule,
  DefaultFieldNameValidationRule,
  goQuote,
  marshalStruct,
  maxSafeJSONInt,
  type Field,
  type FieldApp,
  type FieldCollection,
  type FieldRecord,
  type MaxBodySizeCalculator,
} from "@/fields/field";
import {
  anyType,
  boolType,
  intType,
  stringType,
  unmarshal,
  unmarshalStruct,
} from "@/tools/types/go-json";
import { JSONRaw, parseJSONRaw } from "@/tools/types/json-raw";
import { NewError } from "@/validation/error";
import { JSON as JSONRule } from "@/validation/is/rules";
import { Max, Min } from "@/validation/minmax";
import { ErrRequired } from "@/validation/required";
import { Field as StructField, ValidateStruct } from "@/validation/struct";
import { byteLength } from "@/validation/util";
import { By } from "@/validation/validation";
import { ErrUnsupportedValueType } from "@/validators/validators";

export const FieldTypeJSON = "json";

// DefaultJSONFieldMaxSize: 1 MiB
export const DefaultJSONFieldMaxSize = 2 ** 20;

// JSONField defines "json" type field for storing any serialized JSON
// value.
//
// The respective zero record field value is the zero [JSONRaw].
export class JSONField implements Field, MaxBodySizeCalculator {
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
  // If zero, a default limit of 1MB is applied.
  maxSize = 0;

  // Required will require the field value to be non-empty JSON value (aka.
  // not "null", `""`, "[]", "{}").
  required = false;

  constructor(init: Partial<JSONFieldSettings> = {}) {
    Object.assign(this, init);
  }

  // Type implements [Field.Type] interface method.
  type(): string {
    return FieldTypeJSON;
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
    return "JSON DEFAULT NULL";
  }

  // PrepareValue implements [Field.PrepareValue] interface method.
  prepareValue(_record: FieldRecord, raw: unknown): [unknown, Error | null] {
    if (typeof raw === "string") {
      // in order to support seamlessly both json and multipart/form-data
      // requests, the following normalization rules are applied for plain
      // string values:
      // - "true" is converted to the json `true`
      // - "false" is converted to the json `false`
      // - "null" is converted to the json `null`
      // - "[1,2,3]" is converted to the json `[1,2,3]`
      // - "{\"a\":1,\"b\":2}" is converted to the json `{"a":1,"b":2}`
      // - numeric strings are converted to json number
      // - double quoted strings are left as they are (aka. without
      //   normalizations)
      // - any other string (empty string too) is double quoted
      const str = raw;
      const c = str.charCodeAt(0);
      if (str === "") {
        raw = goQuote(str);
      } else if (str === "null" || str === "true" || str === "false") {
        raw = str;
      } else if (
        ((c >= 0x30 && c <= 0x39) ||
          str[0] === "-" ||
          str[0] === '"' ||
          str[0] === "[" ||
          str[0] === "{") &&
        JSONRule.validate(str) === null
      ) {
        raw = str;
      } else {
        raw = goQuote(str);
      }
    }

    try {
      return [parseJSONRaw(raw), null];
    } catch (err) {
      return [new JSONRaw(), err as Error];
    }
  }

  // ValidateValue implements [Field.ValidateValue] interface method.
  validateValue(_app: FieldApp, record: FieldRecord): Error | null {
    const raw = record.getRaw(this.name);
    if (!(raw instanceof JSONRaw)) {
      return ErrUnsupportedValueType;
    }

    const maxSize = this.calculateMaxBodySize();

    if (byteLength(raw.bytes()) > maxSize) {
      return NewError(
        "validation_json_size_limit",
        "The maximum allowed JSON size is {{.maxSize}} bytes",
      ).setParams({ maxSize });
    }

    if (JSONRule.validate(raw) !== null) {
      return NewError("validation_invalid_json", "Must be a valid json value");
    }

    // the stricter encoding/json/v2 decoding (duplicate member names fail)
    if (raw.bytes().length > 0) {
      try {
        unmarshal(raw.bytes(), anyType, { allowInvalidUTF8: true });
      } catch {
        return NewError("validation_invalid_json", "Must be a valid json value");
      }
    }

    const rawStr = trimSpace(raw.string());

    if (this.required && emptyJSONValues.includes(rawStr)) {
      return ErrRequired;
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
      return DefaultJSONFieldMaxSize;
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
        required: boolType,
      },
      () => Object.assign(this, new JSONField()),
    );
  }
}

export type JSONFieldSettings = Pick<
  JSONField,
  "name" | "id" | "system" | "hidden" | "presentable" | "help" | "maxSize" | "required"
>;

const emptyJSONValues = ["null", `""`, "[]", "{}", ""];

// unicode.IsSpace
const spaceChars =
  /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

// strings.TrimSpace: leading and trailing unicode.IsSpace runes removed
function trimSpace(s: string): string {
  return s.replace(spaceChars, "");
}
