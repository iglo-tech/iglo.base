// Upstream: tools/router/error_test.go
//
// ozzo-validation stand-ins: validation.ErrRequired is RequiredError, and
// validation.NewError(code, message) is TestValidationError (with optional
// params, like SetParams). validation.Errors is ValidationErrors and Go's
// map[string]error is a plain object.

import { describe, expect, test } from "bun:test";

import {
  ErrNoRows,
  errorsIs,
  newApiError,
  newBadRequestError,
  newForbiddenError,
  newInternalServerError,
  newNotFoundError,
  newTooManyRequestsError,
  newUnauthorizedError,
  sentenize,
  toApiError,
  ValidationErrors,
  type SafeErrorItem,
  type SafeErrorResolver,
} from "@/server/error";

class RequiredError extends Error {
  constructor() {
    super("cannot be blank");
    this.name = "RequiredError";
  }

  code(): string {
    return "validation_required";
  }
}

class TestValidationError extends Error implements SafeErrorItem {
  readonly #code: string;
  readonly #params: Record<string, unknown>;

  constructor(code: string, message: string, params: Record<string, unknown> = {}) {
    super(message);
    this.name = "TestValidationError";
    this.#code = code;
    this.#params = params;
  }

  code(): string {
    return this.#code;
  }

  params(): Record<string, unknown> {
    return this.#params;
  }
}

class MockSafeErrorItem extends Error implements SafeErrorItem, SafeErrorResolver {
  constructor() {
    super("mock_error");
    this.name = "MockSafeErrorItem";
  }

  code(): string {
    return "mock_code";
  }

  resolve(errData: Record<string, unknown>): Record<string, unknown> {
    errData.mock_resolve = 123;
    return errData;
  }
}

test("NewApiError with raw data", () => {
  const e = newApiError(300, "message_test", "rawData_test");

  expect(JSON.stringify(e)).toBe(`{"data":{},"message":"Message_test.","status":300}`);
  expect(e.message).toBe("Message_test.");
  expect(e.rawData()).toBe("rawData_test");
});

test("NewApiError with validation data", () => {
  const e = newApiError(300, "message_test", {
    err1: new Error("test error"), // should be normalized
    err2: new RequiredError(),
    err3: new ValidationErrors({
      "err3.1": new Error("test error"), // should be normalized
      "err3.2": new RequiredError(),
      "err3.3": new ValidationErrors({
        "err3.3.1": new RequiredError(),
      }),
    }),
    err4: new MockSafeErrorItem(),
    err5: {
      "err5.1": new RequiredError(),
    },
  });

  expect(JSON.stringify(e)).toBe(
    `{"data":{"err1":{"code":"validation_invalid_value","message":"Invalid value."},"err2":{"code":"validation_required","message":"Cannot be blank."},"err3":{"err3.1":{"code":"validation_invalid_value","message":"Invalid value."},"err3.2":{"code":"validation_required","message":"Cannot be blank."},"err3.3":{"err3.3.1":{"code":"validation_required","message":"Cannot be blank."}}},"err4":{"code":"mock_code","message":"Mock_error.","mock_resolve":123},"err5":{"err5.1":{"code":"validation_required","message":"Cannot be blank."}}},"message":"Message_test.","status":300}`,
  );
  expect(e.message).toBe("Message_test.");
  expect(e.rawData()).not.toBeUndefined();
});

describe("NewNotFoundError", () => {
  const scenarios: [string, unknown, string][] = [
    ["", null, `{"data":{},"message":"The requested resource wasn't found.","status":404}`],
    ["demo", "rawData_test", `{"data":{},"message":"Demo.","status":404}`],
    [
      "demo",
      new ValidationErrors({ err1: new TestValidationError("test_code", "test_message") }),
      `{"data":{"err1":{"code":"test_code","message":"Test_message."}},"message":"Demo.","status":404}`,
    ],
  ];
  for (const [i, [message, data, expected]] of scenarios.entries()) {
    test(`case ${i}`, () => {
      expect(JSON.stringify(newNotFoundError(message, data))).toBe(expected);
    });
  }
});

describe("NewBadRequestError", () => {
  const scenarios: [string, unknown, string][] = [
    [
      "",
      null,
      `{"data":{},"message":"Something went wrong while processing your request.","status":400}`,
    ],
    ["demo", "rawData_test", `{"data":{},"message":"Demo.","status":400}`],
    [
      "demo",
      new ValidationErrors({ err1: new TestValidationError("test_code", "test_message") }),
      `{"data":{"err1":{"code":"test_code","message":"Test_message."}},"message":"Demo.","status":400}`,
    ],
  ];
  for (const [i, [message, data, expected]] of scenarios.entries()) {
    test(`case ${i}`, () => {
      expect(JSON.stringify(newBadRequestError(message, data))).toBe(expected);
    });
  }
});

