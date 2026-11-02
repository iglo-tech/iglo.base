// Upstream: tools/logger/batch_handler_test.go

import { describe, expect, test } from "bun:test";

import {
  BatchHandler,
  LevelDebug,
  LevelError,
  LevelInfo,
  LevelWarn,
  type Log,
  type LogRecord,
} from "@/logs/batch-handler";
import { marshal } from "@/tools/types/go-json";
import { Errors, NewError } from "@/validation/error";

const noWrite = (): void => {};

function record(message: string, level = LevelInfo, attrs?: LogRecord["attrs"]): LogRecord {
  return { time: new Date(), level, message, attrs };
}

function validationError(): Error {
  return NewError("validation_code", "validation_message");
}

function messages(logs: Log[]): string[] {
  return logs.map((l) => l.message);
}

describe("BatchHandler", () => {
  test("panics without WriteFunc", () => {
    expect(() => new BatchHandler({} as never)).toThrow();
  });

  test("defaults", () => {
    const h = new BatchHandler({ writeFunc: noWrite });
    expect(h.options.batchSize).toBe(100);
    expect(h.options.level).toBe(LevelInfo);
    expect(h.options.beforeAddFunc).toBeUndefined();
    expect(h.options.writeFunc).toBeDefined();
    expect(h.group).toBe("");
    expect(Object.keys(h.attrs)).toHaveLength(0);
    expect(h.logs).toHaveLength(0);
  });

  test.each([
    [LevelDebug, false],
    [LevelInfo, false],
    [LevelWarn, true],
    [LevelError, true],
  ])("enabled at level %d: %p", (level, expected) => {
    const h = new BatchHandler({ level: LevelWarn, writeFunc: noWrite });
    expect(h.enabled(level)).toBe(expected);
  });

  test("setLevel", () => {
    const h = new BatchHandler({ level: LevelWarn, writeFunc: noWrite });
    expect(h.options.level).toBe(LevelWarn);
    h.setLevel(LevelDebug);
    expect(h.options.level).toBe(LevelDebug);
  });

  test("withAttrs and withGroup", () => {
    const h0 = new BatchHandler({ writeFunc: noWrite });
    const h1 = h0.withAttrs({ test1: 1 });
    const h2 = h1.withGroup("h2_group");
    const h3 = h2.withAttrs({ test2: 2 });

    const scenarios: [BatchHandler, BatchHandler | undefined, string, number][] = [
      [h0, undefined, "", 0],
      [h1, h0, "", 1],
      [h2, h1, "h2_group", 0],
      [h3, h2, "", 1],
    ];
    for (const [handler, parent, group, attrs] of scenarios) {
      expect(handler.group).toBe(group);
      expect(handler.parent).toBe(parent as BatchHandler);
      expect(Object.keys(handler.attrs)).toHaveLength(attrs);
    }
  });

  test("handle", () => {
    const beforeLogs: Log[] = [];
    let writeLogs: Log[] = [];
    const h = new BatchHandler({
      batchSize: 3,
      beforeAddFunc: (log) => {
        beforeLogs.push(log);
        // skip test2 log
        return log.message !== "test2";
      },
      writeFunc: (logs) => {
        writeLogs = logs;
      },
    });

    h.handle(record("test1"));
    h.handle(record("test2"));
    h.handle(record("test3"));

    // no batch write
    expect(messages(beforeLogs)).toEqual(["test1", "test2", "test3"]);
    expect(messages(h.logs)).toEqual(["test1", "test3"]);
    expect(writeLogs).toHaveLength(0);

    // add one more log to trigger the batch write
    h.handle(record("test4"));
    expect(h.logs).toHaveLength(0);
    expect(messages(writeLogs)).toEqual(["test1", "test3", "test4"]);
  });

  test("writeAll", () => {
    const beforeLogs: Log[] = [];
    let writeLogs: Log[] = [];
    const h = new BatchHandler({
      batchSize: 3,
      beforeAddFunc: (log) => {
        beforeLogs.push(log);
        return true;
      },
      writeFunc: (logs) => {
        writeLogs = logs;
      },
    });

    h.handle(record("test1"));
    h.handle(record("test2"));

    expect(messages(beforeLogs)).toEqual(["test1", "test2"]);
    expect(messages(h.logs)).toEqual(["test1", "test2"]);
    expect(writeLogs).toHaveLength(0); // empty because the batch size hasn't been reached

    // force trigger the batch write
    h.writeAll();

    expect(messages(beforeLogs)).toEqual(["test1", "test2"]);
    expect(h.logs).toHaveLength(0); // reset
    expect(messages(writeLogs)).toEqual(["test1", "test2"]);
  });

  test("attrs format", () => {
    const beforeLogs: Log[] = [];
    const h0 = new BatchHandler({
      beforeAddFunc: (log) => {
        beforeLogs.push(log);
        return true;
      },
      writeFunc: noWrite,
    });

    const h1 = h0.withAttrs({ a: 1, b: "123" });
    const h2 = h1
      .withGroup("sub")
      .withAttrs({ c: 3, d: { "d.1": 1 }, e: new Error("example error") });

    const named = record("hello", LevelInfo, { name: "test" });
    h0.handle(named);
    h1.handle(named);
    h2.handle(named);

    // errors serialization checks
    const validationErrors = (): Errors =>
      new Errors({ a: validationError(), b: new Error("plain") });
    h0.handle(
      record("details", LevelError, {
        "validation.Errors": validationErrors(),
        "wrapped_validation.Errors": new Error(`wrapped: ${validationErrors().message}`, {
          cause: validationErrors(),
        }),
        "map[string]any": {
          a: NewError("validation_code", "validation_message"),
          b: new Error("plain"),
          c: "test_any",
          d: {
            nestedA: NewError("nested_code", "nested_message"),
            nestedB: new Error("nested_plain"),
          },
        },
        "map[string]error": { a: validationError(), b: new Error("plain") },
        "map[string]validation.Error": { a: validationError(), b: null },
        plain_error: new Error("plain"),
      }),
    );

    expect(beforeLogs.map((log) => marshal(log.data))).toEqual([
      `{"name":"test"}`,
      `{"a":1,"b":"123","name":"test"}`,
      `{"a":1,"b":"123","sub":{"c":3,"d":{"d.1":1},"e":"example error","name":"test"}}`,
      `{"map[string]any":{"a":"validation_message","b":"plain","c":"test_any","d":{"nestedA":"nested_message","nestedB":"nested_plain"}},"map[string]error":{"a":"validation_message","b":"plain"},"map[string]validation.Error":{"a":"validation_message","b":null},"plain_error":"plain","validation.Errors":{"a":"validation_message","b":"plain"},"wrapped_validation.Errors":{"data":{"a":"validation_message","b":"plain"},"raw":"wrapped: a: validation_message; b: plain."}}`,
    ]);
  });
});
