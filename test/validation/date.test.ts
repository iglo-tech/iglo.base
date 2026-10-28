// Upstream: ozzo-validation v4.4.1 date_test.go

import { describe, expect, test } from "bun:test";

import { DateTime } from "@/tools/types/datetime";
import { Date } from "@/validation/date";
import { type Error as ValidationError, NewError } from "@/validation/error";

function assertError(expected: string, err: globalThis.Error | null): void {
  if (expected === "") {
    expect(err).toBeNull();
    return;
  }
  expect(err?.message).toBe(expected);
}

// time.ANSIC and time.RFC3339
const ANSIC = "Mon Jan _2 15:04:05 2006";
const RFC3339 = "2006-01-02T15:04:05Z07:00";

// time.Date(y, m, d, h, mi, s, 0, time.UTC)
function utc(year: number, month: number, day: number, hour = 0, min = 0, sec = 0): DateTime {
  const ms = globalThis.Date.UTC(year, month - 1, day, hour, min, sec);
  return DateTime.fromInstant({ sec: ms / 1000, nsec: 0 });
}

describe("TestDate", () => {
  const rows = [
    { tag: "t1", layout: ANSIC, value: "", err: "" },
    { tag: "t2", layout: ANSIC, value: "Wed Feb  4 21:00:57 2009", err: "" },
    { tag: "t3", layout: ANSIC, value: "Wed Feb  29 21:00:57 2009", err: "must be a valid date" },
    { tag: "t4", layout: "2006-01-02", value: "2009-11-12", err: "" },
    { tag: "t5", layout: "2006-01-02", value: "2009-11-12 21:00:57", err: "must be a valid date" },
    { tag: "t6", layout: "2006-01-02", value: "2009-1-12", err: "must be a valid date" },
    { tag: "t7", layout: "2006-01-02", value: "2009-01-12", err: "" },
    { tag: "t8", layout: "2006-01-02", value: "2009-01-32", err: "must be a valid date" },
    { tag: "t9", layout: "2006-01-02", value: 1, err: "must be either a string or byte slice" },
  ];

  test.each(rows)("$tag", ({ layout, value, err }) => {
    assertError(err, Date(layout).validate(value));
  });
});

describe("TestDateRule_Error", () => {
  test("error() and rangeError() replace the messages", () => {
    const r = Date(RFC3339)
      .min(utc(2000, 1, 1, 1, 1, 1))
      .error("123")
      .rangeError("456");
    expect(r.validate("0001-01-02T15:04:05Z07:00")?.message).toBe("123");
    expect(r.validate("1999-01-02T15:04:05Z")?.message).toBe("456");
  });

  test("default messages without error() or rangeError()", () => {
    const r = Date(RFC3339).min(utc(2000, 1, 1, 1, 1, 1));
    expect(r.validate("0001-01-02T15:04:05Z07:00")?.message).toBe("must be a valid date");
    expect(r.validate("1999-01-02T15:04:05Z")?.message).toBe("the date is out of range");
  });
});

describe("TestDateRule_ErrorObject", () => {
  test("errorObject() and rangeErrorObject() set the error objects", () => {
    const r = Date(RFC3339).errorObject(NewError("code", "abc"));
    const invalid = r.validate("0001-01-02T15:04:05Z07:00") as ValidationError;
    expect(invalid.code()).toBe("code");
    expect(invalid.getMessage()).toBe("abc");

    const min = utc(2000, 1, 1, 1, 1, 1);
    expect(r.min(min).validate("1999-01-02T15:04:05Z")?.message).toBe("the date is out of range");

    const r2 = r.errorObject(NewError("C", "def")).rangeErrorObject(NewError("D", "123")).min(min);
    const out1 = r2.validate("0001-01-02T15:04:05Z07:00") as ValidationError;
    expect(out1.code()).toBe("C");
    expect(out1.getMessage()).toBe("def");
    const out2 = r2.validate("1999-01-02T15:04:05Z") as ValidationError;
    expect(out2.code()).toBe("D");
    expect(out2.getMessage()).toBe("123");
  });
});

describe("TestDateRule_MinMax", () => {
  test("without a min or max, any date is accepted", () => {
    expect(Date(ANSIC).validate("Wed Feb  4 21:00:57 2009")).toBeNull();
  });

  test("min() rejects dates before it, max() rejects dates after it", () => {
    const now = DateTime.fromInstant({ sec: Math.floor(globalThis.Date.now() / 1000), nsec: 0 });
    expect(Date(ANSIC).min(now).validate("Wed Feb  4 21:00:57 2009")?.message).toBe(
      "the date is out of range",
    );
    expect(Date(ANSIC).max(now).validate("Wed Feb  4 21:00:57 2009")).toBeNull();
    expect(
      Date(ANSIC)
        .max(utc(2000, 1, 1))
        .validate("Wed Feb  4 21:00:57 2009")?.message,
    ).toBe("the date is out of range");
  });

  test("min and max together", () => {
    const r2 = Date("2006-01-02")
      .min(utc(2000, 12, 1))
      .max(utc(2020, 2, 1));
    expect(r2.validate("2010-01-02")).toBeNull();
    expect(r2.validate("1999-01-02")?.message).toBe("the date is out of range");
    expect(r2.validate("2021-01-02")?.message).toBe("the date is out of range");
  });
});
