// Upstream: tools/router/unmarshal_request_data_test.go
//
// Scenarios dropped because they only exist because of Go's type system:
//   - "non-pointer map[string]any": Go needs a pointer to write into a map
//     value. A TypeScript destination object is always writable.
//   - "unsupported *map[string]string" and "unsupported *map[string][]string":
//     Go rejects these destination types through its typed reflection. The
//     TypeScript destination is a plain object, so there is no equivalent.
//   - "non-pointer struct": Go needs a pointer to a struct to set its fields.
//     TypeScript objects are passed by reference.
//
// Go's JSON result is replaced by the decoded destination values keyed by the
// Go field names. Fields that were never set stay absent.

import { expect, test } from "bun:test";

import {
  pointerTo,
  sliceOf,
  structOf,
  textOf,
  unmarshalRequestData,
  type MapRef,
  type RequestData,
  type StructType,
} from "@/server/unmarshal-request-data";

const timeType = textOf((text) => {
  const d = new Date(text);
  if (Number.isNaN(d.getTime()) || !/^\d{4}-\d\d-\d\dT/.test(text)) {
    throw new Error("parsing time");
  }
  return text;
});

const embed1Type = structOf([
  { name: "Name", type: "string", tags: { form: "embed_name", json: "embed_name" } },
]);

const embed2Type = structOf([
  { name: "Name", type: "string", tags: { form: "embed_name2", json: "embed_name2" } },
]);

