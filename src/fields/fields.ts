// Upstream: core/field.go (Fields, FieldFactoryFunc) and the init()
// functions of core/field_*.go that fill it.
//
// The field type → constructor table. Upstream's map is open for Go code
// to register custom fields; here it is a fixed table of upstream's types,
// with no way to add to it.

import { AutodateField, FieldTypeAutodate } from "@/fields/autodate";
import { BoolField, FieldTypeBool } from "@/fields/bool";
import { DateField, FieldTypeDate } from "@/fields/date";
import { EditorField, FieldTypeEditor } from "@/fields/editor";
import { EmailField, FieldTypeEmail } from "@/fields/email";
import type { Field } from "@/fields/field";
import { FieldTypeFile, FileField } from "@/fields/file";
import { FieldTypeGeoPoint, GeoPointField } from "@/fields/geo-point";
import { FieldTypeJSON, JSONField } from "@/fields/json";
import { FieldTypeNumber, NumberField } from "@/fields/number";
import { FieldTypePassword, PasswordField } from "@/fields/password";
import { FieldTypeRelation, RelationField } from "@/fields/relation";
import { FieldTypeSelect, SelectField } from "@/fields/select";
import { FieldTypeText, TextField } from "@/fields/text";
import { FieldTypeURL, URLField } from "@/fields/url";

// FieldFactoryFunc defines a simple function to construct a specific Field
// instance.
export type FieldFactoryFunc = () => Field;

// Fields holds all available collection fields.
export const Fields: Readonly<Record<string, FieldFactoryFunc>> = Object.freeze({
  [FieldTypeText]: () => new TextField(),
  [FieldTypeEditor]: () => new EditorField(),
  [FieldTypeNumber]: () => new NumberField(),
  [FieldTypeBool]: () => new BoolField(),
  [FieldTypeEmail]: () => new EmailField(),
  [FieldTypeURL]: () => new URLField(),
  [FieldTypeDate]: () => new DateField(),
  [FieldTypeAutodate]: () => new AutodateField(),
  [FieldTypeSelect]: () => new SelectField(),
  [FieldTypeJSON]: () => new JSONField(),
  [FieldTypeGeoPoint]: () => new GeoPointField(),
  [FieldTypeRelation]: () => new RelationField(),
  [FieldTypeFile]: () => new FileField(),
  [FieldTypePassword]: () => new PasswordField(),
});

// the factory of a field type, or undefined for an unknown type (Go's
// `factory, ok := Fields[type]`)
export function fieldFactory(type: string): FieldFactoryFunc | undefined {
  return Object.hasOwn(Fields, type) ? Fields[type] : undefined;
}
