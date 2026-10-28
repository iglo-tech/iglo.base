// src/fields/field.ts and src/fields/fields.ts: the field type table, the
// optional interface checks, Go's strconv.Quote and the struct marshaling
// the fields share. (core/field.go has no test file of its own; its
// validation rules are covered through every field's settings tests.)

import { describe, expect, test } from "bun:test";

import { AutodateField } from "@/fields/autodate";
import { EditorField } from "@/fields/editor";
import {
  goQuote,
  isDriverValuer,
  isGetterFinder,
  isMaxBodySizeCalculator,
  isMultiValuer,
  isRecordInterceptor,
  isSetterFinder,
  marshalStruct,
} from "@/fields/field";
import { Fields, fieldFactory } from "@/fields/fields";
import { JSONField } from "@/fields/json";
import { NumberField } from "@/fields/number";
import { SelectField } from "@/fields/select";
import { TextField } from "@/fields/text";
import { bytesToText } from "@/tools/types/go-json";

test("Fields holds upstream's simple field types", () => {
  expect(Object.keys(Fields).toSorted()).toEqual(
    [
      "autodate",
      "bool",
      "date",
      "editor",
      "email",
      "geoPoint",
      "json",
      "number",
      "select",
      "text",
      "url",
    ].toSorted(),
  );
  for (const [type, factory] of Object.entries(Fields)) {
    const a = factory();
    expect(a.type()).toBe(type);
    expect(factory()).not.toBe(a); // a new instance each time
  }
  expect(fieldFactory("file")).toBeUndefined(); // M1.5
  expect(fieldFactory("toString")).toBeUndefined();
  expect(fieldFactory("__proto__")).toBeUndefined();
});

// SetterFinder, GetterFinder, DriverValuer, MultiValuer,
// MaxBodySizeCalculator, RecordInterceptor
const implemented = (f: Parameters<typeof isSetterFinder>[0]): boolean[] => [
  isSetterFinder(f),
  isGetterFinder(f),
  isDriverValuer(f),
  isMultiValuer(f),
  isMaxBodySizeCalculator(f),
  isRecordInterceptor(f),
];

test("the optional interfaces upstream's fields implement", () => {
  expect(implemented(new TextField())).toEqual([true, false, false, false, false, true]);
  expect(implemented(new NumberField())).toEqual([true, false, false, false, false, false]);
  expect(implemented(new SelectField())).toEqual([true, false, true, true, false, false]);
  expect(implemented(new AutodateField())).toEqual([true, false, false, false, false, true]);
  expect(implemented(new EditorField())).toEqual([false, false, false, false, true, false]);
  expect(implemented(new JSONField())).toEqual([false, false, false, false, true, false]);
});

describe("goQuote (strconv.Quote)", () => {
  const cases: [string, string][] = [
    ["", `""`],
    ["abc", `"abc"`],
    [`a"b\\c`, `"a\\"b\\\\c"`],
    ["\x07\b\f\n\r\t\v", `"\\a\\b\\f\\n\\r\\t\\v"`],
    ["\x00\x1f\x7f", `"\\x00\\x1f\\x7f"`],
    ["é日本", `"é日本"`],
    ["  ﻿", `"\\u00a0\\u2028\\ufeff"`],
    ["\u{e0001}", `"\\U000e0001"`],
    ["'", `"'"`],
    [bytesToText(Uint8Array.of(0x61, 0xff, 0x62)), `"a\\xffb"`],
  ];
  for (const [input, expected] of cases) {
    test(JSON.stringify(input), () => {
      expect(goQuote(input)).toBe(expected);
    });
  }
});

test("marshalStruct keeps the member order and does not escape HTML", () => {
  expect(
    marshalStruct([
      ["b", "<&>"],
      ["a", [1.5, null]],
      ["c", { y: 1, x: 2 }],
    ]),
  ).toBe(`{"b":"<&>","a":[1.5,null],"c":{"x":2,"y":1}}`);
});