const testStruct = structOf([
  { name: "Any", type: "any", tags: { form: "anyTag", query: "anyTag2" } },
  { name: "AnyPtr", type: pointerTo("any") },
  { name: "AnySlice", type: sliceOf("any") },
  { name: "AnySlicePtr", type: pointerTo(sliceOf("any")), tags: { form: "anySlicePtrTag" } },
  { name: "AnySliceOfPtr", type: sliceOf(pointerTo("any")) },

  { name: "String", type: "string", tags: { form: "stringTag", query: "stringTag2" } },
  { name: "StringPtr", type: pointerTo("string") },
  { name: "StringSlice", type: sliceOf("string") },
  {
    name: "StringSlicePtr",
    type: pointerTo(sliceOf("string")),
    tags: { form: "stringSlicePtrTag" },
  },
  { name: "StringSliceOfPtr", type: sliceOf(pointerTo("string")) },

  { name: "Bool", type: "bool", tags: { form: "boolTag", query: "boolTag2" } },
  { name: "BoolPtr", type: pointerTo("bool") },
  { name: "BoolSlice", type: sliceOf("bool") },
  { name: "BoolSlicePtr", type: pointerTo(sliceOf("bool")), tags: { form: "boolSlicePtrTag" } },
  { name: "BoolSliceOfPtr", type: sliceOf(pointerTo("bool")) },

  { name: "Int8", type: "int8", tags: { form: "int8Tag", query: "int8Tag2" } },
  { name: "Int8Ptr", type: pointerTo("int8") },
  { name: "Int8Slice", type: sliceOf("int8") },
  { name: "Int8SlicePtr", type: pointerTo(sliceOf("int8")), tags: { form: "int8SlicePtrTag" } },
  { name: "Int8SliceOfPtr", type: sliceOf(pointerTo("int8")) },

  { name: "Int16", type: "int16", tags: { form: "int16Tag", query: "int16Tag2" } },
  { name: "Int16Ptr", type: pointerTo("int16") },
  { name: "Int16Slice", type: sliceOf("int16") },
  { name: "Int16SlicePtr", type: pointerTo(sliceOf("int16")), tags: { form: "int16SlicePtrTag" } },
  { name: "Int16SliceOfPtr", type: sliceOf(pointerTo("int16")) },

  { name: "Int32", type: "int32", tags: { form: "int32Tag", query: "int32Tag2" } },
  { name: "Int32Ptr", type: pointerTo("int32") },
  { name: "Int32Slice", type: sliceOf("int32") },
  { name: "Int32SlicePtr", type: pointerTo(sliceOf("int32")), tags: { form: "int32SlicePtrTag" } },
  { name: "Int32SliceOfPtr", type: sliceOf(pointerTo("int32")) },

  { name: "Int64", type: "int64", tags: { form: "int64Tag", query: "int64Tag2" } },
  { name: "Int64Ptr", type: pointerTo("int64") },
  { name: "Int64Slice", type: sliceOf("int64") },
  { name: "Int64SlicePtr", type: pointerTo(sliceOf("int64")), tags: { form: "int64SlicePtrTag" } },
  { name: "Int64SliceOfPtr", type: sliceOf(pointerTo("int64")) },

  { name: "Int", type: "int", tags: { form: "intTag", query: "intTag2" } },
  { name: "IntPtr", type: pointerTo("int") },
  { name: "IntSlice", type: sliceOf("int") },
  { name: "IntSlicePtr", type: pointerTo(sliceOf("int")), tags: { form: "intSlicePtrTag" } },
  { name: "IntSliceOfPtr", type: sliceOf(pointerTo("int")) },

  { name: "Uint8", type: "uint8", tags: { form: "uint8Tag", query: "uint8Tag2" } },
  { name: "Uint8Ptr", type: pointerTo("uint8") },
  { name: "Uint8Slice", type: sliceOf("uint8") },
  { name: "Uint8SlicePtr", type: pointerTo(sliceOf("uint8")), tags: { form: "uint8SlicePtrTag" } },
  { name: "Uint8SliceOfPtr", type: sliceOf(pointerTo("uint8")) },

  { name: "Uint16", type: "uint16", tags: { form: "uint16Tag", query: "uint16Tag2" } },
  { name: "Uint16Ptr", type: pointerTo("uint16") },
  { name: "Uint16Slice", type: sliceOf("uint16") },
  {
    name: "Uint16SlicePtr",
    type: pointerTo(sliceOf("uint16")),
    tags: { form: "uint16SlicePtrTag" },
  },
  { name: "Uint16SliceOfPtr", type: sliceOf(pointerTo("uint16")) },

  { name: "Uint32", type: "uint32", tags: { form: "uint32Tag", query: "uint32Tag2" } },
  { name: "Uint32Ptr", type: pointerTo("uint32") },
  { name: "Uint32Slice", type: sliceOf("uint32") },
  {
    name: "Uint32SlicePtr",
    type: pointerTo(sliceOf("uint32")),
    tags: { form: "uint32SlicePtrTag" },
  },
  { name: "Uint32SliceOfPtr", type: sliceOf(pointerTo("uint32")) },

  { name: "Uint64", type: "uint64", tags: { form: "uint64Tag", query: "uint64Tag2" } },
  { name: "Uint64Ptr", type: pointerTo("uint64") },
  { name: "Uint64Slice", type: sliceOf("uint64") },
  {
    name: "Uint64SlicePtr",
    type: pointerTo(sliceOf("uint64")),
    tags: { form: "uint64SlicePtrTag" },
  },
  { name: "Uint64SliceOfPtr", type: sliceOf(pointerTo("uint64")) },

  { name: "Uint", type: "uint", tags: { form: "uintTag", query: "uintTag2" } },
  { name: "UintPtr", type: pointerTo("uint") },
  { name: "UintSlice", type: sliceOf("uint") },
  { name: "UintSlicePtr", type: pointerTo(sliceOf("uint")), tags: { form: "uintSlicePtrTag" } },
  { name: "UintSliceOfPtr", type: sliceOf(pointerTo("uint")) },

  { name: "Float32", type: "float32", tags: { form: "float32Tag", query: "float32Tag2" } },
  { name: "Float32Ptr", type: pointerTo("float32") },
  { name: "Float32Slice", type: sliceOf("float32") },
  {
    name: "Float32SlicePtr",
    type: pointerTo(sliceOf("float32")),
    tags: { form: "float32SlicePtrTag" },
  },
  { name: "Float32SliceOfPtr", type: sliceOf(pointerTo("float32")) },

  { name: "Float64", type: "float64", tags: { form: "float64Tag", query: "float64Tag2" } },
  { name: "Float64Ptr", type: pointerTo("float64") },
  { name: "Float64Slice", type: sliceOf("float64") },
  {
    name: "Float64SlicePtr",
    type: pointerTo(sliceOf("float64")),
    tags: { form: "float64SlicePtrTag" },
  },
  { name: "Float64SliceOfPtr", type: sliceOf(pointerTo("float64")) },

  // encoding.TextUnmarshaler
  { name: "Time", type: timeType, tags: { form: "timeTag", query: "timeTag2" } },
  { name: "TimePtr", type: pointerTo(timeType) },
  { name: "TimeSlice", type: sliceOf(timeType) },
  { name: "TimeSlicePtr", type: pointerTo(sliceOf(timeType)), tags: { form: "timeSlicePtrTag" } },
  { name: "TimeSliceOfPtr", type: sliceOf(pointerTo(timeType)) },

  // @jsonPayload fields
  { name: "JSONPayloadA", type: "string", tags: { form: "shouldBeIgnored", json: "payloadA" } },
  { name: "JSONPayloadB", type: sliceOf("int"), tags: { json: "payloadB" } },
  { name: "JSONPayloadC", type: "bool", tags: { json: "-" } },

  // unexported fields or `-` tags
  { name: "unexported", type: "string" },
  { name: "SkipExported", type: "string", tags: { form: "-" } },
  {
    name: "unexportedStructFieldWithoutTag",
    type: structOf([
      { name: "Name", type: "string", tags: { json: "unexportedStructFieldWithoutTag_name" } },
    ]),
  },
  {
    name: "unexportedStructFieldWithTag",
    type: structOf([
      { name: "Name", type: "string", tags: { json: "unexportedStructFieldWithTag_name" } },
    ]),
    tags: { form: "unexportedStruct" },
  },

  // structs
  {
    name: "StructWithoutTag",
    type: structOf([{ name: "Name", type: "string", tags: { json: "StructWithoutTag_name" } }]),
  },
  {
    name: "StructWithTag",
    type: structOf([{ name: "Name", type: "string", tags: { json: "StructWithTag_name" } }]),
    tags: { form: "exportedStruct" },
  },

  // embedded
  { name: "embed1", type: embed1Type, embedded: true },
  { name: "embed2", type: embed2Type, embedded: true, tags: { form: "embed2" } },
]);

