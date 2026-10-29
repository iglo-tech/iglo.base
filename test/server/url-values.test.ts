// url.Values.Encode and url.QueryEscape (Go's net/url), which recordsList
// uses to hand the request query to the search provider.

import { expect, test } from "bun:test";

import { encodeValues, parseQuery, queryEscape } from "@/server/request";

test.each<[Map<string, string[]>, string]>([
  [new Map(), ""],
  [
    new Map([
      ["q", ["puppies"]],
      ["oe", ["utf8"]],
    ]),
    "oe=utf8&q=puppies",
  ],
  [new Map([["q", ["dogs", "&", "7"]]]), "q=dogs&q=%26&q=7"],
  [
    new Map([
      ["c", ["c1", "c2"]],
      ["a", ["a1", "a2"]],
      ["b", ["b1"]],
    ]),
    "a=a1&a=a2&b=b1&c=c1&c=c2",
  ],
  // keys sorted by their UTF-8 bytes, not UTF-16 code units
  [
    new Map([
      ["\u{1F600}", ["x"]],
      ["Ａ", ["y"]],
      ["Z", ["z"]],
    ]),
    "Z=z&%EF%BC%A1=y&%F0%9F%98%80=x",
  ],
  [new Map([["a b", ["c+d=e f"]]]), "a+b=c%2Bd%3De+f"],
])("Encode %#", (values, expected) => {
  expect(encodeValues(values)).toBe(expected);
});

test("QueryEscape keeps only the unreserved characters", () => {
  expect(queryEscape("AZaz09-_.~ !*'();:@&=+$,/?#[]%")).toBe(
    "AZaz09-_.~+%21%2A%27%28%29%3B%3A%40%26%3D%2B%24%2C%2F%3F%23%5B%5D%25",
  );
  expect(queryEscape("ż")).toBe("%C5%BC");
});

test("Encode after ParseQuery normalizes the query", () => {
  const { values } = parseQuery("sort=-created&filter=a%3D'b c'&expand=rel&filter=x");
  expect(encodeValues(values)).toBe("expand=rel&filter=a%3D%27b+c%27&filter=x&sort=-created");
});
