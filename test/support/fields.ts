// Test doubles for the field tests: the record, collection, fields list
// and app members that src/fields/field.ts declares (FieldRecord,
// FieldCollection, FieldsListReader, FieldApp), with upstream's behavior
// for the parts the ported field tests use. The real implementations come
// with M1.6 (core/collection_model.go, core/fields_list.go) and M1.8
// (core/record_model.go); upstream's tests.NewTestApp is a copy of the
// vendored fixture opened with src/db.

import { expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Clock } from "@/app/clock";
import { Databases } from "@/db/base";
import type { Builder } from "@/db/dbx/builder";
import { HashExp, newExp, or } from "@/db/dbx/expression";
import {
  FieldNameId,
  defaultLowercaseRecordIdPattern,
  isGetterFinder,
  isSetterFinder,
  type Field,
  type FieldApp,
  type FieldCollection,
  type FieldRecord,
  type FieldsListReader,
} from "@/fields/field";
import { fieldFactory } from "@/fields/fields";
import { TextField } from "@/fields/text";
import { toString as castToString } from "@/tools/types/cast";
import { type DateTime, parseDateTime } from "@/tools/types/datetime";
import { anyType, marshal, sliceOf, unmarshal } from "@/tools/types/go-json";
import { Errors } from "@/validation/error";

import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";

// crc32Checksum (core/collection_model.go): the IEEE CRC-32 in decimal
export function crc32Checksum(str: string): string {
  return String(Bun.hash.crc32(str));
}

// core/fields_list.go FieldsList: the methods the tests use
export class TestFieldsList implements FieldsListReader {
  private list: Field[] = [];

  constructor(...fields: Field[]) {
    this.add(...fields);
  }

  [Symbol.iterator](): Iterator<Field> {
    return this.list[Symbol.iterator]();
  }

  get length(): number {
    return this.list.length;
  }

  getById(fieldId: string): Field | null {
    return this.list.find((f) => f.getId() === fieldId) ?? null;
  }

  getByName(fieldName: string): Field | null {
    return this.list.find((f) => f.getName() === fieldName) ?? null;
  }

  // Add adds one or more fields to the list, replacing a field with the
  // same id (or, for a field without id, the same name) in place; a field
  // without id gets "<type><crc32 of name>".
  add(...fields: Field[]): void {
    for (const f of fields) {
      this.addOne(f);
    }
  }

  private addOne(newField: Field): void {
    let replaceByName = false;
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
    for (const [i, field] of this.list.entries()) {
      if (replaceByName) {
        const name = newField.getName();
        if (name !== "" && field.getName() === name) {
          // reuse the original id
          newField.setId(field.getId());
          this.list[i] = newField;
          return;
        }
      } else if (field.getId() === newFieldId) {
        this.list[i] = newField;
        return;
      }
    }

    this.list.push(newField);
  }
}

// core/collection_model.go Collection: the members the fields read
export class TestCollection implements FieldCollection {
  id: string;
  name: string;
  type: string;
  fields: TestFieldsList;

  constructor(type: string, name: string, id = "", fields: TestFieldsList = new TestFieldsList()) {
    this.type = type;
    this.name = name;
    this.id = id === "" ? "pbc_" + crc32Checksum(type + name) : id;
    this.fields = fields;
  }
}

// NewBaseCollection: a base collection with the default "id" field
export function newBaseCollection(name: string, id = ""): TestCollection {
  return new TestCollection(
    "base",
    name,
    id,
    new TestFieldsList(
      new TextField({
        name: FieldNameId,
        system: true,
        primaryKey: true,
        required: true,
        min: 15,
        max: 15,
        pattern: defaultLowercaseRecordIdPattern,
        autogeneratePattern: "[a-z0-9]{15}",
      }),
    ),
  );
}

// core/record_model.go Record: the data store, setters and getters
export class TestRecord implements FieldRecord {
  id = "";
  private readonly data = new Map<string, unknown>();
  private originalData: Map<string, unknown>;
  private savedPK = "";
  private notNew = false;

  // NewRecord: every field except "id" starts with its PrepareValue(nil)
  constructor(readonly collection: TestCollection) {
    this.originalData = new Map();
    for (const field of collection.fields) {
      const name = field.getName();
      if (name === FieldNameId) {
        continue;
      }
      this.originalData.set(name, field.prepareValue(this, null)[0]);
    }
  }

  tableName(): string {
    return this.collection.name;
  }

  isNew(): boolean {
    return !this.notNew;
  }

  lastSavedPK(): string {
    return this.savedPK;
  }

  // PostScan: marks the record as saved with its current data
  postScan(): void {
    if (this.id === "") {
      throw new Error("missing record primary key");
    }
    this.notNew = true;
    this.savedPK = this.id;
    const original = new Map<string, unknown>();
    for (const field of this.collection.fields) {
      original.set(field.getName(), this.getRaw(field.getName()));
    }
    this.originalData = original;
  }