const mapData: RequestData = {
  number1: ["1"],
  number2: ["2", "3"],
  number3: ["2.1", "-3.4"],
  number4: ["0", "-0", "0.0001"],
  string0: [""],
  string1: ["a"],
  string2: ["b", "c"],
  string3: [
    "0.0",
    "-0.0",
    "000.1",
    "000001",
    "-000001",
    "1.6E-35",
    "-1.6E-35",
    "10e100",
    "1_000_000",
    "1.000.000",
    " 123 ",
    "0b1",
    "0xFF",
    "1234A",
    "Infinity",
    "-Infinity",
    "undefined",
    "null",
  ],
  bool1: ["true"],
  bool2: ["true", "false"],
  mixed: ["true", "123", "test"],
  "@jsonPayload": [`{"json_a":null,"json_b":123}`, `{"json_c":[1,2,3]}`],
};

const structData: RequestData = {
  anyTag: ["a", "b"],
  AnyPtr: ["b"],
  AnySlice: ["a", "b", "false", ""],
  anySlicePtrTag: ["d", "true"],
  AnySliceOfPtr: ["f", "123.456"],

  stringTag: ["a", "b"],
  StringPtr: ["b"],
  StringSlice: ["a", "b", "c", ""],
  stringSlicePtrTag: ["d", "e"],
  StringSliceOfPtr: ["f", "g"],

  boolTag: ["true"],
  BoolPtr: ["true"],
  BoolSlice: ["true", "false", ""],
  boolSlicePtrTag: ["false", "false", "true"],
  BoolSliceOfPtr: ["false", "true", "false"],

  int8Tag: ["-1", "2"],
  Int8Ptr: ["3"],
  Int8Slice: ["4", "5", ""],
  int8SlicePtrTag: ["5", "6"],
  Int8SliceOfPtr: ["7", "8"],

  int16Tag: ["-1", "2"],
  Int16Ptr: ["3"],
  Int16Slice: ["4", "5", ""],
  int16SlicePtrTag: ["5", "6"],
  Int16SliceOfPtr: ["7", "8"],

  int32Tag: ["-1", "2"],
  Int32Ptr: ["3"],
  Int32Slice: ["4", "5", ""],
  int32SlicePtrTag: ["5", "6"],
  Int32SliceOfPtr: ["7", "8"],

  int64Tag: ["-1", "2"],
  Int64Ptr: ["3"],
  Int64Slice: ["4", "5", ""],
  int64SlicePtrTag: ["5", "6"],
  Int64SliceOfPtr: ["7", "8"],

  intTag: ["-1", "2"],
  IntPtr: ["3"],
  IntSlice: ["4", "5", ""],
  intSlicePtrTag: ["5", "6"],
  IntSliceOfPtr: ["7", "8"],

  uint8Tag: ["1", "2"],
  Uint8Ptr: ["3"],
  Uint8Slice: ["4", "5", ""],
  uint8SlicePtrTag: ["5", "6"],
  Uint8SliceOfPtr: ["7", "8"],

  uint16Tag: ["1", "2"],
  Uint16Ptr: ["3"],
  Uint16Slice: ["4", "5", ""],
  uint16SlicePtrTag: ["5", "6"],
  Uint16SliceOfPtr: ["7", "8"],

  uint32Tag: ["1", "2"],
  Uint32Ptr: ["3"],
  Uint32Slice: ["4", "5", ""],
  uint32SlicePtrTag: ["5", "6"],
  Uint32SliceOfPtr: ["7", "8"],

  uint64Tag: ["1", "2"],
  Uint64Ptr: ["3"],
  Uint64Slice: ["4", "5", ""],
  uint64SlicePtrTag: ["5", "6"],
  Uint64SliceOfPtr: ["7", "8"],

  uintTag: ["1", "2"],
  UintPtr: ["3"],
  UintSlice: ["4", "5", ""],
  uintSlicePtrTag: ["5", "6"],
  UintSliceOfPtr: ["7", "8"],

  float32Tag: ["-1.2"],
  Float32Ptr: ["1.5", "2.0"],
  Float32Slice: ["1", "2.3", "-0.3", ""],
  float32SlicePtrTag: ["-1.3", "3"],
  Float32SliceOfPtr: ["0", "1.2"],

  float64Tag: ["-1.2"],
  Float64Ptr: ["1.5", "2.0"],
  Float64Slice: ["1", "2.3", "-0.3", ""],
  float64SlicePtrTag: ["-1.3", "3"],
  Float64SliceOfPtr: ["0", "1.2"],

  timeTag: ["2009-11-10T15:00:00Z"],
  TimePtr: ["2009-11-10T14:00:00Z", "2009-11-10T15:00:00Z"],
  TimeSlice: ["2009-11-10T14:00:00Z", "2009-11-10T15:00:00Z"],
  timeSlicePtrTag: ["2009-11-10T15:00:00Z", "2009-11-10T16:00:00Z"],
  TimeSliceOfPtr: ["2009-11-10T17:00:00Z", "2009-11-10T18:00:00Z"],

  // @jsonPayload fields
  "@jsonPayload": [
    `{"payloadA":"test", "shouldBeIgnored": "abc"}`,
    `{"payloadB":[1,2,3], "payloadC":true}`,
  ],

  // unexported fields or `-` tags
  unexperted: ["test"],
  SkipExported: ["test"],
  "unexportedStructFieldWithoutTag.Name": ["test"],
  "unexportedStruct.Name": ["test"],

  // structs
  "StructWithoutTag.Name": ["test1"],
  "exportedStruct.Name": ["test2"],

  // embedded
  embed_name: ["test3"],
  "embed2.embed_name2": ["test4"],
};

