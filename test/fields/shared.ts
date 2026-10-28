// Upstream: core/field_test.go (the shared base-method, id, name and help
// validation helpers every field test runs)

import { expect, test } from "bun:test";

import type { Field } from "@/fields/field";
import { fieldFactory } from "@/fields/fields";
import { Errors } from "@/validation/error";

import { newBaseCollection, noDBApp } from "@test/support/fields";

function newField(fieldType: string): Field {
  const factory = fieldFactory(fieldType);
  if (factory === undefined) {
    throw new Error(`Missing ${JSON.stringify(fieldType)} field factory`);
  }
  return factory();
}

function errorKeys(err: Error | null): Record<string, unknown> {
  return err instanceof Errors ? err.errors : {};
}

export function testFieldBaseMethods(fieldType: string): void {
  const f = newField(fieldType);

  test("type", () => {
    expect(f.type()).toBe(fieldType);
  });

  test("id", () => {
    for (const expected of ["new_id", ""]) {
      f.setId(expected);
      expect(f.getId()).toBe(expected);
    }
  });

  test("name", () => {
    for (const expected of ["new_name", ""]) {
      f.setName(expected);
      expect(f.getName()).toBe(expected);
    }
  });

  test("system", () => {
    for (const expected of [false, true]) {
      f.setSystem(expected);
      expect(f.getSystem()).toBe(expected);
    }
  });

  test("hidden", () => {
    for (const expected of [false, true]) {
      f.setHidden(expected);
      expect(f.getHidden()).toBe(expected);
    }
  });
}

export function testDefaultFieldIdValidation(fieldType: string): void {
  const app = noDBApp();
  const collection = newBaseCollection("test_collection");

  const scenarios: { name: string; field: () => Field; expectError: boolean }[] = [
    { name: "empty value", field: () => newField(fieldType), expectError: true },
    {
      name: "invalid length",
      field: () => {
        const f = newField(fieldType);
        f.setId("a".repeat(101));
        return f;
      },
      expectError: true,
    },
    {
      name: "valid length",
      field: () => {
        const f = newField(fieldType);
        f.setId("a".repeat(100));
        return f;
      },
      expectError: false,
    },
  ];

  for (const s of scenarios) {
    test(`[id] ${s.name}`, () => {
      const errs = errorKeys(s.field().validateSettings(app, collection));
      expect(errs["id"] !== undefined).toBe(s.expectError);
    });
  }
}

export function testDefaultFieldNameValidation(fieldType: string): void {
  const app = noDBApp();
  const collection = newBaseCollection("test_collection");

  const named = (name: string) => () => {
    const f = newField(fieldType);
    f.setName(name);
    return f;
  };

  const scenarios: { name: string; field: () => Field; expectError: boolean }[] = [
    { name: "empty value", field: () => newField(fieldType), expectError: true },
    { name: "invalid length", field: named("a".repeat(101)), expectError: true },
    { name: "valid length", field: named("a".repeat(100)), expectError: false },
    { name: "invalid regex", field: named("test("), expectError: true },
    { name: "valid regex", field: named("test_123"), expectError: false },
    { name: "_via_", field: named("a_via_b"), expectError: true },
    { name: "system reserved - null", field: named("null"), expectError: true },
    { name: "system reserved - false", field: named("false"), expectError: true },
    { name: "system reserved - true", field: named("true"), expectError: true },
    { name: "system reserved - _rowid_", field: named("_rowid_"), expectError: true },
    { name: "system reserved - expand", field: named("expand"), expectError: true },
    { name: "system reserved - collectionId", field: named("collectionId"), expectError: true },
    {
      name: "system reserved - collectionName",
      field: named("collectionName"),
      expectError: true,
    },
  ];

  for (const s of scenarios) {
    test(`[name] ${s.name}`, () => {
      const errs = errorKeys(s.field().validateSettings(app, collection));
      expect(errs["name"] !== undefined).toBe(s.expectError);
    });
  }
}

export function testDefaultFieldHelpValidation(fieldType: string): void {
  const app = noDBApp();
  const collection = newBaseCollection("test_collection");

  const scenarios: { name: string; json: string; expectError: boolean }[] = [
    { name: "empty value", json: `{}`, expectError: false },
    { name: "< max limit", json: `{"help":"abc"}`, expectError: false },
    { name: "= max limit", json: `{"help":"${"a".repeat(300)}"}`, expectError: false },
    { name: "> max limit", json: `{"help":"${"a".repeat(301)}"}`, expectError: true },
  ];

  for (const s of scenarios) {
    test(`[help] ${s.name}`, () => {
      const field = newField(fieldType);
      field.unmarshalJSON(s.json);

      const errs = errorKeys(field.validateSettings(app, collection));
      expect(errs["help"] !== undefined).toBe(s.expectError);
    });
  }
}
