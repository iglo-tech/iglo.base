// Upstream: core/field_text.go
//
// Patterns are Go regular expressions (src/tools/regexp), matched and
// generated with Go's semantics. The primary key duplicate check queries
// the app's concurrent db.

import { newExp } from "@/db/dbx/expression";
import { isNoRowsError } from "@/db/dbx/rows";
import {
  DefaultFieldHelpValidationRule,
  DefaultFieldIdValidationRule,
  DefaultFieldNameValidationRule,
  InterceptorActionCreate,
  InterceptorActionValidate,
  defaultLowercaseRecordIdPattern,
  goQuote,
  idColumn,
  marshalStruct,
  maxSafeJSONInt,
  type Field,
  type FieldApp,
  type FieldCollection,
  type FieldRecord,
  type RecordInterceptor,
  type SetterFinder,
  type SetterFunc,
} from "@/fields/field";
import { boolType, intType, stringType, unmarshalStruct, type GoInt } from "@/tools/types/go-json";
import { matchString } from "@/tools/regexp/regexp";
import { randomStringByRegex } from "@/tools/security/random-by-regex";
import { toString as castToString } from "@/tools/types/cast";
import { SimpleFold } from "@/tools/unicode/letter";
import { NewError, type Error as ValidationError } from "@/validation/error";
import { In } from "@/validation/in";
import { Max, Min } from "@/validation/minmax";
import { Empty } from "@/validation/absent";
import { Required } from "@/validation/required";
import { Field as StructField, ValidateStruct } from "@/validation/struct";
import { runeCount } from "@/validation/util";
import { By, type RuleFunc } from "@/validation/validation";
import { When } from "@/validation/when";
import { IsRegex } from "@/validators/string";
import { ErrUnsupportedValueType } from "@/validators/validators";

export const FieldTypeText = "text";

const autogenerateModifier = ":autogenerate";

const forbiddenPKCharacters = [
  ".",
  "/",
  "\\",
  "|",
  '"',
  "'",
  "`",
  "<",
  ">",
  ":",
  "?",
  "*",
  "%",
  "$",
  "\0",
  "\t",
  "\n",
  "\r",
  " ",
];

// (see largestReservedPKLength)
const caseInsensitiveReservedPKs = [
  // reserved Windows files names
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
];

const largestReservedPKLength = 4;

// TextField defines "text" type field for storing any string value.
//
// The respective zero record field value is empty string.
//
// The following additional setter keys are available:
//
// - "fieldName:autogenerate" - autogenerate field value if
//   AutogeneratePattern is set. For example:
//
//	record.set("slug:autogenerate", "") // [random value]
//	record.set("slug:autogenerate", "abc-") // abc-[random value]
export class TextField implements Field, SetterFinder, RecordInterceptor {
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

  // Min specifies the minimum required string characters.
  //
  // if zero value, no min limit is applied.
  min: GoInt = 0;

  // Max specifies the maximum allowed string characters.
  //
  // If zero, a default limit of 5000 is applied.
  max: GoInt = 0;

  // Pattern specifies an optional regex pattern to match against the field
  // value.
  //
  // Leave it empty to skip the pattern check.
  pattern = "";

  // AutogeneratePattern specifies an optional regex pattern that could be
  // used to generate random string from it and set it automatically on
  // record create if no explicit value is set or when the `:autogenerate`
  // modifier is used.
  //
  // Note: the generated value still needs to satisfy min, max, pattern (if
  // set)
  autogeneratePattern = "";

  // Required will require the field value to be non-empty string.
  required = false;

  // PrimaryKey will mark the field as primary key.
  //
  // A single collection can have only 1 field marked as primary key.
  primaryKey = false;

  constructor(init: Partial<TextFieldSettings> = {}) {
    Object.assign(this, init);
  }

  // Type implements [Field.Type] interface method.
  type(): string {
    return FieldTypeText;
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
    if (this.primaryKey) {
      // note: the default is just a last resort fallback to avoid empty
      // string values in case the record was inserted with raw sql and it
      // is not actually used when operating with the db abstraction
      return "TEXT PRIMARY KEY DEFAULT ('r'||lower(hex(randomblob(7)))) NOT NULL";
    }

    return "TEXT DEFAULT '' NOT NULL";
  }

  // PrepareValue implements [Field.PrepareValue] interface method.
  prepareValue(_record: FieldRecord, raw: unknown): [unknown, Error | null] {
    return [castToString(raw), null];
  }

