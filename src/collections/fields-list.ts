// Upstream: core/fields_list.go
//
// Go's FieldsList is a slice type with methods; here it is a class around
// an array. A nil and an empty list behave the same (both marshal as []).
// The field types come from src/fields/fields.ts's fixed constructor table.
// Go's (value, error) results throw instead.

import { crc32Checksum } from "@/db/db";
import type { Field, FieldsListReader } from "@/fields/field";
import { goQuote } from "@/fields/field";
import { fieldFactory } from "@/fields/fields";
import { arrayElements, decodeString, unmarshalGoStruct } from "@/collections/go-json-struct";
import {
  anyType,
  bytesToText,
  mapOf,
  marshal,
  marshalPartial,
  setOwn,
  unmarshal,
} from "@/tools/types/go-json";

// NewFieldsList creates a new FieldsList instance with the provided fields.
export function newFieldsList(...fields: Field[]): FieldsList {
  const l = new FieldsList();

  l.add(...fields);

  return l;
}

// FieldsList defines a Collection slice of fields.
export class FieldsList implements FieldsListReader {
  private list: Field[] = [];

  [Symbol.iterator](): Iterator<Field> {
    return this.list[Symbol.iterator]();
  }

  // len(l)
  get length(): number {
    return this.list.length;
  }

  // l[i]
  at(i: number): Field | undefined {
    return this.list[i];
  }

  // a copy of the underlying slice
  toArray(): Field[] {
    return [...this.list];
  }

  // the underlying slice, for a reader that does not change it
  items(): readonly Field[] {
    return this.list;
  }

  // l = fields: a slice assignment, without Add's id and name rules
  setItems(fields: Field[]): void {
    this.list = fields;
  }

  // Clone creates a deep clone of the current list.
  clone(): FieldsList {
    const copyRaw = this.marshalJSON();

    const result = new FieldsList();
    result.unmarshalJSON(copyRaw);

    return result;
  }

  // FieldNames returns a slice with the name of all list fields.
  fieldNames(): string[] {
    return this.list.map((field) => field.getName());
  }

  // AsMap returns a map with all registered list field.
  // The returned map is indexed with each field name.
  asMap(): Map<string, Field> {
    const result = new Map<string, Field>();

    for (const field of this.list) {
      result.set(field.getName(), field);
    }

    return result;
  }

  // GetById returns a single field by its id (null when missing).
  getById(fieldId: string): Field | null {
    for (const field of this.list) {
      if (field.getId() === fieldId) {
        return field;
      }
    }
    return null;
  }

  // GetByName returns a single field by its name (null when missing).
  getByName(fieldName: string): Field | null {
    for (const field of this.list) {
      if (field.getName() === fieldName) {
        return field;
      }
    }
    return null;
  }

  // RemoveById removes a single field by its id.
  //
  // This method does nothing if field with the specified id doesn't exist.
  removeById(fieldId: string): void {
    const i = this.list.findIndex((field) => field.getId() === fieldId);
    if (i >= 0) {
      this.list.splice(i, 1);
    }
  }

  // RemoveByName removes a single field by its name.
  //
  // This method does nothing if field with the specified name doesn't exist.
  removeByName(fieldName: string): void {
    const i = this.list.findIndex((field) => field.getName() === fieldName);
    if (i >= 0) {
      this.list.splice(i, 1);
    }
  }

  // Add adds one or more fields to the current list.
  //
  // By default this method will try to REPLACE existing fields with
  // the new ones by their id or by their name if the new field doesn't have an explicit id.
  //
  // If no matching existing field is found, it will APPEND the field to the end of the list.
  //
  // In all cases, if any of the new fields don't have an explicit id it will auto generate a default one for them
  // (the id value doesn't really matter and it is mostly used as a stable identifier in case of a field rename).
  add(...fields: Field[]): void {
    for (const f of fields) {
      this.addField(-1, f);
    }
  }

  // AddAt is the same as Add but insert/move the fields at the specific position.
  //
  // If pos < 0, then this method acts the same as calling Add.
  //
  // If pos > FieldsList total items, then the specified fields are inserted/moved at the end of the list.
  addAt(pos: number, ...fields: Field[]): void {
    const total = this.list.length;

    for (const [i, f] of fields.entries()) {
      if (pos < 0) {
        this.addField(-1, f);
      } else if (pos > total) {
        this.addField(total + i, f);
      } else {
        this.addField(pos + i, f);
      }
    }
  }

  // AddMarshaledJSON parses the provided raw json data and adds the
  // found fields into the current list (following the same rule as the Add method).
  //
  // The rawJSON argument could be one of:
  //   - serialized array of field objects
  //   - single field object.
  //
  // Example:
  //
  //	l.addMarshaledJSON(`{"type":"text", name: "test"}`)
  //	l.addMarshaledJSON(`[{"type":"text", name: "test1"}, {"type":"text", name: "test2"}]`)
  addMarshaledJSON(rawJSON: string | Uint8Array): void {
    const extractedFields = marshaledJSONtoFieldsList(rawJSON);

    this.add(...extractedFields.list);
  }

  // AddMarshaledJSONAt is the same as AddMarshaledJSON but insert/move the fields at the specific position.
  //
  // If pos < 0, then this method acts the same as calling AddMarshaledJSON.
  //
  // If pos > FieldsList total items, then the specified fields are inserted/moved at the end of the list.
  addMarshaledJSONAt(pos: number, rawJSON: string | Uint8Array): void {
    const extractedFields = marshaledJSONtoFieldsList(rawJSON);

    this.addAt(pos, ...extractedFields.list);
  }

