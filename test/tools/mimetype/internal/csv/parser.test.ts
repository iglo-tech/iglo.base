// Upstream: gabriel-vasile/mimetype v1.4.15 internal/csv/parser_test.go

import { describe, expect, test } from "bun:test";

import { Parser } from "@/tools/mimetype/internal/csv/parser";
import { Bytes } from "@/tools/mimetype/internal/scan/bytes";
import { g, raw } from "@test/tools/mimetype/go-literal";

interface line {
  fields: number;
  // indexes[i] says at which index in the line the i-th field starts at.
  indexes: number[];
  hasMore: boolean;
}

const comma = 0x2c; // ','
const hash = 0x23; // '#'

// ln is a line whose Go encoding/csv record has the given fields. The expected
// values were produced by encoding/csv (stdlibLines in the Go test) for each
// case: Go's FieldPos columns, minus one, and hasMore true for every record.
const ln = (fields: number, indexes: number[]): line => ({ fields, indexes, hasMore: true });

const testcases: { name: string; csv: Uint8Array; comma: number; comment: number; want: line[] }[] =
  [
    {
      name: "empty",
      csv: raw(""),
      comma,
      comment: hash,
      want: [],
    },
    {
      name: "simple",
      csv: raw(`foo,bar,baz
1,2,3
"1","a",b`),
      comma,
      comment: hash,
      want: [ln(3, [0, 4, 8]), ln(3, [0, 2, 4]), ln(3, [0, 4, 8])],
    },
    {
      name: "crlf line endings",
      csv: g`foo,bar,baz\r\n1,2,3\r\n`,
      comma,
      comment: hash,
      want: [ln(3, [0, 4, 8]), ln(3, [0, 2, 4])],
    },
    {
      name: "leading and trailing space",
      csv: raw(`1, abc ,3`),
      comma,
      comment: hash,
      want: [ln(3, [0, 2, 8])],
    },
    {
      name: "empty quote",
      csv: raw(`1,"",3`),
      comma,
      comment: hash,
      want: [ln(3, [0, 2, 5])],
    },
    {
      name: "quotes with comma",
      csv: raw(`1,",",3`),
      comma,
      comment: hash,
      want: [ln(3, [0, 2, 6])],
    },
    {
      name: "quotes with quote",
      csv: raw(`1,""",3`),
      comma,
      comment: hash,
      want: [ln(2, [0, 2])],
    },
    {
      name: "fewer fields",
      csv: raw(`foo,bar,baz
1,2`),
      comma,
      comment: hash,
      want: [ln(3, [0, 4, 8]), ln(2, [0, 2])],
    },
    {
      name: "more fields",
      csv: raw(`1,2,3,4`),
      comma,
      comment: hash,
      want: [ln(4, [0, 2, 4, 6])],
    },
    {
      name: "forgot quote",
      csv: raw(`1,"Forgot,3`),
      comma,
      comment: hash,
      want: [ln(2, [0, 2])],
    },
    {
      name: "unescaped quote",
      csv: raw(`1,"abc"def",3`),
      comma,
      comment: hash,
      want: [ln(3, [0, 2, 12])],
    },
    {
      name: "unescaped quote",
      csv: raw(`1,"abc"def",3`),
      comma,
      comment: hash,
      want: [ln(3, [0, 2, 12])],
    },
    {
      name: "unescaped quote2",
      csv: raw(`1,abc"quote"def,3`),
      comma,
      comment: hash,
      want: [ln(3, [0, 2, 16])],
    },
    {
      name: "escaped quote",
      csv: raw(`1,abc""def,3`),
      comma,
      comment: hash,
      want: [ln(3, [0, 2, 11])],
    },
    {
      name: "new line",
      csv: raw(`1,abc
def,3`),
      comma,
      comment: hash,
      want: [ln(2, [0, 2]), ln(2, [0, 4])],
    },
    {
      name: "new line quotes",
      csv: raw(`1,"abc
def",3`),
      comma,
      comment: hash,
      want: [ln(3, [0, 2, 5])],
    },
    {
      name: "quoted field at end",
      csv: raw(`1,"abc"`),
      comma,
      comment: hash,
      want: [ln(2, [0, 2])],
    },
    {
      name: "not ended quoted field at end",
      csv: raw(`1,"abc`),
      comma,
      comment: hash,
      want: [ln(2, [0, 2])],
    },
    {
      name: "empty field",
      csv: raw(`1,,3`),
      comma,
      comment: hash,
      want: [ln(3, [0, 2, 3])],
    },
    {
      name: "unicode fields",
      csv: raw(`💁,👌,🎍,😍`),
      comma,
      comment: hash,
      want: [ln(4, [0, 5, 10, 15])],
    },
    {
      name: "comment",
      csv: raw(`#comment`),
      comma,
      comment: hash,
      want: [],
    },
    {
      name: "line with \\r at the end",
      csv: g`123\r\n456\r`,
      comma,
      comment: hash,
      want: [ln(1, [0]), ln(1, [0])],
    },
    {
      name: 'from fuzz \\"\\"\\r\\n0',
      csv: g`\"\"\r\n0`,
      comma,
      comment: 0x11,
      want: [ln(1, [0]), ln(1, [0])],
    },
  ];

// ourLines reads every record the way the Go test does: CountFields until
// hasMore is false.
function ourLines(data: Uint8Array, sep: number, comment: number): line[] {
  const p = new Parser(sep, comment, new Bytes(data));
  const lines: line[] = [];
  for (;;) {
    const [fields, indexes, hasMore] = p.countFields(true);
    if (!hasMore) {
      break;
    }
    lines.push({ fields, indexes: indexes ?? [], hasMore });
  }
  return lines;
}

// Test our parser against the one from encoding/csv.
describe("TestParser", () => {
  for (const tc of testcases) {
    test(tc.name, () => {
      expect(ourLines(tc.csv, tc.comma, tc.comment)).toEqual(tc.want);
    });
  }
});
