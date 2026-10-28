// Upstream: core/field_autodate.go
//
// The current time comes from the app's clock (upstream: time.Now()).

import {
  DefaultFieldIdValidationRule,
  DefaultFieldNameValidationRule,
  InterceptorActionCreateExecute,
  InterceptorActionUpdateExecute,
  internalCustomFieldKeyPrefix,
  marshalStruct,
  noopSetter,
  type Field,
  type FieldApp,
  type FieldCollection,
  type FieldRecord,
  type RecordInterceptor,
  type SetterFinder,
  type SetterFunc,
} from "@/fields/field";
import { type DateTime, nowDateTime, parseDateTime } from "@/tools/types/datetime";
import { boolType, stringType, unmarshalStruct } from "@/tools/types/go-json";
import { Required } from "@/validation/required";
import { Field as StructField, ValidateStruct } from "@/validation/struct";
import { By } from "@/validation/validation";
import { When } from "@/validation/when";
import { Equal } from "@/validators/equal";

export const FieldTypeAutodate = "autodate";

// used to keep track of the last set autodate value
const autodateLastKnownPrefix = internalCustomFieldKeyPrefix + "_last_autodate_";

// AutodateField defines an "autodate" type field, aka. field which
// datetime value could be auto set on record create/update.
//
// This field is usually used for defining timestamp fields like "created"
// and "updated".
//
// Requires either both or at least one of the OnCreate or OnUpdate options
// to be set.
export class AutodateField implements Field, SetterFinder, RecordInterceptor {
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

  // OnCreate auto sets the current datetime as field value on record
  // create.
  onCreate = false;

  // OnUpdate auto sets the current datetime as field value on record
  // update.
  onUpdate = false;

  constructor(init: Partial<AutodateFieldSettings> = {}) {
    Object.assign(this, init);
  }

  // Type implements [Field.Type] interface method.
  type(): string {
    return FieldTypeAutodate;
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
    return "TEXT DEFAULT '' NOT NULL"; // note: sqlite doesn't allow adding new columns with non-constant defaults
  }

  // PrepareValue implements [Field.PrepareValue] interface method.
  prepareValue(_record: FieldRecord, raw: unknown): [unknown, Error | null] {
    return [parseDateTime(raw), null];
  }

  // ValidateValue implements [Field.ValidateValue] interface method.
  validateValue(_app: FieldApp, _record: FieldRecord): Error | null {
    return null;
  }

  // ValidateSettings implements [Field.ValidateSettings] interface method.
  validateSettings(app: FieldApp, collection: FieldCollection): Error | null {
    let oldOnCreate = this.onCreate;
    let oldOnUpdate = this.onUpdate;

    let oldCollection: FieldCollection | null = null;
    try {
      oldCollection = app.findCollectionByNameOrId(collection.id);
    } catch {
      // not found (or another error): nothing to compare with
    }
    if (oldCollection !== null) {
      const oldField = oldCollection.fields.getById(this.id);
      if (oldField instanceof AutodateField) {
        oldOnCreate = oldField.onCreate;
        oldOnUpdate = oldField.onUpdate;
      }
    }

    return ValidateStruct(
      StructField("id", this.id, By(DefaultFieldIdValidationRule)),
      StructField("name", this.name, By(DefaultFieldNameValidationRule)),
      StructField(
        "onCreate",
        this.onCreate,
        When(this.system, By(Equal(oldOnCreate))),
        Required.error("either onCreate or onUpdate must be enabled").when(!this.onUpdate),
      ),
      StructField(
        "onUpdate",
        this.onUpdate,
        When(this.system, By(Equal(oldOnUpdate))),
        Required.error("either onCreate or onUpdate must be enabled").when(!this.onCreate),
      ),
    );
  }

  // FindSetter implements the [SetterFinder] interface.
  findSetter(key: string): SetterFunc | null {
    switch (key) {
      case this.name:
        // return noopSetter to disallow updating the value with record.set()
        return noopSetter;
      default:
        return null;
    }
  }

  // Intercept implements the [RecordInterceptor] interface.
  async intercept(
    app: FieldApp,
    record: FieldRecord,
    actionName: string,
    actionFunc: () => Promise<void>,
  ): Promise<void> {
    switch (actionName) {
      case InterceptorActionCreateExecute: {
        // ignore if a date different from the old one was manually set with SetRaw
        if (this.onCreate && record.getDateTime(this.name).equal(this.getLastKnownValue(record))) {
          const now = nowDateTime(app.clock);
          record.setRaw(this.name, now);
          record.setRaw(autodateLastKnownPrefix + this.name, now); // eagerly set so that it can be renewed on resave after failure
        }

        await actionFunc();

        record.setRaw(autodateLastKnownPrefix + this.name, record.getRaw(this.name));

        return;
      }
      case InterceptorActionUpdateExecute: {
        // ignore if a date different from the old one was manually set with SetRaw
        if (this.onUpdate && record.getDateTime(this.name).equal(this.getLastKnownValue(record))) {
          const now = nowDateTime(app.clock);
          record.setRaw(this.name, now);
          record.setRaw(autodateLastKnownPrefix + this.name, now); // eagerly set so that it can be renewed on resave after failure
        }

        await actionFunc();

        record.setRaw(autodateLastKnownPrefix + this.name, record.getRaw(this.name));

        return;
      }
      default:
        return actionFunc();
    }
  }

  private getLastKnownValue(record: FieldRecord): DateTime {
    const v = record.getDateTime(autodateLastKnownPrefix + this.name);
    if (!v.isZero()) {
      return v;
    }

    return record.original().getDateTime(this.name);
  }

  // json.Marshal: the Go struct field order
  marshalJSON(): string {
    return marshalStruct([
      ["name", this.name],
      ["id", this.id],
      ["system", this.system],
      ["hidden", this.hidden],
      ["presentable", this.presentable],
      ["onCreate", this.onCreate],
      ["onUpdate", this.onUpdate],
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
        onCreate: (v) => (this.onCreate = v as boolean),
        onUpdate: (v) => (this.onUpdate = v as boolean),
      },
      {
        name: stringType,
        id: stringType,
        system: boolType,
        hidden: boolType,
        presentable: boolType,
        onCreate: boolType,
        onUpdate: boolType,
      },
      () => Object.assign(this, new AutodateField()),
    );
  }
}

export type AutodateFieldSettings = Pick<
  AutodateField,
  "name" | "id" | "system" | "hidden" | "presentable" | "onCreate" | "onUpdate"
>;
