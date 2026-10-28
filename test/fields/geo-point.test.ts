// Upstream: core/field_geo_point_test.go

import { describe, expect, test } from "bun:test";

import { FieldTypeGeoPoint, GeoPointField } from "@/fields/geo-point";
import { GeoPoint } from "@/tools/types/geo-point";
import { marshal } from "@/tools/types/go-json";

import { TestRecord, newBaseCollection, noDBApp } from "@test/support/fields";
import {
  testDefaultFieldHelpValidation,
  testDefaultFieldIdValidation,
  testDefaultFieldNameValidation,
  testFieldBaseMethods,
} from "@test/fields/shared";

describe("TestGeoPointFieldBaseMethods", () => {
  testFieldBaseMethods(FieldTypeGeoPoint);
});

test("TestGeoPointFieldColumnType", () => {
  const f = new GeoPointField();

  const expected = String.raw`JSON DEFAULT '{"lon":0,"lat":0}' NOT NULL`;

  expect(f.columnType(noDBApp())).toBe(expected);
});

describe("TestGeoPointFieldPrepareValue", () => {
  const f = new GeoPointField();
  const record = new TestRecord(newBaseCollection("test"));

  const scenarios: { raw: unknown; expected: string }[] = [
    { raw: null, expected: `{"lon":0,"lat":0}` },
    { raw: "", expected: `{"lon":0,"lat":0}` },
    { raw: new TextEncoder().encode(""), expected: `{"lon":0,"lat":0}` },
    { raw: {}, expected: `{"lon":0,"lat":0}` },
    { raw: new GeoPoint(10, 20), expected: `{"lon":10,"lat":20}` },
    // &GeoPoint in Go: the same object in TS
    { raw: new GeoPoint(10, 20), expected: `{"lon":10,"lat":20}` },
    {
      raw: new TextEncoder().encode(`{"lon": 10, "lat": 20}`),
      expected: `{"lon":10,"lat":20}`,
    },
    { raw: { lon: 10, lat: 20 }, expected: `{"lon":10,"lat":20}` },
    // map[string]float64 in Go: the same plain object in TS
    { raw: { lon: 10, lat: 20 }, expected: `{"lon":10,"lat":20}` },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${String(s.raw)}`, () => {
      const [v, err] = f.prepareValue(record, s.raw);
      expect(err).toBeNull();

      expect(marshal(v)).toBe(s.expected);
    });
  }
});

describe("TestGeoPointFieldValidateValue", () => {
  const collection = newBaseCollection("test_collection");

  const withValue = (value: unknown) => () => {
    const record = new TestRecord(collection);
    record.setRaw("test", value);
    return record;
  };

  const scenarios: {
    name: string;
    field: GeoPointField;
    record: () => TestRecord;
    expectError: boolean;
  }[] = [
    {
      name: "invalid raw value",
      field: new GeoPointField({ name: "test" }),
      record: withValue(123),
      expectError: true,
    },
    {
      name: "zero field value (non-required)",
      field: new GeoPointField({ name: "test" }),
      record: withValue(new GeoPoint()),
      expectError: false,
    },
    {
      name: "zero field value (required)",
      field: new GeoPointField({ name: "test", required: true }),
      record: withValue(new GeoPoint()),
      expectError: true,
    },
    {
      name: "non-zero Lat field value (required)",
      field: new GeoPointField({ name: "test", required: true }),
      record: withValue(new GeoPoint(0, 1)),
      expectError: false,
    },
    {
      name: "non-zero Lon field value (required)",
      field: new GeoPointField({ name: "test", required: true }),
      record: withValue(new GeoPoint(1, 0)),
      expectError: false,
    },
    {
      name: "non-zero Lat-Lon field value (required)",
      field: new GeoPointField({ name: "test", required: true }),
      record: withValue(new GeoPoint(-1, -2)),
      expectError: false,
    },
    {
      name: "lat < -90",
      field: new GeoPointField({ name: "test" }),
      record: withValue(new GeoPoint(0, -90.1)),
      expectError: true,
    },
    {
      name: "lat > 90",
      field: new GeoPointField({ name: "test" }),
      record: withValue(new GeoPoint(0, 90.1)),
      expectError: true,
    },
    {
      name: "lon < -180",
      field: new GeoPointField({ name: "test" }),
      record: withValue(new GeoPoint(-180.1, 0)),
      expectError: true,
    },
    {
      name: "lon > 180",
      field: new GeoPointField({ name: "test" }),
      record: withValue(new GeoPoint(180.1, 0)),
      expectError: true,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const err = s.field.validateValue(noDBApp(), s.record());
      expect(err !== null).toBe(s.expectError);
    });
  }
});

describe("TestGeoPointFieldValidateSettings", () => {
  testDefaultFieldIdValidation(FieldTypeGeoPoint);
  testDefaultFieldNameValidation(FieldTypeGeoPoint);
  testDefaultFieldHelpValidation(FieldTypeGeoPoint);
});
