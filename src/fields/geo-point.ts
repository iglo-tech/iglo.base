// Upstream: core/field_geo_point.go

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
import { GeoPoint } from "@/tools/types/geo-point";
import { boolType, stringType, unmarshalStruct } from "@/tools/types/go-json";
import { NewError } from "@/validation/error";
import { ErrRequired } from "@/validation/required";
import { Field as StructField, ValidateStruct } from "@/validation/struct";
import { By } from "@/validation/validation";
import { ErrUnsupportedValueType } from "@/validators/validators";

export const FieldTypeGeoPoint = "geoPoint";

// GeoPointField defines "geoPoint" type field for storing latitude and
// longitude GPS coordinates.
//
// You can set the record field value as [GeoPoint], map or serialized json
// object with lat-lon props. The stored value is always converted to
// [GeoPoint]. Nil, empty map, empty bytes slice, etc. results in zero
// [GeoPoint].
//
// Examples of updating a record's GeoPointField value programmatically:
//
//	record.set("location", new GeoPoint(456, 123))
//	record.set("location", {lat: 123, lon: 456})
//	record.set("location", `{"lat":123, "lon":456}`)
export class GeoPointField implements Field {
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

  // Required will require the field coordinates to be non-zero (aka. not
  // "Null Island").
  required = false;

  constructor(init: Partial<GeoPointFieldSettings> = {}) {
    Object.assign(this, init);
  }

  // Type implements [Field.Type] interface method.
  type(): string {
    return FieldTypeGeoPoint;
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
    return `JSON DEFAULT '{"lon":0,"lat":0}' NOT NULL`;
  }

  // PrepareValue implements [Field.PrepareValue] interface method.
  prepareValue(_record: FieldRecord, raw: unknown): [unknown, Error | null] {
    const point = new GeoPoint();
    try {
      point.scan(raw);
    } catch (err) {
      // a failed scan may have changed the point already, as in Go
      return [point, err as Error];
    }
    return [point, null];
  }

  // ValidateValue implements [Field.ValidateValue] interface method.
  validateValue(_app: FieldApp, record: FieldRecord): Error | null {
    const val = record.getRaw(this.name);
    if (!(val instanceof GeoPoint)) {
      return ErrUnsupportedValueType;
    }

    if (val.lat === 0 && val.lon === 0) {
      if (this.required) {
        return ErrRequired;
      }
      return null;
    }

    if (val.lat < -90 || val.lat > 90) {
      return NewError(
        "validation_invalid_latitude",
        "Latitude must be between -90 and 90 degrees.",
      );
    }

    if (val.lon < -180 || val.lon > 180) {
      return NewError(
        "validation_invalid_longitude",
        "Longitude must be between -180 and 180 degrees.",
      );
    }

    return null;
  }

  // ValidateSettings implements [Field.ValidateSettings] interface method.
  validateSettings(_app: FieldApp, _collection: FieldCollection): Error | null {
    return ValidateStruct(
      StructField("id", this.id, By(DefaultFieldIdValidationRule)),
      StructField("name", this.name, By(DefaultFieldNameValidationRule)),
      StructField("help", this.help, By(DefaultFieldHelpValidationRule)),
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
        required: (v) => (this.required = v as boolean),
      },
      {
        name: stringType,
        id: stringType,
        system: boolType,
        hidden: boolType,
        presentable: boolType,
        help: stringType,
        required: boolType,
      },
      () => Object.assign(this, new GeoPointField()),
    );
  }
}

export type GeoPointFieldSettings = Pick<
  GeoPointField,
  "name" | "id" | "system" | "hidden" | "presentable" | "help" | "required"
>;