describe("NewForbiddenError", () => {
  const scenarios: [string, unknown, string][] = [
    ["", null, `{"data":{},"message":"You are not allowed to perform this request.","status":403}`],
    ["demo", "rawData_test", `{"data":{},"message":"Demo.","status":403}`],
    [
      "demo",
      new ValidationErrors({ err1: new TestValidationError("test_code", "test_message") }),
      `{"data":{"err1":{"code":"test_code","message":"Test_message."}},"message":"Demo.","status":403}`,
    ],
  ];
  for (const [i, [message, data, expected]] of scenarios.entries()) {
    test(`case ${i}`, () => {
      expect(JSON.stringify(newForbiddenError(message, data))).toBe(expected);
    });
  }
});

describe("NewUnauthorizedError", () => {
  const scenarios: [string, unknown, string][] = [
    ["", null, `{"data":{},"message":"Missing or invalid authentication.","status":401}`],
    ["demo", "rawData_test", `{"data":{},"message":"Demo.","status":401}`],
    [
      "demo",
      new ValidationErrors({ err1: new TestValidationError("test_code", "test_message") }),
      `{"data":{"err1":{"code":"test_code","message":"Test_message."}},"message":"Demo.","status":401}`,
    ],
  ];
  for (const [i, [message, data, expected]] of scenarios.entries()) {
    test(`case ${i}`, () => {
      expect(JSON.stringify(newUnauthorizedError(message, data))).toBe(expected);
    });
  }
});

describe("NewInternalServerError", () => {
  const scenarios: [string, unknown, string][] = [
    [
      "",
      null,
      `{"data":{},"message":"Something went wrong while processing your request.","status":500}`,
    ],
    ["demo", "rawData_test", `{"data":{},"message":"Demo.","status":500}`],
    [
      "demo",
      new ValidationErrors({ err1: new TestValidationError("test_code", "test_message") }),
      `{"data":{"err1":{"code":"test_code","message":"Test_message."}},"message":"Demo.","status":500}`,
    ],
  ];
  for (const [i, [message, data, expected]] of scenarios.entries()) {
    test(`case ${i}`, () => {
      expect(JSON.stringify(newInternalServerError(message, data))).toBe(expected);
    });
  }
});

describe("NewTooManyRequestsError", () => {
  const scenarios: [string, unknown, string][] = [
    ["", null, `{"data":{},"message":"Too Many Requests.","status":429}`],
    ["demo", "rawData_test", `{"data":{},"message":"Demo.","status":429}`],
    [
      "demo",
      new ValidationErrors({
        err1: new TestValidationError("test_code", "test_message", { test: 123 }),
      }),
      `{"data":{"err1":{"code":"test_code","message":"Test_message.","params":{"test":123}}},"message":"Demo.","status":429}`,
    ],
  ];
  for (const [i, [message, data, expected]] of scenarios.entries()) {
    test(`case ${i}`, () => {
      expect(JSON.stringify(newTooManyRequestsError(message, data))).toBe(expected);
    });
  }
});

test("ApiError is", () => {
  const err0 = newInternalServerError("", null);
  const err1 = newInternalServerError("", null);
  const err2 = new Error("test");
  const err3 = new Error("wrapped", { cause: err0 });

  expect(errorsIs(err0, undefined)).toBe(false); // nil error
  expect(errorsIs(err0, err1)).toBe(false); // non ApiError
  expect(errorsIs(err0, err2)).toBe(false); // different ApiError
  expect(errorsIs(err0, err0)).toBe(true); // same ApiError
  expect(errorsIs(err3, err0)).toBe(true); // wrapped ApiError
});

describe("ToApiError", () => {
  const notFound = `{"data":{},"message":"The requested resource wasn't found.","status":404}`;
  const scenarios: [string, unknown, string][] = [
    [
      "regular error",
      new Error("test"),
      `{"data":{},"message":"Something went wrong while processing your request.","status":400}`,
    ],
    [
      "fs.ErrNotExist",
      Object.assign(new Error("file does not exist"), { code: "ENOENT" }),
      notFound,
    ],
    ["sql.ErrNoRows", ErrNoRows, notFound],
    ["ApiError", newForbiddenError("test", null), `{"data":{},"message":"Test.","status":403}`],
    [
      "wrapped ApiError",
      new Error("wrapped", { cause: newForbiddenError("test", null) }),
      `{"data":{},"message":"Test.","status":403}`,
    ],
  ];
  for (const [name, err, expected] of scenarios) {
    test(name, () => {
      expect(JSON.stringify(toApiError(err as Error))).toBe(expected);
    });
  }
});

// Upstream: tools/inflector/inflector_test.go (TestSentenize)
describe("sentenize", () => {
  const scenarios: [string, string][] = [
    ["", ""],
    ["   ", ""],
    [".", "."],
    ["?", "?"],
    ["!", "!"],
    ["Test", "Test."],
    [" test ", "Test."],
    ["hello world", "Hello world."],
    ["hello world.", "Hello world."],
    ["hello world!", "Hello world!"],
    ["hello world?", "Hello world?"],
  ];
  for (const [input, expected] of scenarios) {
    test(JSON.stringify(input), () => {
      expect(sentenize(input)).toBe(expected);
    });
  }
});
