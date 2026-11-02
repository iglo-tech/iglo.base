// Upstream: core/log_model.go

import { BaseModel } from "@/db/model";
import type { Params, Row } from "@/db/dbx/query";
import type { Log as BatchLog } from "@/logs/batch-handler";
import { parseDateTime, DateTime } from "@/tools/types/datetime";
import { marshal, setOwn } from "@/tools/types/go-json";
import { type JSONMap, jsonMapMarshalJSON, scanJSONMap } from "@/tools/types/json-map";

export const LogsTableName = "_logs";

const defaultMaxLogDataSize = 16 << 10; // ~16kb
const defaultMaxLogMessageSize = 8000;

export class Log extends BaseModel {
  created = new DateTime();
  data: JSONMap<unknown> = {};
  message = "";
  level = 0;

  tableName(): string {
    return LogsTableName;
  }

  override dbScan(row: Row): void {
    super.dbScan(row);
    if (Object.hasOwn(row, "created")) {
      this.created = parseDateTime(row.created);
    }
    if (Object.hasOwn(row, "data")) {
      this.data = scanJSONMap(row.data);
    }
    if (Object.hasOwn(row, "message")) {
      this.message = String(row.message ?? "");
    }
    if (Object.hasOwn(row, "level")) {
      this.level = Number(row.level ?? 0);
    }
  }

  // the Go struct's JSON: BaseModel's id first, then the fields in order
  marshalJSON(): string {
    const data = jsonMapMarshalJSON(this.data);
    return `{"id":${marshal(this.id)},"created":${this.created.marshalJSON()},"data":${data},"message":${marshal(this.message, { allowInvalidUTF8: true })},"level":${String(this.level)}}`;
  }
}

// str[:max] of a Go string: a character cut in two ends with U+FFFD, the
// text Go's invalid bytes read back as.
export function cutBytes(str: string, max: number): string {
  return Buffer.from(str).subarray(0, max).toString();
}

// DBExport prepares and exports the log for db persistence: its data goes
// in as the raw JSON text.
//
// It also truncates the log's message and data to ensure that it is
// under Logs.MaxDataSize.
export function logDBExport(id: string, log: BatchLog, maxDataSize: number): Params {
  // truncate the raw message bytes
  // (this is expected to be very rare so it is ok even if multi-byte chars)
  const message =
    Buffer.byteLength(log.message) > defaultMaxLogMessageSize
      ? cutBytes(log.message, defaultMaxLogMessageSize)
      : log.message;

  return {
    id,
    created: DateTime.fromDate(log.time).toString(),
    level: log.level,
    message,
    data: exportData(log.data, maxDataSize),
  };
}

function exportData(data: JSONMap<unknown>, maxDataSize: number): string {
  let rawData = jsonMapMarshalJSON(data);

  const limit = maxDataSize === 0 ? defaultMaxLogDataSize : maxDataSize;
  if (Buffer.byteLength(rawData) > limit) {
    // the "valid" attrs read up to the invalid part are kept, as
    // jsonv2's stream decoding leaves them
    const truncatedData = decodeTruncated(cutBytes(rawData, limit));
    truncatedData["__pb_truncated__"] = true;
    rawData = jsonMapMarshalJSON(truncatedData);
  }

  return rawData;
}

// json.Unmarshal of a compact JSON object cut at any byte into a map, keeping
// what Go's decoder has stored when it fails at the end of the input: every
// member read so far, the objects and arrays that were open, and a null for
// the value it failed on. The limit can be smaller than the data's first
// member, so the result may be empty.
function decodeTruncated(text: string): JSONMap<unknown> {
  return new TruncatedDecoder(text).object();
}

const numberPattern = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

class TruncatedDecoder {
  private i = 0;
  private failed = false;

  constructor(private readonly s: string) {}

  object(): JSONMap<unknown> {
    const obj: JSONMap<unknown> = {};
    this.i++; // {
    for (;;) {
      if (this.s[this.i] === ",") {
        this.i++;
      }
      if (this.i >= this.s.length) {
        this.failed = true;
        return obj;
      }
      if (this.s[this.i] === "}") {
        this.i++;
        return obj;
      }
      const name = this.string();
      if (name === undefined) {
        this.failed = true;
        return obj;
      }
      let value: unknown = null;
      if (this.s[this.i] === ":") {
        this.i++;
        value = this.value();
      } else {
        this.failed = true;
      }
      setOwn(obj, name, value);
      if (this.failed) {
        return obj;
      }
    }
  }

  private array(): unknown[] {
    const arr: unknown[] = [];
    this.i++; // [
    for (;;) {
      if (this.s[this.i] === ",") {
        this.i++;
      }
      if (this.s[this.i] === "]") {
        this.i++;
        return arr;
      }
      arr.push(this.value());
      if (this.failed) {
        return arr;
      }
    }
  }

  private value(): unknown {
    const c = this.s[this.i];
    switch (c) {
      case undefined:
        this.failed = true;
        return null;
      case "{":
        return this.object();
      case "[":
        return this.array();
      case '"': {
        const str = this.string();
        if (str === undefined) {
          this.failed = true;
          return null;
        }
        return str;
      }
      case "t":
        return this.literal("true", true);
      case "f":
        return this.literal("false", false);
      case "n":
        return this.literal("null", null);
    }
    return this.number();
  }

  private literal(text: string, value: unknown): unknown {
    if (!this.s.startsWith(text, this.i)) {
      this.failed = true;
      return null;
    }
    this.i += text.length;
    return value;
  }

  // a number that ends with the input is complete, unless its fraction or
  // exponent has no digits yet
  private number(): unknown {
    numberPattern.lastIndex = this.i;
    const match = numberPattern.exec(this.s);
    const next = match ? this.s[this.i + match[0].length] : ".";
    if (!match || next === "." || next === "e" || next === "E") {
      this.failed = true;
      return null;
    }
    this.i += match[0].length;
    return Number(match[0]);
  }

  // undefined when the string does not end
  private string(): string | undefined {
    for (let end = this.i + 1; end < this.s.length; end++) {
      const c = this.s[end];
      if (c === "\\") {
        end++;
      } else if (c === '"') {
        const text = this.s.slice(this.i, end + 1);
        this.i = end + 1;
        return JSON.parse(text) as string;
      }
    }
    return undefined;
  }
}
