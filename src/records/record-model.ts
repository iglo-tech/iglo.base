// Upstream: core/record_model.go (the Record model, from the Record struct
// to just before callFieldInterceptors)
//
// Record implements the record interface fields/ declares (FieldRecord in
// src/fields/field.ts). Its auth accessors (core/record_model_auth.go) and
// IsSuperuser (core/record_model_superusers.go) are methods here that
// call the functions in their own files, as Go's methods are spread over
// those files.
//
// Go's map[string]any arguments and results are plain objects
// (DataMap) with own properties; the record's internal maps (the
// original data, the data, expand and custom visibility stores) are
// Maps. Go's (value, error) results are the value, and the error is
// thrown. DBExport's app argument is unused upstream and left out, as
// src/db's DBExporter has none; it returns upstream's typed values (the
// save path, M1.8c, converts them to driver values before binding).
//
// newRecordFromNullStringMap reads a row as dbx scans it into a
// NullStringMap: each column as database/sql converts it to a string
// (nullStringMapFromRow, on a row read withExactIntegers), a NULL column
// not Valid.
//
// Not ported: registerRecordHooks and the save, validate and delete chain
// (callFieldInterceptors on, M1.8c), HookTags (hooks only). GetUploadedFiles
// does not log its deprecation notice (application code logs only
// errors).

import type { Collection } from "@/collections/collection-model";
import type { Params, Row } from "@/db/dbx/query";
import { BaseModel } from "@/db/model";
import {
  FieldNameCollectionId,
  FieldNameCollectionName,
  FieldNameEmail,
  FieldNameEmailVisibility,
  FieldNameExpand,
  FieldNameId,
  FieldNamePassword,
  FieldNameTokenKey,
  idColumn,
  internalCustomFieldKeyPrefix,
  isDriverValuer,
  isGetterFinder,
  isSetterFinder,
  type Field,
  type FieldRecord,
} from "@/fields/field";
import { FieldTypeFile, FileField } from "@/fields/file";
import { toInt, toInt64, toStringMap } from "@/records/cast";
import {
  recordEmail,
  recordEmailVisibility,
  recordRefreshTokenKey,
  recordSetEmail,
  recordSetEmailVisibility,
  recordSetPassword,
  recordSetRandomPassword,
  recordSetTokenKey,
  recordSetVerified,
  recordTokenKey,
  recordValidatePassword,
  recordVerified,
} from "@/records/record-model-auth";
import { recordIsSuperuser } from "@/records/record-model-superusers";
import { File } from "@/tools/filesystem/file";
import { toUniqueStringSlice } from "@/tools/list/list";
import { Store } from "@/tools/store/store";
import { toBool, toFloat64, toString as castToString } from "@/tools/types/cast";
import { type DateTime, parseDateTime } from "@/tools/types/datetime";
import { GeoPoint } from "@/tools/types/geo-point";
import {
  type GoInt,
  type GoType,
  type JSONMarshaler,
  anyType,
  bytesToText,
  mapOf,
  marshal,
  setOwn,
  unmarshal,
} from "@/tools/types/go-json";
import { JSONRaw } from "@/tools/types/json-raw";
import { formatFloatV } from "@/validation/error";

// A Go map[string]any: a plain object with own properties.
export type DataMap = { [key: string]: unknown };

// dbx.NullStringMap: each column's text, or null for a NULL column (not
// Valid). A column that is not in the map is not "ok".
export type NullStringMap = { readonly [column: string]: string | null };

// The NullStringMap dbx scans a row into. Go's SQLite driver
// (modernc.org/sqlite rows.go Next) returns each column by its storage
// class: INTEGER as int64, REAL as float64, TEXT as string, BLOB as
// []byte, NULL as nil; database/sql (convert.go asString) converts them
// to strings: int64 in decimal, float64 with strconv.FormatFloat(f, 'g',
// -1, 64), text and blobs as their bytes. NULL is not Valid.
//
// The row must be read withExactIntegers (src/db/dbx/query.ts), so that
// every INTEGER value is a bigint and every number a REAL value: a narrowed
// integer from 1e6 on would be formatted as a float ("1.234567e+06").
export function nullStringMapFromRow(row: Row): NullStringMap {
  const out: { [column: string]: string | null } = {};
  for (const [column, v] of Object.entries(row)) {
    setOwn(out, column, nullStringText(v));
  }
  return out;
}

