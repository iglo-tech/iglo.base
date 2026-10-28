// Upstream: ozzo-validation v4.4.1 is/rules_test.go
//
// Only the rows for the rules ported in src/validation/is/rules.ts (Domain,
// EmailFormat, HexColor, Host, JSON, URL) are here. The other rows of the Go
// table are not ported and are dropped.

import { describe, expect, test } from "bun:test";

import {
  Domain,
  EmailFormat,
  HexColor,
  Host,
  JSON as JSONRule,
  URL as URLRule,
} from "@/validation/is/rules";

const rows = [
  {
    name: "EmailFormat",
    rule: EmailFormat,
    valid: "test@example.com",
    invalid: "example.com",
    err: "must be a valid email address",
  },
  {
    name: "URL",
    rule: URLRule,
    valid: "http://example.com",
    invalid: "examplecom",
    err: "must be a valid URL",
  },
  {
    name: "Domain (localhost)",
    rule: Domain,
    valid: "example-domain.com",
    invalid: "localhost",
    err: "must be a valid domain",
  },
  {
    name: "Domain (256 chars)",
    rule: Domain,
    valid: "example-domain.com",
    invalid: "a".repeat(256),
    err: "must be a valid domain",
  },
  {
    name: "Host",
    rule: Host,
    valid: "example.com",
    invalid: "abc%",
    err: "must be a valid IP address or DNS name",
  },
  {
    name: "HexColor",
    rule: HexColor,
    valid: "F00",
    invalid: "FTF",
    err: "must be a valid hexadecimal color code",
  },
  {
    name: "JSON",
    rule: JSONRule,
    valid: "[1, 2]",
    invalid: "[1, 2,]",
    err: "must be in valid JSON format",
  },
];

describe("TestAll", () => {
  test.each(rows)("$name", ({ rule, valid, invalid, err }) => {
    expect(rule.validate("")).toBeNull();
    expect(rule.validate(valid)).toBeNull();
    expect(rule.validate(invalid)?.message).toBe(err);
  });
});
