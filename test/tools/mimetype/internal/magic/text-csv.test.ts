// Upstream: gabriel-vasile/mimetype v1.4.15 internal/magic/text_csv_test.go

import { describe, expect, test } from "bun:test";

import { CSV } from "@/tools/mimetype/internal/magic/text-csv";
import { raw } from "@test/tools/mimetype/go-literal";

// len() of a Go string: its byte length.
const goLen = (s: string): number => raw(s).length;

const testcases: { name: string; in: string; limit: number; expected: boolean }[] = [
  // Minimum valid CSV: 2 rows and 2 columns.
  { name: "two rows two cols", in: "a,b\nc,d", limit: 0, expected: true },
  { name: "two rows three cols", in: "a,b,c\n1,2,3", limit: 0, expected: true },

  // Too few rows.
  { name: "empty", in: "", limit: 0, expected: false },
  { name: "one row two cols", in: "a,b", limit: 0, expected: false },
  { name: "one row only newline", in: "\n", limit: 0, expected: false },

  // Too few columns.
  { name: "two rows one col each", in: "a\nb", limit: 0, expected: false },
  { name: "one col with newlines", in: "a\nb\nc", limit: 0, expected: false },

  // Inconsistent column counts.
  { name: "mismatched col count", in: "a,b\nc,d,e", limit: 0, expected: false },
  { name: "mismatched col count reversed", in: "a,b,c\nd,e", limit: 0, expected: false },
  { name: "first row ok third mismatches", in: "a,b\nc,d\ne", limit: 0, expected: false },

  // Quoted fields.
  { name: "quoted fields", in: '"a","b"\n"c","d"', limit: 0, expected: true },
  {
    name: "quoted field with comma inside",
    in: '"a,x","b"\n"c,y","d"',
    limit: 0,
    expected: true,
  },
  { name: "quoted field with newline inside", in: '"a\nb",c\nd,e', limit: 0, expected: true },

  // CRLF line endings.
  { name: "crlf endings", in: "a,b\r\nc,d", limit: 0, expected: true },
  { name: "crlf one row", in: "a,b\r\n", limit: 0, expected: false },

  // Comment lines (# is the comment character) are skipped.
  { name: "comment then two rows", in: "# skip\na,b\nc,d", limit: 0, expected: true },
  { name: "comment then one row", in: "# skip\na,b", limit: 0, expected: false },
  { name: "all comments", in: "# a\n# b\n", limit: 0, expected: false },

  // Empty lines are skipped.
  { name: "empty lines between rows", in: "a,b\n\nc,d", limit: 0, expected: true },
  { name: "leading empty line", in: "\na,b\nc,d", limit: 0, expected: true },

  // Early return after 10 rows.
  { name: "ten rows returns true", in: "a,b\n".repeat(10), limit: 0, expected: true },

  // Early return after 10 rows ignores subsequent invalid input.
  { name: "ten rows returns true", in: "a,b\n".repeat(10) + "bad", limit: 0, expected: true },

  // Truncation: limit=0 means whole input should be parsed and correct.
  { name: "limit zero no drop", in: "a,b\nc,d\nbad", limit: 0, expected: false },

  // Truncation: last incomplete line is allowed to have different number of fields.
  {
    name: "truncated last line dropped",
    in: "a,b\nc,d\nbad",
    limit: goLen("a,b\nc,d\nbad"),
    expected: true,
  },

  // Truncation: last line is dropped when len(data)==limit.
  { name: "gets truncated", in: "a,b\nc,d", limit: goLen("a,b\nc,d"), expected: true },

  // Truncated but the remaining data is still invalid.
  { name: "truncated still one row", in: "a,b\nbad", limit: goLen("a,b\nbad"), expected: false },

  // Limit set but data is smaller than limit (complete file): no drop.
  {
    name: "limit larger than data",
    in: "a,b\nc,d\nbad",
    limit: goLen("a,b\nc,d\nbad") + 1,
    expected: false,
  },

  // TSV via the CSV function should not match tab-separated data.
  { name: "tab separated not csv", in: "a\tb\nc\td", limit: 0, expected: false },
];

describe("TestCSV", () => {
  for (const tc of testcases) {
    test(tc.name, () => {
      const got = CSV(raw(tc.in), tc.limit);
      expect(got).toBe(tc.expected);
    });
  }
});