test("nil data leaves the destination untouched", () => {
  const dst: MapRef = { map: {} };
  unmarshalRequestData(undefined, dst);
  expect(dst.map).toEqual({});
});

test("map destination infers values from the data", () => {
  const ref: MapRef = { map: {} };
  unmarshalRequestData(mapData, ref);
  const dst = ref.map as Record<string, unknown>;

  // -0 is checked separately: toEqual does not tell -0 and 0 apart
  const number4 = dst.number4 as number[];
  delete dst.number4;

  expect(dst).toEqual({
    bool1: true,
    bool2: [true, false],
    json_a: null,
    json_b: 123,
    json_c: [1, 2, 3],
    mixed: [true, 123, "test"],
    number1: 1,
    number2: [2, 3],
    number3: [2.1, -3.4],
    string0: "",
    string1: "a",
    string2: ["b", "c"],
    string3: [
      "0.0",
      "-0.0",
      "000.1",
      "000001",
      "-000001",
      "1.6E-35",
      "-1.6E-35",
      "10e100",
      "1_000_000",
      "1.000.000",
      " 123 ",
      "0b1",
      "0xFF",
      "1234A",
      "Infinity",
      "-Infinity",
      "undefined",
      "null",
    ],
  });

  expect(number4).toHaveLength(3);
  expect(number4[0]).toBe(0);
  expect(Object.is(number4[1], -0)).toBe(true);
  expect(number4[2]).toBe(0.0001);
});

