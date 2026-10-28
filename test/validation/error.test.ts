// Upstream: ozzo-validation v4.4.1 error_test.go

import { describe, expect, test } from "bun:test";

import { newBadRequestError } from "@/server/error";
import { ErrorObject, Errors, Float64, NewError, NewInternalError } from "@/validation/error";
import { Length } from "@/validation/length";
import { Key, Map } from "@/validation/map";
import { Required } from "@/validation/required";
import { Field, ValidateStruct } from "@/validation/struct";

describe("error", () => {
  test("TestNewInternalError", () => {
    const err = NewInternalError(new Error("abc"));
    expect(err.internalError()).not.toBeNull();
    expect(err.internalError().message).toBe("abc");
  });

  test("TestErrors_Error", () => {
    let errs = new Errors({
      B: new Error("B1"),
      C: new Error("C1"),
      A: new Error("A1"),
    });
    expect(errs.error()).toBe("A: A1; B: B1; C: C1.");

    errs = new Errors({
      B: new Error("B1"),
    });
    expect(errs.error()).toBe("B: B1.");

    errs = new Errors({});
    expect(errs.error()).toBe("");
  });

  test("TestErrors_MarshalMessage", () => {
    const errs = new Errors({
      A: new Error("A1"),
      B: new Errors({
        "2": new Error("B1"),
      }),
    });
    expect(errs.marshalJSON()).toBe('{"A":"A1","B":{"2":"B1"}}');
  });

  test("TestErrors_Filter", () => {
    let errs = new Errors({
      B: new Error("B1"),
      C: null,
      A: new Error("A1"),
    });
    let err = errs.filter();
    expect(errs.size).toBe(2);
    expect(err).not.toBeNull();
    expect(err?.error()).toBe("A: A1; B: B1.");

    errs = new Errors({});
    expect(errs.filter()).toBeNull();

    errs = new Errors({
      B: null,
      C: null,
    });
    err = errs.filter();
    expect(err).toBeNull();
  });

  test("TestErrorObject_SetCode", () => {
    let err = new ErrorObject("A", "msg");

    expect(err.code()).toBe("A");

    const set = err.setCode("B") as ErrorObject;
    expect(set.code()).toBe("B");
    expect(err.code()).toBe("A");
    err = set;
    expect(err.code()).toBe("B");
  });

  test("TestErrorObject_Code", () => {
    const err = new ErrorObject("A", "msg");

    expect(err.code()).toBe("A");
  });

  test("TestErrorObject_SetMessage", () => {
    let err = new ErrorObject("code", "A");

    expect(err.getMessage()).toBe("A");

    const set = err.setMessage("abc");
    expect(set.getMessage()).toBe("abc");
    expect(err.getMessage()).toBe("A");
    err = set as ErrorObject;
    expect(err.getMessage()).toBe("abc");
  });

  test("TestErrorObject_Message", () => {
    const err = new ErrorObject("code", "A");

    expect(err.getMessage()).toBe("A");
  });

  test("TestErrorObject_Params", () => {
    const p = { A: "val1", AA: "val2" };

    const err = new ErrorObject("code", "A").setParams(p).setMessage("B");

    expect(err.params()).toEqual(p);
  });

  test("TestErrorObject_AddParam2", () => {
    const p = { key: "val" };
    const err = new ErrorObject("code", "A").addParam("key", "val");

    expect(err.params()).toEqual(p);
  });

  test("TestErrorObject_AddParam", () => {
    const p = { A: "val1", B: "val2" };

    const err = (new ErrorObject("code", "A").setParams(p) as ErrorObject).addParam("C", "val3");

    expect(err.params()).toEqual({ A: "val1", B: "val2", C: "val3" });
  });

  test("TestError_Code", () => {
    const err = NewError("A", "msg");

    expect(err.code()).toBe("A");
  });

  test("TestError_SetMessage", () => {
    let err = NewError("code", "A");

    expect(err.getMessage()).toBe("A");

    err = err.setMessage("abc");
    expect(err.getMessage()).toBe("abc");
  });

  test("TestError_Message", () => {
    const err = NewError("code", "A");

    expect(err.getMessage()).toBe("A");
  });

  test("TestError_Params", () => {
    const p = { A: "val1", AA: "val2" };

    const err = NewError("code", "A").setParams(p).setMessage("B");

    expect(err.params()).toEqual(p);
  });

  test("TestValidationError", () => {
    const params = { A: "B" };

    let err = NewError("code", "msg").setParams(params);

    expect(err.code()).toBe("code");
    expect(err.getMessage()).toBe("msg");
    expect(err.params()).toEqual(params);

    const params2 = { min: 1 };
    err = err.setParams(params2);

    expect(err.params()).toEqual(params2);
  });
});

// The template subset (ErrorObject.Error) and the API error data built from
// Errors by src/server/error.ts (tools/router/error.go).
describe("template subset and API error data", () => {
  test("params print as Go's fmt prints them", () => {
    const err = NewError(
      "c",
      "{{.s}}|{{ .i }}|{{.f}}|{{.small}}|{{.list}}|{{.missing}}|{{.nil}}|{{.b}}",
    );
    expect(
      err.setParams({
        s: "x",
        i: 9007199254740991,
        f: new Float64(1e6),
        small: 0.5,
        list: ["a", "b"],
        nil: null,
        b: true,
      }).message,
    ).toBe("x|9007199254740991|1e+06|0.5|[a b]|<no value>|<no value>|true");
  });

  test("a message without params is not executed", () => {
    expect(NewError("c", "{{.x}} and {{").message).toBe("{{.x}} and {{");
  });

  test("an unsupported action throws, as template.Must panics", () => {
    expect(() => NewError("c", "{{if .x}}{{end}}").setParams({ x: 1 })).toThrow();
    expect(() => NewError("c", "{{.x").setParams({ x: 1 })).toThrow();
  });

  test("Errors become the API error data", () => {
    const errs = ValidateStruct(
      Field("name", "", Required),
      Field("title", "abcdef", Length(1, 3)),
      Field("nested", { a: "" }, Map(Key("a", Required))),
    );
    expect(JSON.stringify(newBadRequestError("", errs))).toBe(
      `{"data":{"name":{"code":"validation_required","message":"Cannot be blank."},"nested":{"a":{"code":"validation_required","message":"Cannot be blank."}},"title":{"code":"validation_length_out_of_range","message":"The length must be between 1 and 3.","params":{"max":3,"min":1}}},"message":"Something went wrong while processing your request.","status":400}`,
    );
  });
});
