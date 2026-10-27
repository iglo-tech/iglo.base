// Upstream: Go's mime/mediatype_test.go (TestParseMediaType), the RFC 2231
// rows: parseMediaType ports mime.ParseMediaType for the router's form and
// multipart parsing.

import { expect, test } from "bun:test";

import { parseMediaType } from "@/server/request";

test.each<[string, string, Record<string, string>]>([
  // From RFC 2231:
  [
    "application/x-stuff; title*=us-ascii'en-us'This%20is%20%2A%2A%2Afun%2A%2A%2A",
    "application/x-stuff",
    { title: "This is ***fun***" },
  ],
  [
    'message/external-body; access-type=URL; URL*0="ftp://";URL*1="cs.utk.edu/pub/moore/bulk-mailer/bulk-mailer.tar"',
    "message/external-body",
    { "access-type": "URL", url: "ftp://cs.utk.edu/pub/moore/bulk-mailer/bulk-mailer.tar" },
  ],
  [
    "application/x-stuff; title*0*=us-ascii'en'This%20is%20even%20more%20; title*1*=%2A%2A%2Afun%2A%2A%2A%20; title*2=\"isn't it!\"",
    "application/x-stuff",
    { title: "This is even more ***fun*** isn't it!" },
  ],
  // Tests from http://greenbytes.de/tech/tc2231/
  [
    "attachment; filename*=UTF-8''foo-%c3%a4-%e2%82%ac.html",
    "attachment",
    { filename: "foo-ä-€.html" },
  ],
  ["attachment; filename*=''foo-%c3%a4-%e2%82%ac.html", "attachment", {}],
  ["attachment; filename*=UTF-8''foo-a%cc%88.html", "attachment", { filename: "foo-a\u0308.html" }],
  ["attachment; filename*= UTF-8''foo-%c3%a4.html", "attachment", { filename: "foo-ä.html" }],
  ["attachment; filename* =UTF-8''foo-%c3%a4.html", "attachment", { filename: "foo-ä.html" }],
  ["attachment; filename*=\"UTF-8''foo-%c3%a4.html\"", "attachment", { filename: "foo-ä.html" }],
  ['attachment; filename*="foo%20bar.html"', "attachment", {}],
  ["attachment; filename*=UTF-8'foo-%c3%a4.html", "attachment", {}],
  ["attachment; filename*=UTF-8''foo%", "attachment", {}],
  ["attachment; filename*=UTF-8''f%oo.html", "attachment", {}],
  ["attachment; filename*=UTF-8''A-%2541.html", "attachment", { filename: "A-%41.html" }],
  ['attachment; filename*0="foo."; filename*1="html"', "attachment", { filename: "foo.html" }],
  [
    "attachment; filename*0*=UTF-8''foo-%c3%a4; filename*1=\".html\"",
    "attachment",
    { filename: "foo-ä.html" },
  ],
  ['attachment; filename*0="foo"; filename*01="bar"', "attachment", { filename: "foo" }],
  ['attachment; filename*0="foo"; filename*2="bar"', "attachment", { filename: "foo" }],
  ['attachment; filename*1="foo."; filename*2="html"', "attachment", {}],
  ['attachment; filename*1="bar"; filename*0="foo"', "attachment", { filename: "foobar" }],
  [
    "attachment; filename=\"foo-ae.html\"; filename*=UTF-8''foo-%c3%a4.html",
    "attachment",
    { filename: "foo-ä.html" },
  ],
  [
    "attachment; filename*=UTF-8''foo-%c3%a4.html; filename=\"foo-ae.html\"",
    "attachment",
    { filename: "foo-ä.html" },
  ],
  [
    "attachment; filename*0*=ISO-8859-15''euro-sign%3d%a4; filename*=ISO-8859-1''currency-sign%3d%a4",
    "attachment",
    {},
  ],
  // issue #46323: trailing semicolon after continuations
  [
    'message/external-body; access-type=URL;\n\t\tURL*0="ftp://";\n\t\tURL*1="cs.utk.edu/pub/moore/bulk-mailer/bulk-mailer.tar";',
    "message/external-body",
    { "access-type": "URL", url: "ftp://cs.utk.edu/pub/moore/bulk-mailer/bulk-mailer.tar" },
  ],
])("%s", (input, mediaType, params) => {
  const parsed = parseMediaType(input);
  expect(parsed).toEqual({ mediaType, params: new Map(Object.entries(params)) });
});
