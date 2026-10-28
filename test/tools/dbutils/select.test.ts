// Upstream: tools/dbutils/select_test.go

import { describe, expect, test } from "bun:test";
import { aliasOrIdentifier } from "@/tools/dbutils/select";

describe("AliasOrIdentifier", () => {
  const scenarios: { value: string; expected: string }[] = [
    { value: "", expected: "" },
    { value: "abc", expected: "abc" },
    { value: "abc  ", expected: "abc  " }, // return unmodified
    { value: "abc.def", expected: "abc.def" },
    { value: "abc.123 def", expected: "def" },
    { value: "abc.123 as def.456", expected: "def.456" },
    { value: "(abc) def", expected: "def" },
    { value: "(abc) as def", expected: "def" },
    { value: "abc   def", expected: "def" },
    { value: "abc as   def", expected: "def" },
    // technically invalid identifier but consistent with the dbx regex matching
    { value: "a b c d", expected: "d" },
    { value: "a b c as d", expected: "d" },
  ];

  for (const s of scenarios) {
    test(s.value, () => {
      expect(aliasOrIdentifier(s.value)).toBe(s.expected);
    });
  }
});
