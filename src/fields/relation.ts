// Upstream: core/field_relation.go

import { inExp } from "@/db/dbx/expression";
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
import { subtractSlice, toInterfaceSlice, toUniqueStringSlice } from "@/tools/list/list";
import { boolType, intType, stringType, unmarshalStruct } from "@/tools/types/go-json";
import type { JSONArray } from "@/tools/types/json-array";
import { NewError } from "@/validation/error";
import { Min } from "@/validation/minmax";
import { ErrRequired, Required } from "@/validation/required";
import { Field as StructField, ValidateStruct } from "@/validation/struct";
import { By, type RuleFunc } from "@/validation/validation";
import { When } from "@/validation/when";

export const FieldTypeRelation = "relation";

// core/collection_model.go CollectionTypeView
const collectionTypeView = "view";

// RelationField defines "relation" type field for storing single or
// multiple collection record references.
//
// Requires the CollectionId option to be set.
//
// If MaxSelect is not set or <= 1, then the field value is expected to be
// a single record id.
//
// If MaxSelect is > 1, then the field value is expected to be a slice of
// record ids.
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
//     record.set("categories+", ["new1", "new2"]) // ["old1", "old2", "new1", "new2"]
//
//   - "+fieldName" - prepend one or more values to the existing record one.
//     For example:
//
//     record.set("+categories", ["new1", "new2"]) // ["new1", "new2", "old1", "old2"]
//
//   - "fieldName-" - subtract one or more values from the existing record
//     one. For example:
//
//     record.set("categories-", "old1") // ["old2"]
export class RelationField implements Field, MultiValuer, DriverValuer, SetterFinder {
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

  // CollectionId is the id of the related collection.
  collectionId = "";

  // CascadeDelete indicates whether the root model should be deleted in
  // case of delete of all linked relations.
  cascadeDelete = false;

  // MinSelect indicates the min number of allowed relation records that
  // could be linked to the main model.
  //
  // No min limit is applied if it is zero or negative value.
  minSelect = 0;

  // MaxSelect indicates the max number of allowed relation records that
  // could be linked to the main model.
  //
  // For multiple select the value must be > 1, otherwise fallbacks to
  // single (default).
  //
  // If MinSelect is set, MaxSelect must be at least >= MinSelect.
  maxSelect = 0;

  // Required will require the field value to be non-empty.
  required = false;

  constructor(init: Partial<RelationFieldSettings> = {}) {
    Object.assign(this, init);
  }

  // Type implements [Field.Type] interface method.
  type(): string {
    return FieldTypeRelation;
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
  validateValue(app: FieldApp, record: FieldRecord): Error | null {
    const ids = toUniqueStringSlice(record.getRaw(this.name));
    if (ids.length === 0) {
      if (this.required) {
        return ErrRequired;
      }
      return null; // nothing to check
    }

    if (this.minSelect > 0 && ids.length < this.minSelect) {
      return NewError("validation_not_enough_values", "Select at least {{.minSelect}}").setParams({
        minSelect: this.minSelect,
      });
    }

    const maxSelect = Math.max(this.maxSelect, 1);
    if (ids.length > maxSelect) {
      return NewError("validation_too_many_values", "Select no more than {{.maxSelect}}").setParams(
        { maxSelect },
      );
    }

    // check if the related records exist
    // ---
    let relCollection: FieldCollection;
    try {
      relCollection = app.findCachedCollectionByNameOrId(this.collectionId);
    } catch {
      return NewError(
        "validation_missing_rel_collection",
        "Relation connection is missing or cannot be accessed",
      );
    }

    // the query error is ignored, as upstream does (total stays 0)
    let total = 0;
    try {
      const row = app
        .concurrentDB()
        .select("count(*)")
        .from(relCollection.name)
        .andWhere(inExp("id", ...toInterfaceSlice(ids)))
        .row();
      total = Number(row[0] ?? 0);
    } catch {
      // ignored
    }
    if (total !== ids.length) {
      return NewError(
        "validation_missing_rel_records",
        "Failed to find all relation records with the provided ids",
      );
    }
    // ---

    return null;
  }

  // ValidateSettings implements [Field.ValidateSettings] interface method.
  validateSettings(app: FieldApp, collection: FieldCollection): Error | null {
    return ValidateStruct(
      StructField("id", this.id, By(DefaultFieldIdValidationRule)),
      StructField("name", this.name, By(DefaultFieldNameValidationRule)),
      StructField("help", this.help, By(DefaultFieldHelpValidationRule)),
      StructField(
        "collectionId",
        this.collectionId,
        Required,
        By(this.checkCollectionId(app, collection)),
      ),
      StructField("minSelect", this.minSelect, Min(0)),
      StructField(
        "maxSelect",
        this.maxSelect,
        When(this.minSelect > 0, Required),
        Min(this.minSelect),
      ),
    );
  }

  private checkCollectionId(app: FieldApp, collection: FieldCollection): RuleFunc {
    return (value) => {
      const v = typeof value === "string" ? value : "";
      if (v === "") {
        return null; // nothing to check
      }

      let oldCollection: FieldCollection | null = null;

      if (!collection.isNew()) {
        try {
          oldCollection = app.findCachedCollectionByNameOrId(collection.id);
        } catch (err) {
          return err as Error;
        }
      }

      // prevent collectionId change
      if (oldCollection !== null) {
        const oldField = oldCollection.fields.getById(this.id);
        if (oldField instanceof RelationField && oldField.collectionId !== v) {
          return NewError(
            "validation_field_relation_change",
            "The relation collection cannot be changed.",
          );
        }
      }

      let relCollection: FieldCollection | null = null;
      try {
        relCollection = app.findCachedCollectionByNameOrId(v);
      } catch {
        // a missing collection
      }

      // validate collectionId
      if (relCollection === null || relCollection.id !== v) {
        return NewError(
          "validation_field_relation_missing_collection",
          "The relation collection doesn't exist.",
        );
      }

      // allow only views to have relations to other views
      // (see https://ganigeorgiev.com/pocketbase/discussions/3000)
      if (collection.type !== collectionTypeView && relCollection.type === collectionTypeView) {
        return NewError(
          "validation_relation_field_non_view_base_collection",
          "Only view collections are allowed to have relations to other views.",
        );
      }

      return null;
    };
  }

  // ---

  // FindSetter implements [SetterFinder] interface method.
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
      ["collectionId", this.collectionId],
      ["cascadeDelete", this.cascadeDelete],
      ["minSelect", this.minSelect],
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
        collectionId: (v) => (this.collectionId = v as string),
        cascadeDelete: (v) => (this.cascadeDelete = v as boolean),
        minSelect: (v) => (this.minSelect = v as number),
        maxSelect: (v) => (this.maxSelect = v as number),
        required: (v) => (this.required = v as boolean),
      },
      {
        name: stringType,
        id: stringType,
        system: boolType,
        hidden: boolType,
        presentable: boolType,
        help: stringType,
        collectionId: stringType,
        cascadeDelete: boolType,
        minSelect: intType,
        maxSelect: intType,
        required: boolType,
      },
      () => Object.assign(this, new RelationField()),
    );
  }
}

export type RelationFieldSettings = Pick<
  RelationField,
  | "name"
  | "id"
  | "system"
  | "hidden"
  | "presentable"
  | "help"
  | "collectionId"
  | "cascadeDelete"
  | "minSelect"
  | "maxSelect"
  | "required"
>;
