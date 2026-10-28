// Upstream: ozzo-validation v4.4.1 minmax_test.go
//
// Dropped rows: t2.6 of TestMin and TestMax (the uint64 name
// in the message: uint and int are both JS integers here) and t4.7 of TestMin
// (the Go anonymous struct type name "struct {}").

import { describe, expect, test } from "bun:test";

import { DateTime } from "@/tools/types/datetime";
import { Float64, type Error as ValidationError, NewError } from "@/validation/error";
import { Max, Min } from "@/validation/minmax";

function assertError(expected: string, err: globalThis.Error | null): void {
  if (expected === "") {
    expect(err).toBeNull();
    return;
  }
  expect(err?.message).toBe(expected);
}

// time.Date(y, m, d, h, mi, s, 0, time.UTC)
function utc(year: number, month: number, day: number): DateTime {
  return DateTime.fromInstant({ sec: globalThis.Date.UTC(year, month - 1, day) / 1000, nsec: 0 });
}

const date0 = new DateTime();
const date20000101 = utc(2000, 1, 1);
const date20001201 = utc(2000, 12, 1);
const date20000601 = utc(2000, 6, 1);

describe("TestMin", () => {
  const rows: {
    tag: string;
    threshold: unknown;
    exclusive: boolean;
    value: unknown;
    err: string;
  }[] = [
    // int cases
    { tag: "t1.1", threshold: 1, exclusive: false, value: 1, err: "" },
    { tag: "t1.2", threshold: 1, exclusive: false, value: 2, err: "" },
    { tag: "t1.3", threshold: 1, exclusive: false, value: -1, err: "must be no less than 1" },
    { tag: "t1.4", threshold: 1, exclusive: false, value: 0, err: "" },
    { tag: "t1.5", threshold: 1, exclusive: true, value: 1, err: "must be greater than 1" },
    {
      tag: "t1.6",
      threshold: 1,
      exclusive: false,
      value: "1",
      err: "cannot convert string to int64",
    },
    { tag: "t1.7", threshold: "1", exclusive: false, value: 1, err: "type not supported: string" },
    // uint cases (uint and int are both JS integers; t2.6 is dropped)
    { tag: "t2.1", threshold: 2, exclusive: false, value: 2, err: "" },
    { tag: "t2.2", threshold: 2, exclusive: false, value: 3, err: "" },
    { tag: "t2.3", threshold: 2, exclusive: false, value: 1, err: "must be no less than 2" },
    { tag: "t2.4", threshold: 2, exclusive: false, value: 0, err: "" },
    { tag: "t2.5", threshold: 2, exclusive: true, value: 2, err: "must be greater than 2" },
    // float cases
    { tag: "t3.1", threshold: new Float64(2), exclusive: false, value: 2, err: "" },
    { tag: "t3.2", threshold: new Float64(2), exclusive: false, value: 3, err: "" },
    {
      tag: "t3.3",
      threshold: new Float64(2),
      exclusive: false,
      value: 1,
      err: "must be no less than 2",
    },
    { tag: "t3.4", threshold: new Float64(2), exclusive: false, value: 0, err: "" },
    {
      tag: "t3.5",
      threshold: new Float64(2),
      exclusive: true,
      value: 2,
      err: "must be greater than 2",
    },
    {
      tag: "t3.6",
      threshold: new Float64(2),
      exclusive: false,
      value: "1",
      err: "cannot convert string to float64",
    },
    // Time cases
    { tag: "t4.1", threshold: date20000601, exclusive: false, value: date20000601, err: "" },
    { tag: "t4.2", threshold: date20000601, exclusive: false, value: date20001201, err: "" },
    {
      tag: "t4.3",
      threshold: date20000601,
      exclusive: false,
      value: date20000101,
      err: "must be no less than 2000-06-01 00:00:00 +0000 UTC",
    },
    { tag: "t4.4", threshold: date20000601, exclusive: false, value: date0, err: "" },
    {
      tag: "t4.5",
      threshold: date20000601,
      exclusive: true,
      value: date20000601,
      err: "must be greater than 2000-06-01 00:00:00 +0000 UTC",
    },
    {
      tag: "t4.6",
      threshold: date20000601,
      exclusive: true,
      value: 1,
      err: "cannot convert int to time.Time",
    },
    { tag: "t4.8", threshold: date0, exclusive: false, value: date20000601, err: "" },
  ];

  test.each(rows)("$tag", ({ threshold, exclusive, value, err }) => {
    let r = Min(threshold);
    if (exclusive) {
      r = r.exclusive();
    }
    assertError(err, r.validate(value));
  });
});

