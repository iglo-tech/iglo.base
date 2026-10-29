// Upstream: tools/picker/excerpt_modifier_test.go

import { expect, test } from "bun:test";

import { toInt } from "@/records/cast";
import { newExcerptModifier } from "@/tools/picker/excerpt-modifier";
import { toBool } from "@/tools/types/cast";

test.each<[string, string[], boolean]>([
  ["no arguments", [], true],
  ["too many arguments", ["12", "false", "something"], true],
  ["non-numeric max argument", ["something"], true], // should fallback to 0 which is not allowed
  ["negative max argument", ["-1"], true],
  ["zero max argument", ["0"], true],
  ["numeric max argument", ["12"], false],
  ["non-bool withEllipsis argument", ["12", "something"], false], // should fallback to false which is allowed
  ["truthy withEllipsis argument", ["12", "t"], false],
])("NewExcerptModifier: %s", (_name, args, expectError) => {
  let m;
  let err: unknown;
  try {
    m = newExcerptModifier(...args);
  } catch (e) {
    err = e;
  }

  expect(err !== undefined).toBe(expectError);
  if (err !== undefined || m === undefined) {
    return;
  }

  const argMax = args.length > 0 ? Number(toInt(args[0])) : 0;
  const argWithEllipsis = args.length > 1 ? toBool(args[1]) : false;

  expect(m.max).toBe(argMax);
  expect(m.withEllipsis).toBe(argWithEllipsis);
});

const html = ` <script>var a = 123;</script>   <p>Hello</p><div id="test_id">t   est<b>12
	3</b><span>456</span></div><span>word <b>7</b> 89<span>!<b>?</b><b> a </b><b>b </b>c</span>#<h1>title</h1>`;

const plainText = "Hello t est12 3456 word 7 89!? a b c# title";

test.each<[string, string[], string, string]>([
  // without ellipsis
  ["only max < len(plainText)", ["2"], html, plainText.slice(0, 2)],
  ["only max = len(plainText)", [String(plainText.length)], html, plainText],
  ["only max > len(plainText)", [String(plainText.length + 5)], html, plainText],

  // with ellipsis
  ["with ellipsis and max < len(plainText)", ["2", "t"], html, plainText.slice(0, 2) + "..."],
  ["with ellipsis and max = len(plainText)", [String(plainText.length), "t"], html, plainText],
  ["with ellipsis and max > len(plainText)", [String(plainText.length + 5), "t"], html, plainText],

  // multibyte chars
  ["mutibyte chars <= max", ["4", "t"], "аб\nв ", "аб в"],
  ["mutibyte chars > max", ["3", "t"], "аб\nв ", "аб..."],
])("ExcerptModifier.Modify: %s", (_name, args, value, expected) => {
  const m = newExcerptModifier(...args);
  expect(m.modify(value)).toBe(expected);
});

test("ExcerptModifier.Modify keeps non-string values", () => {
  const m = newExcerptModifier("3");
  expect(m.modify(123)).toBe(123);
  expect(m.modify(null)).toBe(null);
});
