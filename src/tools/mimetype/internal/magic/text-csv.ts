// Upstream: gabriel-vasile/mimetype v1.4.15 internal/magic/text_csv.go.

import { newParser } from "@/tools/mimetype/internal/csv/parser";
import { Bytes } from "@/tools/mimetype/internal/scan/bytes";

// CSV matches a comma-separated values file.
export function CSV(raw: Uint8Array, limit: number): boolean {
  return sv(raw, 0x2c, limit);
}

// TSV matches a tab-separated values file.
export function TSV(raw: Uint8Array, limit: number): boolean {
  return sv(raw, 0x09, limit);
}

function sv(input: Uint8Array, comma: number, limit: number): boolean {
  const s = new Bytes(input);
  const r = newParser(comma, 0x23, s);

  const [headerFields, , headerHasMore] = r.countFields(false);
  if (headerFields < 2 || !headerHasMore) {
    return false;
  }
  let csvLines = 1; // 1 for header
  for (;;) {
    const [fields, , hasMore] = r.countFields(false);
    if (!hasMore && fields === 0) {
      break;
    }
    if (fields === headerFields) {
      csvLines++;
    } else {
      // maybeTruncated signals the input was cut at the read limit,
      // meaning the last line may be an incomplete CSV record.
      const maybeTruncated = limit > 0 && input.length >= limit;
      if (maybeTruncated && fields < headerFields) {
        // Allow the last row to have any number of fields
        // if the input is maybeTruncated.
        // BUG: if len(input) == limit, then the input is not truncated
        // but it is still allowed to have the wrong number of fields
        // and it will be reported as valid CSV.
        if (s.length === 0) {
          break;
        }
      }
      return false;
    }
    if (csvLines >= 10) {
      return true;
    }
  }

  return csvLines >= 2;
}