  // ValidateValue implements [Field.ValidateValue] interface method.
  validateValue(app: FieldApp, record: FieldRecord): Error | null {
    const newVal = record.getRaw(this.name);
    if (typeof newVal !== "string") {
      return ErrUnsupportedValueType;
    }

    if (this.primaryKey) {
      // disallow PK change
      if (!record.isNew()) {
        const oldVal = record.lastSavedPK();
        if (oldVal !== newVal) {
          return NewError("validation_pk_change", "The record primary key cannot be changed.");
        }
        if (oldVal !== "") {
          // no need to further validate because the id can't be updated
          // and because the id could have been inserted manually by
          // migration from another system that may not comply with the user
          // defined PocketBase validations
          return null;
        }
      } else {
        // this technically shouldn't be necessarily but again to minimize
        // misuse of the Pattern validator that could cause side-effects on
        // some platforms check for duplicates in a case-insensitive manner
        //
        // (@todo eventually may get replaced in the future with a system
        // unique constraint to avoid races or wrapping the request in a
        // transaction)
        if (this.pattern !== defaultLowercaseRecordIdPattern) {
          let exists = 0;
          let failed = false;
          try {
            const row = app
              .concurrentDB()
              .select("(1)")
              .from(record.tableName())
              .where(newExp("id = {:id} COLLATE NOCASE", { id: newVal }))
              .limit(1)
              .row();
            exists = Number(row[0] ?? 0);
          } catch (err) {
            failed = !isNoRowsError(err);
          }
          if (exists > 0 || failed) {
            return NewError(
              "validation_pk_invalid",
              "The record primary key is invalid or already exists.",
            );
          }
        }
      }
    }

    return this.validatePlainValue(newVal);
  }

  // ValidatePlainValue validates the provided string against the field
  // options.
  validatePlainValue(value: string): ValidationError | null {
    if (this.required || this.primaryKey) {
      const err = Required.validate(value);
      if (err !== null) {
        return err as ValidationError;
      }
    }

    if (value === "") {
      return null; // nothing to check
    }

    // note: counted in runes to count multi-byte chars as one
    const length = runeCount(value);

    if (this.min > 0 && length < this.min) {
      return NewError(
        "validation_min_text_constraint",
        "Must be at least {{.min}} character(s).",
      ).setParams({ min: this.min });
    }

    let max = this.max;
    if (max === 0) {
      max = 5000;
    }

    if (max > 0 && length > max) {
      return NewError(
        "validation_max_text_constraint",
        "Must be no more than {{.max}} character(s).",
      ).setParams({ max });
    }

    if (this.pattern !== "") {
      let match = false;
      try {
        match = matchString(this.pattern, value);
      } catch {
        // regexp.MatchString returns false with the compile error
      }
      if (!match) {
        return NewError("validation_invalid_format", "Invalid value format.");
      }
    }

    // additional primary key checks to minimize eventual filesystem
    // compatibility issues because the primary key is often used as a
    // file/directory name
    if (this.primaryKey && this.pattern !== defaultLowercaseRecordIdPattern) {
      for (const ch of forbiddenPKCharacters) {
        if (value.includes(ch)) {
          return NewError(
            "validation_forbidden_pk_character",
            "'{{.ch}}' is not a valid primary key character.",
          ).setParams({ ch });
        }
      }

      if (largestReservedPKLength >= length) {
        for (const reserved of caseInsensitiveReservedPKs) {
          if (equalFold(value, reserved)) {
            return NewError(
              "validation_reserved_pk",
              "The primary key '{{.reserved}}' is reserved and cannot be used.",
            ).setParams({ reserved });
          }
        }
      }
    }

    return null;
  }

  // ValidateSettings implements [Field.ValidateSettings] interface method.
  validateSettings(_app: FieldApp, collection: FieldCollection): Error | null {
    return ValidateStruct(
      StructField("id", this.id, By(DefaultFieldIdValidationRule)),
      StructField(
        "name",
        this.name,
        By(DefaultFieldNameValidationRule),
        When(this.primaryKey, In(idColumn).error(`The primary key must be named "id".`)),
      ),
      StructField("help", this.help, By(DefaultFieldHelpValidationRule)),
      StructField("primaryKey", this.primaryKey, By(this.checkOtherFieldsForPK(collection))),
      StructField("min", this.min, Min(0), Max(maxSafeJSONInt)),
      StructField("max", this.max, Min(this.min), Max(maxSafeJSONInt)),
      StructField("pattern", this.pattern, When(this.primaryKey, Required), By(IsRegex)),
      StructField("hidden", this.hidden, When(this.primaryKey, Empty)),
      StructField("required", this.required, When(this.primaryKey, Required)),
      StructField(
        "autogeneratePattern",
        this.autogeneratePattern,
        By(IsRegex),
        By((value) => this.checkAutogeneratePattern(value)),
      ),
    );
  }