describe("TestMinError", () => {
  test("default message, then error() replaces it", () => {
    expect(Min(10).validate(9)?.message).toBe("must be no less than 10");
    expect(Min(10).error("123").validate(9)?.message).toBe("123");
  });
});

describe("TestMax", () => {
  const rows: {
    tag: string;
    threshold: unknown;
    exclusive: boolean;
    value: unknown;
    err: string;
  }[] = [
    // int cases
    { tag: "t1.1", threshold: 2, exclusive: false, value: 2, err: "" },
    { tag: "t1.2", threshold: 2, exclusive: false, value: 1, err: "" },
    { tag: "t1.3", threshold: 2, exclusive: false, value: 3, err: "must be no greater than 2" },
    { tag: "t1.4", threshold: 2, exclusive: false, value: 0, err: "" },
    { tag: "t1.5", threshold: 2, exclusive: true, value: 2, err: "must be less than 2" },
    {
      tag: "t1.6",
      threshold: 2,
      exclusive: false,
      value: "1",
      err: "cannot convert string to int64",
    },
    { tag: "t1.7", threshold: "1", exclusive: false, value: 1, err: "type not supported: string" },
    // uint cases (uint and int are both JS integers; t2.6 is dropped)
    { tag: "t2.1", threshold: 2, exclusive: false, value: 2, err: "" },
    { tag: "t2.2", threshold: 2, exclusive: false, value: 1, err: "" },
    { tag: "t2.3", threshold: 2, exclusive: false, value: 3, err: "must be no greater than 2" },
    { tag: "t2.4", threshold: 2, exclusive: false, value: 0, err: "" },
    { tag: "t2.5", threshold: 2, exclusive: true, value: 2, err: "must be less than 2" },
    // float cases
    { tag: "t3.1", threshold: new Float64(2), exclusive: false, value: 2, err: "" },
    { tag: "t3.2", threshold: new Float64(2), exclusive: false, value: 1, err: "" },
    {
      tag: "t3.3",
      threshold: new Float64(2),
      exclusive: false,
      value: 3,
      err: "must be no greater than 2",
    },
    { tag: "t3.4", threshold: new Float64(2), exclusive: false, value: 0, err: "" },
    {
      tag: "t3.5",
      threshold: new Float64(2),
      exclusive: true,
      value: 2,
      err: "must be less than 2",
    },
    {
      tag: "t3.6",
      threshold: new Float64(2),
      exclusive: false,
      value: "1",
      err: "cannot convert string to float64",
    },
    // Time cases
    { tag: "t4.1", threshold: date20000601, exclusive: false, value: date20000601, err: "" },
    { tag: "t4.2", threshold: date20000601, exclusive: false, value: date20000101, err: "" },
    {
      tag: "t4.3",
      threshold: date20000601,
      exclusive: false,
      value: date20001201,
      err: "must be no greater than 2000-06-01 00:00:00 +0000 UTC",
    },
    { tag: "t4.4", threshold: date20000601, exclusive: false, value: date0, err: "" },
    {
      tag: "t4.5",
      threshold: date20000601,
      exclusive: true,
      value: date20000601,
      err: "must be less than 2000-06-01 00:00:00 +0000 UTC",
    },
    {
      tag: "t4.6",
      threshold: date20000601,
      exclusive: true,
      value: 1,
      err: "cannot convert int to time.Time",
    },
  ];

  test.each(rows)("$tag", ({ threshold, exclusive, value, err }) => {
    let r = Max(threshold);
    if (exclusive) {
      r = r.exclusive();
    }
    assertError(err, r.validate(value));
  });
});

describe("TestMaxError", () => {
  test("default message, then error() replaces it", () => {
    expect(Max(10).validate(11)?.message).toBe("must be no greater than 10");
    expect(Max(10).error("123").validate(11)?.message).toBe("123");
  });
});

describe("TestThresholdRule_ErrorObject", () => {
  test("errorObject() sets the code and message of the error", () => {
    const err = NewError("code", "abc");
    const out = Max(10).errorObject(err).validate(11) as ValidationError;

    // the threshold param is attached to a copy of the error (Go's SetParams)
    expect(out.code()).toBe("code");
    expect(out.getMessage()).toBe("abc");
  });
});