test("valid struct destination (all fields)", () => {
  const dst: Record<string, unknown> = {};
  unmarshalRequestData(structData, dst, testStruct);

  expect(dst).toEqual({
    Any: "a",
    AnyPtr: "b",
    AnySlice: ["a", "b", false, ""],
    AnySlicePtr: ["d", true],
    AnySliceOfPtr: ["f", 123.456],

    String: "a",
    StringPtr: "b",
    StringSlice: ["a", "b", "c", ""],
    StringSlicePtr: ["d", "e"],
    StringSliceOfPtr: ["f", "g"],

    Bool: true,
    BoolPtr: true,
    BoolSlice: [true, false, false],
    BoolSlicePtr: [false, false, true],
    BoolSliceOfPtr: [false, true, false],

    Int8: -1,
    Int8Ptr: 3,
    Int8Slice: [4, 5, 0],
    Int8SlicePtr: [5, 6],
    Int8SliceOfPtr: [7, 8],

    Int16: -1,
    Int16Ptr: 3,
    Int16Slice: [4, 5, 0],
    Int16SlicePtr: [5, 6],
    Int16SliceOfPtr: [7, 8],

    Int32: -1,
    Int32Ptr: 3,
    Int32Slice: [4, 5, 0],
    Int32SlicePtr: [5, 6],
    Int32SliceOfPtr: [7, 8],

    Int64: -1,
    Int64Ptr: 3,
    Int64Slice: [4, 5, 0],
    Int64SlicePtr: [5, 6],
    Int64SliceOfPtr: [7, 8],

    Int: -1,
    IntPtr: 3,
    IntSlice: [4, 5, 0],
    IntSlicePtr: [5, 6],
    IntSliceOfPtr: [7, 8],

    // Go marshals []uint8 as base64 ("BAUA"); here it is a number array
    Uint8: 1,
    Uint8Ptr: 3,
    Uint8Slice: [4, 5, 0],
    Uint8SlicePtr: [5, 6],
    Uint8SliceOfPtr: [7, 8],

    Uint16: 1,
    Uint16Ptr: 3,
    Uint16Slice: [4, 5, 0],
    Uint16SlicePtr: [5, 6],
    Uint16SliceOfPtr: [7, 8],

    Uint32: 1,
    Uint32Ptr: 3,
    Uint32Slice: [4, 5, 0],
    Uint32SlicePtr: [5, 6],
    Uint32SliceOfPtr: [7, 8],

    Uint64: 1,
    Uint64Ptr: 3,
    Uint64Slice: [4, 5, 0],
    Uint64SlicePtr: [5, 6],
    Uint64SliceOfPtr: [7, 8],

    Uint: 1,
    UintPtr: 3,
    UintSlice: [4, 5, 0],
    UintSlicePtr: [5, 6],
    UintSliceOfPtr: [7, 8],

    Float32: Math.fround(-1.2),
    Float32Ptr: Math.fround(1.5),
    Float32Slice: [1, Math.fround(2.3), Math.fround(-0.3), 0],
    Float32SlicePtr: [Math.fround(-1.3), 3],
    Float32SliceOfPtr: [0, Math.fround(1.2)],

    Float64: -1.2,
    Float64Ptr: 1.5,
    Float64Slice: [1, 2.3, -0.3, 0],
    Float64SlicePtr: [-1.3, 3],
    Float64SliceOfPtr: [0, 1.2],

    Time: "2009-11-10T15:00:00Z",
    TimePtr: "2009-11-10T14:00:00Z",
    TimeSlice: ["2009-11-10T14:00:00Z", "2009-11-10T15:00:00Z"],
    TimeSlicePtr: ["2009-11-10T15:00:00Z", "2009-11-10T16:00:00Z"],
    TimeSliceOfPtr: ["2009-11-10T17:00:00Z", "2009-11-10T18:00:00Z"],

    JSONPayloadA: "test",
    JSONPayloadB: [1, 2, 3],

    // Go also emits "SkipExported": "" (a zero value); this port never
    // writes a form:"-" field, so it stays absent.
    StructWithoutTag: { Name: "test1" },
    StructWithTag: { Name: "test2" },

    // embedded structs are stored under their type name
    embed1: { Name: "test3" },
    embed2: { Name: "test4" },
  });
});