// one column value as NullString scans it (null: not Valid)
export function nullStringText(v: unknown): string | null {
  if (v === null || v === undefined) {
    return null;
  }
  if (typeof v === "string" || v instanceof Uint8Array) {
    return bytesToText(v);
  }
  // INTEGER (int64)
  if (typeof v === "bigint") {
    return v.toString();
  }
  // REAL (float64)
  if (typeof v === "number") {
    return formatFloatV(v);
  }
  if (typeof v === "boolean") {
    return v ? "true" : "false";
  }
  return castToString(v);
}

// -------------------------------------------------------------------

// newRecordFromNullStringMap initializes a single new Record model
// with data loaded from the provided NullStringMap.
//
// Note that this method is intended to load and Scan data from a database row result.
export function newRecordFromNullStringMap(collection: Collection, data: NullStringMap): Record {
  const record = newRecord(collection);

  for (const field of collection.fields) {
    const fieldName = field.getName();

    const nullString = Object.hasOwn(data, fieldName) ? data[fieldName] : null;

    const [value, err] = field.prepareValue(record, nullString ?? null);

    if (err !== null) {
      throw err;
    }

    // we load only the original data to avoid unnecessary copying the same data into the record.data store
    // (it is also the reason why we don't invoke PostScan on the record itself)
    record.originalData.set(fieldName, value);

    if (fieldName === FieldNameId) {
      record.id = castToString(value);
    }
  }

  record.markAsNotNew();

  return record;
}

// newRecordsFromNullStringMaps initializes a new Record model for
// each row in the provided NullStringMap slice.
//
// Note that this method is intended to load and Scan data from a database rows result.
export function newRecordsFromNullStringMaps(
  collection: Collection,
  rows: readonly NullStringMap[],
): Record[] {
  return rows.map((row) => newRecordFromNullStringMap(collection, row));
}

// -------------------------------------------------------------------

// NewRecord initializes a new empty Record model.
export function newRecord(collection: Collection): Record {
  return new Record(collection);
}

export class Record extends BaseModel implements FieldRecord, JSONMarshaler {
  readonly #collection: Collection;
  // the last saved (or loaded) field values; package-visible in Go
  originalData: Map<string, unknown>;
  #customVisibility = new Store<string, boolean>();
  #data = new Store<string, unknown>();
  #expand: Store<string, unknown> | null = null;

  #exportCustomData = false;
  #ignoreEmailVisibility = false;
  #ignoreUnchangedFields = false;

  // NewRecord: every field except "id" starts with its PrepareValue(nil)
  constructor(collection: Collection) {
    super();
    this.#collection = collection;
    this.originalData = new Map();

    // initialize default field values
    for (const field of collection.fields) {
      const fieldName = field.getName();

      if (fieldName === FieldNameId) {
        continue;
      }

      const [value] = field.prepareValue(this, null);
      this.originalData.set(fieldName, value);
    }
  }

  // Collection returns the Collection model associated with the current Record model.
  //
  // NB! The returned collection is only for read purposes and it shouldn't be modified
  // because it could have unintended side-effects on other Record models from the same collection.
  collection(): Collection {
    return this.#collection;
  }

  // TableName returns the table name associated with the current Record model.
  tableName(): string {
    return this.#collection.name;
  }

  // PostScan implements the [dbx.PostScanner] interface.
  //
  // It essentially refreshes/updates the current Record original state
  // as if the model was fetched from the databases for the first time.
  //
  // Or in other words, it means that m.Original().FieldsData() will have
  // the same values as m.Record().FieldsData().
  override postScan(): void {
    if (this.id === "") {
      throw new Error("missing record primary key");
    }

    super.postScan();

    this.originalData = new Map(Object.entries(this.fieldsData()));
  }

