// Upstream: tools/logger/batch_handler.go, tools/logger/log.go
//
// Go's slog.Handler that keeps the logs in a queue and hands them to
// WriteFunc in batches. Here a record's attributes are a plain object, a
// LogGroup stands for slog.Group, and Go's logger.BlockKey context value is
// the `block` argument of handle and writeAll. Everything is synchronous and
// on one thread, so the mutex has no counterpart.

import { ValidationErrors, errorsAs } from "@/server/error";
import { isJSONMarshaler } from "@/tools/types/go-json";
import type { JSONMap } from "@/tools/types/json-map";

export const LevelDebug = -4;
export const LevelInfo = 0;
export const LevelWarn = 4;
export const LevelError = 8;

export type LogAttrs = { [key: string]: unknown };

// slog.Group
export class LogGroup {
  constructor(readonly attrs: LogAttrs) {}
}

// slog.Record
export interface LogRecord {
  time: Date;
  level: number;
  message: string;
  attrs?: LogAttrs;
}

// Log is similar to slog.Record but contains the log attributes as
// preformatted JSON map.
export interface Log {
  time: Date;
  data: JSONMap<unknown>;
  message: string;
  level: number;
}

// BatchOptions are options for the BatchHandler.
export interface BatchOptions {
  // WriteFunc processes the batched logs. `block` is true when the write
  // must finish before the call returns.
  writeFunc: (logs: Log[], block: boolean) => void;
  // BeforeAddFunc is optional function that is invoked every time
  // before a new log is added to the batch queue.
  //
  // Return false to skip adding the log into the batch queue.
  beforeAddFunc?: (log: Log) => boolean;
  // Level reports the minimum level to log.
  // Levels with lower levels are discarded.
  // If unset, the Handler uses LevelInfo.
  level?: number;
  // BatchSize specifies how many logs to accumulate before calling WriteFunc.
  // If not set or 0, fallback to 100 by default.
  batchSize?: number;
}

interface ResolvedOptions {
  writeFunc: BatchOptions["writeFunc"];
  beforeAddFunc: BatchOptions["beforeAddFunc"];
  level: number;
  batchSize: number;
}

// BatchHandler is a slog handler that writes records on batches.
//
// The log records attributes are formatted in JSON.
export class BatchHandler {
  readonly options: ResolvedOptions;
  readonly parent: BatchHandler | undefined;
  readonly group: string;
  readonly attrs: LogAttrs;
  logs: Log[] = [];

  constructor(
    options: BatchOptions | ResolvedOptions,
    parent?: BatchHandler,
    group = "",
    attrs: LogAttrs = {},
  ) {
    if (!options.writeFunc) {
      throw new Error("options.WriteFunc must be set");
    }

    this.options = parent
      ? (options as ResolvedOptions)
      : {
          writeFunc: options.writeFunc,
          beforeAddFunc: options.beforeAddFunc,
          level: options.level ?? LevelInfo,
          batchSize: options.batchSize || 100,
        };
    this.parent = parent;
    this.group = group;
    this.attrs = attrs;
  }

  // Enabled reports whether the handler handles records at the given level.
  //
  // The handler ignores records whose level is lower.
  enabled(level: number): boolean {
    return level >= this.options.level;
  }

  // WithGroup returns a new BatchHandler that starts a group.
  //
  // All logger attributes will be resolved under the specified group name.
  withGroup(name: string): BatchHandler {
    if (name === "") {
      return this;
    }
    return new BatchHandler(this.options, this, name);
  }

  // WithAttrs returns a new BatchHandler loaded with the specified attributes.
  withAttrs(attrs: LogAttrs): BatchHandler {
    if (Object.keys(attrs).length === 0) {
      return this;
    }
    return new BatchHandler(this.options, this, "", attrs);
  }

  // Handle formats the record as a JSON object and adds it to the batch queue.
  //
  // If the batch queue threshold has been reached, the WriteFunc option
  // is invoked with the accumulated logs which in turn will reset the batch queue.
  handle(r: LogRecord, block = false): void {
    if (this.group !== "") {
      r = { ...r, attrs: { [this.group]: new LogGroup({ ...this.attrs, ...r.attrs }) } };
    } else if (Object.keys(this.attrs).length > 0) {
      r = { ...r, attrs: { ...r.attrs, ...this.attrs } };
    }

    if (this.parent) {
      this.parent.handle(r, block);
      return;
    }

    const data: JSONMap<unknown> = Object.create(null) as JSONMap<unknown>;
    for (const key in r.attrs) {
      resolveAttr(data, key, r.attrs[key]);
    }

    const log: Log = { time: r.time, level: r.level, message: r.message, data };

    if (this.options.beforeAddFunc && !this.options.beforeAddFunc(log)) {
      return;
    }

    this.logs.push(log);

    if (this.logs.length >= this.options.batchSize) {
      this.writeAll(block);
    }
  }

  // SetLevel updates the handler options level to the specified one.
  setLevel(level: number): void {
    this.options.level = level;
  }

  // WriteAll writes all accumulated Log entries and resets the batch queue.
  writeAll(block = false): void {
    if (this.parent) {
      // invoke recursively the parent level handler since the most
      // top level one is holding the logs queue.
      this.parent.writeAll(block);
      return;
    }

    // no logs to write
    if (this.logs.length === 0) {
      return;
    }

    const logs = this.logs;
    this.logs = [];

    this.options.writeFunc(logs, block);
  }
}

// resolveAttr writes attr into data.
function resolveAttr(data: JSONMap<unknown>, key: string, value: unknown): void {
  if (key === "" && value === undefined) {
    return; // ignore empty attrs
  }

  if (value instanceof LogGroup) {
    const keys = Object.keys(value.attrs);
    if (keys.length === 0) {
      return; // ignore empty groups
    }

    // create a submap to wrap the resolved group attributes
    const groupData: JSONMap<unknown> = Object.create(null) as JSONMap<unknown>;
    for (const subKey of keys) {
      resolveAttr(groupData, subKey, value.attrs[subKey]);
    }

    if (Object.keys(groupData).length > 0) {
      data[key] = groupData;
    }
    return;
  }

  data[key] = normalizeLogAttrValue(value);
}

function isPlainMap(value: object): value is { [key: string]: unknown } {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serializeMap(errors: { [key: string]: unknown }): { [key: string]: unknown } {
  const out: { [key: string]: unknown } = Object.create(null) as { [key: string]: unknown };
  for (const key of Object.keys(errors)) {
    out[key] = serializeLogError(errors[key]);
  }
  return out;
}

function normalizeLogAttrValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }

  if (value instanceof ValidationErrors) {
    return serializeMap(value.errors);
  }

  if (value instanceof Error) {
    // check for wrapped validation.Errors
    const ve = errorsAs(value, ValidationErrors);
    if (ve) {
      return { data: serializeMap(ve.errors), raw: serializeLogError(value) };
    }
    return serializeLogError(value);
  }

  if (typeof value === "object" && value !== null && isPlainMap(value)) {
    const out: { [key: string]: unknown } = Object.create(null) as { [key: string]: unknown };
    for (const key of Object.keys(value)) {
      const v = value[key];
      out[key] = v instanceof Error ? serializeLogError(v) : normalizeLogAttrValue(v);
    }
    return out;
  }

  return value;
}

function serializeLogError(err: unknown): unknown {
  if (err === null || err === undefined) {
    return null;
  }

  // prioritize a json structured format (e.g. validation.Errors)
  if (isJSONMarshaler(err)) {
    return err;
  }

  // fallback to its original string representation
  return err instanceof Error ? err.message : err;
}
