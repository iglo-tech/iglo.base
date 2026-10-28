// Upstream: core/validators/string_test.go

import { describe, expect, test } from "bun:test";

import { IPOrSubnet, IsRegex } from "@/validators/string";

describe("TestIsRegex", () => {
  const scenarios: [val: string, expectError: boolean][] = [
    ["", false],
    [String.raw`abc`, false],
    [String.raw`\w+`, false],
    [String.raw`\w*((abc+`, true],
  ];

  for (const [i, [val, expectError]] of scenarios.entries()) {
    test(`${i}_${JSON.stringify(val)}`, () => {
      const err = IsRegex(val);
      expect(err !== null).toBe(expectError);
    });
  }

  test("the error is Go's regexp compile error", () => {
    const err = IsRegex(String.raw`\w*((abc+`) as Error & { code(): string };
    expect(err.code()).toBe("validation_invalid_regex");
    expect(err.message).toBe("error parsing regexp: missing closing ): `\\w*((abc+`");
  });

  test("a non-string value", () => {
    expect((IsRegex(123) as Error & { code(): string }).code()).toBe(
      "validation_unsupported_value_type",
    );
  });
});

describe("TestIPOrSubnet", () => {
  const scenarios: [val: string, expectError: boolean][] = [
    ["", false],
    [String.raw`invalid`, true],
    [String.raw`127.0`, true], // incomplete
    [String.raw`127.0.0.1`, false],
    [String.raw`::1`, false],
    [String.raw`0000:0000:0000:0000:0000:0000:0000:0001`, false],
    [String.raw`127.0.0.1/24`, false],
    [String.raw`::/128`, false],
  ];

  for (const [i, [val, expectError]] of scenarios.entries()) {
    test(`${i}_${JSON.stringify(val)}`, () => {
      const err = IPOrSubnet(val);
      expect(err !== null).toBe(expectError);
    });
  }

  test("the error", () => {
    const err = IPOrSubnet("invalid") as Error & { code(): string };
    expect(err.code()).toBe("validation_invlaid_ip_or_subnet");
    expect(err.message).toBe("invalid IP or CIDR subnet");
  });
});
