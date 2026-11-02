// Upstream: core/log_printer.go
//
// The colors are fatih/color's: a bold attribute ends with its own reset.

import { LevelDebug, LevelError, LevelInfo, LevelWarn, type Log } from "@/logs/batch-handler";
import { isJSONMarshaler } from "@/tools/types/go-json";
import { jsonMapString } from "@/tools/types/json-map";

function paint(color: boolean, code: string, text: string): string {
  if (!color) {
    return text;
  }
  const end = code.startsWith("1;") ? "22;0" : "0";
  return `\x1b[${code}m${text}\x1b[${end}m`;
}

// fmt's %v of a decoded JSON value, or of an error kept as a JSON marshaler
function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "<nil>";
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (Array.isArray(value)) {
    return `[${value.map(formatValue).join(" ")}]`;
  }
  if (typeof value === "object" && !isJSONMarshaler(value)) {
    const map = value as { [key: string]: unknown };
    const items = Object.keys(map)
      .toSorted()
      .map((key) => `${key}:${formatValue(map[key])}`);
    return `map[${items.join(" ")}]`;
  }
  return String(value);
}

// the text printLog writes for the provided log
export function formatLog(log: Log, color: boolean): string {
  let str: string;

  switch (log.level) {
    case LevelDebug:
      str = paint(color, "1;90", "DEBUG ") + paint(color, "37", log.message);
      break;
    case LevelInfo:
      str = paint(color, "1;37", "INFO ") + paint(color, "37", log.message);
      break;
    case LevelWarn:
      str = paint(color, "1;33", "WARN ") + paint(color, "33", log.message);
      break;
    case LevelError:
      str = paint(color, "1;31", "ERROR ") + paint(color, "31", log.message);
      break;
    default:
      str = paint(color, "1;36", `[${log.level}] `) + paint(color, "36", log.message);
  }

  str += "\n";

  if (log.data.type === "request") {
    let padding = 0;
    for (const key of ["error", "details"]) {
      const v = log.data[key];
      if (v !== null && v !== undefined) {
        str += paint(color, "91", `${" ".repeat(padding)}└─ ${formatValue(v)}`) + "\n";
        padding += 3;
      }
    }
  } else if (Object.keys(log.data).length > 0) {
    str += paint(color, "90", `└─ ${jsonMapString(log.data)}`) + "\n";
  }

  return str;
}
