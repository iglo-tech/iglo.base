// Upstream: gabriel-vasile/mimetype v1.4.16 internal/magic/archive_test.go

import { describe, expect, test } from "bun:test";

import { tarParseOctal } from "@/tools/mimetype/internal/magic/archive";
import { g, raw } from "@test/tools/mimetype/go-literal";

// Go's octal literals (0227, 032033, ...) written as 0o227, 0o32033, ...
const tests: Array<{ in: Uint8Array; want: number }> = [
  { in: g`0000000\u0000`, want: 0 },
  { in: g` \u000000000\u0000`, want: 0 },
  { in: g` \u000000003\u0000`, want: 3 },
  { in: g`00000000227\u0000`, want: 0o227 },
  { in: g`032033\u0000 `, want: 0o3_2033 },
  { in: g`320330\u0000 `, want: 0o32_0330 },
  { in: g`0000660\u0000 `, want: 0o660 },
  { in: g`\u0000 0000660\u0000 `, want: 0o660 },
  { in: raw("0123456789abcdef"), want: -1 },
  { in: g`0123456789\u0000abcdef`, want: -1 },
  { in: g`01234567\u000089abcdef`, want: 0o123_4567 },
  { in: g`0123\u007e\u005f\u00264123`, want: -1 },
];

describe("TestTarParseOctal", () => {
  for (const tt of tests) {
    test(`parseOctal(${JSON.stringify(Array.from(tt.in))})`, () => {
      expect(tarParseOctal(tt.in)).toBe(tt.want);
    });
  }
});