  private checkOtherFieldsForPK(collection: FieldCollection): RuleFunc {
    return (value) => {
      if (value !== true) {
        return null; // not a pk
      }

      let totalPrimaryKeys = 0;
      for (const field of collection.fields) {
        if (field instanceof TextField && field.primaryKey) {
          totalPrimaryKeys++;
        }

        if (totalPrimaryKeys > 1) {
          return NewError(
            "validation_unsupported_composite_pk",
            "Composite PKs are not supported and the collection must have only 1 PK.",
          );
        }
      }

      return null;
    };
  }

  private checkAutogeneratePattern(value: unknown): Error | null {
    const v = typeof value === "string" ? value : "";
    if (v === "") {
      return null; // nothing to check
    }

    // run 10 tests to check for conflicts with the other field validators
    for (let i = 0; i < 10; i++) {
      let generated: string;
      try {
        generated = randomStringByRegex(v);
      } catch (err) {
        return NewError("validation_invalid_autogenerate_pattern", (err as Error).message);
      }

      // (loosely) check whether the generated pattern satisfies the current
      // field settings
      if (this.validatePlainValue(generated) !== null) {
        return NewError(
          "validation_invalid_autogenerate_pattern_value",
          `The provided autogenerate pattern could produce invalid field values, ex.: ${goQuote(generated)}`,
        );
      }
    }

    return null;
  }

  // Intercept implements the [RecordInterceptor] interface.
  async intercept(
    _app: FieldApp,
    record: FieldRecord,
    actionName: string,
    actionFunc: () => Promise<void>,
  ): Promise<void> {
    // set autogenerated value if missing for new records
    switch (actionName) {
      case InterceptorActionValidate:
      case InterceptorActionCreate:
        if (this.autogeneratePattern !== "" && this.hasZeroValue(record) && record.isNew()) {
          let v: string;
          try {
            v = randomStringByRegex(this.autogeneratePattern);
          } catch (err) {
            throw new Error(
              `failed to autogenerate ${goQuote(this.name)} value: ${(err as Error).message}`,
              { cause: err },
            );
          }
          record.setRaw(this.name, v);
        }
    }

    return actionFunc();
  }

  private hasZeroValue(record: FieldRecord): boolean {
    const v = record.getRaw(this.name);
    return typeof v !== "string" || v === "";
  }

  // FindSetter implements the [SetterFinder] interface.
  findSetter(key: string): SetterFunc | null {
    switch (key) {
      case this.name:
        return (record, raw) => {
          record.setRaw(this.name, castToString(raw));
        };
      case this.name + autogenerateModifier:
        return (record, raw) => {
          let v = castToString(raw);

          if (this.autogeneratePattern !== "") {
            try {
              v += randomStringByRegex(this.autogeneratePattern);
            } catch {
              // the generated part is empty on error
            }
          }

          record.setRaw(this.name, v);
        };
      default:
        return null;
    }
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
      ["min", this.min],
      ["max", this.max],
      ["pattern", this.pattern],
      ["autogeneratePattern", this.autogeneratePattern],
      ["required", this.required],
      ["primaryKey", this.primaryKey],
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
        min: (v) => (this.min = v as GoInt),
        max: (v) => (this.max = v as GoInt),
        pattern: (v) => (this.pattern = v as string),
        autogeneratePattern: (v) => (this.autogeneratePattern = v as string),
        required: (v) => (this.required = v as boolean),
        primaryKey: (v) => (this.primaryKey = v as boolean),
      },
      {
        name: stringType,
        id: stringType,
        system: boolType,
        hidden: boolType,
        presentable: boolType,
        help: stringType,
        min: intType,
        max: intType,
        pattern: stringType,
        autogeneratePattern: stringType,
        required: boolType,
        primaryKey: boolType,
      },
      () => Object.assign(this, new TextField()),
    );
  }
}

export type TextFieldSettings = Pick<
  TextField,
  | "name"
  | "id"
  | "system"
  | "hidden"
  | "presentable"
  | "help"
  | "min"
  | "max"
  | "pattern"
  | "autogeneratePattern"
  | "required"
  | "primaryKey"
>;

// strings.EqualFold: equal under Unicode simple case folding
function equalFold(s: string, t: string): boolean {
  const a = [...s];
  const b = [...t];
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    const r = (a[i] as string).codePointAt(0) as number;
    const tr = (b[i] as string).codePointAt(0) as number;
    if (r === tr) {
      continue;
    }
    // follow r's fold orbit looking for tr
    let f = SimpleFold(r);
    while (f !== r && f !== tr) {
      f = SimpleFold(f);
    }
    if (f !== tr) {
      return false;
    }
  }
  return true;
}