test.each<[string, RequestData]>([
  ["invalid struct uint value", { uintTag: ["-1"] }],
  ["invalid struct int value", { intTag: ["abc"] }],
  ["invalid struct bool value", { boolTag: ["abc"] }],
  ["invalid struct float value", { float64Tag: ["abc"] }],
  ["invalid struct TextUnmarshaler value", { timeTag: ["123"] }],
])("%s", (_name, data) => {
  expect(() => unmarshalRequestData(data, {}, testStruct)).toThrow();
});

test("custom tagKey", () => {
  const dst: Record<string, unknown> = {};
  unmarshalRequestData(
    { tag1: ["a"], tag2: ["b"], tag3: ["c"], Item: ["d"] },
    dst,
    structOf([
      { name: "Item", type: "string", tags: { form: "tag1", query: "tag2", json: "tag2" } },
    ]),
    "query",
  );
  expect(dst).toEqual({ Item: "b" });
});

test("custom prefix", () => {
  const dst: Record<string, unknown> = {};
  unmarshalRequestData(
    { "test.A": ["1"], A: ["2"], "test.alias": ["3"] },
    dst,
    structOf([
      { name: "A", type: "string" },
      { name: "B", type: "string", tags: { form: "alias" } },
    ]),
    "",
    "test",
  );
  expect(dst).toEqual({ A: "1", B: "3" });
});

// note: extra unexported checks in addition to the above test as there
// is no easy way to print nested structs with all their fields.
test("unexported fields are not set", () => {
  const type: StructType = structOf([
    { name: "Exported", type: "string" },
    { name: "unexported", type: "string" },
    {
      name: "unexportedWithTag",
      type: "string",
      tags: { form: "unexportedWithTag", json: "unexportedWithTag" },
    },
  ]);

  const dst: Record<string, unknown> = {};
  unmarshalRequestData(
    {
      Exported: ["test"], // just for reference

      Unexported: ["test"],
      unexported: ["test"],
      UnexportedWithTag: ["test"],
      unexportedWithTag: ["test"],
    },
    dst,
    type,
  );

  expect(dst).toEqual({ Exported: "test" });
});
