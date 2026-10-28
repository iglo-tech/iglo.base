// Upstream: gabriel-vasile/mimetype v1.4.15 internal/magic/text_test.go
// Only TestRFC822 is ported; BenchmarkJSONPathological is skipped.

import { describe, expect, test } from "bun:test";

import { RFC822 } from "@/tools/mimetype/internal/magic/text";
import { raw } from "@test/tools/mimetype/go-literal";

const testcases = [
  { name: "empty", in: "", expected: false },
  { name: "one hint", in: "Cc: cc@mail.com", expected: false },
  { name: "two identical hints", in: "Cc: cc@mail.com\nCc: cc@mail.com", expected: true },
  { name: "two different hints", in: "Cc: cc@mail.com\nTo: to@mail.com", expected: true },
  { name: "junk at start", in: "junk\nCc: cc@mail.com\nTo: to@mail.com", expected: false },
  { name: "junk later", in: "Cc: cc@mail.com\njunk To: to@mail.com", expected: false },
];

describe("TestRFC822", () => {
  for (const tc of testcases) {
    test(tc.name, () => {
      const got = RFC822(raw(tc.in), 0);
      expect(got).toBe(tc.expected);
    });
  }
});
