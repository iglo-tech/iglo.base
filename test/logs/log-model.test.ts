// Upstream: core/log_model_test.go (TestLogDBExport), plus the cuts of
// json/v2's stream decoding, as the upstream binary stored them for every
// logs.maxDataSize from 1 up to the data's whole size.

import { describe, expect, test } from "bun:test";

import type { Log } from "@/logs/batch-handler";
import { cutBytes, logDBExport } from "@/logs/log-model";

const date = new Date("2026-08-18T10:20:30.456Z");
const messageLimit = 8000;
const dataLimit = 16 << 10;

function log(message: string, data: Log["data"]): Log {
  return { time: date, level: 123, message, data };
}

describe("logDBExport", () => {
  test("empty log", () => {
    expect(logDBExport("", { ...log("", {}), level: 0 }, 0)).toMatchObject({
      data: "{}",
      id: "",
      level: 0,
      message: "",
    });
  });

  test("below the default limits", () => {
    expect(logDBExport("test_id", log("test_message", { a: "test1", b: "test2" }), 0)).toEqual({
      id: "test_id",
      created: "2026-08-18 10:20:30.456Z",
      level: 123,
      message: "test_message",
      data: `{"a":"test1","b":"test2"}`,
    });
  });

  test("exactly the default limits", () => {
    const c = "a".repeat(dataLimit - 32);
    const row = logDBExport(
      "test_id",
      log("a".repeat(messageLimit), { a: "test1", b: "test2", c }),
      0,
    );
    expect(row.message).toBe("a".repeat(messageLimit));
    expect(row.data).toBe(`{"a":"test1","b":"test2","c":"${c}"}`);
  });

  test("above the default limits", () => {
    const c = "a".repeat(dataLimit - 32) + "x";
    const row = logDBExport(
      "test_id",
      log("a".repeat(messageLimit) + "x", { a: "test1", b: "test2", c }),
      0,
    );
    expect(row.message).toBe("a".repeat(messageLimit));
    expect(row.data).toBe(`{"__pb_truncated__":true,"a":"test1","b":"test2","c":"${c}"}`);
  });

  test("above a custom limit", () => {
    const c = "a".repeat((2 << 10) - 32) + "x";
    const row = logDBExport("test_id", log("test_message", { a: "test1", b: "test2", c }), 2 << 10);
    expect(row.data).toBe(`{"__pb_truncated__":true,"a":"test1","b":"test2","c":"${c}"}`);
  });

  const data = { a: { b: { c: "text", d: 12.5 }, e: 400 }, f: "x", g: 400 };
  const raw = `{"a":{"b":{"c":"text","d":12.5},"e":400},"f":"x","g":400}`;
  test.each([
    // inside the first name
    [1, `{"__pb_truncated__":true}`],
    [3, `{"__pb_truncated__":true}`],
    // the name ended: its value failed
    [4, `{"__pb_truncated__":true,"a":null}`],
    [5, `{"__pb_truncated__":true,"a":null}`],
    // an open object stays
    [6, `{"__pb_truncated__":true,"a":{}}`],
    [9, `{"__pb_truncated__":true,"a":{"b":null}}`],
    [11, `{"__pb_truncated__":true,"a":{"b":{}}}`],
    // inside a string value
    [18, `{"__pb_truncated__":true,"a":{"b":{"c":null}}}`],
    [21, `{"__pb_truncated__":true,"a":{"b":{"c":"text"}}}`],
    // a number that ends with the input is complete
    [27, `{"__pb_truncated__":true,"a":{"b":{"c":"text","d":1}}}`],
    [28, `{"__pb_truncated__":true,"a":{"b":{"c":"text","d":12}}}`],
    // a fraction without digits is not
    [29, `{"__pb_truncated__":true,"a":{"b":{"c":"text","d":null}}}`],
    [30, `{"__pb_truncated__":true,"a":{"b":{"c":"text","d":12.5}}}`],
    // after the whole first member
    [41, `{"__pb_truncated__":true,"a":{"b":{"c":"text","d":12.5},"e":400}}`],
    [47, `{"__pb_truncated__":true,"a":{"b":{"c":"text","d":12.5},"e":400},"f":null}`],
    [48, `{"__pb_truncated__":true,"a":{"b":{"c":"text","d":12.5},"e":400},"f":"x"}`],
    [56, `{"__pb_truncated__":true,"a":{"b":{"c":"text","d":12.5},"e":400},"f":"x","g":400}`],
  ])("a cut at %d keeps what the decoder read", (limit, expected) => {
    expect(raw.length).toBe(57);
    expect(logDBExport("id", log("m", data), limit).data).toBe(expected);
  });

  test("the whole data fits", () => {
    expect(logDBExport("id", log("m", data), 57).data).toBe(raw);
  });

  test("the limits count bytes", () => {
    expect(logDBExport("id", log("é".repeat(5000), {}), 0).message).toBe(
      cutBytes("é".repeat(5000), messageLimit),
    );
    expect(Buffer.byteLength(cutBytes("é".repeat(5000), messageLimit))).toBe(messageLimit);
  });
});