  // add (Go's unexported FieldsList.add): pos < 0 replaces in place or
  // appends.
  private addField(pos: number, newField: Field): void {
    const fields = this.list;

    let replaceByName = false;
    let replaceInPlace = false;

    if (pos < 0) {
      replaceInPlace = true;
      pos = fields.length;
    } else if (pos > fields.length) {
      pos = fields.length;
    }

    let newFieldId = newField.getId();

    // set default id
    if (newFieldId === "") {
      replaceByName = true;

      const baseId = newField.type() + crc32Checksum(newField.getName());
      newFieldId = baseId;
      for (let i = 2; i < 1000; i++) {
        if (this.getById(newFieldId) === null) {
          break; // already unique
        }
        newFieldId = baseId + String(i);
      }
      newField.setId(newFieldId);
    }

    // try to replace existing
    for (const [i, field] of fields.entries()) {
      if (replaceByName) {
        const name = newField.getName();
        if (name !== "" && field.getName() === name) {
          // reuse the original id
          newField.setId(field.getId());

          if (replaceInPlace) {
            this.list[i] = newField;
            return;
          } else {
            // remove the current field and insert it later at the specific position
            this.list.splice(i, 1);
            const total = this.list.length;
            if (pos > total) {
              pos = total;
            }
            break;
          }
        }
      } else if (field.getId() === newFieldId) {
        if (replaceInPlace) {
          this.list[i] = newField;
          return;
        } else {
          // remove the current field and insert it later at the specific position
          this.list.splice(i, 1);
          const total = this.list.length;
          if (pos > total) {
            pos = total;
          }
          break;
        }
      }
    }

    // insert the new field
    this.list.splice(pos, 0, newField);
  }

  // String returns the string representation of the current list ("" when
  // a field cannot be marshaled; the bytes written before the error when
  // the list cannot).
  string(): string {
    const [v] = this.marshalJSONWithPartial();
    return v;
  }

  toString(): string {
    return this.string();
  }

  // MarshalJSON implements the json.Marshaler interface: each field's JSON
  // decoded into a map, its "type" added, the list marshaled with the map
  // members sorted (json.Deterministic). Numbers pass through float64.
  marshalJSON(): string {
    const [v, err] = this.marshalJSONWithPartial();
    if (err !== null) {
      throw err;
    }
    return v;
  }

  private marshalJSONWithPartial(): [string, unknown] {
    const wrapper: Record<string, unknown>[] = [];

    try {
      for (const f of this.list) {
        // precompute the json into a map so that we can append the type to a flatten object
        const raw = marshal(f);

        const data = unmarshal(raw, mapOf(anyType)) as Record<string, unknown> | undefined;
        const obj = data ?? {};
        setOwn(obj, "type", f.type());

        wrapper.push(obj);
      }
    } catch (err) {
      return ["", err];
    }

    try {
      return [marshal(wrapper), null];
    } catch (err) {
      return [marshalPartial(err), err];
    }
  }

  // Value implements the db driver Valuer: the MarshalJSON text.
  value(): string {
    return this.marshalJSON();
  }

  // Scan implements the sql.Scanner interface to scan the provided value
  // into the current FieldsList instance.
  scan(value: unknown): void {
    let data: string;
    if (value === null || value === undefined) {
      data = "";
    } else if (value instanceof Uint8Array || typeof value === "string") {
      data = bytesToText(value);
    } else {
      throw new Error(`failed to unmarshal FieldsList value ${goQuote(String(value))}`);
    }

    if (data.length === 0) {
      data = "[]";
    }

    this.unmarshalJSON(data);
  }

  // UnmarshalJSON implements json.Unmarshaler and
  // loads the provided json data into the current FieldsList.
  unmarshalJSON(data: string | Uint8Array): void {
    const elements = arrayElements(data) ?? [];

    const fields = elements.map(fieldWithTypeUnmarshalJSON);

    this.list = []; // reset

    for (const f of fields) {
      this.addField(-1, f);
    }
  }
}

function marshaledJSONtoFieldsList(rawJSON: string | Uint8Array): FieldsList {
  const extractedFields = new FieldsList();

  const text = bytesToText(rawJSON);

  // nothing to add
  if (text.length === 0) {
    return extractedFields;
  }

  // try to unmarshal first into a new fields list
  // (assuming that rawJSON is array of objects)
  try {
    extractedFields.unmarshalJSON(text);
  } catch {
    // try again but wrap the rawJSON in []
    // (assuming that rawJSON is a single object)
    try {
      extractedFields.unmarshalJSON("[" + text + "]");
    } catch (err) {
      throw new Error(
        "failed to unmarshal the provided JSON - expects array of objects or just single object: " +
          (err instanceof Error ? err.message : String(err)),
        { cause: err },
      );
    }
  }

  return extractedFields;
}

// fieldWithType.UnmarshalJSON: the field type is read first to construct
// a blank field of that type, which then reads the whole object.
function fieldWithTypeUnmarshalJSON(data: string): Field {
  // extract the field type to init a blank factory
  let type = "";
  try {
    unmarshalGoStruct(data, { type: (raw) => (type = decodeString(raw)) }, () => (type = ""));
  } catch (err) {
    throw new Error(`failed to unmarshal field type: ${errorText(err)}`, { cause: err });
  }

  const factory = fieldFactory(type);
  if (factory === undefined) {
    throw new Error(`missing or unknown field type in ${data}`);
  }

  const field = factory();

  // unmarshal the rest of the data into the created field
  try {
    field.unmarshalJSON(data);
  } catch (err) {
    throw new Error(`failed to unmarshal field: ${errorText(err)}`, { cause: err });
  }

  return field;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
