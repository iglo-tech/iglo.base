// Upstream: tools/types/geo_point_test.go

import { describe, expect, test } from "bun:test";

import { GeoPoint } from "@/tools/types/geo-point";
import { marshal } from "@/tools/types/go-json";
import { JSONRaw } from "@/tools/types/json-raw";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("GeoPointAsMap", () => {
  const scenarios: [string, GeoPoint, { lon: number; lat: number }][] = [
    ["zero", new GeoPoint(), { lon: 0.0, lat: 0.0 }],
    ["non-zero", new GeoPoint(-10, 20.123), { lon: -10.0, lat: 20.123 }],
  ];

  for (const [name, point, expected] of scenarios) {
    test(name, () => {
      expect(point.asMap()).toEqual(expected);
    });
  }
});

describe("GeoPointStringAndValue", () => {
  const scenarios: [string, GeoPoint, string][] = [
    ["zero", new GeoPoint(), `{"lon":0,"lat":0}`],
    ["non-zero", new GeoPoint(-10, 20.123), `{"lon":-10,"lat":20.123}`],
  ];

  for (const [name, point, expected] of scenarios) {
    test(name, () => {
      expect(point.string()).toBe(point.value());
      expect(point.string()).toBe(expected);
    });
  }
});

// Not in upstream's tests: json.Marshal fails on NaN and ±Inf, String
// ignores the error and Value returns it.
describe("GeoPoint with a non-finite coordinate", () => {
  // json.Marshal keeps the bytes written before the error, and String
  // returns them (checked against the upstream binary)
  const scenarios: [string, GeoPoint, string][] = [
    ["lon NaN", new GeoPoint(NaN, 1), `{"lon"`],
    ["lat NaN", new GeoPoint(1, NaN), `{"lon":1,"lat"`],
    ["lon +Inf", new GeoPoint(Infinity, 1), `{"lon"`],
    ["lat -Inf", new GeoPoint(1, -Infinity), `{"lon":1,"lat"`],
  ];

  for (const [name, point, partial] of scenarios) {
    test(name, () => {
      expect(point.string()).toBe(partial);
      expect(String(point)).toBe(partial);
      expect(() => point.value()).toThrow();
      expect(() => point.marshalJSON()).toThrow();
      expect(() => marshal({ p: point })).toThrow();
    });
  }
});

describe("GeoPointScan", () => {
  const scenarios: [unknown, boolean, string][] = [
    [null, false, `{"lon":1,"lat":2}`],
    ["", false, `{"lon":1,"lat":2}`],
    [new JSONRaw(), false, `{"lon":1,"lat":2}`],
    [new Uint8Array(), false, `{"lon":1,"lat":2}`],
    [`{}`, false, `{"lon":1,"lat":2}`],
    [`[]`, true, `{"lon":1,"lat":2}`],
    [0, true, `{"lon":1,"lat":2}`],
    [`{"lon":"1.23","lat":"4.56"}`, true, `{"lon":1,"lat":2}`],
    [`{"lon":1.23,"lat":4.56}`, false, `{"lon":1.23,"lat":4.56}`],
    [bytes(`{"lon":1.23,"lat":4.56}`), false, `{"lon":1.23,"lat":4.56}`],
    [new JSONRaw(`{"lon":1.23,"lat":4.56}`), false, `{"lon":1.23,"lat":4.56}`],
    [new GeoPoint(), false, `{"lon":0,"lat":0}`],
    [new GeoPoint(1.23, 4.56), false, `{"lon":1.23,"lat":4.56}`],
    // &types.GeoPoint{...}: a pointer is the same object in JS
    [new GeoPoint(1.23, 4.56), false, `{"lon":1.23,"lat":4.56}`],
  ];

  scenarios.forEach(([value, expectErr, expectStr], i) => {
    test(`${i}_${String(value)}`, () => {
      const point = new GeoPoint(1, 2);
      let hasErr = false;
      try {
        point.scan(value);
      } catch {
        hasErr = true;
      }
      expect(hasErr).toBe(expectErr);
      expect(point.string()).toBe(expectStr);
    });
  });
});

// Not in upstream's tests: Go json v2 struct decoding and float text.
describe("GeoPointScan Go decoding", () => {
  const scenarios: [string, unknown, boolean, string][] = [
    ["partial object keeps the other field", `{"lat":5}`, false, `{"lon":1,"lat":5}`],
    ["null is the zero value", `null`, false, `{"lon":0,"lat":0}`],
    ["null field is zero", `{"lon":null}`, false, `{"lon":0,"lat":2}`],
    ["names are case-sensitive", `{"LON":5}`, false, `{"lon":1,"lat":2}`],
    ["unknown members are ignored", `{"x":"y","lon":3}`, false, `{"lon":3,"lat":2}`],
    // json v2 stops at the first error
    ["a wrong field type stops decoding", `{"lon":"x","lat":7}`, true, `{"lon":1,"lat":2}`],
    ["members before a wrong type are kept", `{"lat":7,"lon":"x"}`, true, `{"lon":1,"lat":7}`],
    ["a syntax error keeps earlier members", `{"lon":5,`, true, `{"lon":5,"lat":2}`],
    ["duplicate names fail after the first", `{"lon":5,"lon":6}`, true, `{"lon":5,"lat":2}`],
    ["a map is marshaled first", { lon: 8, lat: 9 }, false, `{"lon":8,"lat":9}`],
    ["negative zero and exponents", `{"lon":-0,"lat":1e21}`, false, `{"lon":-0,"lat":1e+21}`],
    ["small numbers", `{"lon":0.0000001,"lat":-1.5e-10}`, false, `{"lon":1e-7,"lat":-1.5e-10}`],
    // the whole number token is checked before the field is set
    ["a dot without digits", `{"lon":50.}`, true, `{"lon":1,"lat":2}`],
    ["an exponent without digits", `{"lon":50e}`, true, `{"lon":1,"lat":2}`],
    ["a signed exponent without digits", `{"lon":50e+}`, true, `{"lon":1,"lat":2}`],
    ["a dot before the exponent", `{"lon":1.e5}`, true, `{"lon":1,"lat":2}`],
    ["a lone minus", `{"lon":-}`, true, `{"lon":1,"lat":2}`],
    ["an incomplete number at the end", `{"lon":50.`, true, `{"lon":1,"lat":2}`],
    ["an incomplete number after a member", `{"lat":7,"lon":5E-}`, true, `{"lon":1,"lat":7}`],
    // `0` is a complete number; the `1` after it is the syntax error
    ["a leading zero", `{"lon":01}`, true, `{"lon":0,"lat":2}`],
    ["a second fraction", `{"lon":1.5.2}`, true, `{"lon":1.5,"lat":2}`],
  ];

  for (const [name, value, expectErr, expectStr] of scenarios) {
    test(name, () => {
      const point = new GeoPoint(1, 2);
      let hasErr = false;
      try {
        point.scan(value);
      } catch {
        hasErr = true;
      }
      expect(hasErr).toBe(expectErr);
      expect(point.string()).toBe(expectStr);
    });
  }
});