  // BaseFilesPath returns the storage dir path used by the record.
  baseFilesPath(): string {
    let id = castToString(this.lastSavedPK());
    if (id === "") {
      id = this.id;
    }

    return this.#collection.baseFilesPath() + "/" + id;
  }

  // Original returns a shallow copy of the current record model populated
  // with its ORIGINAL db data state (aka. right after PostScan())
  // and everything else reset to the defaults.
  //
  // If record was created using NewRecord() the original will be always
  // a blank record (until PostScan() is invoked).
  original(): Record {
    const copy = new Record(this.#collection);

    copy.originalData = new Map(this.originalData);

    const id = copy.originalData.get(FieldNameId);
    if (id !== null && id !== undefined) {
      copy.id = castToString(id);
      copy.markAsNotNew();
    }

    return copy;
  }

  // Fresh returns a shallow copy of the current record model populated
  // with its LATEST data state and everything else reset to the defaults
  // (aka. no expand, no unknown fields and with default visibility flags).
  fresh(): Record {
    const copy = this.original();

    // note: this will also load the Id field through m.GetRaw
    for (const field of this.#collection.fields) {
      const fieldName = field.getName();
      copy.setRaw(fieldName, this.getRaw(fieldName));
    }

    return copy;
  }

  // Clone returns a shallow copy of the current record model with all of
  // its collection and unknown fields data, expand and flags copied.
  //
  // use [Record.Fresh()] instead if you want a copy with only the latest
  // collection fields data and everything else reset to the defaults.
  clone(): Record {
    const copy = this.original();

    copy.id = this.id;
    copy.#exportCustomData = this.#exportCustomData;
    copy.#ignoreEmailVisibility = this.#ignoreEmailVisibility;
    copy.#ignoreUnchangedFields = this.#ignoreUnchangedFields;
    copy.#customVisibility.reset(this.#customVisibility.getAll());

    for (const [k, v] of this.#data.getAll()) {
      copy.setRaw(k, v);
    }

    if (this.#expand !== null) {
      copy.setExpand(this.#expand.getAll());
    }

    return copy;
  }

  // Expand returns a shallow copy of the current Record model expand data (if any).
  expand(): DataMap {
    if (this.#expand === null) {
      // return a dummy initialized map to avoid assignment to nil map errors
      return {};
    }

    return toDataMap(this.#expand.getAll());
  }

  // SetExpand replaces the current Record's expand with the provided expand arg data (shallow copied).
  setExpand(expand: DataMap | ReadonlyMap<string, unknown> | null): void {
    if (this.#expand === null) {
      this.#expand = new Store<string, unknown>();
    }

    this.#expand.reset(toMap(expand));
  }

  // MergeExpand merges recursively the provided expand data into
  // the current model's expand (if any).
  //
  // Note that if an expanded prop with the same key is a slice (old or new expand)
  // then both old and new records will be merged into a new slice (aka. a :merge: [b,c] => [a,b,c]).
  // Otherwise the "old" expanded record will be replace with the "new" one (aka. a :merge: aNew => aNew).
  mergeExpand(expand: DataMap | ReadonlyMap<string, unknown> | null): void {
    const newExpand = toMap(expand);

    // nothing to merge
    if (newExpand.size === 0) {
      return;
    }

    // no old expand
    if (this.#expand === null) {
      this.#expand = new Store<string, unknown>(newExpand);
      return;
    }

    const oldExpand = this.#expand.getAll();

    for (const [key, newValue] of newExpand) {
      if (!oldExpand.has(key)) {
        oldExpand.set(key, newValue);
        continue;
      }
      const old = oldExpand.get(key);

      let wasOldSlice = false;
      let oldSlice: Record[];
      if (old instanceof Record) {
        oldSlice = [old];
      } else if (isRecordSlice(old)) {
        wasOldSlice = true;
        oldSlice = old;
      } else {
        // invalid old expand data -> assign directly the new
        // (no matter whether new is valid or not)
        oldExpand.set(key, newValue);
        continue;
      }

      let wasNewSlice = false;
      let newSlice: Record[];
      if (newValue instanceof Record) {
        newSlice = [newValue];
      } else if (isRecordSlice(newValue)) {
        wasNewSlice = true;
        newSlice = newValue;
      } else {
        // invalid new expand data -> skip
        continue;
      }

      const oldIndexed = new Map<string, Record>();
      for (const oldRecord of oldSlice) {
        oldIndexed.set(oldRecord.id, oldRecord);
      }

      for (const newItem of newSlice) {
        const oldRecord = oldIndexed.get(newItem.id);
        if (oldRecord !== undefined) {
          // note: there is no need to update oldSlice since oldRecord is a reference
          oldRecord.mergeExpand(newItem.expand());
        } else {
          // missing new entry
          oldSlice = [...oldSlice, newItem];
        }
      }

      if (wasOldSlice || wasNewSlice || oldSlice.length === 0) {
        oldExpand.set(key, oldSlice);
      } else {
        oldExpand.set(key, oldSlice[0]);
      }
    }

    this.#expand.reset(oldExpand);
  }

  // FieldsData returns a shallow copy ONLY of the collection's fields record's data.
  fieldsData(): DataMap {
    const result: DataMap = {};

    for (const field of this.#collection.fields) {
      const fieldName = field.getName();
      setOwn(result, fieldName, this.get(fieldName));
    }

    return result;
  }

  // CustomData returns a shallow copy ONLY of the custom record fields data,
  // aka. fields that are neither defined by the collection, nor special system ones.
  //
  // Note that custom fields prefixed with "@pbInternal" are always skipped.
  customData(): DataMap {
    const knownFields = new Set<string>();

    for (const f of this.#collection.fields) {
      knownFields.add(f.getName());
    }

    const result: DataMap = {};

    for (const [k, v] of this.#data.getAll()) {
      if (!knownFields.has(k)) {
        // skip internal custom fields
        if (k.startsWith(internalCustomFieldKeyPrefix)) {
          continue;
        }

        setOwn(result, k, v);
      }
    }

    return result;
  }

  // WithCustomData toggles the export/serialization of custom data fields
  // (false by default).
  withCustomData(state: boolean): this {
    this.#exportCustomData = state;
    return this;
  }

  // IgnoreEmailVisibility toggles the flag to ignore the auth record email visibility check.
  ignoreEmailVisibility(state: boolean): this {
    this.#ignoreEmailVisibility = state;
    return this;
  }

  // IgnoreUnchangedFields toggles the flag to ignore the unchanged fields
  // from the DB export for the UPDATE SQL query.
  //
  // This could be used if you want to save only the record fields that you've changed
  // without overwrite other untouched fields in case of concurrent update.
  //
  // Note that the fields change comparison is based on the current fields against m.Original()
  // (aka. if you have performed save on the same Record instance multiple times you may have to refetch it,
  // so that m.Original() could reflect the last saved change).
  ignoreUnchangedFields(state: boolean): this {
    this.#ignoreUnchangedFields = state;
    return this;
  }

  // Set sets the provided key-value data pair into the current Record
  // model directly as it is WITHOUT NORMALIZATIONS.
  //
  // See also [Record.Set].
  setRaw(key: string, value: unknown): void {
    if (key === FieldNameId) {
      this.id = castToString(value);
    }

    this.#data.set(key, value);
  }

  // SetIfFieldExists sets the provided key-value data pair into the current Record model
  // ONLY if key is existing Collection field name/modifier.
  //
  // This method does nothing if key is not a known Collection field name/modifier.
  //
  // On success returns the matched Field, otherwise - null.
  //
  // To set any key-value, including custom/unknown fields, use the [Record.Set] method.
  setIfFieldExists(key: string, value: unknown): Field | null {
    for (const field of this.#collection.fields) {
      if (isSetterFinder(field)) {
        const setter = field.findSetter(key);
        if (setter !== null) {
          setter(this, value);
          return field;
        }
      }

      // fallback to the default field PrepareValue method for direct match
      if (key === field.getName()) {
        [value] = field.prepareValue(this, value);
        this.setRaw(key, value);
        return field;
      }
    }

    return null;
  }

  // Set sets the provided key-value data pair into the current Record model.
  //
  // If the record collection has field with name matching the provided "key",
  // the value will be further normalized according to the field setter(s).
  set(key: string, value: unknown): void {
    switch (key) {
      case FieldNameExpand: // for backward-compatibility with earlier versions
        this.setExpand(toStringMap(value));
        break;
      default: {
        const field = this.setIfFieldExists(key, value);
        if (field === null) {
          // custom key - set it without any transformations
          this.setRaw(key, value);
        }
      }
    }
  }

  getRaw(key: string): unknown {
    if (key === FieldNameId) {
      return this.id;
    }

    const [v, ok] = this.#data.getOk(key);
    if (ok) {
      return v;
    }

    return this.originalData.get(key);
  }

  // Get returns a normalized single record model data value for "key".
  get(key: string): unknown {
    switch (key) {
      case FieldNameExpand: // for backward-compatibility with earlier versions
        return this.expand();
      default:
        for (const field of this.#collection.fields) {
          if (!isGetterFinder(field)) {
            continue; // no custom getters
          }

          const getter = field.findGetter(key);
          if (getter !== null) {
            return getter(this);
          }
        }

        return this.getRaw(key);
    }
  }

  // Load bulk loads the provided data into the current Record model.
  load(data: DataMap | ReadonlyMap<string, unknown>): void {
    for (const [k, v] of toMap(data)) {
      this.set(k, v);
    }
  }

  // GetBool returns the data value for "key" as a bool.
  getBool(key: string): boolean {
    return toBool(this.get(key));
  }

  // GetString returns the data value for "key" as a string.
  getString(key: string): string {
    return castToString(this.get(key));
  }

  // GetInt returns the data value for "key" as an int.
  getInt(key: string): GoInt {
    return toInt(this.get(key));
  }

  // GetInt64 returns the data value for "key" as an int64.
  getInt64(key: string): GoInt {
    return toInt64(this.get(key));
  }

  // GetFloat returns the data value for "key" as a float64.
  getFloat(key: string): number {
    return toFloat64(this.get(key));
  }

  // GetDateTime returns the data value for "key" as a DateTime instance.
  getDateTime(key: string): DateTime {
    return parseDateTime(this.get(key));
  }

  // GetGeoPoint returns the data value for "key" as a GeoPoint instance.
  getGeoPoint(key: string): GeoPoint {
    const point = new GeoPoint();
    try {
      point.scan(this.get(key));
    } catch {
      // the scan error is ignored upstream
    }
    return point;
  }

  // GetStringSlice returns the data value for "key" as a slice of non-zero unique strings.
  getStringSlice(key: string): string[] {
    return toUniqueStringSlice(this.get(key));
  }

  // GetUnsavedFiles returns the uploaded files for the provided "file" field key,
  // (aka. the current [filesystem.File] values) so that you can apply further
  // validations or modifications (including changing the file name or content before persisting).
  //
  // Returns null (Go's nil slice) when the key is not a file field.
  getUnsavedFiles(key: string): File[] | null {
    if (!key.endsWith(":unsaved")) {
      key += ":unsaved";
    }

    const values = this.get(key);

    // Go's type assertion to []*filesystem.File
    return Array.isArray(values) && values.every((v) => v instanceof File) ? values : null;
  }

  // Deprecated: replaced with GetUnsavedFiles.
  getUploadedFiles(key: string): File[] | null {
    return this.getUnsavedFiles(key);
  }

  // Retrieves the "key" json field value and unmarshals it into a value of
  // the Go type t (json.Unmarshal; any by default). Throws Go's error.
  unmarshalJSONField(key: string, t: GoType = anyType): unknown {
    return unmarshal(this.getString(key), t);
  }

  // ExpandedOne retrieves a single relation Record from the already
  // loaded expand data of the current model.
  //
  // If the requested expand relation is multiple, this method returns
  // only first available Record from the expanded relation.
  //
  // Returns null if there is no such expand relation loaded.
  expandedOne(relField: string): Record | null {
    if (this.#expand === null) {
      return null;
    }

    const rel = this.#expand.get(relField);

    if (rel instanceof Record) {
      return rel;
    }
    if (isRecordSlice(rel) && rel.length > 0) {
      return rel[0] as Record;
    }

    return null;
  }

  // ExpandedAll retrieves a slice of relation Records from the already
  // loaded expand data of the current model.
  //
  // If the requested expand relation is single, this method normalizes
  // the return result and will wrap the single model as a slice.
  //
  // Returns null (Go's nil slice) if there is no such expand relation loaded.
  expandedAll(relField: string): Record[] | null {
    if (this.#expand === null) {
      return null;
    }

    const rel = this.#expand.get(relField);

    if (rel instanceof Record) {
      return [rel];
    }
    if (isRecordSlice(rel)) {
      return rel;
    }

    return null;
  }

  // FindFileFieldByFile returns the first file type field for which
  // any of the record's data contains the provided filename.
  findFileFieldByFile(filename: string): FileField | null {
    for (const field of this.#collection.fields) {
      if (field.type() !== FieldTypeFile) {
        continue;
      }

      if (!(field instanceof FileField)) {
        continue;
      }

      const filenames = this.getStringSlice(field.getName());
      if (filenames.includes(filename)) {
        return field;
      }
    }

    return null;
  }

  // DBExport implements the [DBExporter] interface and returns a key-value
  // map with the data to be persisted when saving the Record in the database.
  dbExport(): Params {
    const result = this.dbExportAll();

    // remove exported fields that haven't changed
    // (with exception of the id column)
    if (!this.isNew() && this.#ignoreUnchangedFields) {
      const oldResult = this.original().dbExportAll();

      for (const [oldK, oldV] of Object.entries(oldResult)) {
        if (oldK === idColumn) {
          continue;
        }
        if (Object.hasOwn(result, oldK) && areValuesEqual(result[oldK], oldV)) {
          delete result[oldK];
        }
      }
    }

    return result;
  }

  // dbExport (unexported in Go)
  private dbExportAll(): Params {
    const result: Params = {};

    for (const field of this.#collection.fields) {
      const fieldName = field.getName();

      if (isDriverValuer(field)) {
        const [v, err] = field.driverValue(this);
        if (err !== null) {
          throw err;
        }
        setOwn(result, fieldName, v);
      } else {
        setOwn(result, fieldName, this.getRaw(fieldName));
      }
    }

    return result;
  }

  // Hide hides the specified fields from the public safe serialization of the record.
  hide(...fieldNames: string[]): this {
    for (const name of fieldNames) {
      this.#customVisibility.set(name, false);
    }

    return this;
  }

  // Unhide forces to unhide the specified fields from the public safe serialization
  // of the record (even when the collection field itself is marked as hidden).
  unhide(...fieldNames: string[]): this {
    for (const name of fieldNames) {
      this.#customVisibility.set(name, true);
    }

    return this;
  }

  // PublicExport exports only the record fields that are safe to be public.
  //
  // To export unknown data fields you need to set record.WithCustomData(true).
  //
  // For auth records, to force the export of the email field you need to set
  // record.IgnoreEmailVisibility(true).
  publicExport(): DataMap {
    const exportData = new Map<string, unknown>();

    const customVisibility = this.#customVisibility.getAll();

    // export schema fields
    for (const f of this.#collection.fields) {
      const fieldName = f.getName();

      let isVisible = customVisibility.get(fieldName);
      if (isVisible === undefined) {
        isVisible = !f.getHidden();
      }

      if (!isVisible) {
        continue;
      }

      exportData.set(fieldName, this.get(fieldName));
    }

    // export custom fields
    if (this.#exportCustomData) {
      for (const [k, v] of Object.entries(this.customData())) {
        const isVisible = customVisibility.get(k);
        if (isVisible === undefined || isVisible) {
          exportData.set(k, v);
        }
      }
    }

    if (this.#collection.isAuth()) {
      // always hide the password and tokenKey fields
      exportData.delete(FieldNamePassword);
      exportData.delete(FieldNameTokenKey);

      if (!this.#ignoreEmailVisibility && !this.getBool(FieldNameEmailVisibility)) {
        exportData.delete(FieldNameEmail);
      }
    }

    // add helper collection reference fields
    let isVisible = customVisibility.get(FieldNameCollectionId);
    if (isVisible === undefined || isVisible) {
      exportData.set(FieldNameCollectionId, this.#collection.id);
    }
    isVisible = customVisibility.get(FieldNameCollectionName);
    if (isVisible === undefined || isVisible) {
      exportData.set(FieldNameCollectionName, this.#collection.name);
    }

    // add expand (if non-nil)
    isVisible = customVisibility.get(FieldNameExpand);
    if ((isVisible === undefined || isVisible) && this.#expand !== null) {
      exportData.set(FieldNameExpand, toDataMap(this.#expand.getAll()));
    }

    return toDataMap(exportData);
  }

  // MarshalJSON implements the [json.Marshaler] interface.
  //
  // Only the data exported by `PublicExport()` will be serialized.
  marshalJSON(): string {
    return marshal(this.publicExport(), {
      // for compliance with old data (and slightly better performance)
      allowDuplicateNames: true,
      // preserve the old jsonv1 behavior in case of invalid data
      allowInvalidUTF8: true,
    });
  }

  // UnmarshalJSON implements the [json.Unmarshaler] interface.
  unmarshalJSON(data: string | Uint8Array): void {
    const result = unmarshal(data, mapOf(anyType)) as DataMap | undefined;

    this.load(result ?? {});
  }

  // ReplaceModifiers returns a new map with applied modifier
  // values based on the current record and the specified data.
  //
  // The resolved modifier keys will be removed.
  //
  // Multiple modifiers will be applied one after another,
  // while reusing the previous base key value result (ex. 1; -5; +2 => -2).
  //
  // Note that because Go doesn't guaranteed the iteration order of maps,
  // we would explicitly apply shorter keys first for a more consistent and reproducible behavior.
  //
  // Example usage:
  //
  //	 newData := record.ReplaceModifiers(data)
  //		// record: {"field": 10}
  //		// data:   {"field+": 5}
  //		// result: {"field": 15}
  replaceModifiers(data: DataMap): DataMap {
    const keys = Object.keys(data);
    if (keys.length === 0) {
      return data;
    }

    const dataCopy = toDataMap(new Map(Object.entries(data)));

    const recordCopy = this.fresh();

    // key orders is not guaranteed so (a stable sort by key length)
    const sortedDataKeys = keys.toSorted((a, b) => a.length - b.length);

    for (const k of sortedDataKeys) {
      const field = recordCopy.setIfFieldExists(k, data[k]);
      if (field !== null) {
        // delete the original key in case it is with a modifer (ex. "items+")
        delete dataCopy[k];

        // store the transformed value under the field name
        setOwn(dataCopy, field.getName(), recordCopy.get(field.getName()));
      }
    }

    return dataCopy;
  }

  // -------------------------------------------------------------------
  // core/record_model_auth.go

  // Email returns the "email" record field value (usually available with Auth collections).
  email(): string {
    return recordEmail(this);
  }

  // SetEmail sets the "email" record field value (usually available with Auth collections).
  setEmail(email: string): void {
    recordSetEmail(this, email);
  }

  // EmailVisibility returns the "emailVisibility" record field value (usually available with Auth collections).
  emailVisibility(): boolean {
    return recordEmailVisibility(this);
  }

  // SetEmailVisibility sets the "emailVisibility" record field value (usually available with Auth collections).
  setEmailVisibility(visible: boolean): void {
    recordSetEmailVisibility(this, visible);
  }

  // Verified returns the "verified" record field value (usually available with Auth collections).
  verified(): boolean {
    return recordVerified(this);
  }

  // SetVerified sets the "verified" record field value (usually available with Auth collections).
  setVerified(verified: boolean): void {
    recordSetVerified(this, verified);
  }

  // TokenKey returns the "tokenKey" record field value (usually available with Auth collections).
  tokenKey(): string {
    return recordTokenKey(this);
  }

  // SetTokenKey sets the "tokenKey" record field value (usually available with Auth collections).
  setTokenKey(key: string): void {
    recordSetTokenKey(this, key);
  }

  // RefreshTokenKey generates and sets a new random auth record "tokenKey".
  refreshTokenKey(): void {
    recordRefreshTokenKey(this);
  }

  // SetPassword sets the "password" record field value (usually available with Auth collections).
  setPassword(password: string): void {
    recordSetPassword(this, password);
  }

  // SetRandomPassword sets the "password" auth record field to a random autogenerated value.
  setRandomPassword(): string {
    return recordSetRandomPassword(this);
  }

  // ValidatePassword validates a plain password against the "password" record field.
  //
  // Returns false if the password is incorrect.
  validatePassword(password: string): boolean {
    return recordValidatePassword(this, password);
  }

  // -------------------------------------------------------------------
  // core/record_model_superusers.go

  // IsSuperuser returns whether the current record is a superuser, aka.
  // whether the record is from the _superusers collection.
  isSuperuser(): boolean {
    return recordIsSuperuser(this);
  }
}

// a Go []*Record: an array whose items are all records
function isRecordSlice(v: unknown): v is Record[] {
  return Array.isArray(v) && v.every((item) => item instanceof Record);
}

function toMap(
  data: DataMap | ReadonlyMap<string, unknown> | null | undefined,
): Map<string, unknown> {
  if (data === null || data === undefined) {
    return new Map();
  }
  return new Map(data instanceof Map ? data : Object.entries(data));
}

function toDataMap(m: ReadonlyMap<string, unknown>): DataMap {
  const out: DataMap = {};
  for (const [k, v] of m) {
    setOwn(out, k, v);
  }
  return out;
}

// areValuesEqual: Go's type switch. Go's typed values map to JS types:
// strings, booleans, numbers (float64), bigints (Go integers), byte
// slices, arrays of primitives (Go's []string, []int, []float64,
// JSONArray[string], compared element by element) and JSONRaw (compared
// by bytes); anything else is compared by its deterministic JSON.
export function areValuesEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "string" || typeof a === "boolean" || typeof a === "bigint") {
    return typeof b === typeof a && a === b;
  }
  if (typeof a === "number") {
    // Go's == on float64: NaN != NaN, 0 == -0
    return typeof b === "number" && a === b;
  }
  if (a instanceof Uint8Array) {
    return b instanceof Uint8Array && a.length === b.length && a.every((x, i) => x === b[i]);
  }
  if (a instanceof JSONRaw) {
    return b instanceof JSONRaw && a.bytes() === b.bytes();
  }
  if (Array.isArray(a) && a.every(isPrimitive)) {
    return (
      Array.isArray(b) &&
      b.every(isPrimitive) &&
      a.length === b.length &&
      a.every((x, i) => typeof x === typeof b[i] && x === b[i])
    );
  }

  let aRaw: string;
  let bRaw: string;
  try {
    aRaw = marshal(a);
    bRaw = marshal(b);
  } catch {
    return false;
  }
  return aRaw === bRaw;
}

function isPrimitive(v: unknown): boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "bigint";
}
