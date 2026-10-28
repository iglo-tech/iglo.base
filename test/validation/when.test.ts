// Upstream: ozzo-validation v4.4.1 when_test.go
//
// Dropped: TestWhenWithContext (context variants).

import { describe, expect, test } from "bun:test";

import { Required } from "@/validation/required";
import { NewStringRule } from "@/validation/string";
import { When, type WhenRule } from "@/validation/when";
import { Validate, type Rule } from "@/validation/validation";

function abcValidation(val: string): boolean {
  return val === "abc";
}

function validateMe(s: string): boolean {
  return s === "me";
}

describe("when", () => {
  const abcRule = NewStringRule(abcValidation, "wrong_abc");
  const validateMeRule = NewStringRule(validateMe, "wrong_me");

  const rows: {
    tag: string;
    condition: boolean;
    value: unknown;
    rules: Rule[];
    elseRules: Rule[];
    err: string;
  }[] = [
    // True condition
    { tag: "t1.1", condition: true, value: null, rules: [], elseRules: [], err: "" },
    { tag: "t1.2", condition: true, value: "", rules: [], elseRules: [], err: "" },
    { tag: "t1.3", condition: true, value: "", rules: [abcRule], elseRules: [], err: "" },
    { tag: "t1.4", condition: true, value: 12, rules: [Required], elseRules: [], err: "" },
    {
      tag: "t1.5",
      condition: true,
      value: null,
      rules: [Required],
      elseRules: [],
      err: "cannot be blank",
    },
    {
      tag: "t1.6",
      condition: true,
      value: "123",
      rules: [abcRule],
      elseRules: [],
      err: "wrong_abc",
    },
    { tag: "t1.7", condition: true, value: "abc", rules: [abcRule], elseRules: [], err: "" },
    {
      tag: "t1.8",
      condition: true,
      value: "abc",
      rules: [abcRule, abcRule],
      elseRules: [],
      err: "",
    },
    {
      tag: "t1.9",
      condition: true,
      value: "abc",
      rules: [abcRule, validateMeRule],
      elseRules: [],
      err: "wrong_me",
    },
    {
      tag: "t1.10",
      condition: true,
      value: "me",
      rules: [abcRule, validateMeRule],
      elseRules: [],
      err: "wrong_abc",
    },
    { tag: "t1.11", condition: true, value: "me", rules: [], elseRules: [abcRule], err: "" },

    // False condition
    { tag: "t2.1", condition: false, value: "", rules: [], elseRules: [], err: "" },
    { tag: "t2.2", condition: false, value: "", rules: [abcRule], elseRules: [], err: "" },
    { tag: "t2.3", condition: false, value: "abc", rules: [abcRule], elseRules: [], err: "" },
    {
      tag: "t2.4",
      condition: false,
      value: "abc",
      rules: [abcRule, abcRule],
      elseRules: [],
      err: "",
    },
    {
      tag: "t2.5",
      condition: false,
      value: "abc",
      rules: [abcRule, validateMeRule],
      elseRules: [],
      err: "",
    },
    {
      tag: "t2.6",
      condition: false,
      value: "me",
      rules: [abcRule, validateMeRule],
      elseRules: [],
      err: "",
    },
    {
      tag: "t2.7",
      condition: false,
      value: "",
      rules: [abcRule, validateMeRule],
      elseRules: [],
      err: "",
    },
    {
      tag: "t2.8",
      condition: false,
      value: "me",
      rules: [],
      elseRules: [abcRule, validateMeRule],
      err: "wrong_abc",
    },
  ];

  test.each(rows)("TestWhen $tag", ({ condition, value, rules, elseRules, err }) => {
    const rule: WhenRule = When(condition, ...rules).else(...elseRules);
    const got = Validate(value, rule);
    if (err === "") {
      expect(got).toBeNull();
    } else {
      expect(got?.message).toBe(err);
    }
  });
});
