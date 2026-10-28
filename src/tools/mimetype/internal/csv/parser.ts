// Upstream: gabriel-vasile/mimetype v1.4.15 internal/csv/parser.go.

import type { Bytes } from "@/tools/mimetype/internal/scan/bytes";

// Parser is a CSV reader that only counts fields.
// It avoids allocating/copying memory and to verify behaviour, it is tested
// and fuzzed against encoding/csv parser.
export class Parser {
  constructor(
    private comma: number,
    private comment: number,
    private s: Bytes,
  ) {}

  private readLine(): [line: Uint8Array, cutShort: boolean] {
    const line = this.s.readSlice(0x0a).b;

    const n = line.length;
    if (n > 0 && line[n - 1] === 0x0d) {
      return [line.subarray(0, n - 1), false]; // drop \r at end of line
    }

    // This line is problematic. The logic from CountFields comes from
    // encoding/csv.Reader which relies on mutating the input bytes.
    // https://github.com/golang/go/blob/b3251514531123d7fd007682389bce7428d159a0/src/encoding/csv/reader.go#L275-L279
    // To avoid mutating the input, we return cutShort. #680
    if (n >= 2 && line[n - 2] === 0x0d && line[n - 1] === 0x0a) {
      return [line.subarray(0, n - 2), true];
    }
    return [line, false];
  }

  // CountFields reads one CSV line and counts how many records that line contained.
  // hasMore reports whether there are more lines in the input.
  // collectIndexes makes CountFields return a list of indexes where CSV fields
  // start in the line. These indexes are used to test the correctness against the
  // encoding/csv parser.
  countFields(
    collectIndexes: boolean,
  ): [fields: number, fieldPos: number[] | null, hasMore: boolean] {
    let finished = false;
    let line: Uint8Array;
    let cutShort: boolean;
    for (;;) {
      [line, cutShort] = this.readLine();
      if (finished) {
        return [0, null, false];
      }
      finished = this.s.length === 0 && line.length === 0;
      if (line.length === lengthNL(line)) {
        continue; // Skip empty lines.
      }
      if (line.length > 0 && line[0] === this.comment) {
        continue;
      }
      break;
    }

    let fields = 0;
    const indexes: number[] = [];
    let originalLine = line;
    parseField: for (;;) {
      if (line.length === 0 || line[0] !== 0x22) {
        // non-quoted string field
        fields++;
        if (collectIndexes) {
          indexes.push(originalLine.length - line.length);
        }
        const i = line.indexOf(this.comma);
        if (i >= 0) {
          line = line.subarray(i + 1); // 1 to get over ending comma
          continue parseField;
        }
        break parseField;
      } else {
        // Quoted string field.
        if (collectIndexes) {
          indexes.push(originalLine.length - line.length);
        }
        line = line.subarray(1); // get over starting quote
        for (;;) {
          const i = line.indexOf(0x22);
          if (i >= 0) {
            line = line.subarray(i + 1); // 1 for ending quote
            const rn = line.length > 0 ? (line[0] as number) : 0;
            if (rn === 0x22) {
              line = line.subarray(1);
            } else if (rn === this.comma) {
              line = line.subarray(1);
              fields++;
              continue parseField;
            } else if (lengthNL(line) === line.length) {
              fields++;
              break parseField;
            }
          } else if (line.length > 0 || cutShort) {
            [line, cutShort] = this.readLine();
            originalLine = line;
          } else {
            fields++;
            break parseField;
          }
        }
      }
    }

    return [fields, indexes, fields !== 0];
  }
}

export function newParser(comma: number, comment: number, s: Bytes): Parser {
  return new Parser(comma, comment, s);
}

// lengthNL reports the number of bytes for the trailing \n.
function lengthNL(b: Uint8Array): number {
  if (b.length > 0 && b[b.length - 1] === 0x0a) {
    return 1;
  }
  return 0;
}