  original(): TestRecord {
    const r = new TestRecord(this.collection);
    r.originalData = new Map(this.originalData);
    const id = this.originalData.get(FieldNameId);
    if (id !== null && id !== undefined) {
      r.savedPK = castToString(id);
      r.id = r.savedPK;
    }
    return r;
  }

  setRaw(key: string, value: unknown): void {
    if (key === FieldNameId) {
      this.id = castToString(value);
    }
    this.data.set(key, value);
  }

  getRaw(key: string): unknown {
    if (key === FieldNameId) {
      return this.id;
    }
    if (this.data.has(key)) {
      return this.data.get(key);
    }
    return this.originalData.get(key);
  }

  // SetIfFieldExists + Set
  set(key: string, value: unknown): void {
    for (const field of this.collection.fields) {
      if (isSetterFinder(field)) {
        const setter = field.findSetter(key);
        if (setter !== null) {
          setter(this, value);
          return;
        }
      }

      // fallback to the default field PrepareValue method for direct match
      if (key === field.getName()) {
        this.setRaw(key, field.prepareValue(this, value)[0]);
        return;
      }
    }

    // custom key - set it without any transformations
    this.setRaw(key, value);
  }

  get(key: string): unknown {
    for (const field of this.collection.fields) {
      if (isGetterFinder(field)) {
        const getter = field.findGetter(key);
        if (getter !== null) {
          return getter(this);
        }
      }
    }
    return this.getRaw(key);
  }

  getString(key: string): string {
    return castToString(this.get(key));
  }

  getDateTime(key: string): DateTime {
    return parseDateTime(this.get(key));
  }
}

// A fixed clock for the tests (upstream reads time.Now()).
export function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}

// tests.NewTestApp: a copy of the vendored fixture opened with src/db.
// Collections are read from its _collections table on every call, as
// upstream's FindCollectionByNameOrId does (fields of the types not ported
// yet are skipped).
export class TestApp implements FieldApp {
  private constructor(
    private readonly dbs: Databases,
    readonly clock: Clock,
  ) {}

  concurrentDB(): Builder {
    return this.dbs.concurrentDB();
  }

  static open(clock: Clock = { now: () => new Date() }): TestApp {
    const root = mkdtempSync(join(tmpdir(), "iglo-base-fields-"));
    const dataDir = join(root, "pb_data");
    copyDataDir(fixtureDir, dataDir);
    return new TestApp(Databases.open({ dataDir }), clock);
  }

  cleanup(): void {
    this.dbs.close();
  }

  findCollectionByNameOrId(nameOrId: string): TestCollection {
    const row = this.dbs
      .concurrentDB()
      .select("id", "name", "type", "fields")
      .from("_collections")
      .where(
        or(
          new HashExp({ id: nameOrId }),
          newExp("LOWER([[name]])={:name}", { name: nameOrId.toLowerCase() }),
        ),
      )
      .limit(1)
      .row();
    const [id, name, type, fieldsJSON] = row as [string, string, string, string];
    const fields = new TestFieldsList();
    for (const data of unmarshal(fieldsJSON, sliceOf(anyType)) as Record<string, unknown>[]) {
      const factory = fieldFactory(String(data.type));
      if (factory === undefined) {
        continue;
      }
      const field = factory();
      field.unmarshalJSON(marshal(data));
      fields.add(field);
    }
    return new TestCollection(type, name, id, fields);
  }

  // FindFirstRecordByFilter(collection, "id != ''"): the first record id
  firstRecordId(collection: TestCollection): string {
    const row = this.dbs
      .concurrentDB()
      .select("id")
      .from(collection.name)
      .where(newExp("[[id]] != ''"))
      .limit(1)
      .row();
    return String(row[0]);
  }
}

// An app without a database, for the tests that do not query: any query or
// collection lookup fails.
export function noDBApp(clock: Clock = { now: () => new Date() }): FieldApp {
  return {
    concurrentDB(): Builder {
      throw new Error("no database in this test");
    },
    clock,
    findCollectionByNameOrId(nameOrId: string): FieldCollection {
      throw new Error(`no collection ${JSON.stringify(nameOrId)}`);
    },
  };
}

// tests.TestValidationErrors: err is validation.Errors with exactly the
// expected keys (or null for none)
export function expectValidationErrors(err: Error | null, expectedKeys: readonly string[]): void {
  if (err !== null && !(err instanceof Errors)) {
    throw new Error(`expected validation Errors, got ${err.name}: ${err.message}`);
  }
  const keys = err === null ? [] : Object.keys(err.errors);
  expect(keys.toSorted()).toEqual([...expectedKeys].toSorted());
}
